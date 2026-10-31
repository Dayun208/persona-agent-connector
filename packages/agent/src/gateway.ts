import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { AgentConfig, Logger } from '@pasc/core';
import type { AgentHealth, AgentRequest, AgentResponse, AgentTransport } from './transport.js';

/**
 * OpenClaw Gateway 传输 —— 按真实协议实现(实测 OpenClaw 2026.6.8 / protocol 4)。
 *
 * 协议要点(完整记录见 docs/openclaw-integration.md):
 *   1. 建连后 Gateway 先发 `connect.challenge`;
 *   2. 客户端首发必须是 `connect` 请求, 带 client.id / client.mode / role / scopes / auth.token;
 *   3. `hello-ok` 返回 protocol、server、features.methods、policy;
 *   4. 发消息用 `chat.send`(非阻塞, 立即 ack `{runId, status:"started"}`),
 *      回答通过 `chat` 事件流式返回: state=delta 带 deltaText, state=final 带 message。
 *
 * 最初版本是按"猜的信封"写的, 现在已经全部换成实测字段。
 */

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

interface PendingRun {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface GatewayFrame {
  type?: string;
  id?: string;
  ok?: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
  event?: string;
}

interface ChatEventPayload {
  runId?: string;
  sessionKey?: string;
  state?: string;
  deltaText?: string;
  message?: unknown;
}

const PROTOCOL_MIN = 3;
const PROTOCOL_MAX = 4;
/** OpenClaw 对 client.id / client.mode 做枚举校验, 第三方桥接用这两个值 */
const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';

export class GatewayAgentTransport implements AgentTransport {
  readonly name = 'openclaw-gateway';

  private ws: WebSocket | undefined;
  private connecting: Promise<void> | undefined;
  private connected = false;
  private closedByUs = false;

  private readonly pending = new Map<string, PendingRequest>();
  /** runId → 等待者 */
  private readonly runs = new Map<string, PendingRun>();
  /** 早于 ack 到达的 chat 事件, 按 runId 暂存 */
  private readonly earlyEvents = new Map<string, ChatEventPayload[]>();
  /** runId → 已累积的增量文本(部分实现 final 不带 message 时兜底) */
  private readonly deltas = new Map<string, string>();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly logger: Logger,
  ) {}

  get url(): string {
    return this.cfg.address || 'ws://127.0.0.1:18789';
  }

