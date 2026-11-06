import { readFile } from 'node:fs/promises';
const container = '/app/.config/QQ/nt_qq_5ecb2484649796af87d51e62a3c40343/nt_data/Pic/2026-11/Ori/0e43eb696c34de43b2c6ec05acedc2ac.png';
const host = container.replace('/app/.config/QQ', '/Users/dayun/pasc-docker/napcat/qq');
try {
  const buf = await readFile(host);
  console.log('  读取成功:', buf.byteLength, '字节');
  const b64 = buf.toString('base64');
  console.log('  base64 长度:', b64.length);
} catch (e) {
  console.log('  读取失败:', (e as Error).message);
}
