import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

/**
 * node:sqlite 的薄封装。
 *
 * 选它而不是 better-sqlite3 的原因: Node 22 内置, 零原生编译, 换机器不用重装。
 * 代价是启动时会有一条 ExperimentalWarning(可以用
 * `NODE_OPTIONS=--disable-warning=ExperimentalWarning` 关掉)。
 *
 * 注意这里用 createRequire 而不是静态 import: vite/vitest 的内置模块白名单里还没有
 * node:sqlite, 静态 import 会被当成普通依赖去解析而报错。
 */
export type SqliteDatabase = DatabaseSync;

type SqliteCtor = new (path: string, options?: { open?: boolean; readOnly?: boolean }) => DatabaseSync;
type SqliteModule = { DatabaseSync: SqliteCtor };

let cached: SqliteModule | undefined;

function sqliteModule(): SqliteModule {
  if (!cached) {
    const req = createRequire(import.meta.url);
    cached = req('node:sqlite') as SqliteModule;
  }
  return cached;
}

export interface OpenOptions {
  /** 只读打开(导入校验、离线查看用) */
  readonly?: boolean;
  busyTimeoutMs?: number;
}

export function openSqlite(file: string, opts: OpenOptions = {}): SqliteDatabase {
  const { DatabaseSync: Db } = sqliteModule();
  const db = new Db(file, { open: true, readOnly: opts.readonly ?? false });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5_000}`);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/** 当前 Node 是否带 node:sqlite(老版本 Node 没有) */
export function sqliteAvailable(): boolean {
  try {
    const { DatabaseSync: Db } = sqliteModule();
    new Db(':memory:').close();
    return true;
  } catch {
    return false;
  }
}

/** 事务包装: 出错自动回滚 */
export function transaction<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败就让原始错误冒上去 */
    }
    throw err;
  }
}
