import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryGraph, extractGraph, isGenericName } from '@pasc/core';

const dirs: string[] = [];
function makeGraph() {
  const dir = mkdtempSync(join(tmpdir(), 'pasc-graph-'));
  dirs.push(dir);
  return { graph: MemoryGraph.open(join(dir, 'g.json')), dir };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('MemoryGraph', () => {
  it('同一实体重复出现只累加权重', async () => {
    const { graph } = makeGraph();
    const g = await graph;
    g.merge([{ name: '张三', type: 'person' }], [], 'm1');
    g.merge([{ name: '张三', type: 'person' }], [], 'm2');
    const snap = g.snapshot();
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0]!.mentions).toBe(2);
    expect(snap.nodes[0]!.memoryIds).toEqual(['m1', 'm2']);
  });

  it('泛称不会进图', async () => {
    const { graph } = makeGraph();
    const g = await graph;
    g.merge([{ name: '用户', type: 'person' }, { name: '张三', type: 'person' }], [], 'm1');
    expect(g.snapshot().nodes.map((n) => n.name)).toEqual(['张三']);
  });

  it('关系两端不存在时丢弃，避免断头边', async () => {
    const { graph } = makeGraph();
    const g = await graph;
    g.merge([{ name: '张三', type: 'person' }], [{ from: '张三', to: '不存在', relation: '住在' }], 'm1');
    expect(g.snapshot().edges).toHaveLength(0);
  });

  it('重命名钩子能把 QQ 号换成昵称', async () => {
    const { graph } = makeGraph();
    const g = await graph;
    g.merge([{ name: '2959515696', type: 'person' }], [], 'm1', (n) => (n === '2959515696' ? '二小' : n));
    expect(g.snapshot().nodes[0]!.name).toBe('二小');
  });

  it('落盘后能重新读出来', async () => {
    const { graph, dir } = makeGraph();
    const g = await graph;
    g.merge([{ name: '张三', type: 'person' }, { name: '杭州', type: 'place' }], [{ from: '张三', to: '杭州', relation: '住在' }], 'm1');
    await g.save();
    const reopened = await MemoryGraph.open(join(dir, 'g.json'));
    expect(reopened.nodeCount).toBe(2);
    expect(reopened.edgeCount).toBe(1);
  });

  it('about() 返回关联边与邻居', async () => {
    const { graph } = makeGraph();
    const g = await graph;
    g.merge(
      [{ name: '张三', type: 'person' }, { name: '杭州', type: 'place' }],
      [{ from: '张三', to: '杭州', relation: '住在' }],
      'm1',
    );
    const about = g.about('张三');
    expect(about.edges).toHaveLength(1);
    expect(about.neighborIds).toEqual(['杭州']);
  });
});

describe('extractGraph', () => {
  it('解析实体与关系', async () => {
    const client = {
      configured: true,
      complete: async () => ({ text: '{"entities":[{"name":"张三","type":"person"}],"relations":[{"from":"张三","to":"杭州","relation":"住在"}]}' }),
    };
    const r = await extractGraph(client, ['张三住在杭州']);
    expect(r.data?.entities).toHaveLength(1);
    expect(r.data?.relations[0]?.relation).toBe('住在');
  });

  it('空记忆直接返回警告', async () => {
    const r = await extractGraph({ configured: true, complete: async () => ({ text: '{}' }) }, []);
    expect(r.data).toBeUndefined();
    expect(r.warning).toBeTruthy();
  });

  it('模型乱输出时不抛错', async () => {
    const r = await extractGraph({ configured: true, complete: async () => ({ text: '我觉得有张三' }) }, ['张三']);
    expect(r.data).toBeUndefined();
    expect(r.warning).toBeTruthy();
  });
});

describe('isGenericName', () => {
  it('泛称命中', () => {
    expect(isGenericName('用户')).toBe(true);
    expect(isGenericName('群友')).toBe(true);
  });
  it('正常名字不命中', () => {
    expect(isGenericName('张三')).toBe(false);
  });
});
