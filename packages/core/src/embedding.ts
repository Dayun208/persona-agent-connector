/**
 * Embedding 客户端 —— 与判断/提取模型一样走 OpenAI 兼容的 /embeddings。
 *
 * 参考 LivingMemory 的做法: Embedding 不是必需品, 没配就退回关键词召回,
 * 配了就自动升级为"关键词 + 向量"双路召回。
 */

export interface EmbeddingApiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  dimensions?: number;
  timeoutMs: number;
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export class EmbeddingClient {
  constructor(
    private readonly cfg: EmbeddingApiConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return this.cfg.baseURL.trim().length > 0 && this.cfg.model.trim().length > 0;
  }

  get modelName(): string {
    return this.cfg.model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.configured) throw new EmbeddingError('未配置 Embedding 模型');
    if (texts.length === 0) return [];

    const url = resolveEmbeddingEndpoint(this.cfg.baseURL);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;

    const body: Record<string, unknown> = { model: this.cfg.model, input: texts };
    if (this.cfg.dimensions) body.dimensions = this.cfg.dimensions;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      throw new EmbeddingError(`请求 Embedding 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    const raw = await res.text();
    if (!res.ok) throw new EmbeddingError(`Embedding 返回 HTTP ${res.status}: ${raw.slice(0, 200)}`, res.status);

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new EmbeddingError('Embedding 返回的不是 JSON', res.status);
    }

    const data = (json as { data?: Array<{ embedding?: number[]; index?: number }> }).data;
    if (!Array.isArray(data)) throw new EmbeddingError('Embedding 响应缺少 data 字段');

    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((item) => (Array.isArray(item.embedding) ? item.embedding : []));
  }

  /** 单条嵌入; 失败返回 undefined, 让调用方优雅降级 */
  async embedQuiet(text: string): Promise<number[] | undefined> {
    try {
      const [vec] = await this.embed([text]);
      return vec && vec.length > 0 ? vec : undefined;
    } catch {
      return undefined;
    }
  }
}

export function resolveEmbeddingEndpoint(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/embeddings$/i.test(base)) return base;
  if (/\/v\d+$/i.test(base)) return `${base}/embeddings`;
  return `${base}/v1/embeddings`;
}

/** 余弦相似度; 任一为零向量时返回 0 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function l2Normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}
