import { appendJsonl, readJsonl } from './store.js';

/**
 * 动作执行流水（execution log）
 *
 * 为什么单独存一份：
 *   聊天存档里只有"说了什么"，没有"做了什么"。而"做了动作"这件事
 *   既不属于消息、又没有 schema 位置放，所以落成一条 append-only 的 JSONL，
 *   前端按 sceneKey + 时间 合并进会话时间线。
 */
export interface ExecutionRecord {
  id: string;
  /** 毫秒时间戳，用于和消息对齐 */
  ts: number;
  sceneKey: string;
  /** 触发这次动作的消息 id */
  triggerId: string;
  action: string;
  ok: boolean;
  /** 一行摘要，直接给人看 */
  summary: string;
  /** 失败原因或拒绝原因 */
  reason?: string;
}

export interface ExecutionQuery {
  sceneKey?: string;
  limit?: number;
}

export class ExecutionLog {
  constructor(private readonly file: string) {}

  async append(record: ExecutionRecord): Promise<void> {
    await appendJsonl(this.file, record).catch(() => undefined);
  }

  async recent(opts: ExecutionQuery = {}): Promise<ExecutionRecord[]> {
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
    const all = await readJsonl<ExecutionRecord>(this.file);
    const filtered = opts.sceneKey ? all.filter((r) => r.sceneKey === opts.sceneKey) : all;
    return filtered.slice(-limit);
  }
}
