import { describe, expect, it } from 'vitest';
import { filterPairsWithAI, parseVerdicts } from '@pasc/core';
import type { QaPair } from '@pasc/core';

function pair(id: string, question: string, answer: string): QaPair {
  return {
    id,
    sceneKey: 'group:1',
    asker: { id: '1', name: '甲' },
    target: { id: '2', name: '二小' },
    question,
    answer,
    questionAt: 1_700_000_000_000,
    answerAt: 1_700_000_001_000,
    link: 'adjacent',
    role: 'answerer',
    score: 0.5,
  };
}

function fakeClient(reply: string) {
  return {
    configured: true,
    async completeJson() {
      return { value: reply, raw: reply, latencyMs: 1 };
    },
  } as never;
}

describe('parseVerdicts', () => {
  it('能从带前后废话和代码块的输出里抽出结论', () => {
    const raw = '好的，我筛完了：\n```json\n{"keep":[{"i":1,"score":0.9,"why":"有口癖"},{"i":3,"score":0.4}]}\n```\n以上。';
    const v = parseVerdicts(raw);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ i: 1, score: 0.9 });
    expect(v[1]!.i).toBe(3);
  });

  it('丢掉非法编号，分数收敛到 0~1', () => {
    const raw = '{"keep":[{"i":0},{"i":"x"},{"i":2,"score":9}]}';
    const v = parseVerdicts(raw);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ i: 2, score: 1 });
  });

  it('完全不是 JSON 时返回空数组而不是抛错', () => {
    expect(parseVerdicts('我觉得都挺好的')).toEqual([]);
  });
});

describe('filterPairsWithAI', () => {
  it('按 id 映射回原始配对，并按 AI 分数排序', async () => {
    const pairs = [pair('a', '在吗', '在的捏'), pair('b', '吃了吗', '吃了'), pair('c', '打游戏吗', '来！')];
    const client = fakeClient('{"keep":[{"i":1,"score":0.3,"why":"太短"},{"i":3,"score":0.9,"why":"有情绪"}]}');
    const r = await filterPairsWithAI(pairs, client, { maxKeep: 10 });
    expect(r.batches).toBe(1);
    expect(r.failedBatches).toBe(0);
    expect(r.kept.map((k) => k.id)).toEqual(['c', 'a']);
    expect(r.kept[0]!.score).toBe(0.9);
  });

  it('超过 maxKeep 时截断到上限', async () => {
    const pairs = Array.from({ length: 6 }, (_, i) => pair(`p${i}`, `q${i}`, `a${i}`));
    const keep = Array.from({ length: 6 }, (_, i) => ({ i: i + 1, score: i / 10 })).map((x) => JSON.stringify(x));
    const client = fakeClient(`{"keep":[${keep.join(',')}]}`);
    const r = await filterPairsWithAI(pairs, client, { maxKeep: 2 });
    expect(r.kept).toHaveLength(2);
  });

  it('模型没按格式回答时记 failedBatches，不抛错', async () => {
    const pairs = [pair('a', 'q', 'a')];
    const r = await filterPairsWithAI(pairs, fakeClient('我不会'), {});
    expect(r.kept).toHaveLength(0);
    expect(r.failedBatches).toBe(1);
  });

  it('配对很多时分批送模型', async () => {
    const pairs = Array.from({ length: 60 }, (_, i) => pair(`p${i}`, `q${i}`, `a${i}`));
    const r = await filterPairsWithAI(pairs, fakeClient('{"keep":[]}'), { batchSize: 25 });
    expect(r.batches).toBe(3);
  });
});

describe('同题去重', () => {
  it('同一个问题配了多条回答时，只保留 AI 分最高的一条', async () => {
    const q = '你看他这样还是不说话 你把阈值调低一点？';
    const pairs = [
      pair('a', q, '第一句回答'),
      pair('b', q, '第二句回答'),
      pair('c', '另一个问题', '另一条回答'),
    ];
    const client = fakeClient('{"keep":[{"i":1,"score":0.9},{"i":2,"score":0.95},{"i":3,"score":0.8}]}');
    const r = await filterPairsWithAI(pairs, client, { maxKeep: 10 });
    expect(r.kept.map((k) => k.id)).toEqual(['b', 'c']);
    expect(r.deduped).toBe(1);
  });
});
