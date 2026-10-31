import type { LlmConfig } from './config.js';
import type { Logger } from './logger.js';
import { extractJsonValue } from './json-utils.js';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmResult {
  text: string;
  usage?: LlmUsage;
  latencyMs: number;
  model: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface CompleteOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** 尽量让服务端返回 JSON (部分本地模型不支持该参数, 失败会自动重试一次去掉它) */
  json?: boolean;
}

/**
 * OpenAI 兼容的 chat/completions 客户端。
 * 本地 Ollama / LM Studio / vLLM / 云端 DeepSeek 等都可以直接接。
 */
export class ChatClient {
  constructor(
    private readonly cfg: LlmConfig,
    private readonly log?: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return this.cfg.baseURL.trim().length > 0 && this.cfg.model.trim().length > 0;
  }

  get modelName(): string {
    return this.cfg.model;
  }

  get endpoint(): string {
    return resolveEndpoint(this.cfg.baseURL);
  }

  async complete(messages: LlmMessage[], opts: CompleteOptions = {}): Promise<LlmResult> {
    const started = Date.now();
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      temperature: opts.temperature ?? this.cfg.temperature,
      max_tokens: opts.maxTokens ?? this.cfg.maxTokens,
      stream: false,
    };
    if (opts.json) body.response_format = { type: 'json_object' };
    if (shouldDisableThinking(this.cfg)) {
      body.enable_thinking = false;
      body.chat_template_kwargs = { enable_thinking: false };
    }

    let text: string;
    let usage: LlmUsage | undefined;
    try {
      ({ text, usage } = await this.request(body, opts.timeoutMs ?? this.cfg.timeoutMs));
    } catch (err) {
      // 有些兼容层不认 response_format / enable_thinking, 去掉这些可选参数重试一次
      const canRetry = err instanceof LlmError && (err.status === 400 || err.status === 422);
      const hasOptional = 'response_format' in body || 'enable_thinking' in body;
      if (canRetry && hasOptional) {
        delete body.response_format;
        delete body.enable_thinking;
        delete body.chat_template_kwargs;
        ({ text, usage } = await this.request(body, opts.timeoutMs ?? this.cfg.timeoutMs));
      } else {
        throw err;
      }
    }

    return { text, usage, latencyMs: Date.now() - started, model: this.cfg.model };
  }

  /** 调用并解析成 JSON; 解析失败抛 LlmError, 便于上层回退 */
  async completeJson(messages: LlmMessage[], opts: CompleteOptions = {}): Promise<{ value: unknown; result: LlmResult }> {
    const result = await this.complete(messages, { ...opts, json: opts.json ?? true });
    const value = extractJsonValue(result.text);
    if (value === undefined) {
      throw new LlmError(`模型返回内容不是可解析的 JSON: ${result.text.slice(0, 200)}`);
    }
    return { value, result };
  }

  private async request(
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ text: string; usage?: LlmUsage }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;

    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new LlmError(`请求模型失败 (${this.endpoint}): ${reason}`);
    }

    const raw = await res.text();
    if (!res.ok) {
      throw new LlmError(`模型返回 HTTP ${res.status}`, res.status, raw.slice(0, 500));
    }

    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      throw new LlmError('模型返回的不是 JSON 响应体', res.status, raw.slice(0, 500));
    }

    const data = json as {
      choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(stringifyPart).join('') : '';
    if (!text) {
      this.log?.warn('模型返回空内容', { endpoint: this.endpoint, body: raw.slice(0, 200) });
      return { text: '' };
    }

    const usage: LlmUsage | undefined = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined;
    return { text, usage };
  }
}

function stringifyPart(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text);
  return '';
}

/** 把用户填的各种 baseURL 形态归一化成 chat/completions 端点 */
export function resolveEndpoint(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}


/** 本机端点才自动关闭思考, 云端模型不认识的参数会 400 */
export function isLocalEndpoint(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

export function shouldDisableThinking(cfg: Pick<LlmConfig, 'enableThinking' | 'baseURL'>): boolean {
  if (cfg.enableThinking === 'on') return false;
  if (cfg.enableThinking === 'off') return true;
  return isLocalEndpoint(cfg.baseURL);
}
