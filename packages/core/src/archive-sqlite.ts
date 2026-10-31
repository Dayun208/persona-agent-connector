import { readFileSync } from 'node:fs';
import type { ArchiveQuery } from './archive.js';
import { openSqlite, transaction, type SqliteDatabase } from './sqlite.js';
import type { ChatMessage, Segment } from './types.js';

export interface ArchiveStats {
  total: number;
  scenes: Array<{ sceneKey: string; count: number; lastAt: number }>;
  users: Array<{ senderId: string; senderName: string; count: number }>;
  days: Array<{ date: string; count: number }>;
}

export interface SearchOptions {
  sceneKey?: string;
  limit?: number;
}

interface MessageRow {
  id: string;
  scene_key: string;
  scene_kind: string;
  scene_id: string;
  sender_id: string;
  sender_name: string;
  text: string;
  segments: string;
  at_targets: string;
  mentions_self: number;
  is_self: number;
  timestamp: number;
  seq: number;
  source: string;
}

/**
 * SQLite 版聊天记录库。
 *
 * 参考 qq-chat-exporter 的取舍: 原文与结构化字段分开存, 文本走 FTS5 索引,
 * 导入的记录带 source 标记(区分实时抓取 / QCE 导入), 便于回滚与统计。
 *
 * 中文检索用 FTS5 的 trigram 分词器 —— unicode61 会把整句中文当成一个词,
 * 而 trigram 支持任意子串匹配, 不需要额外分词器。
 */
export class SqliteArchive {
  private readonly insertStmt: ReturnType<SqliteDatabase['prepare']>;
  private readonly db: SqliteDatabase;
  /** trigram 不可用时退化为 LIKE */
  private ftsEnabled = false;

