#!/usr/bin/env node
/**
 * DSH 收件箱 —— 常驻监听测试号（DSH 那个 QQ）收到的私聊消息，落成本地 JSONL。
 *
 * 为什么需要它：
 *   QQ 消息只在 NapCat 的 WebSocket 事件里出现一次，错过了就没了。
 *   这个小程序常驻连上去，把发给 DSH 的消息全部写进 data/dsh-inbox.jsonl，
 *   这样 DSH（agent）可以随时读文件补看，不依赖"当时正好在线"。
 *
 * 环境变量（或 scripts/.env.local）：
 *   TEST_NAPCAT_WS    默认 ws://127.0.0.1:3101
 *   TEST_NAPCAT_TOKEN 测试实例的 OneBot token
 *
 * 输出：data/dsh-inbox.jsonl，每行一条：
 *   { ts, from, fromName, text, rawType }
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = join(ROOT, 'data', 'dsh-inbox.jsonl');

async function loadEnvLocal() {
  try {
    const raw = await readFile(join(ROOT, 'scripts', '.env.local'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    /* 没有本地 env 就用默认值 */
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
      if (s.type === 'at') return `@${s.data?.qq ?? ''}`;
      return '';
    })
    .join('');
}

async function record(entry) {
  await mkdir(dirname(INBOX), { recursive: true });
  await appendFile(INBOX, JSON.stringify(entry) + '\n', 'utf8');
  console.log(`[${new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false })}] ${entry.fromName}(${entry.from}): ${entry.text}`);
}

async function main() {
  await loadEnvLocal();
  const base = process.env.TEST_NAPCAT_WS || 'ws://127.0.0.1:3101';
  const token = process.env.TEST_NAPCAT_TOKEN || '';
  const url = token ? `${base}/?access_token=${encodeURIComponent(token)}` : base;

  let backoff = 1000;
  for (;;) {
    await new Promise((resolve) => {
      const ws = new WebSocket(url);
      let opened = false;
      let settled = false;

      // 关键：连接失败时 undici 的 WebSocket 只发 error、不发 close，
      // 没有这个兜底，Promise 会永远悬着，事件循环空了进程直接退出。
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(connectTimeout);
        resolve();
      };
      const connectTimeout = setTimeout(() => {
        console.log('[dsh-inbox] 连接超时，重试');
        try { ws.close(); } catch { /* ignore */ }
        finish();
      }, 12_000);
      const timer = setTimeout(() => {}, 0); // 占位，保证事件循环不空

      ws.onopen = () => {
        opened = true;
        backoff = 1000;
        clearTimeout(connectTimeout);
        console.log(`[dsh-inbox] 已连上 ${base}`);
      };
      ws.onmessage = (ev) => {
        let frame;
        try {
          frame = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (frame.post_type !== 'message') return;
        if (frame.message_type !== 'private') return; // 只收私聊，群里的走 PASC
        const text = extractText(frame.message);
        if (!text.trim()) return;
        void record({
          ts: Date.now(),
          from: String(frame.user_id ?? ''),
          fromName: frame.sender?.nickname ?? String(frame.user_id ?? ''),
          text,
          rawType: frame.message_type,
        });
      };
      ws.onerror = () => {
        if (opened) console.log('[dsh-inbox] 连接出错，准备重连');
        finish();
      };
      ws.onclose = () => {
        if (opened) console.log('[dsh-inbox] 断开，准备重连');
        finish();
      };
    });
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
}

main().catch((err) => {
  console.error('[dsh-inbox] 致命错误:', err);
  process.exit(1);
});
