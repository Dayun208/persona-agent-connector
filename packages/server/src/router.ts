import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ApiContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  url: URL;
}

export type ApiResult =
  | { status?: number; json: unknown }
  | { status?: number; text: string; contentType?: string; headers?: Record<string, string> }
  /** 自己接管响应(SSE / 静态文件) */
  | { handled: true };

export type ApiHandler = (ctx: ApiContext) => Promise<ApiResult> | ApiResult;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: ApiHandler;
}

/**
 * 极简路由器。不引框架是刻意的: 中间件的 HTTP 面很小,
 * 少一层依赖就少一处升级负担, 也方便日后嵌入到 NapCat 插件里。
 */
export class Router {
  private readonly routes: Route[] = [];
  private fallback: ((ctx: ApiContext) => Promise<boolean>) | undefined;
  private authGuard: ((req: IncomingMessage, url: URL) => string | undefined) | undefined;

  get(path: string, handler: ApiHandler): this {
    return this.add('GET', path, handler);
  }
  post(path: string, handler: ApiHandler): this {
    return this.add('POST', path, handler);
  }
  put(path: string, handler: ApiHandler): this {
    return this.add('PUT', path, handler);
  }
  patch(path: string, handler: ApiHandler): this {
    return this.add('PATCH', path, handler);
  }
  delete(path: string, handler: ApiHandler): this {
    return this.add('DELETE', path, handler);
  }

  /** 未匹配时的兜底(静态文件) */
  setFallback(fn: (ctx: ApiContext) => Promise<boolean>): void {
    this.fallback = fn;
  }

  /** 鉴权钩子: 返回错误字符串表示拒绝 */
  setAuthGuard(fn: (req: IncomingMessage, url: URL) => string | undefined): void {
    this.authGuard = fn;
  }

  private add(method: string, path: string, handler: ApiHandler): this {
    const keys: string[] = [];
    const pattern = path
      .split('/')
      .map((part) => {
        if (part.startsWith(':')) {
          keys.push(part.slice(1));
          return '([^/]+)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, regex: new RegExp(`^${pattern}/?$`), keys, handler });
    return this;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = (req.method ?? 'GET').toUpperCase();

    if (this.authGuard) {
      const denial = this.authGuard(req, url);
      if (denial) {
        sendJson(res, 401, { error: denial });
        return;
      }
    }

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1] ?? '');
      });

      let body: unknown;
      if (method !== 'GET' && method !== 'HEAD') {
        body = await readJsonBody(req).catch((err: Error) => {
          sendJson(res, 400, { error: err.message });
          throw err;
        });
      }

      const ctx: ApiContext = { req, res, params, query: url.searchParams, body, url };
      try {
        const result = await route.handler(ctx);
        applyResult(res, result);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return;
    }

    if (this.fallback && (await this.fallback({ req, res, params: {}, query: url.searchParams, body: undefined, url }))) {
      return;
    }
    sendJson(res, 404, { error: `未找到路由: ${method} ${url.pathname}` });
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function applyResult(res: ServerResponse, result: ApiResult | undefined): void {
  if (!result) return;
  if ('handled' in result) return;
  if ('json' in result) {
    sendJson(res, result.status ?? 200, result.json);
    return;
  }
  res.writeHead(result.status ?? 200, {
    'content-type': result.contentType ?? 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...(result.headers ?? {}),
  });
  res.end(result.text);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return undefined;

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 5 * 1024 * 1024) throw new Error('请求体过大 (上限 5MB)');
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}
