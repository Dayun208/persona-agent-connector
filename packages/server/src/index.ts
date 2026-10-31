import { createServer } from 'node:http';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.js';
import { Runtime } from './runtime.js';

/**
 * 入口。
 *
 * PASC_HOME 决定数据目录(默认是仓库根目录), 数据放在 $PASC_HOME/data 下,
 * 日志放在 $PASC_HOME/logs 下 —— 这样升级代码不会动用户数据。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.PASC_HOME ? resolvePath(process.env.PASC_HOME) : resolvePath(HERE, '../../..');

async function main(): Promise<void> {
  const runtime = await Runtime.create(HOME);
  const router = createApi(runtime);

  router.setAuthGuard((req, url) => {
    const token = runtime.config.server.accessToken.trim();
    if (!token) return undefined;
    // 静态页面不鉴权(里面没有敏感数据), 接口与 webhook 都要
    const needsAuth = url.pathname.startsWith('/api') || url.pathname === '/napcat/event';
    if (!needsAuth) return undefined;

    const header = req.headers.authorization ?? '';
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const fromQuery = url.searchParams.get('token') ?? '';
    if (bearer === token || fromQuery === token) return undefined;
    return '需要 accessToken (Authorization: Bearer ... 或 ?token=...)';
  });

  const server = createServer((req, res) => {
    void router.handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
  });

  const { host, port } = runtime.config.server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  await runtime.start();

  const base = `http://${host}:${port}`;
  printBanner(base, runtime);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[pasc] 收到 ${signal}, 正在关闭...`);
    server.close();
    await runtime.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

function printBanner(base: string, runtime: Runtime): void {
  const cfg = runtime.config;
  const lines = [
    '',
    '  ██████╗  █████╗ ███████╗ ██████╗',
    '  ██╔══██╗██╔══██╗██╔════╝██╔════╝',
    '  ██████╔╝███████║███████╗██║     ',
    '  ██╔═══╝ ██╔══██║╚════██║██║     ',
    '  ██║     ██║  ██║███████║╚██████╗',
    '  ╚═╝     ╚═╝  ╚═╝╚══════╝ ╚═════╝',
    '',
    `  控制台      ${base}`,
    `  健康检查    ${base}/api/health`,
    `  NapCat      ${cfg.napcat.protocol} ${cfg.napcat.protocol === 'ws' ? cfg.napcat.address : cfg.napcat.httpAddress}`,
    `  Agent       ${runtime.agent.name}  (${cfg.openclaw.transport})`,
    `  判断模型    ${runtime.config.judgeModel.api.model || '未配置 → 启发式'}`,
    `  数据目录    ${runtime.paths.dataDir}`,
    '',
  ];
  console.log(lines.join('\n'));
}

main().catch((err: unknown) => {
  console.error('[pasc] 启动失败:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
