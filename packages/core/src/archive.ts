import { appendJsonl, readJsonl } from './store.js';
import type { ChatMessage } from './types.js';

export interface ArchiveQuery {
  sceneKey?: string;
  senderId?: string;
  /** 消息文本包含的关键词 */
  keyword?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
  /** 倒序返回(默认按时间正序) */
  desc?: boolean;
}

/**
 * 聊天记录管理器 —— 模块五的最小实现。
 *
 * 里程碑 1 用"内存环形窗口 + JSONL 追加"足够跑通链路;
 * 真正要替代 qq-chat-exporter 时, 这里会换成 SQLite(node:sqlite) + FTS,
 * 对外接口 query/append 保持不变。
 */
export class MessageArchive {
  private buffer: ChatMessage[] = [];

  private constructor(
    private readonly file: string,
    private readonly memoryLimit: number,
  ) {}

  static async open(file: string, opts: { memoryLimit?: number } = {}): Promise<MessageArchive> {
    const limit = opts.memoryLimit ?? 20_000;
    const archive = new MessageArchive(file, limit);
    const loaded = await readJsonl<ChatMessage>(file, limit);
    archive.buffer = loaded;
    return archive;
  }

  append(msg: ChatMessage): void {
    this.buffer.push(msg);
    if (this.buffer.length > this.memoryLimit) {
      this.buffer.splice(0, this.buffer.length - this.memoryLimit);
    }
    void appendJsonl(this.file, msg);
  }

  /** 兼容需求文档里"消息 + 回复一起存档"的写法 */
  appendReply(reply: ChatMessage): void {
    this.append(reply);
  }

  query(q: ArchiveQuery = {}): ChatMessage[] {
    const limit = q.limit ?? 100;
    const offset = q.offset ?? 0;
    let rows = this.buffer;

    if (q.sceneKey) rows = rows.filter((m) => m.sceneKey === q.sceneKey);
    if (q.senderId) rows = rows.filter((m) => m.senderId === q.senderId);
    const since = q.since;
    const until = q.until;
    if (since !== undefined) rows = rows.filter((m) => m.timestamp >= since);
    if (until !== undefined) rows = rows.filter((m) => m.timestamp <= until);
    if (q.keyword) {
      const kw = q.keyword.toLowerCase();
      rows = rows.filter((m) => m.text.toLowerCase().includes(kw));
    }
    if (q.desc) rows = [...rows].reverse();
    return rows.slice(offset, offset + limit);
  }

  recent(limit = 50): ChatMessage[] {
    return this.buffer.slice(-limit);
  }

  get size(): number {
    return this.buffer.length;
  }

  /** 统计某个用户在某个会话里说了多少条, 给"按用户提取"做准备 */
  countBySender(sceneKey: string): Array<{ senderId: string; senderName: string; count: number }> {
    const map = new Map<string, { senderId: string; senderName: string; count: number }>();
    for (const m of this.buffer) {
      if (m.sceneKey !== sceneKey) continue;
      const hit = map.get(m.senderId);
      if (hit) hit.count += 1;
      else map.set(m.senderId, { senderId: m.senderId, senderName: m.senderName, count: 1 });
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }
}

/** 存档实现的最小接口: 内存版与 SQLite 版都满足它 */
export interface MessageArchiveLike {
  append(msg: ChatMessage): void;
  appendReply(msg: ChatMessage): void;
  query(q: ArchiveQuery): ChatMessage[];
  recent(limit: number): ChatMessage[];
  readonly size: number;
  countBySender(sceneKey: string): Array<{ senderId: string; senderName: string; count: number }>;
}
