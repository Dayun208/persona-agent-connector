import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Logger } from '@pasc/core';
import type { OneBotEvent } from './parse.js';

export type NapCatStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

export interface WsTransportOptions {
  url: string;
  token?: string;
  logger: Logger;
  reconnect?: { enabled: boolean; minDelayMs: number; maxDelayMs: number };
  callTimeoutMs?: number;
}

/** 事件名 → 参数元组 */
export interface TransportEvents {
  open: [];
  close: [code: number, reason: string];
  error: [error: Error];
  event: [event: OneBotEvent];
  status: [status: NapCatStatus];
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  action: string;
}

/**
 * NapCat 正向 WebSocket 客户端。
 *
 * PASC 主动连到 NapCat 的 WS 端口: 收事件、发 action(靠 echo 关联请求与响应)。
 * 断线后按指数退避重连, 期间 send 会抛错, 由上层决定是重试还是走 HTTP 兜底。
 */
export class WsTransport extends EventEmitter<TransportEvents> {
  private ws: WebSocket | undefined;
  private pending = new Map<string, PendingCall>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private statusValue: NapCatStatus = 'idle';

  constructor(private readonly opts: WsTransportOptions) {
    super();
  }

  get status(): NapCatStatus {
    return this.statusValue;
  }

  get connected(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.rejectAll('连接已关闭');
    const ws = this.ws;
    this.ws = undefined;
    this.setStatus('closed');
    if (ws) {
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', () => resolve());
        ws.close();
        setTimeout(resolve, 1_000).unref?.();
      });
    }
  }

  /** 通过 WS 调用 OneBot action, 用 echo 等响应 */
  call(action: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`WebSocket 未连接, 无法执行 ${action}`));
    }
    const echo = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`调用 ${action} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer, action });
      ws.send(JSON.stringify({ action, params, echo }), (err) => {
        if (!err) return;
        const entry = this.pending.get(echo);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(echo);
          reject(err);
        }
      });
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');

    const url = this.buildUrl();
    this.opts.logger.info('正在连接 NapCat WebSocket', { url: redactToken(url), attempt: this.reconnectAttempt + 1 });

    const headers: Record<string, string> = {};
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { headers, handshakeTimeout: 10_000 });
    } catch (err) {
      this.handleError(err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.setStatus('connected');
      this.opts.logger.info('NapCat WebSocket 已连接');
      this.emit('open');
    });

    ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });

    ws.on('error', (err: Error) => {
      this.handleError(err);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const text = reason?.toString() ?? '';
      this.opts.logger.warn('NapCat WebSocket 断开', { code, reason: text });
      this.ws = undefined;
      this.rejectAll('连接已断开');
      this.setStatus('closed');
      this.emit('close', code, text);
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.opts.logger.debug('收到非 JSON 的 WS 消息', { raw: raw.slice(0, 200) });
      return;
    }
    const payload = json as { echo?: unknown; post_type?: string; status?: string; retcode?: number; data?: unknown;[k: string]: unknown };

    if (payload.echo !== undefined && payload.echo !== null) {
      const echo = String(payload.echo);
      const entry = this.pending.get(echo);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(echo);
        const retcode = typeof payload.retcode === 'number' ? payload.retcode : 0;
        if (retcode !== 0) {
          entry.reject(new Error(`${entry.action} 失败: retcode=${retcode} ${JSON.stringify(payload.data ?? '').slice(0, 200)}`));
        } else {
          entry.resolve(payload.data ?? payload);
        }
      }
      return;
    }

    this.emit('event', payload as OneBotEvent);
  }

  private scheduleReconnect(): void {
    const cfg = this.opts.reconnect;
    if (this.stopped || !cfg?.enabled) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempt += 1;
    const base = Math.min(cfg.maxDelayMs, cfg.minDelayMs * 2 ** (this.reconnectAttempt - 1));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.opts.logger.info(`${delay}ms 后重连 NapCat`, { attempt: this.reconnectAttempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private rejectAll(reason: string): void {
    for (const [echo, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${reason} (${entry.action})`));
      this.pending.delete(echo);
    }
  }

  private handleError(err: Error): void {
    this.opts.logger.error('NapCat WebSocket 错误', { error: err.message });
    this.emit('error', err);
  }

  private setStatus(status: NapCatStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.emit('status', status);
  }

  private buildUrl(): string {
    if (!this.opts.token) return this.opts.url;
    try {
      const u = new URL(this.opts.url);
      u.searchParams.set('access_token', this.opts.token);
      return u.toString();
    } catch {
      return this.opts.url;
    }
  }
}

function redactToken(url: string): string {
  return url.replace(/access_token=[^&]+/, 'access_token=***');
}
