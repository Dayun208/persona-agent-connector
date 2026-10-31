import type { AgentConfig, Logger } from '@pasc/core';
import { parseAgentOutput } from '@pasc/core';
import type { AgentHealth, AgentRequest, AgentResponse, AgentTransport } from './transport.js';

/**
 * HTTP 传输。
 *
 * 两种请求体形态:
 *   - pasc    : { system, user, meta }  ← 给自建/轻量 Agent 服务
 *   - openai  : { model, messages: [...] } ← 直接把 OpenClaw 或任意模型当 chat 端点
 *
 * 响应也做归一化: 支持 {text} / {message,execution} / OpenAI choices / 纯文本。
 */
export class HttpAgentTransport implements AgentTransport {
  readonly name = 'http';

  constructor(
    private readonly cfg: AgentConfig,
    private readonly logger: Logger,
  ) {}

  async health(): Promise<AgentHealth> {
    try {
      const res = await fetch(this.cfg.address, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3_000),
      });
      return { ok: res.ok || res.status === 405, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async send(req: AgentRequest): Promise<AgentResponse> {
    const started = Date.now();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.token) headers.authorization = `Bearer ${this.cfg.token}`;

    const body =
      this.cfg.httpPayload === 'openai'
        ? {
            model: 'pasc-agent',
            messages: [
              { role: 'system', content: req.system },
              { role: 'user', content: req.user },
            ],
            temperature: 0.8,
            stream: false,
          }
        : { system: req.system, user: req.user, meta: req.meta };

    let res: Response;
    try {
      res = await fetch(this.cfg.address, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      throw new Error(`请求 Agent 失败 (${this.cfg.address}): ${err instanceof Error ? err.message : String(err)}`);
    }

    const raw = await res.text();
    if (!res.ok) throw new Error(`Agent 返回 HTTP ${res.status}: ${raw.slice(0, 300)}`);

    const text = normalizeResponse(raw);
    this.logger.debug('Agent 原始返回', { preview: text.slice(0, 200) });
    return { text, latencyMs: Date.now() - started, transport: this.name };
  }
}

/** 把各种可能的响应形态压成一段"可能含 JSON 的文本" */
export function normalizeResponse(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return trimmed; // 纯文本, 交给解析器兜底
  }

  if (typeof json === 'string') return json;
  if (!json || typeof json !== 'object') return trimmed;

  const obj = json as Record<string, unknown>;

  // { text: "..." }
  if (typeof obj.text === 'string') return obj.text;
  // { reply: "..." }
  if (typeof obj.reply === 'string') return obj.reply;
  // { message, execution } —— 已经是协议格式, 原样交回去
  if (typeof obj.message === 'string' || obj.execution !== undefined || obj.messages !== undefined) {
    return JSON.stringify(obj);
  }
  // OpenAI 兼容
  const choices = obj.choices;
  if (Array.isArray(choices)) {
    const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (typeof content === 'string') return content;
  }
  // { data: { text } }
  const data = obj.data as { text?: unknown } | undefined;
  if (data && typeof data.text === 'string') return data.text;

  return trimmed;
}

/** 给控制台"测试连接"用: 不经过消息池, 直接发一个最小请求 */
export async function probeAgent(transport: AgentTransport): Promise<{ ok: boolean; detail: string; sample?: string }> {
  try {
    const res = await transport.send({
      system: '你是连通性测试助手, 只输出 JSON: {"message":"pong"}',
      user: 'ping',
      meta: { sceneKey: 'test', sceneLabel: '测试', triggerId: '0', reason: 'manual' },
    });
    const parsed = parseAgentOutput(res.text);
    return {
      ok: true,
      detail: `${res.transport} 可用, 延迟 ${res.latencyMs}ms`,
      sample: parsed.messages.join(' / ') || '(空回复)',
    };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
