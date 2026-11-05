#!/usr/bin/env node
/**
 * DSH 自动回复 —— 有人私聊测试号（DSH 那个 QQ）时，自动调 PASC 的 agent 通道回复。
 *
 * 链路：
 *   QQ 私聊 → NapCat(test) WS :3101 → 本脚本 → POST /api/agent/chat → OpenClaw
 *                                            ↓
 *                              HTTP :3100 send_private_msg → 回到 QQ
 *
 * 设计：
 *   - 每个对端维护一份最近 12 条对话历史，让回复有上下文
 *   - 同一个人连发多条时排队串行处理，避免并发回复顺序错乱
 *   - 连接失败只发 error 不发 close（undici 的行为），所以有超时兜底
 *
 * 环境变量（或 scripts/.env.local）：
 *   TEST_NAPCAT_WS / TEST_NAPCAT_TOKEN / TEST_NAPCAT_URL / PASC_API
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadEnvLocal() {
  try {
    const raw = await readFile(join(ROOT, 'scripts', '.env.local'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* 用默认值 */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractText(segments) {
  if (typeof segments === 'string') return segments;
  if (!Array.isArray(segments)) return '';
  return segments
    .map((s) => {
      if (s.type === 'text') return s.data?.text ?? '';
      if (s.type === 'image') return '[图片]';
      if (s.type === 'face') return '[表情]';
      if (s.type === 'record') return '[语音]';
      if (s.type === 'file') return '[文件]';
      return '';
    })
    .join('')
    .trim();
}

const HISTORY_LIMIT = 12;
const histories = new Map(); // peerId -> [{role, content}]
const queues = new Map(); // peerId -> Promise

const SYSTEM = [
  '你是 DSH，一个在 QQ 上和熟人私聊的助手。',
  '说话简短自然，一到两句，口语化，不用列表、不用 markdown、不加表情包。',
  '对方可能就是随口聊聊，你不必每句都给建议。',
  '不要自称"AI 助手""语言模型"，也不要说"作为一个 AI"。',
  '如果对方问技术问题，直接给答案；不确定就说不确定。',
].join('\n');

async function askAgent(peerId, text) {
  const history = histories.get(peerId) ?? [];
  const body = JSON.stringify({ text, system: SYSTEM, history });
  const base = process.env.PASC_API || 'http://127.0.0.1:7788';
  const res = await fetch(`${base}/api/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'agent 调用失败');

  const next = [...history, { role: 'user', content: text }, { role: 'assistant', content: data.text }];
  histories.set(peerId, next.slice(-HISTORY_LIMIT));
  return data.text;
}

async function sendPrivate(peerId, text) {
  const base = process.env.TEST_NAPCAT_URL || 'http://127.0.0.1:3100';
  const token = process.env.TEST_NAPCAT_TOKEN || '';
  const res = await fetch(`${base}/send_private_msg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ user_id: Number(peerId), message: text }),
  });
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(data.message || '发送失败');
  return data;
}

/** 同一个人连发消息时串行处理 */
function enqueue(peerId, task) {
  const prev = queues.get(peerId) ?? Promise.resolve();
  const next = prev.then(task).catch((err) => {
    console.error(`[autoreply] 处理失败 ${peerId}:`, err instanceof Error ? err.message : err);
  });
  queues.set(peerId, next);
  return next;
}

async function handlePrivate(from, fromName, text) {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${stamp}] ← ${fromName}(${from}) ${text}`);
  const reply = await askAgent(from, text);
  if (!reply) {
    console.log('[autoreply] agent 返回空，跳过');
    return;
  }
  await sendPrivate(from, reply);
  console.log(`[${stamp}] → ${reply}`);
}

async function main() {
  await loadEnvLocal();
  const wsBase = process.env.TEST_NAPCAT_WS || 'ws://127.0.0.1:3101';
  const token = process.env.TEST_NAPCAT_TOKEN || '';
  const url = token ? `${wsBase}/?access_token=${encodeURIComponent(token)}` : wsBase;

  let backoff = 1000;
  for (;;) {
    await new Promise((resolve) => {
      const ws = new WebSocket(url);
      let opened = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        resolve();
      };
      const connectTimeout = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        finish();
      }, 12_000);

      ws.onopen = () => {
        opened = true;
        backoff = 1000;
        clearTimeout(connectTimeout);
        console.log(`[autoreply] 已连上 ${wsBase}`);
      };
      ws.onmessage = (ev) => {
        let frame;
        try { frame = JSON.parse(String(ev.data)); } catch { return; }
        if (frame.post_type !== 'message' || frame.message_type !== 'private') return;
        if (String(frame.user_id) === String(frame.self_id)) return; // 自己发的不处理
        const text = extractText(frame.message);
        if (!text) return;
        void enqueue(String(frame.user_id), () => handlePrivate(String(frame.user_id), frame.sender?.nickname ?? '', text));
      };
      ws.onerror = () => { if (opened) console.log('[autoreply] 连接出错，重连'); finish(); };
      ws.onclose = () => { if (opened) console.log('[autoreply] 断开，重连'); finish(); };
    });
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
}

main().catch((err) => {
  console.error('[autoreply] 致命错误:', err);
  process.exit(1);
});
