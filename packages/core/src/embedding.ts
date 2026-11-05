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

/**
 * 向量质量自检。
 *
 * 有些本地推理框架（比如 oMLX）的 /embeddings 接口看着能通，
 * 但对中文单字会返回完全相同的向量（"猫"/"狗"/"鱼" 相似度 1.0000），
 * 整批文本都挤在一个窄锥里（两两相似度均值 0.69、标准差 0.07）。
 * 这种向量拿去做召回是有害的——它会把所有记忆拉平成同一个分数。
 *
 * 判定规则：
 *   1. 任意两组不同文本的相似度 ≥ 0.999 → 退化（等于没区分）
 *   2. 两两相似度的标准差 < 0.02      → 退化（区分度过窄）
 */
export interface EmbeddingQuality {
  ok: boolean;
  reason?: string;
  /** 两两相似度均值 */
  meanSimilarity: number;
  /** 两两相似度标准差 */
  stdSimilarity: number;
  /** 最高的一对 */
  worstPair: [string, string, number] | null;
}

export async function checkEmbeddingQuality(
  client: EmbeddingClient,
  probes: string[] = ['猫', '狗', '量子力学', '今天想吃点好的', 'PASC 是 QQ 机器人中间件'],
): Promise<EmbeddingQuality> {
  const empty: EmbeddingQuality = { ok: false, reason: '未配置', meanSimilarity: 0, stdSimilarity: 0, worstPair: null };
  if (!client.configured) return empty;

  let vectors: number[][];
  try {
    vectors = await client.embed(probes);
  } catch (err) {
    return { ...empty, reason: `调用失败: ${err instanceof Error ? err.message : String(err)}` };
  }
  const valid = vectors.filter((v) => v.length > 0);
  if (valid.length < 3) return { ...empty, reason: `只拿到 ${valid.length} 条向量` };

  const sims: number[] = [];
  let worst: [string, string, number] | null = null;
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      const s = cosineSimilarity(valid[i]!, valid[j]!);
      sims.push(s);
      if (!worst || s > worst[2]) worst = [probes[i] ?? `#${i}`, probes[j] ?? `#${j}`, s];
    }
  }
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
  const std = Math.sqrt(sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length);

  if (worst && worst[2] >= 0.999) {
    return { ok: false, reason: `不同文本的向量几乎相同（「${worst[0]}」与「${worst[1]}」相似度 ${worst[2].toFixed(4)}）`, meanSimilarity: mean, stdSimilarity: std, worstPair: worst };
  }
  if (std < 0.02) {
    return { ok: false, reason: `区分度过窄（两两相似度标准差 ${std.toFixed(4)}）`, meanSimilarity: mean, stdSimilarity: std, worstPair: worst };
  }
  return { ok: true, meanSimilarity: mean, stdSimilarity: std, worstPair: worst };
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
