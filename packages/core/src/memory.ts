import { randomUUID } from 'node:crypto';
import { appendJsonl, readJsonl, rewriteJsonl } from './store.js';
import { similarity } from './text.js';

export interface MemoryItem {
  id: string;
  /** 一条独立事实, 例如 "张三在杭州读研, 养了一只叫年糕的猫" */
  text: string;
  tags: string[];
  createdAt: number;
  source?: string;
  /** 预留: 接上 embedding 后写入向量 */
  embedding?: number[];
}

export interface MemoryHit extends MemoryItem {
  score: number;
}

/**
 * 持久记忆模块 —— 对应需求里"通过 Embedding 筛选高相关度事实/关系"。
 *
 * 里程碑 1 的实现:
 *   - 存储: JSONL, 一条一事实
 *   - 检索: 字符 n-gram 相似度(没有 embedding 时的兜底)
 *   - 预留: embedding 字段 + MemoryRetriever 接口, 接向量库时只换检索实现
 *
 * 与 OpenClaw 自带 embedding 的分工见 docs/decisions.md:
 * 中间件只做"筛选 + 转发", 不做全量记忆推理。
 */
export class MemoryStore {
  private items: MemoryItem[] = [];

  private constructor(private readonly file: string) {}

  static async open(file: string, opts: { seed?: boolean } = {}): Promise<MemoryStore> {
    const store = new MemoryStore(file);
    store.items = await readJsonl<MemoryItem>(file);
    if (store.items.length === 0 && (opts.seed ?? true)) {
      store.add({
        text: '群主老陈是个程序员, 主要写 Go, 最近在折腾 NAS。',
        tags: ['群主', '技术'],
        source: 'seed',
      });
      store.add({
        text: '阿琳在杭州读研, 养了一只叫年糕的橘猫, 经常发猫图。',
        tags: ['群友', '生活'],
        source: 'seed',
      });
    }
    return store;
  }

  list(limit = 500): MemoryItem[] {
    return this.items.slice(-limit).reverse();
  }

  get size(): number {
    return this.items.length;
  }

  add(input: { text: string; tags?: string[]; source?: string; embedding?: number[] }): MemoryItem {
    const item: MemoryItem = {
      id: randomUUID(),
      text: input.text.trim(),
      tags: input.tags ?? [],
      createdAt: Date.now(),
      ...(input.source ? { source: input.source } : {}),
      ...(input.embedding ? { embedding: input.embedding } : {}),
    };
    this.items.push(item);
    void appendJsonl(this.file, item);
    return item;
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.items.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    await rewriteJsonl(this.file, this.items);
    return true;
  }

  /** 关键词兜底检索; 接上 embedding 后改走向量召回 */
  search(query: string, topK: number, minScore: number): MemoryHit[] {
    if (this.items.length === 0 || topK <= 0) return [];
    const hits: MemoryHit[] = [];
    for (const item of this.items) {
      const score = similarity(query, `${item.text} ${item.tags.join(' ')}`);
      if (score >= minScore) hits.push({ ...item, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }
}
