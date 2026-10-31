import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  level?: LogLevel;
  /** 内存里保留多少条日志给控制台/SSE 用 */
  bufferSize?: number;
  /** 追加写入的日志文件, 留空则只打 stdout */
  file?: string;
  /** 关掉 stdout 输出(测试用) */
  silent?: boolean;
}

/** 所有 logger(含子 logger)共享的日志中枢 */
interface LogHub {
  entries: LogEntry[];
  subscribers: Set<(entry: LogEntry) => void>;
  level: LogLevel;
  bufferSize: number;
  file: string;
  silent: boolean;
  fileReady: boolean;
}

function createHub(opts: LoggerOptions): LogHub {
  return {
    entries: [],
    subscribers: new Set(),
    level: opts.level ?? 'info',
    bufferSize: opts.bufferSize ?? 500,
    file: opts.file ?? '',
    silent: opts.silent ?? false,
    fileReady: false,
  };
}

/**
 * 轻量结构化日志器: stdout + 内存环形缓冲(给 Web 控制台) + 可选文件。
 * 子 logger 与父级共享同一个 hub, 所以控制台能看到全部日志。
 */
export class Logger {
  private static instance: Logger | undefined;

  constructor(
    private readonly hub: LogHub,
    private readonly scope = 'pasc',
  ) {}

  /** 创建根 logger */
  static create(opts: LoggerOptions = {}): Logger {
    return new Logger(createHub(opts), 'pasc');
  }

  /** 进程级单例, 供各模块共享日志缓冲 */
  static root(opts: LoggerOptions = {}): Logger {
    Logger.instance ??= Logger.create(opts);
    return Logger.instance;
  }

  static resetRoot(): void {
    Logger.instance = undefined;
  }

  /** 子 logger 无独立配置, 直接复用 hub */
  static empty(): Logger {
    return new Logger(createHub({ silent: true, level: 'error' }), 'noop');
  }

  child(scope: string): Logger {
    return new Logger(this.hub, `${this.scope}:${scope}`);
  }

  get level(): LogLevel {
    return this.hub.level;
  }

  configure(opts: { level?: LogLevel; file?: string; bufferSize?: number; silent?: boolean }): void {
    if (opts.level) this.hub.level = opts.level;
    if (opts.file !== undefined) this.hub.file = opts.file;
    if (opts.bufferSize) this.hub.bufferSize = opts.bufferSize;
    if (opts.silent !== undefined) this.hub.silent = opts.silent;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.write('debug', msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.write('info', msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.write('warn', msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.write('error', msg, data);
  }

  /** 最近 n 条日志, 时间正序 */
  recent(n = 100): LogEntry[] {
    return this.hub.entries.slice(-n);
  }

  subscribe(fn: (entry: LogEntry) => void): () => void {
    this.hub.subscribers.add(fn);
    return () => this.hub.subscribers.delete(fn);
  }

  private write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.hub.level]) return;
    const entry: LogEntry = { ts: Date.now(), level, scope: this.scope, msg, data };

    this.hub.entries.push(entry);
    if (this.hub.entries.length > this.hub.bufferSize) {
      this.hub.entries.splice(0, this.hub.entries.length - this.hub.bufferSize);
    }

    if (!this.hub.silent) {
      const line = formatEntry(entry);
      if (level === 'error' || level === 'warn') console.error(line);
      else console.log(line);
    }

    if (this.hub.file) void this.appendToFile(this.hub, entry);

    for (const fn of this.hub.subscribers) {
      try {
        fn(entry);
      } catch {
        /* 订阅者异常不能影响主流程 */
      }
    }
  }

  private async appendToFile(hub: LogHub, entry: LogEntry): Promise<void> {
    try {
      if (!hub.fileReady) {
        await mkdir(dirname(hub.file), { recursive: true });
        hub.fileReady = true;
      }
      await appendFile(hub.file, formatEntry(entry) + '\n', 'utf8');
    } catch {
      /* 日志落盘失败不影响主流程 */
    }
  }
}

export function formatEntry(entry: LogEntry): string {
  const d = new Date(entry.ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const t =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const tag = entry.level.toUpperCase().padEnd(5);
  const extra = entry.data && Object.keys(entry.data).length > 0 ? ` ${safeJson(entry.data)}` : '';
  return `${t} ${tag} [${entry.scope}] ${entry.msg}${extra}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
