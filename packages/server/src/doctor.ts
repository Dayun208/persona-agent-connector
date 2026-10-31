import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig, openSqlite, probeModelEndpoints, readJsonFile, sqliteAvailable } from '@pasc/core';

/**
 * `pnpm doctor` —— 环境自检。
 *
 * 存在的理由: 这个项目要同时依赖 NapCat、OpenClaw、本地模型三件外部东西,
 * 任何一件没起来都会表现为"机器人不理人", 排查起来很痛苦。
 * 与其让人翻日志, 不如一条命令把所有链路点一次。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.PASC_HOME ? resolvePath(process.env.PASC_HOME) : resolvePath(HERE, '../../..');

type Status = 'ok' | 'warn' | 'fail';
interface Check {
  name: string;
  status: Status;
  detail: string;
  hint?: string;
}

const checks: Check[] = [];

function add(name: string, status: Status, detail: string, hint?: string): void {
  checks.push({ name, status, detail, ...(hint ? { hint } : {}) });
}

function icon(status: Status): string {
  return status === 'ok' ? '\x1b[32m✓\x1b[0m' : status === 'warn' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✗\x1b[0m';
}

async function main(): Promise<void> {
  console.log(`\n  PASC 环境自检 · ${HOME}\n`);

  // 1. Node 运行时
  const major = Number(process.version.slice(1).split('.')[0]);
  add(
    'Node 版本',
    major >= 22 ? 'ok' : 'fail',
    `${process.version} (${process.platform}/${process.arch})`,
    major >= 22 ? undefined : '需要 Node 22+, 因为用到了内置的 node:sqlite',
  );

  // 2. SQLite 能力
  const hasSqlite = sqliteAvailable();
  add('SQLite (node:sqlite)', hasSqlite ? 'ok' : 'fail', hasSqlite ? '可用' : '不可用', hasSqlite ? undefined : '升级 Node 到 22+, 或把 archive.driver 设成 jsonl');

  // 3. 数据目录
  const dataDir = join(HOME, 'data');
  add('数据目录', existsSync(dataDir) ? 'ok' : 'warn', dataDir, existsSync(dataDir) ? undefined : '首次启动会自动创建');

  // 4. 配置
  const configPath = join(dataDir, 'config.json');
  let config = normalizeConfig({});
  if (existsSync(configPath)) {
    try {
      const raw = await readJsonFile<unknown>(configPath, null);
      config = normalizeConfig(raw ?? {});
      add('配置文件', 'ok', `${configPath} (已加载)`);
    } catch (err) {
      add('配置文件', 'fail', `${configPath} 解析失败`, err instanceof Error ? err.message : String(err));
    }
  } else {
    add('配置文件', 'warn', '还没有 config.json', '启动一次 server 会自动生成');
  }

  // 5. 服务端口
  const { host, port } = config.server;
  const portFree = await isPortFree(port, host);
  if (portFree) {
    add('PASC 端口', 'ok', `${host}:${port} 可用`, '还没启动 server');
  } else {
    const alive = await isPascAlive(`http://${host}:${port}`);
    add(
      'PASC 端口',
      alive ? 'ok' : 'warn',
      alive ? `${host}:${port} 已被 PASC 占用(说明服务在跑)` : `${host}:${port} 被其它程序占用`,
      alive ? undefined : '换一个 server.port, 或先停掉占用的进程',
    );
  }

  // 6. NapCat
  if (config.napcat.protocol === 'ws') {
    const result = await probeWs(config.napcat.address, 2_000);
    add(
      'NapCat WebSocket',
      result.ok ? 'ok' : 'fail',
      result.ok ? `已连接 ${redact(config.napcat.address)}` : `${redact(config.napcat.address)} → ${result.error ?? '连不上'}`,
      result.ok ? undefined : '确认 NapCat 已登录, 且开启了 WebSocket 服务端; 地址/Token 是否一致',
    );
  } else {
    const result = await probeHttp(`${config.napcat.httpAddress}/get_login_info`);
    add(
      'NapCat HTTP API',
      result.ok ? 'ok' : 'fail',
      result.ok ? '可访问' : `${config.napcat.httpAddress} → ${result.error ?? '连不上'}`,
      result.ok ? undefined : '确认 NapCat 的 HTTP 服务已开启',
    );
  }

  // 7. 模型端点
  const endpoints = [
    config.judgeModel.api.baseURL,
    config.distill.api.baseURL,
    config.embedding.api.baseURL,
    'http://127.0.0.1:11434/v1',
    'http://127.0.0.1:1234/v1',
  ].filter((u) => u.trim().length > 0);

  const probed = await probeModelEndpoints(endpoints, { timeoutMs: 1_200 });
  const usable = probed.filter((p) => p.ok && p.models.length > 0);
  if (usable.length > 0) {
    const summary = usable.map((u) => `${u.baseURL} (${u.models.length} 个模型)`).join('; ');
    add('模型端点', 'ok', summary);
    for (const u of usable) {
      console.log(`      · ${u.baseURL}: ${u.models.slice(0, 5).join(', ')}${u.models.length > 5 ? ' …' : ''}`);
    }
    if (!config.judgeModel.api.baseURL) {
      add('判断模型配置', 'warn', '还没填 judgeModel.api', `可以填 ${usable[0]!.baseURL} + ${usable[0]!.models[0]}, 或用控制台的"探测模型"`);
    } else {
      add('判断模型配置', 'ok', `${config.judgeModel.api.model || '(未填模型名)'} @ ${config.judgeModel.api.baseURL}`);
    }
  } else {
    add(
      '模型端点',
      'warn',
      '没有探测到可用模型',
      '启动 Ollama / LM Studio 后重试; 没有模型时判断会走启发式, 功能仍然可用',
    );
  }

  // 8. 存档
  const dbPath = config.archive.path || join(dataDir, 'pasc.db');
  if (existsSync(dbPath)) {
    try {
      const db = openSqlite(dbPath, { readonly: true });
      const row = db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number } | undefined;
      db.close();
      const mb = (statSync(dbPath).size / 1024 / 1024).toFixed(1);
      add('聊天记录库', 'ok', `${row?.c ?? 0} 条消息 · ${mb} MB · ${dbPath}`);
    } catch (err) {
      add('聊天记录库', 'warn', `打开失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    add('聊天记录库', 'warn', '还没有 pasc.db', '导入 QCE 或收到第一条消息后自动创建');
  }

  // 9. 人格同步文件
  if (config.openclaw.personaFile) {
    const file = config.openclaw.personaFile;
    add(
      '人格 markdown',
      existsSync(file) ? 'ok' : 'warn',
      existsSync(file) ? `已存在 ${file}` : `还没生成 ${file}`,
      existsSync(file) ? undefined : '在控制台点"导出到 OpenClaw", 或保存一次人格',
    );
  } else {
    add('人格 markdown', 'warn', '未配置 openclaw.personaFile', '如需让 OpenClaw 自己注入人格, 建议配置一个路径');
  }

  // 汇总
  console.log('');
  for (const c of checks) {
    console.log(`  ${icon(c.status)} ${c.name.padEnd(18, ' ')} ${c.detail}`);
    if (c.hint) console.log(`    \x1b[90m→ ${c.hint}\x1b[0m`);
  }

  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  console.log(
    `\n  ${fails === 0 ? '\x1b[32m核心链路正常\x1b[0m' : `\x1b[31m${fails} 项失败\x1b[0m`}` +
      (warns ? `, ${warns} 项提醒` : '') +
      '\n',
  );

  process.exit(fails > 0 ? 1 : 0);
}

function redact(url: string): string {
  return url.replace(/access_token=[^&]+/, 'access_token=***');
}

function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function isPascAlive(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1_000) });
    if (!res.ok) return false;
    const json = (await res.json()) as { version?: string; napcat?: unknown };
    return Boolean(json.version && json.napcat);
  } catch {
    return false;
  }
}

/**
 * 只做一次 WebSocket 握手, 不引 ws 依赖 —— 自检工具不该拖一个新的运行时依赖进来。
 * 收到 101 就说明 NapCat 的 WS 服务在监听且接受了升级请求。
 */
function probeWs(url: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, error?: string): void => {
      if (settled) return;
      settled = true;
      resolve({ ok, ...(error ? { error } : {}) });
    };

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      finish(false, '地址格式不对');
      return;
    }

    const req = request({
      hostname: target.hostname,
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
      },
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(false, '连接超时');
    });
    req.on('upgrade', () => {
      req.destroy();
      finish(true);
    });
    req.on('response', (res) => {
      req.destroy();
      finish(false, `握手被拒 (HTTP ${res.statusCode})`);
    });
    req.on('error', (err: Error) => finish(false, err.message));
    req.end();
  });
}

async function probeHttp(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return { ok: res.ok, ...(res.ok ? {} : { error: `HTTP ${res.status}` }) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

main().catch((err: unknown) => {
  console.error('[doctor] 自检失败:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
