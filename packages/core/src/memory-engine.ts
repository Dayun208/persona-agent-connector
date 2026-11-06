import { randomUUID } from 'node:crypto';
import type { MemoryConfig } from './config.js';
import type { EmbeddingClient } from './embedding.js';
import { cosineSimilarity } from './embedding.js';
import type { Logger } from './logger.js';
import type { MemoryHit } from './memory.js';
import { appendJsonl, readJsonl, rewriteJsonl } from './store.js';
import { similarity } from './text.js';

/**
 * 持久记忆引擎。
 *
 * 设计参考 astrbot_plugin_livingmemory, 但按 PASC 的定位做了裁剪:
 *   - 类型化记忆(fact/preference/relationship/plan/event) + 按类型的 TTL
 *   - 重要性(importance) 由抽取时给定, 决定它能活多久
 *   - 新鲜度按指数衰减, 被访问过的记忆衰减更慢(访问抵抗), 且有分数加成
 *   - 召回 = 关键词 + 向量双路, 支持分数级融合(weighted)与排名级融合(rrf)
 *   - 旧记忆不是删除而是归档, 可以恢复
 *
 * 没有 Embedding 时自动退化为纯关键词召回, 功能不缺失, 只是召回质量下降。
 */

export type MemoryType = 'fact' | 'preference' | 'relationship' | 'plan' | 'event' | 'episode' | 'unknown';
export type MemoryStatus = 'active' | 'archived' | 'forgotten' | 'merged';

export const MEMORY_TYPES: MemoryType[] = ['fact', 'preference', 'relationship', 'plan', 'event', 'episode', 'unknown'];

export interface MemoryRecord {
  id: string;
  text: string;
  type: MemoryType;
  /** 0~1, 越大越重要、活得越久 */
  importance: number;
  tags: string[];
  /** 相关的人(QQ 号) */
  subjects: string[];
  sceneKey?: string;
  personaId?: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
  /** 到期时间; 到期后归档 */
  expiresAt: number;
  status: MemoryStatus;
  /** 来源消息 id, 便于追溯 */
  sourceIds: string[];
  embedding?: number[];
  /** 向量由哪个模型算出；换了模型后旧向量不可比，需要重建 */
  embeddingModel?: string;
  /** 被哪条记忆合并掉了（status=merged 时有值），便于追溯 */
  mergedInto?: string;
}

export interface MemorySearchHit extends MemoryHit {
  type: MemoryType;
  importance: number;
  accessCount: number;
  lastAccessedAt: number;
  /** 关键词路得分 */
  keywordScore: number;
  /** 向量路得分(没有 embedding 时为 0) */
  vectorScore: number;
  /** 新鲜度 0~1 */
  freshness: number;
}

export interface AddMemoryInput {
  text: string;
  type?: MemoryType;
  importance?: number;
  tags?: string[];
  subjects?: string[];
  sceneKey?: string;
  personaId?: string;
  sourceIds?: string[];
  /** true 时跳过"相似记忆合并"，强制新建（反思合并要用） */
  skipMerge?: boolean;
}

export interface MemoryEngineDeps {
  getConfig: () => MemoryConfig;
  getEmbedder: () => EmbeddingClient | undefined;
  logger?: Logger;
  now?: () => number;
}

export interface MemoryStats {
  total: number;
  active: number;
  archived: number;
  forgotten: number;
  embedded: number;
  withEmbeddingModel: boolean;
  byType: Record<string, number>;
  avgImportance: number;
}

interface MemoryFileV2 {
  version: 2;
  items: MemoryRecord[];
}

