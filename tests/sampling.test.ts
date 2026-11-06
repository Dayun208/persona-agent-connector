import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SampleStore } from '@pasc/core';

const dirs: string[] = [];
async function makeStore(): Promise<SampleStore> {
  const dir = mkdtempSync(join(tmpdir(), 'pasc-samples-'));
  dirs.push(dir);
  return SampleStore.open(join(dir, 'samples.jsonl'), { seed: false });
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('样本池按人格隔离', () => {
  it('list 只返回该人格的样本与全局样本', async () => {
    const store = await makeStore();
    store.add({ question: 'a', answer: '1' });
    store.add({ question: 'b', answer: '2', personaId: 'p1' });
    store.add({ question: 'c', answer: '3', personaId: 'p2' });
    expect(store.list(100, 'p1').map((s) => s.question).sort()).toEqual(['a', 'b']);
    expect(store.countFor('p1')).toBe(1);
    expect(store.countFor('p2')).toBe(1);
  });

  it('人格有自己的池时，pick 只从池里挑', async () => {
    const store = await makeStore();
    store.add({ question: '全局问题', answer: '全局回答' });
    store.add({ question: '专属问题', answer: '专属回答', personaId: 'p1' });
    const picked = store.pick('问题', 5, 'p1');
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.every((s) => s.personaId === 'p1' || !s.personaId)).toBe(true);
    expect(picked.some((s) => s.personaId === 'p1')).toBe(true);
  });

  it('人格没有专属样本时回退到全局', async () => {
    const store = await makeStore();
    store.add({ question: '全局', answer: '回答' });
    const picked = store.pick('全局', 5, 'p9');
    expect(picked).toHaveLength(1);
  });

  it('不传 personaId 时行为与之前一致', async () => {
    const store = await makeStore();
    store.add({ question: 'x', answer: '1' });
    store.add({ question: 'y', answer: '2', personaId: 'p1' });
    expect(store.list(100)).toHaveLength(2);
    expect(store.pick('x', 5)).toHaveLength(2);
  });
});
