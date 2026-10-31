#!/usr/bin/env node
/**
 * 直接对 NapCat（生产实例）调 OneBot 接口的小工具。
 *
 * 场景：机器人被封 / 发不出消息，需要后台解封，这时候走不通模型和 PASC，
 *      直接对 NapCat 的 WS 发指令最快。
 *
 * 用法：
 *   NAPCAT_WS=ws://127.0.0.1:3001 NAPCAT_TOKEN=xxx \
 *     node scripts/napcat-api.mjs get_login_info '{}'
 *
 *   node scripts/napcat-api.mjs set_group_ban '{"group_id":123,"user_id":456,"duration":0}'
 *
 * 依赖：Node 22+ 自带 WebSocket，无需安装任何包。
 */
const WS_URL = process.env.NAPCAT_WS || 'ws://127.0.0.1:3001';
const TOKEN = process.env.NAPCAT_TOKEN || '';

const [action, paramsJson] = process.argv.slice(2);
if (!action) {
  console.error('用法: node scripts/napcat-api.mjs <action> [json参数]');
  process.exit(1);
}

const url = TOKEN ? `${WS_URL}/?access_token=${encodeURIComponent(TOKEN)}` : WS_URL;
const ws = new WebSocket(url);
const echo = 'cli-' + Date.now();

ws.onopen = () => {
  ws.send(JSON.stringify({ action, params: JSON.parse(paramsJson || '{}'), echo }));
};
ws.onmessage = (ev) => {
  const d = JSON.parse(String(ev.data));
  if (d.echo !== echo) return;
  console.log(JSON.stringify(d, null, 2));
  ws.close();
  process.exit(d.status === 'ok' ? 0 : 1);
};
ws.onerror = () => {
  console.error('连接失败：' + url);
  process.exit(1);
};
setTimeout(() => { console.error('超时'); process.exit(1); }, 15000).unref();
