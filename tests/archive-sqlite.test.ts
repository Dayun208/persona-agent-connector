import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteArchive } from '@pasc/core';
import { makeMessage, makeMessages } from './helpers.js';

let dir: string;
let archive: SqliteArchive;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pasc-archive-'));
  archive = SqliteArchive.open(join(dir, 'test.db'));
});

afterEach(() => {
  archive.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SqliteArchive', () => {
  it('写入并读回', () => {
    const msgs = makeMessages(['你好', '在吗', '在的']);
    msgs.forEach((m) => archive.append(m));

    expect(archive.size).toBe(3);
    expect(archive.query({ limit: 10 }).map((m) => m.text)).toEqual(['你好', '在吗', '在的']);
    expect(archive.recent(2).map((m) => m.text)).toEqual(['在吗', '在的']);
  });

  it('按 sceneKey / senderId / 时间过滤', () => {
    const a = makeMessage({ text: '群消息', scene: { kind: 'group', groupId: '1' }, timestamp: 1000 });
    const b = makeMessage({ text: '私聊消息', scene: { kind: 'private', userId: '2' }, timestamp: 2000, senderId: '20002' });
    archive.append(a);
    archive.append(b);

    expect(archive.query({ sceneKey: 'group:1' }).length).toBe(1);
    expect(archive.query({ senderId: '20002' }).length).toBe(1);
    expect(archive.query({ since: 1500 }).length).toBe(1);
    expect(archive.query({ desc: true })[0]!.text).toBe('私聊消息');
  });

  it('同一条消息重复写入会被忽略', () => {
    const msg = makeMessage({ id: 'dup-1', text: '重复' });
    expect(archive.append(msg)).toBe(true);
    expect(archive.append(msg)).toBe(false);
    expect(archive.size).toBe(1);
  });

  it('中文全文检索可用', () => {
    makeMessages(['今天有人试过那个新的推理框架吗', '据说挺快的, 就是文档稀烂', '给我发张图']).forEach((m) =>
      archive.append(m),
    );

    const hits = archive.search('推理框架');
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).toContain('推理框架');

    expect(archive.search('文档稀烂').length).toBe(1);
    expect(archive.search('这张图').length).toBe(0);
  });

  it('检索可以限定会话', () => {
    archive.append(makeMessage({ text: '群里的推理框架', scene: { kind: 'group', groupId: '1' } }));
    archive.append(makeMessage({ text: '私聊的推理框架', scene: { kind: 'private', userId: '2' } }));
    expect(archive.search('推理框架', { sceneKey: 'group:1' }).length).toBe(1);
  });

  it('批量导入返回实际写入数', () => {
    const batch = makeMessages(['a1', 'a2', 'a3']);
    expect(archive.importMany(batch)).toBe(3);
    expect(archive.importMany(batch)).toBe(0); // 去重
  });

  it('按发送者统计', () => {
    archive.append(makeMessage({ text: '1', senderId: '1', senderName: '甲' }));
    archive.append(makeMessage({ text: '2', senderId: '1', senderName: '甲' }));
    archive.append(makeMessage({ text: '3', senderId: '2', senderName: '乙' }));

    const rows = archive.countBySender('group:123456');
    expect(rows[0]).toMatchObject({ senderId: '1', count: 2 });
  });

  it('统计信息包含会话/用户/日期', () => {
    archive.append(makeMessage({ text: '1', timestamp: Date.now() }));
    const stats = archive.stats();
    expect(stats.total).toBe(1);
    expect(stats.scenes).toHaveLength(1);
    expect(stats.users[0]!.senderId).toBe('10001');
    expect(stats.days).toHaveLength(1);
  });

  it('数据可跨实例持久化', () => {
    archive.append(makeMessage({ text: '持久化测试' }));
    archive.close();

    const reopened = SqliteArchive.open(join(dir, 'test.db'));
    expect(reopened.query({ limit: 5 }).map((m) => m.text)).toEqual(['持久化测试']);
    reopened.close();
    archive = SqliteArchive.open(join(dir, 'test.db'));
  });
});