export class MemoryEngine {
  private records: MemoryRecord[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private dirty = false;

  /** 懒回填节流：两次之间至少隔 60 秒 */
  private lastLazyBackfill = 0;

  private constructor(
    private readonly file: string,
    private readonly deps: MemoryEngineDeps,
  ) {}

  static async open(file: string, deps: MemoryEngineDeps): Promise<MemoryEngine> {
    const engine = new MemoryEngine(file, deps);
    const loaded = await readJsonl<MemoryRecord | { id?: string; text?: string; tags?: string[]; createdAt?: number }>(file);
    engine.records = loaded
      .map((item) => normalizeRecord(item, deps.getConfig()))
      .filter((r): r is MemoryRecord => r !== undefined);
    return engine;
  }

  get size(): number {
    return this.records.length;
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** 新增一条记忆; 与已有记忆高度相似时合并而不是重复插入 */
  async add(input: AddMemoryInput): Promise<{ record: MemoryRecord; merged: boolean }> {
    const cfg = this.deps.getConfig();
    const text = input.text.trim();
    if (!text) throw new Error('记忆内容不能为空');

    const type = input.type ?? 'unknown';
    const importance = clamp01(input.importance ?? 0.5);
    const now = this.now;

    // 1) 相似记忆合并(去重)
    let best: { record: MemoryRecord; score: number } | undefined;
    for (const record of input.skipMerge ? [] : this.records) {
      if (record.status !== 'active') continue;
      const score = similarity(text, record.text);
      if (score >= cfg.mergeThreshold && (!best || score > best.score)) best = { record, score };
    }

    if (best) {
      const target = best.record;
      target.importance = Math.max(target.importance, importance);
      target.accessCount += 1;
      target.lastAccessedAt = now;
      target.updatedAt = now;
      target.tags = unique([...target.tags, ...(input.tags ?? [])]);
      target.subjects = unique([...target.subjects, ...(input.subjects ?? [])]);
      target.sourceIds = unique([...target.sourceIds, ...(input.sourceIds ?? [])]);
      // 更长的表述通常信息更全, 保留它
      if (text.length > target.text.length) target.text = text;
      this.markDirty();
      return { record: target, merged: true };
    }

    // 2) 新建
    const record: MemoryRecord = {
      id: randomUUID(),
      text,
      type,
      importance,
      tags: unique(input.tags ?? []),
      subjects: unique(input.subjects ?? []),
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      expiresAt: now + ttlMs(type, cfg),
      status: 'active',
      sourceIds: unique(input.sourceIds ?? []),
      ...(input.sceneKey ? { sceneKey: input.sceneKey } : {}),
      ...(input.personaId ? { personaId: input.personaId } : {}),
    };

    const embedder = this.deps.getEmbedder();
    if (embedder?.configured && this.deps.getConfig().enabled) {
      const vec = await embedder.embedQuiet(text);
      if (vec) {
        record.embedding = vec;
        record.embeddingModel = embedder.modelName;
      }
    }

    this.records.push(record);
    await appendJsonl(this.file, record).catch(() => undefined);
    return { record, merged: false };
  }

  /**
   * 回填向量。
   *
   * 需要它的场景：
   *   - 记忆是在 Embedding 没配/离线的时候写进去的
   *   - 换了 embedding 模型（旧向量和新的不可比）
   *   - 从 JSONL 导入的历史数据
   *
   * @param opts.force 连已有的也重算
   * @param opts.limit 本次最多处理多少条（大库分批用）
   */
  /**
   * 反思合并：写入一条合并后的记忆，并把参与合并的原条目标记为 merged。
   * 原条目不会被删除 —— 保留 mergedInto 方便追溯"这句话是从哪来的"。
   */
  async consolidate(input: {
    text: string;
    type?: MemoryType;
    importance?: number;
    sourceIds: string[];
    tags?: string[];
    subjects?: string[];
  }): Promise<{ record: MemoryRecord; absorbed: number }> {
    const cfg = this.deps.getConfig();
    const sourceSet = new Set(input.sourceIds);

    // 已经有一条内容相近的活跃记忆（且不在本次来源里）→ 直接并进它，
    // 否则每反思一次就会多出一条近重复的记忆
    let target = this.records.find(
      (r) => r.status === 'active' && !sourceSet.has(r.id) && similarity(input.text, r.text) >= cfg.mergeThreshold,
    );

    if (target) {
      target.text = input.text.length > target.text.length ? input.text : target.text;
      target.importance = Math.max(target.importance, input.importance ?? 0.6);
      target.tags = unique([...target.tags, ...(input.tags ?? [])]);
      target.subjects = unique([...target.subjects, ...(input.subjects ?? [])]);
      target.updatedAt = this.now;
      target.lastAccessedAt = this.now;
    } else {
      const created = await this.add({
        text: input.text,
        ...(input.type ? { type: input.type } : {}),
        importance: input.importance ?? 0.6,
        tags: input.tags ?? [],
        subjects: input.subjects ?? [],
        // 强制新建：add() 的相似合并可能挑到本次来源里的某一条，
        // 那条接着又会被标记 merged，自相矛盾
        skipMerge: true,
      });
      target = created.record;
    }

    let absorbed = 0;
    for (const id of input.sourceIds) {
      if (id === target.id) continue;
      const source = this.records.find((r) => r.id === id);
      if (!source || source.status !== 'active') continue;
      source.status = 'merged';
      source.mergedInto = target.id;
      source.updatedAt = this.now;
      absorbed += 1;
    }

    // 合并出来的记录要带上来源，方便回溯
    target.sourceIds = unique([...target.sourceIds, ...input.sourceIds]);
    this.markDirty();
    return { record: target, absorbed };
  }

  /** 标记某条记忆过时（被新说法推翻） */
  supersede(id: string, reason?: string): boolean {
    const record = this.records.find((r) => r.id === id);
    if (!record || record.status !== 'active') return false;
    record.status = 'archived';
    record.updatedAt = this.now;
    if (reason) record.tags = unique([...record.tags, 'superseded']);
    this.markDirty();
    return true;
  }

  async backfill(
    opts: { force?: boolean; limit?: number; batchSize?: number } = {},
  ): Promise<{ scanned: number; updated: number; failed: number; remaining: number }> {
    const embedder = this.deps.getEmbedder();
    if (!embedder?.configured) return { scanned: 0, updated: 0, failed: 0, remaining: 0 };

    const model = embedder.modelName;
    const stale = this.records.filter((r) => {
      if (opts.force) return true;
      if (!r.embedding || r.embedding.length === 0) return true;
      return r.embeddingModel !== model;
    });
    const work = opts.limit ? stale.slice(0, opts.limit) : stale;
    const batchSize = Math.max(1, Math.min(64, opts.batchSize ?? 16));

    let updated = 0;
    let failed = 0;
    for (let i = 0; i < work.length; i += batchSize) {
      const chunk = work.slice(i, i + batchSize);
      try {
        const vectors = await embedder.embed(chunk.map((r) => r.text));
        chunk.forEach((record, idx) => {
          const vec = vectors[idx];
          if (vec && vec.length > 0) {
            record.embedding = vec;
            record.embeddingModel = model;
            updated += 1;
          } else {
            failed += 1;
          }
        });
        if (updated > 0) this.markDirty(200);
      } catch {
        failed += chunk.length;
      }
    }
    if (updated > 0) await this.flush();
    return { scanned: work.length, updated, failed, remaining: stale.length - work.length };
  }

  /** 向量覆盖率与陈旧向量数（给控制台看） */
  embeddingHealth(): { total: number; embedded: number; stale: number; model: string } {
    const model = this.deps.getEmbedder()?.modelName ?? '';
    let embedded = 0;
    let stale = 0;
    for (const r of this.records) {
      const has = Boolean(r.embedding && r.embedding.length > 0);
      if (has) embedded += 1;
      if (!has || (model && r.embeddingModel !== model)) stale += 1;
    }
    return { total: this.records.length, embedded, stale, model };
  }

  /** 批量写入抽取结果 */
  async ingest(
    candidates: AddMemoryInput[],
    ctx: { sceneKey?: string; personaId?: string; sourceIds?: string[] },
  ): Promise<{ added: number; merged: number; records: MemoryRecord[] }> {
    let added = 0;
    let merged = 0;
    const records: MemoryRecord[] = [];
    for (const candidate of candidates) {
      const result = await this.add({
        ...candidate,
        ...(ctx.sceneKey && !candidate.sceneKey ? { sceneKey: ctx.sceneKey } : {}),
        ...(ctx.personaId && !candidate.personaId ? { personaId: ctx.personaId } : {}),
        ...(ctx.sourceIds ? { sourceIds: [...(candidate.sourceIds ?? []), ...ctx.sourceIds] } : {}),
      });
      records.push(result.record);
      if (result.merged) merged += 1;
      else added += 1;
    }
    return { added, merged, records };
  }

  /**
   * 召回。
   *
   * 打分公式(与 LivingMemory 同构):
   *   relevance = 关键词/向量 双路融合
   *   freshness = exp(-有效衰减率 × 距上次访问的天数)
   *   final = w_rel·relevance + w_imp·importance + w_rec·freshness, 再乘以访问加成
   */
  async search(
    query: string,
    opts: { topK?: number; minScore?: number; sceneKey?: string; personaId?: string } = {},
  ): Promise<MemorySearchHit[]> {
    const cfg = this.deps.getConfig();
    const now = this.now;
    const q = query.trim();
    if (!q) return [];

    const candidates = this.records.filter((r) => r.status === 'active' && r.expiresAt > now);
    if (candidates.length === 0) return [];

    // 关键词路
    const keywordScores = candidates.map((r) => similarity(q, `${r.text} ${r.tags.join(' ')}`));

    // 向量路(可选)
    let vectorScores: number[] | undefined;
    const embedder = this.deps.getEmbedder();
    if (embedder?.configured) {
      // 懒回填：发现有没有向量（或向量是旧模型算的）的记录，就顺手补一批。
      // 不阻塞本次检索——补完下一轮就生效，避免每次搜索都可能卡 30 秒超时。
      const model = embedder.modelName;
      const missing = candidates.filter((r) => !r.embedding || r.embedding.length === 0 || r.embeddingModel !== model);
      if (missing.length > 0 && now - this.lastLazyBackfill > 60_000) {
        this.lastLazyBackfill = now;
        void this.backfill({ limit: 64 }).catch(() => undefined);
      }

      if (candidates.some((r) => r.embedding && r.embedding.length > 0)) {
        const queryVec = await embedder.embedQuiet(q);
        if (queryVec) {
          // 没有向量的记录不该因为"缺数据"被清零——用它的关键词分当兜底证据
          vectorScores = candidates.map((r, i) =>
            r.embedding && r.embedding.length > 0 ? cosineSimilarity(queryVec, r.embedding) : (keywordScores[i] ?? 0) * 0.8,
          );
        }
      }
    }

    const relevance = fuseScores(keywordScores, vectorScores, cfg);

    const hits: MemorySearchHit[] = [];
    const topK = opts.topK ?? cfg.topK;
    const minScore = opts.minScore ?? cfg.minScore;

    candidates.forEach((record, i) => {
      if (opts.sceneKey && record.sceneKey && record.sceneKey !== opts.sceneKey) return;
      if (opts.personaId && record.personaId && record.personaId !== opts.personaId) return;

      const rel = relevance[i] ?? 0;
      const freshness = computeFreshness(record, now, cfg);
      const accessBonus = 1 + Math.min(record.accessCount, 8) * cfg.accessBoost;
      const score = Math.min(
        1,
        (cfg.weights.relevance * rel + cfg.weights.importance * record.importance + cfg.weights.recency * freshness) *
          accessBonus,
      );

      hits.push({
        id: record.id,
        text: record.text,
        tags: record.tags,
        createdAt: record.createdAt,
        score: round(score),
        type: record.type,
        importance: record.importance,
        accessCount: record.accessCount,
        lastAccessedAt: record.lastAccessedAt,
        keywordScore: round(keywordScores[i] ?? 0),
        vectorScore: round(vectorScores?.[i] ?? 0),
        freshness: round(freshness),
      });
    });

    const filtered = hits.filter((h) => h.score >= minScore).sort((a, b) => b.score - a.score);
    const top = filtered.slice(0, topK);

    if (top.length > 0) this.reinforce(top.map((h) => h.id));
    return top;
  }

  /** 访问强化: 更新最近访问时间与次数, 降低后续衰减速度 */
  reinforce(ids: string[]): void {
    if (ids.length === 0) return;
    const now = this.now;
    const set = new Set(ids);
    for (const record of this.records) {
      if (!set.has(record.id)) continue;
      record.accessCount += 1;
      record.lastAccessedAt = now;
    }
    this.markDirty(1_500);
  }

  /**
   * 每日衰减: 到期或生命力过低的记忆归档。
   * vitality = importance × exp(-有效衰减率 × 距上次访问天数)
   */
  decay(): { archived: number; expired: number } {
    const cfg = this.deps.getConfig();
    const now = this.now;
    let archived = 0;
    let expired = 0;

    for (const record of this.records) {
      if (record.status !== 'active') continue;
      if (record.expiresAt <= now) {
        record.status = 'archived';
        archived += 1;
        expired += 1;
        continue;
      }
      const vitality = record.importance * computeFreshness(record, now, cfg);
      if (vitality < cfg.archiveThreshold) {
        record.status = 'archived';
        archived += 1;
      }
    }

    if (archived > 0) this.markDirty(0);
    return { archived, expired };
  }

  archive(id: string): boolean {
    return this.setStatus(id, 'archived');
  }

  forget(id: string): boolean {
    return this.setStatus(id, 'forgotten');
  }

  restore(id: string): boolean {
    return this.setStatus(id, 'active');
  }

  remove(id: string): boolean {
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    this.records.splice(idx, 1);
    this.markDirty(0);
    return true;
  }

  list(opts: { limit?: number; status?: MemoryStatus } = {}): MemoryRecord[] {
    const limit = opts.limit ?? 100;
    return this.records
      .filter((r) => (opts.status ? r.status === opts.status : true))
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, limit);
  }

  stats(): MemoryStats {
    const byType: Record<string, number> = {};
    let active = 0;
    let archived = 0;
    let forgotten = 0;
    let embedded = 0;
    let importanceSum = 0;

    for (const record of this.records) {
      byType[record.type] = (byType[record.type] ?? 0) + 1;
      if (record.status === 'active') active += 1;
      else if (record.status === 'archived') archived += 1;
      else forgotten += 1;
      if (record.embedding && record.embedding.length > 0) embedded += 1;
      importanceSum += record.importance;
    }

    return {
      total: this.records.length,
      active,
      archived,
      forgotten,
      embedded,
      withEmbeddingModel: Boolean(this.deps.getEmbedder()?.configured),
      byType,
      avgImportance: this.records.length ? round(importanceSum / this.records.length) : 0,
    };
  }

  /** 立即落盘(测试与退出前用) */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const payload: MemoryFileV2 = { version: 2, items: this.records };
    await rewriteJsonl(this.file, this.records);
    void payload;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private setStatus(id: string, status: MemoryStatus): boolean {
    const record = this.records.find((r) => r.id === id);
    if (!record) return false;
    record.status = status;
    record.updatedAt = this.now;
    this.markDirty(0);
    return true;
  }

  private markDirty(delayMs = 300): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch(() => undefined);
    }, delayMs);
    this.flushTimer.unref?.();
  }
}