  async health(): Promise<AgentHealth> {
    try {
      await this.ensureConnected();
      const result = (await this.request('health', {}, 5_000)) as { status?: string } | undefined;
      return { ok: true, detail: `gateway 已连接 (${this.url})${result?.status ? ` · ${result.status}` : ''}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async send(req: AgentRequest): Promise<AgentResponse> {
    const started = Date.now();
    await this.ensureConnected();

    const sessionKey = this.sessionKeyFor(req);
    const message = this.composeMessage(req);
    const agentId = req.meta.agentId || this.cfg.agentId || undefined;
    const timeoutMs = Math.max(this.cfg.timeoutMs, 15_000);

    const ack = (await this.request(
      'chat.send',
      {
        sessionKey,
        message,
        idempotencyKey: randomUUID(),
        // 不要投递到 OpenClaw 自己的渠道, PASC 负责把回复送回 QQ
        deliver: false,
        timeoutMs,
        ...(agentId ? { agentId } : {}),
      },
      timeoutMs,
    )) as { runId?: string; status?: string } | undefined;

    const runId = ack?.runId;
    if (!runId) throw new Error('chat.send 没有返回 runId');

    const text = await this.waitForRun(runId, timeoutMs);
    return { text, latencyMs: Date.now() - started, transport: this.name };
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.rejectAll('连接已关闭');
    const ws = this.ws;
    this.ws = undefined;
    this.connected = false;
    if (ws) {
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', () => resolve());
        ws.close();
        setTimeout(resolve, 1_000).unref?.();
      });
    }
  }

  /**
   * 同一会话复用同一个 OpenClaw session, 保证上下文连续。
   * OpenClaw 的约定: 指定 agentId 时, sessionKey 必须写成 `agent:<id>:<key>`,
   * 否则会报 `agentId does not match session key`(实测)。
   */
  private sessionKeyFor(req: AgentRequest): string {
    const prefix = this.cfg.sessionPrefix || 'pasc';
    // 人格 id 进 sessionKey：切换人格 = 换一个全新会话，
    // 否则模型会沿用旧会话里"我叫小明"之类的历史，人格切了也白切。
    const personaTag = req.meta.personaId ? `:p${req.meta.personaId.replace(/-/g, '').slice(0, 8)}` : '';
    const base = `${prefix}:${req.meta.sceneKey}${personaTag}`;
    const agentId = req.meta.agentId || this.cfg.agentId || '';
    return agentId ? `agent:${agentId}:${base}` : base;
  }

  /**
   * OpenClaw 的 chat.send 只接受一条 message, 两种拼法:
   *   inline  — system 与 user 合成一条(默认, 保留 PASC 对 Prompt 的完全控制)
   *   message — 只发 user, 人设交给 OpenClaw 自己的 markdown / agent 配置
   */
  private composeMessage(req: AgentRequest): string {
    if (this.cfg.systemMode === 'message') return req.user;
    const system = req.system.trim();
    return system ? `${system}\n\n---\n\n${req.user}` : req.user;
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.connected) return;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    this.closedByUs = false;
    const url = this.url;
    this.logger.info('连接 OpenClaw Gateway', { url });

    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`连接 ${url} 超时`)), 12_000);

      ws.on('open', () => {
        void this.handshake().then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });

      ws.on('message', (data) => this.onFrame(data.toString()));

      ws.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });

      ws.on('close', (code: number) => {
        this.connected = false;
        this.ws = undefined;
        this.rejectAll(`Gateway 连接断开 (code=${code})`);
        if (!this.closedByUs) this.logger.warn('OpenClaw Gateway 连接断开', { code });
      });
    });
  }

  private async handshake(): Promise<void> {
    const payload = (await this.request(
      'connect',
      {
        minProtocol: PROTOCOL_MIN,
        maxProtocol: PROTOCOL_MAX,
        client: {
          id: CLIENT_ID,
          version: '0.1.0',
          platform: process.platform,
          mode: CLIENT_MODE,
          displayName: 'PASC',
        },
        role: 'operator',
        scopes: ['operator.read', 'operator.write'],
        auth: this.cfg.token ? { token: this.cfg.token } : {},
        locale: 'zh-CN',
        userAgent: 'pasc/0.1.0',
      },
      12_000,
    )) as { protocol?: number; server?: { version?: string }; auth?: { role?: string; scopes?: string[] } };

    this.connected = true;
    this.logger.info('OpenClaw Gateway 已连接', {
      protocol: payload.protocol,
      server: payload.server?.version,
      role: payload.auth?.role,
      scopes: payload.auth?.scopes,
    });
  }

  private onFrame(raw: string): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      return;
    }

    if (frame.type === 'res' && frame.id) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        const code = frame.error?.code ?? '';
        const message = frame.error?.message ?? '';
        pending.reject(new Error(`${pending.method} 失败: ${code} ${message}`.trim()));
      }
      return;
    }

    if (frame.type === 'event' && frame.event === 'chat') {
      this.onChatEvent(frame.payload as ChatEventPayload);
    }
  }

  private onChatEvent(payload: ChatEventPayload): void {
    const runId = payload.runId;
    if (!runId) return;

    const waiter = this.runs.get(runId);
    if (!waiter) {
      // ack 还没回来, 先把事件缓存起来
      const bucket = this.earlyEvents.get(runId) ?? [];
      bucket.push(payload);
      if (bucket.length > 500) bucket.shift();
      this.earlyEvents.set(runId, bucket);
      // ack 一直没回来时这些缓冲不会被消费，限制总量避免长期运行后无限增长
      if (this.earlyEvents.size > 200) {
        const oldest = this.earlyEvents.keys().next().value;
        if (oldest !== undefined && oldest !== runId) this.earlyEvents.delete(oldest);
      }
      return;
    }

    if (payload.state === 'delta') {
      this.deltas.set(runId, (this.deltas.get(runId) ?? '') + (payload.deltaText ?? ''));
      return;
    }

    if (payload.state === 'final') {
      clearTimeout(waiter.timer);
      this.runs.delete(runId);
      const assembled = this.deltas.get(runId) ?? '';
      this.deltas.delete(runId);
      this.earlyEvents.delete(runId);
      waiter.resolve(extractAssistantText(payload.message) || assembled);
    }
  }

  private waitForRun(runId: string, timeoutMs: number): Promise<string> {
    // ack 之前可能已经收到 delta / final, 先回放
    const early = this.earlyEvents.get(runId);
    if (early && early.length > 0) {
      this.earlyEvents.delete(runId);
      for (const event of early) {
        if (event.state === 'delta') this.deltas.set(runId, (this.deltas.get(runId) ?? '') + (event.deltaText ?? ''));
        if (event.state === 'final') {
          const text = extractAssistantText(event.message) || (this.deltas.get(runId) ?? '');
          this.deltas.delete(runId);
          return Promise.resolve(text);
        }
      }
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.runs.delete(runId);
        this.deltas.delete(runId);
        reject(new Error(`等待 Agent 回复超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      this.runs.set(runId, { resolve, reject, timer });
    });
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Gateway 未连接'));
    }
    const id = `pasc-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway 请求 ${method} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ type: 'req', id, method, params }), (err) => {
        if (!err) return;
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private rejectAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`${reason} (${entry.method})`));
      this.pending.delete(id);
    }
    for (const [runId, run] of this.runs) {
      clearTimeout(run.timer);
      run.reject(new Error(reason));
      this.runs.delete(runId);
    }
  }
}

/** 从 final 事件里把助手文本抠出来: content 可能是数组或字符串 */
export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const obj = message as { content?: unknown; text?: unknown; message?: unknown };

  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.message === 'string') return obj.message;

  const content = obj.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text ?? '');
        return '';
      })
      .join('');
  }
  return '';
}
