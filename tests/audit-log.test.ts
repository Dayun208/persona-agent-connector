import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, type AuditRecord } from '@pasc/core';

const dirs: string[] = [];
function makeLog() {
  const dir = mkdtempSync(join(tmpdir(), 'pasc-audit-'));
  dirs.push(dir);
  return new AuditLog(join(dir, 'audit.jsonl'));
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const rec = (over: Partial<AuditRecord>): AuditRecord => ({
  id: '1', ts: Date.now(), sceneKey: 'group:1', senderId: '999', command: 'dev-on', ok: true, ...over,
});

describe('AuditLog', () => {
  it('写入后能读回来', async () => {
    const log = makeLog();
    await log.append(rec({}));
    await log.append(rec({ id: '2', command: 'dev-off' }));
    const items = await log.recent();
    expect(items).toHaveLength(2);
    expect(items[1]!.command).toBe('dev-off');
  });

  it('按会话和操作人过滤', async () => {
    const log = makeLog();
    await log.append(rec({ id: '1', sceneKey: 'group:1', senderId: '999' }));
    await log.append(rec({ id: '2', sceneKey: 'group:2', senderId: '999' }));
    await log.append(rec({ id: '3', sceneKey: 'group:1', senderId: '888' }));
    expect(await log.recent({ sceneKey: 'group:1' })).toHaveLength(2);
    expect(await log.recent({ senderId: '999' })).toHaveLength(2);
    expect(await log.recent({ sceneKey: 'group:1', senderId: '888' })).toHaveLength(1);
  });

  it('文件不存在时返回空数组', async () => {
    expect(await makeLog().recent()).toEqual([]);
  });

  it('limit 生效且取最近的', async () => {
    const log = makeLog();
    for (let i = 0; i < 5; i += 1) await log.append(rec({ id: String(i), detail: `d${i}` }));
    const items = await log.recent({ limit: 2 });
    expect(items.map((x) => x.detail)).toEqual(['d3', 'd4']);
  });
});