function normalizeRecord(
  raw: Partial<MemoryRecord> & { source?: string },
  cfg: MemoryConfig,
): MemoryRecord | undefined {
  if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || !raw.text.trim()) return undefined;
  const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Date.now();
  const type = (MEMORY_TYPES as string[]).includes(String(raw.type)) ? (raw.type as MemoryType) : 'fact';
  const importance = typeof raw.importance === 'number' ? clamp01(raw.importance) : 0.5;

  return {
    id: raw.id ?? randomUUID(),
    text: raw.text.trim(),
    type,
    importance,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    subjects: Array.isArray(raw.subjects) ? raw.subjects : [],
    ...(raw.sceneKey ? { sceneKey: raw.sceneKey } : {}),
    ...(raw.personaId ? { personaId: raw.personaId } : {}),
    createdAt,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : createdAt,
    lastAccessedAt: typeof raw.lastAccessedAt === 'number' ? raw.lastAccessedAt : createdAt,
    accessCount: typeof raw.accessCount === 'number' ? raw.accessCount : 0,
    expiresAt: typeof raw.expiresAt === 'number' ? raw.expiresAt : createdAt + ttlMs(type, cfg),
    status: raw.status ?? 'active',
    sourceIds: Array.isArray(raw.sourceIds) ? raw.sourceIds : [],
    ...(Array.isArray(raw.embedding) ? { embedding: raw.embedding } : {}),
    ...(typeof raw.embeddingModel === 'string' ? { embeddingModel: raw.embeddingModel } : {}),
  };
}

