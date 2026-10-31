import type { Logger } from '@pasc/core';

export interface HttpTransportOptions {
  baseURL: string;
  token?: string;
  logger: Logger;
  timeoutMs?: number;
}

/**
 * NapCat HTTP API 客户端。
 *
 * 用途一: protocol=http 时作为唯一的指令通道(事件走 NapCat 的 HTTP POST 上报到此服务)。
 * 用途二: protocol=ws 时作为 WS 调用失败后的兜底。
 */
export class HttpTransport {
  constructor(private readonly opts: HttpTransportOptions) {}

  get configured(): boolean {
    return this.opts.baseURL.trim().length > 0;
  }

  /** 调 OneBot action: POST {base}/{action} */
  async call(action: string, params: Record<string, unknown>, timeoutMs = this.opts.timeoutMs ?? 15_000): Promise<unknown> {
    if (!this.configured) throw new Error('未配置 NapCat HTTP 地址');

    const url = `${this.opts.baseURL.replace(/\/+$/, '')}/${action}`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`NapCat HTTP 请求失败 (${action}): ${err instanceof Error ? err.message : String(err)}`);
    }

    const raw = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`NapCat HTTP 返回非 JSON (${action}): ${raw.slice(0, 200)}`);
    }

    const body = json as { status?: string; retcode?: number; data?: unknown; message?: string };
    const retcode = typeof body.retcode === 'number' ? body.retcode : 0;
    if (!res.ok || retcode !== 0) {
      throw new Error(`NapCat HTTP ${action} 失败: retcode=${retcode} ${body.message ?? ''}`.trim());
    }
    return body.data ?? body;
  }

  async ping(): Promise<boolean> {
    try {
      await this.call('get_login_info', {}, 3_000);
      return true;
    } catch {
      return false;
    }
  }
}
