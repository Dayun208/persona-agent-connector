import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

/**
 * 假 NapCat —— 本地端到端演练器。
 *
 * 它扮演 PASC 要连的那个"正向 WebSocket 服务端":
 *   - 连上以后按剧本推几条群消息(模拟一个真实群在聊天)
 *   - 收到 PASC 发来的 send_group_msg 之类指令时, 打印出来并回一个成功的 echo
 *
 * 这样不需要装 QQ、不需要 OpenClaw, 就能验证:
 *   消息入池 → 判断 → Prompt 构建 → Agent 回复 → JSON 解析 → 发回"QQ"
 *
 * 用法:
 *   pnpm --filter @pasc/fake-napcat dev
 *   FAKE_PORT=3001 FAKE_GROUP=123456 FAKE_SELF=99999 pnpm ...
 *   AUTO_SCRIPT=0 只起服务不推剧本, 然后用 stdin 手动发消息: "昵称: 内容"
 */

const PORT = Number(process.env.FAKE_PORT ?? 3001);
const GROUP_ID = Number(process.env.FAKE_GROUP ?? 123456);
const SELF_ID = Number(process.env.FAKE_SELF ?? 99999);
const AUTO_SCRIPT = process.env.AUTO_SCRIPT !== '0';
const INTERVAL = Number(process.env.FAKE_INTERVAL ?? 1400);

const C = {
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface ScriptMessage {
  userId: number;
  nickname: string;
  text: string;
  /** 是否 @ 机器人 */
  at?: boolean;
}

const SCRIPT: ScriptMessage[] = [
  { userId: 20001, nickname: '老陈', text: '今天有人试过那个新的推理框架吗' },
  { userId: 20002, nickname: '阿琳', text: '没有诶, 好用吗' },
  { userId: 20001, nickname: '老陈', text: '据说挺快的, 就是文档稀烂' },
  { userId: 10001, nickname: '测试用户', text: '这个报错怎么解决啊, 一直说 module not found' },
  { userId: 20001, nickname: '老陈', text: '小明你出来看看, 你用过这个' },
  { userId: 20002, nickname: '阿琳', text: '给我发张图看看' },
  { userId: 10001, nickname: '测试用户', text: '发张图', at: true },
];

let messageId = 10_000;
let connected: WebSocket | undefined;

const httpServer = createServer((_req, res) => {
  // 顺手提供个状态页, 万一想用 curl 看
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, role: 'fake-napcat', group: GROUP_ID, self: SELF_ID, clients: wss.clients.size }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  connected = ws;
  console.log(C.gray(`\n[fake-napcat] PASC 已连接 (${req.socket.remoteAddress})`));

  ws.on('message', (data) => {
    const raw = data.toString();
    let payload: { action?: string; params?: Record<string, unknown>; echo?: unknown };
    try {
      payload = JSON.parse(raw);
    } catch {
      console.log(C.gray(`[fake-napcat] 收到非 JSON: ${raw.slice(0, 120)}`));
      return;
    }
    handleAction(ws, payload);
  });

  ws.on('close', () => {
    connected = undefined;
    console.log(C.gray('[fake-napcat] PASC 断开连接'));
  });

  if (AUTO_SCRIPT) {
    setTimeout(() => void runScript(), 800);
  }
});