export function ttlMs(type: MemoryType, cfg: MemoryConfig): number {
  const days = cfg.ttlDays[type] ?? cfg.ttlDays.unknown;
  return days * 86_400_000;
}

export function computeFreshness(
  record: Pick<MemoryRecord, 'lastAccessedAt' | 'createdAt' | 'accessCount'>,
  now: number,
  cfg: MemoryConfig,
): number {
  const anchor = Math.max(record.lastAccessedAt, record.createdAt);
  const ageDays = Math.max(0, (now - anchor) / 86_400_000);
  // 访问越多, 有效衰减率越低 —— 常用的记忆不容易被忘掉
  const effectiveRate = cfg.decayRate / (1 + record.accessCount * cfg.accessResistance);
  return Math.exp(-effectiveRate * ageDays);
}

/** 双路融合: 分数级(min-max 归一化后加权) 或 排名级(RRF) */
export function fuseScores(keyword: number[], vector: number[] | undefined, cfg: MemoryConfig): number[] {
  if (!vector) {
    return normalize01(keyword);
  }

  if (cfg.fusion === 'rrf') {
    const k = cfg.rrfK;
    const kwRank = rankOf(keyword);
    const vecRank = rankOf(vector);
    return keyword.map((_, i) => 1 / (k + (kwRank[i] ?? keyword.length)) + 1 / (k + (vecRank[i] ?? vector.length)));
  }

  const kw = normalize01(keyword);
  const vec = normalize01(vector);
  return keyword.map((_, i) => 0.5 * (kw[i] ?? 0) + 0.5 * (vec[i] ?? 0));
}

function normalize01(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-9) return values.map(() => (max > 0 ? 1 : 0));
  return values.map((v) => (v - min) / (max - min));
}

/** 返回每个元素的名次(1 开始, 越大越好) */
function rankOf(values: number[]): number[] {
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
  const ranks = new Array<number>(values.length).fill(values.length);
  order.forEach((item, idx) => {
    ranks[item.i] = idx + 1;
  });
  return ranks;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round(n: number): number {
  return Number(n.toFixed(4));
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
