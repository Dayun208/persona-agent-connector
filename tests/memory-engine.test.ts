import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryEngine,
  computeFreshness,
  cosineSimilarity,
  fuseScores,
  normalizeConfig,
  ttlMs,
  type MemoryConfig,
} from '@pasc/core';

let dir: string;
let cfg: MemoryConfig;
let clock: number;
let lastEngine: MemoryEngine | undefined;

async function makeEngine(overrides: Partial<MemoryConfig> = {}) {
  cfg = normalizeConfig({ memory: { enabled: true, ...overrides } }).memory;
  const engine = await MemoryEngine.open(join(dir, 'memory.jsonl'), {
    getConfig: () => cfg,
    getEmbedder: () => undefined,
    now: () => clock,
  });
  lastEngine = engine;
  return engine;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pasc-memory-'));
  clock = 1_700_000_000_000;
});

afterEach(async () => {
  // 先停掉引擎的防抖落盘, 再删临时目录, 否则会留下 ENOENT 的未处理拒绝
  await lastEngine?.close().catch(() => undefined);
  lastEngine = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('MemoryEngine 基本读写', () => {
  it('写入后能召回', async () => {
    const engine = await makeEngine();
    await engine.add({ text: '阿琳养了一只叫年糕的橘猫', type: 'fact', importance: 0.8, tags: ['猫'] });
    await engine.add({ text: '老陈主要写 Go, 最近在折腾 NAS', type: 'fact', importance: 0.6 });

    const hits = await engine.search('年糕这只猫');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain('年糕');
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it('空查询返回空', async () => {
    const engine = await makeEngine();
    await engine.add({ text: '随便一条' });
    expect(await engine.search('   ')).toEqual([]);
  });

  it('相似记忆会被合并而不是重复插入', async () => {
    const engine = await makeEngine();
    const first = await engine.add({ text: '阿琳养了一只橘猫', importance: 0.5 });
    const second = await engine.add({ text: '阿琳养了一只橘猫呀', importance: 0.9 });

    expect(second.merged).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(engine.size).toBe(1);
    expect(second.record.importance).toBe(0.9);
  });

  it('可以归档/恢复/遗忘/删除', async () => {
    const engine = await makeEngine();
    const { record } = await engine.add({ text: '一条会被归档的记忆' });

    expect(engine.archive(record.id)).toBe(true);
    expect(engine.stats().archived).toBe(1);
    expect(engine.restore(record.id)).toBe(true);
    expect(engine.stats().active).toBe(1);
    expect(engine.forget(record.id)).toBe(true);
    expect(engine.stats().forgotten).toBe(1);
    expect(engine.remove(record.id)).toBe(true);
    expect(engine.size).toBe(0);
  });
});

describe('MemoryEngine 生命周期', () => {
  it('按类型 TTL: 计划比事实活得短', () => {
    expect(ttlMs('plan', cfg)).toBeLessThan(ttlMs('fact', cfg));
    expect(ttlMs('event', cfg)).toBeLessThan(ttlMs('preference', cfg));
  });

  it('过期记忆会被归档', async () => {
    const engine = await makeEngine();
    await engine.add({ text: '我下周三去上海出差', type: 'plan', importance: 0.9 });

    clock += 3 * 86_400_000; // 计划 TTL 是 2 天
    const result = engine.decay();

    expect(result.expired).toBe(1);
    expect(engine.stats().active).toBe(0);
    expect(engine.stats().archived).toBe(1);
  });

  it('生命力过低的记忆会被归档', async () => {
    const engine = await makeEngine({ archiveThreshold: 0.5 });
    await engine.add({ text: '不太重要的一句话', type: 'fact', importance: 0.3 });

    clock += 100 * 86_400_000;
    const result = engine.decay();
    expect(result.archived).toBeGreaterThan(0);
  });

  it('访问过的记忆衰减更慢', () => {
    const base = { createdAt: clock, lastAccessedAt: clock, accessCount: 0 };
    const accessed = { ...base, accessCount: 5 };
    const later = clock + 60 * 86_400_000;

    expect(computeFreshness(accessed, later, cfg)).toBeGreaterThan(computeFreshness(base, later, cfg));
  });

  it('访问会抬高分数', async () => {
    const engine = await makeEngine();
    const { record } = await engine.add({ text: '阿琳养了一只橘猫', importance: 0.5 });
    const before = (await engine.search('橘猫'))[0]!;

    engine.reinforce([record.id]);
    engine.reinforce([record.id]);
    const after = (await engine.search('橘猫'))[0]!;

    expect(after.accessCount).toBeGreaterThan(before.accessCount);
    expect(after.score).toBeGreaterThanOrEqual(before.score);
  });
});

describe('MemoryEngine 持久化与统计', () => {
  it('落盘后可以重新加载', async () => {
    const engine = await makeEngine();
    await engine.add({ text: '重启后应该还在', type: 'fact', importance: 0.7 });
    await engine.flush();
    await engine.close();

    const reopened = await makeEngine();
    expect(reopened.size).toBe(1);
    expect(reopened.list()[0]!.text).toBe('重启后应该还在');
  });

  it('统计信息正确', async () => {
    const engine = await makeEngine();
    await engine.add({ text: '事实一', type: 'fact', importance: 0.6 });
    await engine.add({ text: '偏好一', type: 'preference', importance: 0.8 });
    const stats = engine.stats();

    expect(stats.total).toBe(2);
    expect(stats.byType.fact).toBe(1);
    expect(stats.byType.preference).toBe(1);
    expect(stats.avgImportance).toBeCloseTo(0.7, 2);
    expect(stats.withEmbeddingModel).toBe(false);
  });

  it('批量 ingest 返回新增与合并数', async () => {
    const engine = await makeEngine();
    const r = await engine.ingest(
      [
        { text: '阿琳在杭州读研', type: 'fact', importance: 0.7 },
        { text: '阿琳在杭州读研', type: 'fact', importance: 0.7 },
      ],
      { sceneKey: 'group:1', sourceIds: ['m1'] },
    );
    expect(r.added).toBe(1);
    expect(r.merged).toBe(1);
    expect(r.records[0]!.sceneKey).toBe('group:1');
    expect(r.records[0]!.sourceIds).toContain('m1');
  });
});

describe('融合与相似度', () => {
  it('没有向量时用关键词归一化', () => {
    const fused = fuseScores([0.2, 0.8, 0.5], undefined, cfg);
    expect(fused[1]).toBeGreaterThan(fused[2]!);
    expect(fused[2]).toBeGreaterThan(fused[0]!);
  });

  it('双路融合后取并集', () => {
    const fused = fuseScores([0.9, 0.1], [0.1, 0.9], cfg);
    expect(fused).toHaveLength(2);
    expect(fused[0]).toBeCloseTo(fused[1]!, 2);
  });

  it('rrf 模式也能工作', () => {
    const rrfCfg = normalizeConfig({ memory: { fusion: 'rrf' } }).memory;
    const fused = fuseScores([0.9, 0.1], [0.1, 0.9], rrfCfg);
    expect(fused.every((v) => v > 0)).toBe(true);
  });

  it('余弦相似度', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });
});

describe('embedding 回填', () => {
  it('没有向量的记录会被补齐，且记录模型名', async () => {
    const realCfg = normalizeConfig({ memory: { enabled: true } }).memory;
    const embedder = {
      configured: true,
      modelName: 'fake-embed',
      embed: async (texts: string[]) => texts.map((t) => [t.length, 1, 0]),
      embedQuiet: async (t: string) => [t.length, 1, 0],
    } as never;
    const engine = await MemoryEngine.open(join(dir, 'memory.jsonl'), {
      getConfig: () => realCfg,
      getEmbedder: () => embedder,
      now: () => clock,
    });
    lastEngine = engine;

    await engine.add({ text: '测试记忆一条', type: 'fact', importance: 0.5 });
    const before = engine.embeddingHealth();
    expect(before.embedded).toBe(1);
    expect(before.model).toBe('fake-embed');

    const r = await engine.backfill({ force: true });
    expect(r.updated).toBe(1);
    expect(r.failed).toBe(0);
  });
});

describe('反思合并', () => {
  it('consolidate 写入合并记录并把原条目标记 merged', async () => {
    const engine = await makeEngine();
    const a = await engine.add({ text: '张三在杭州读研', type: 'fact' });
    const b = await engine.add({ text: '张三保研了', type: 'fact' });
    const r = await engine.consolidate({
      text: '张三在杭州读研并已保研',
      type: 'fact',
      importance: 0.8,
      sourceIds: [a.record.id, b.record.id],
    });
    expect(r.absorbed).toBe(2);
    const statuses = engine.list({ limit: 10 }).map((m) => [m.text, m.status]);
    const merged = statuses.find(([t]) => t === '张三在杭州读研');
    expect(merged?.[1]).toBe('merged');
    expect(engine.list({ limit: 10, status: 'merged' }).length).toBe(2);
  });

  it('supersede 把旧记忆归档', async () => {
    const engine = await makeEngine();
    const a = await engine.add({ text: '住在杭州', type: 'fact' });
    expect(engine.supersede(a.record.id, '已搬家')).toBe(true);
    expect(engine.list({ limit: 10, status: 'archived' }).some((m) => m.id === a.record.id)).toBe(true);
  });
});
