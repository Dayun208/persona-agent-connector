import { randomUUID } from 'node:crypto';
import { appendJsonl, readJsonl, rewriteJsonl } from './store.js';
import { similarity } from './text.js';

export interface Sample {
  id: string;
  /** 用户说的话 */
  question: string;
  /** 目标人格可能的回应 */
  answer: string;
  tags: string[];
  createdAt: number;
  /** 来源: manual / import:<file> / extract:<sceneKey> */
  source?: string;
  /** 归属人格；不填 = 全局样本，所有未绑定的人格都能用 */
  personaId?: string;
}

export interface SampleInput {
  personaId?: string;
  question: string;
  answer: string;
  tags?: string[];
  source?: string;
}

const DEMO_SAMPLES: SampleInput[] = [
  {
    question: '这个报错怎么解决啊, 一直说 module not found',
    answer: '装依赖了没啊, node_modules 删了重装一遍试试, 还不行就是包名写错了',
    tags: ['技术', '提问'],
  },
  {
    question: '你们周末一般干嘛',
    answer: '躺平吧, 出门太累了, 你呢',
    tags: ['闲聊'],
  },
];

/**
 * few-shot 样本库。
 *
 * 需求里的"自动截取 Q/A 片段"最终会写到这里; 这个类只负责存取与挑选,
 * 提取逻辑(当前消息 → 上下文里找提问 → 找到对应回答)放在 extractor 里。
 */
export class SampleStore {
  private items: Sample[] = [];

  private constructor(private readonly file: string) {}

  static async open(file: string, opts: { seed?: boolean } = {}): Promise<SampleStore> {
    const store = new SampleStore(file);
    store.items = await readJsonl<Sample>(file);
    if (store.items.length === 0 && (opts.seed ?? true)) {
      for (const demo of DEMO_SAMPLES) store.add(demo);
    }
    return store;
  }

  list(limit = 200, personaId?: string): Sample[] {
    const scoped = personaId
      ? this.items.filter((s) => !s.personaId || s.personaId === personaId)
      : this.items;
    return scoped.slice(-limit).reverse();
  }

  /** 某个人的专属样本数（不含全局） */
  countFor(personaId: string): number {
    return this.items.filter((s) => s.personaId === personaId).length;
  }

  get size(): number {
    return this.items.length;
  }

  add(input: SampleInput): Sample {
    const sample: Sample = {
      id: randomUUID(),
      question: input.question.trim(),
      answer: input.answer.trim(),
      tags: input.tags ?? [],
      createdAt: Date.now(),
      ...(input.source ? { source: input.source } : {}),
      ...(input.personaId ? { personaId: input.personaId } : {}),
    };
    this.items.push(sample);
    void appendJsonl(this.file, sample);
    return sample;
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.items.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    await rewriteJsonl(this.file, this.items);
    return true;
  }

  async clear(): Promise<void> {
    this.items = [];
    await rewriteJsonl(this.file, []);
  }

  /**
   * 按与当前对话的相关度挑选 few-shot。
   * embedding 还没接上, 先用字符 n-gram 相似度 + 时间新鲜度做加权。
   */
  pick(query: string, limit: number, personaId?: string): Sample[] {
    // 人格有自己的样本池时只在池里挑；池是空的才回退到全局样本
    const pool = personaId
      ? (this.items.some((s) => s.personaId === personaId)
          ? this.items.filter((s) => !s.personaId || s.personaId === personaId)
          : this.items)
      : this.items;
    if (pool.length === 0 || limit <= 0) return [];
    if (!query.trim()) return this.list(limit, personaId);

    const now = Date.now();
    const scored = pool.map((sample) => {
      const text = `${sample.question} ${sample.tags.join(' ')}`;
      const rel = similarity(query, text);
      const ageDays = (now - sample.createdAt) / 86_400_000;
      const fresh = 1 / (1 + ageDays / 30);
      return { sample, score: rel * 0.85 + fresh * 0.15 };
    });
    scored.sort((a, b) => b.score - a.score);

    const picked = scored.slice(0, limit).map((s) => s.sample);
    // 一个都没相关时, 退化成时间最近
    if (picked.every((s) => similarity(query, `${s.question} ${s.tags.join(' ')}`) === 0)) {
      return this.list(limit).reverse();
    }
    return picked;
  }
}
