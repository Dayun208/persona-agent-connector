import { appendJsonl, readJsonl } from './store.js';

/**
 * 管理员命令审计流水。
 *
 * 为什么要单独落盘：
 *   #dev / #status 这类命令会改变机器人的行为（甚至临时关掉人格），
 *   但它们在入库之前就被拦掉了 —— 聊天存档里查不到任何痕迹。
 *   出了问题要能回答"谁在什么时候把人格关了"。
 */
export interface AuditRecord {
  id: string;
  ts: number;
  sceneKey: string;
  senderId: string;
  senderName?: string;
  /** dev-on / dev-off / dev-ask / dev-judge / dev-prompt / dev-status / status */
  command: string;
  /** 补充说明，比如查询的话题 */
  detail?: string;
  ok: boolean;
  reason?: string;
}

export interface AuditQuery {
  sceneKey?: string;
  senderId?: string;
  limit?: number;
}

export class AuditLog {
  constructor(private readonly file: string) {}

  async append(record: AuditRecord): Promise<void> {
    await appendJsonl(this.file, record).catch(() => undefined);
  }

  async recent(opts: AuditQuery = {}): Promise<AuditRecord[]> {
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 100));
    const all = await readJsonl<AuditRecord>(this.file);
    const filtered = all
      .filter((r) => (opts.sceneKey ? r.sceneKey === opts.sceneKey : true))
      .filter((r) => (opts.senderId ? r.senderId === opts.senderId : true));
    return filtered.slice(-limit);
  }
}