function handleAction(ws: WebSocket, payload: { action?: string; params?: Record<string, unknown>; echo?: unknown }): void {
  const { action, params = {}, echo } = payload;
  const reply = (data: unknown): void => {
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }));
  };

  switch (action) {
    case 'get_login_info':
      reply({ user_id: SELF_ID, nickname: '小明' });
      break;

    case 'send_group_msg':
    case 'send_private_msg': {
      messageId += 1;
      const segments = (params.message ?? []) as Array<{ type: string; data: Record<string, unknown> }>;
      const rendered = segments.map(renderSegment).join('');
      const target = params.group_id ? `群${params.group_id}` : `私聊${params.user_id}`;
      console.log(C.green(`[QQ ← PASC] ${C.bold(target)}  ${rendered}`));
      reply({ message_id: messageId });
      break;
    }

    case 'upload_group_file':
      console.log(C.yellow(`[QQ ← PASC] 发送文件 ${String(params.name ?? params.file)}`));
      reply({ file_id: 'fake-file-id' });
      break;

    case 'set_group_ban':
      console.log(C.yellow(`[QQ ← PASC] 禁言 ${String(params.user_id)} ${String(params.duration)}秒`));
      reply({});
      break;

    case 'set_group_kick':
      console.log(C.yellow(`[QQ ← PASC] 踢人 ${String(params.user_id)}`));
      reply({});
      break;

    case 'delete_msg':
      console.log(C.yellow(`[QQ ← PASC] 撤回 ${String(params.message_id)}`));
      reply({});
      break;

    case 'group_poke':
    case 'friend_poke':
      console.log(C.yellow(`[QQ ← PASC] 戳一戳 ${String(params.user_id ?? '')}`));
      reply({});
      break;

    default:
      console.log(C.gray(`[fake-napcat] 收到未模拟的 action: ${String(action)}`));
      reply({});
  }
}

function renderSegment(seg: { type: string; data: Record<string, unknown> }): string {
  if (seg.type === 'text') return String(seg.data.text ?? '');
  if (seg.type === 'image') return C.cyan('[图片]') + C.gray(`(${String(seg.data.file ?? '')})`);
  if (seg.type === 'at') return C.cyan(`@${String(seg.data.qq)}`);
  if (seg.type === 'reply') return '';
  return C.cyan(`[${seg.type}]`);
}

function sendMessage(msg: ScriptMessage): void {
  if (!connected || connected.readyState !== 1) {
    console.log(C.gray('[fake-napcat] 没有连接, 跳过这条消息'));
    return;
  }
  messageId += 1;
  const segments: Array<{ type: string; data: Record<string, unknown> }> = [];
  if (msg.at) {
    segments.push({ type: 'at', data: { qq: SELF_ID } });
    segments.push({ type: 'text', data: { text: ' ' } });
  }
  segments.push({ type: 'text', data: { text: msg.text } });

  const event = {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: GROUP_ID,
    user_id: msg.userId,
    self_id: SELF_ID,
    raw_message: msg.text,
    message: segments,
    sender: { user_id: msg.userId, nickname: msg.nickname },
    time: Math.floor(Date.now() / 1000),
  };
  console.log(C.gray(`[QQ → PASC] ${msg.nickname}(${msg.userId}): ${msg.at ? '@我 ' : ''}${msg.text}`));
  connected.send(JSON.stringify(event));
}

async function runScript(): Promise<void> {
  console.log(C.gray(`\n[fake-napcat] 开始走剧本 (${SCRIPT.length} 条消息, 间隔 ${INTERVAL}ms)\n`));
  for (const msg of SCRIPT) {
    sendMessage(msg);
    await sleep(INTERVAL);
  }
  console.log(C.gray('\n[fake-napcat] 剧本结束。继续在终端输入 "昵称: 内容" 可以手动发消息。\n'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(
    [
      '',
      C.bold('  fake-napcat 已启动'),
      `  监听        ws://127.0.0.1:${PORT}`,
      `  模拟群号    ${GROUP_ID}`,
      `  机器人 QQ   ${SELF_ID}`,
      `  自动剧本    ${AUTO_SCRIPT ? '开启' : '关闭'}`,
      C.gray('  手动发消息: 在终端输入  昵称: 内容'),
      '',
    ].join('\n'),
  );
});

// 手动注入
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  for (const line of chunk.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    const m = /^([^:：]{1,20})[:：]\s*(.+)$/.exec(text);
    if (m) sendMessage({ userId: 10002, nickname: m[1]!, text: m[2]! });
    else sendMessage({ userId: 10002, nickname: '手输用户', text });
  }
});