  private constructor(file: string) {
    this.db = openSqlite(file);
    this.migrate();
    this.insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO messages
        (id, scene_key, scene_kind, scene_id, sender_id, sender_name, text,
         segments, at_targets, mentions_self, is_self, timestamp, seq, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
  }

  static open(file: string): SqliteArchive {
    return new SqliteArchive(file);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        rowid        INTEGER PRIMARY KEY AUTOINCREMENT,
        id           TEXT NOT NULL,
        scene_key    TEXT NOT NULL,
        scene_kind   TEXT NOT NULL,
        scene_id     TEXT NOT NULL,
        sender_id    TEXT NOT NULL,
        sender_name  TEXT NOT NULL,
        text         TEXT NOT NULL,
        segments     TEXT NOT NULL,
        at_targets   TEXT NOT NULL,
        mentions_self INTEGER NOT NULL DEFAULT 0,
        is_self      INTEGER NOT NULL DEFAULT 0,
        timestamp    INTEGER NOT NULL,
        seq          INTEGER NOT NULL DEFAULT 0,
        source       TEXT NOT NULL DEFAULT 'live',
        UNIQUE (scene_key, id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_scene_time ON messages (scene_key, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_time ON messages (timestamp);
    `);

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          text, content='messages', content_rowid='rowid', tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        END;
      `);
      this.ftsEnabled = true;
    } catch {
      // 老版本 SQLite 没有 trigram, 退化为 LIKE 查询
      this.ftsEnabled = false;
    }
  }

  get hasFts(): boolean {
    return this.ftsEnabled;
  }

  get size(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  append(msg: ChatMessage, source = 'live'): boolean {
    const id = msg.id || `auto-${msg.timestamp}-${msg.senderId}-${msg.text.slice(0, 8)}`;
    const result = this.insertStmt.run(
      id,
      msg.sceneKey,
      msg.scene.kind,
      msg.scene.kind === 'group' ? msg.scene.groupId : msg.scene.userId,
      msg.senderId,
      msg.senderName,
      msg.text,
      JSON.stringify(msg.segments),
      JSON.stringify(msg.atTargets),
      msg.mentionsSelf ? 1 : 0,
      msg.isSelf ? 1 : 0,
      msg.timestamp,
      msg.seq,
      source,
    );
    return Number(result.changes) > 0;
  }

  appendReply(msg: ChatMessage): void {
    this.append(msg, 'bot');
  }

  /** 批量导入(导入器用), 返回真正写入的条数 */
  importMany(messages: ChatMessage[], source = 'import'): number {
    return transaction(this.db, () => {
      let inserted = 0;
      for (const msg of messages) {
        if (this.append(msg, source)) inserted += 1;
      }
      return inserted;
    });
  }

  query(q: ArchiveQuery = {}): ChatMessage[] {
    const limit = q.limit ?? 100;
    const offset = q.offset ?? 0;
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (q.sceneKey) {
      where.push('scene_key = ?');
      params.push(q.sceneKey);
    }
    if (q.senderId) {
      where.push('sender_id = ?');
      params.push(q.senderId);
    }
    if (q.since !== undefined) {
      where.push('timestamp >= ?');
      params.push(q.since);
    }
    if (q.until !== undefined) {
      where.push('timestamp <= ?');
      params.push(q.until);
    }
    if (q.keyword) {
      const fts = this.ftsFilter(q.keyword);
      if (fts) {
        where.push(fts.sql);
        params.push(...fts.params);
      }
    }

    const build = (clauses: string[], values: Array<string | number>): string =>
      `SELECT * FROM messages ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY timestamp ${q.desc ? 'DESC' : 'ASC'}, rowid ${q.desc ? 'DESC' : 'ASC'}
      LIMIT ? OFFSET ?`;

    try {
      const rows = this.db.prepare(build(where, params)).all(...params, limit, offset) as unknown as MessageRow[];
      return rows.map(rowToMessage);
    } catch (err) {
      // FTS 查询串可能因为标点/短词被 MATCH 拒绝 —— 退回 LIKE, 不要让它变成 500
      if (!q.keyword) throw err;
      const likeWhere = where.filter((w) => !w.includes('messages_fts MATCH'));
      const likeParams = params.filter((_, i) => !where[i]?.includes('messages_fts MATCH'));
      likeWhere.push("text LIKE ? ESCAPE '\\'");
      likeParams.push(`%${q.keyword.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
      const rows = this.db.prepare(build(likeWhere, likeParams)).all(...likeParams, limit, offset) as unknown as MessageRow[];
      return rows.map(rowToMessage);
    }
  }

  /** 全文检索(按相关性排序), 供控制台用 */
  search(keyword: string, opts: SearchOptions = {}): ChatMessage[] {
    const limit = opts.limit ?? 50;
    if (!keyword.trim()) return [];

    if (this.ftsEnabled) {
      const match = toFtsQuery(keyword);
      const sceneFilter = opts.sceneKey ? 'AND m.scene_key = ?' : '';
      const params: Array<string | number> = [match];
      if (opts.sceneKey) params.push(opts.sceneKey);
      try {
        const rows = this.db
          .prepare(
            `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
             WHERE messages_fts MATCH ? ${sceneFilter}
             ORDER BY bm25(messages_fts) LIMIT ?`,
          )
          .all(...params, limit) as unknown as MessageRow[];
        return rows.map(rowToMessage);
      } catch {
        /* 查询语法问题就落到 LIKE */
      }
    }

    const like = `%${keyword.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const sceneFilter = opts.sceneKey ? 'AND scene_key = ?' : '';
    const params: Array<string | number> = [like];
    if (opts.sceneKey) params.push(opts.sceneKey);
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE text LIKE ? ESCAPE '\\' ${sceneFilter} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params, limit) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  recent(limit = 50): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages ORDER BY timestamp DESC, rowid DESC LIMIT ?')
      .all(limit) as unknown as MessageRow[];
    return rows.reverse().map(rowToMessage);
  }

  countBySender(sceneKey: string): Array<{ senderId: string; senderName: string; count: number }> {
    const rows = this.db
      .prepare(
        `SELECT sender_id, sender_name, COUNT(*) AS count FROM messages
         WHERE scene_key = ? GROUP BY sender_id ORDER BY count DESC`,
      )
      .all(sceneKey) as unknown as Array<{ sender_id: string; sender_name: string; count: number }>;
    return rows.map((r) => ({ senderId: r.sender_id, senderName: r.sender_name, count: r.count }));
  }

  stats(): ArchiveStats {
    const total = this.size;
    const scenes = (
      this.db
        .prepare('SELECT scene_key, COUNT(*) AS count, MAX(timestamp) AS lastAt FROM messages GROUP BY scene_key ORDER BY lastAt DESC')
        .all() as unknown as Array<{ scene_key: string; count: number; lastAt: number }>
    ).map((r) => ({ sceneKey: r.scene_key, count: r.count, lastAt: r.lastAt }));

    const users = (
      this.db
        .prepare('SELECT sender_id, sender_name, COUNT(*) AS count FROM messages GROUP BY sender_id ORDER BY count DESC LIMIT 50')
        .all() as unknown as Array<{ sender_id: string; sender_name: string; count: number }>
    ).map((r) => ({ senderId: r.sender_id, senderName: r.sender_name, count: r.count }));

    const days = (
      this.db
        .prepare(
          `SELECT date(timestamp / 1000, 'unixepoch', 'localtime') AS date, COUNT(*) AS count
           FROM messages GROUP BY date ORDER BY date DESC LIMIT 30`,
        )
        .all() as unknown as Array<{ date: string; count: number }>
    ).map((r) => ({ date: r.date, count: r.count }));

    return { total, scenes, users, days };
  }

  /** 从旧的 JSONL 存档迁移(幂等, 迁移完由调用方决定是否改名) */
  migrateJsonl(file: string): number {
    return transaction(this.db, () => {
      // 迁移是一次性操作, 同步读即可
      const rows = readFileSync(file, 'utf8');
      let inserted = 0;
      for (const line of rows.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as ChatMessage;
          if (this.append(msg, 'migrated')) inserted += 1;
        } catch {
          /* 跳过坏行 */
        }
      }
      return inserted;
    });
  }

  close(): void {
    this.db.close();
  }

  private ftsFilter(keyword: string): { sql: string; params: Array<string | number> } | undefined {
    if (!this.ftsEnabled) return { sql: "text LIKE ? ESCAPE '\\'", params: [`%${keyword.replace(/[%_\\]/g, (c) => `\\${c}`)}%`] };
    return {
      sql: 'rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)',
      params: [toFtsQuery(keyword)],
    };
  }
}

function toFtsQuery(keyword: string): string {
  // trigram 需要至少 3 个字符; 短语用双引号包起来避免语法注入
  const clean = keyword.replace(/"/g, '""').trim();
  return `"${clean}"`;
}

function rowToMessage(row: MessageRow): ChatMessage {
  const scene =
    row.scene_kind === 'group'
      ? ({ kind: 'group', groupId: row.scene_id } as const)
      : ({ kind: 'private', userId: row.scene_id } as const);

  return {
    id: row.id,
    seq: row.seq,
    scene,
    sceneKey: row.scene_key,
    senderId: row.sender_id,
    senderName: row.sender_name,
    segments: safeParse<Segment[]>(row.segments, []),
    text: row.text,
    atTargets: safeParse<string[]>(row.at_targets, []),
    mentionsSelf: row.mentions_self === 1,
    timestamp: row.timestamp,
    isSelf: row.is_self === 1,
  };
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

