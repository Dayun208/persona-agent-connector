import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 文件存储小工具: JSON 原子写 + JSONL 追加 */

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 先写临时文件再 rename, 避免进程被杀时留下半个 JSON */
export async function writeJsonFile(file: string, data: unknown): Promise<void> {
  await ensureDir(dirname(file));
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, file);
}

export async function appendJsonl(file: string, record: unknown): Promise<void> {
  await ensureDir(dirname(file));
  await appendFile(file, JSON.stringify(record) + '\n', 'utf8');
}

export async function readJsonl<T>(file: string, limit = Number.POSITIVE_INFINITY): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const slice = limit === Number.POSITIVE_INFINITY ? lines : lines.slice(-limit);
  const out: T[] = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* 跳过损坏的行 */
    }
  }
  return out;
}

/** 重写整个 JSONL(删除记录时用) */
export async function rewriteJsonl(file: string, records: unknown[]): Promise<void> {
  await ensureDir(dirname(file));
  const tmp = `${file}.tmp`;
  await writeFile(tmp, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  await rename(tmp, file);
}
