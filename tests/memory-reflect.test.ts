import { describe, expect, it } from 'vitest';
import { groupForReflection, reflectGroup } from '@pasc/core';
import type { MemoryType } from '@pasc/core';

function rec(id: string, text: string, tags: string[] = [], subjects: string[] = []): {
  id: string; text: string; type: MemoryType; createdAt: number; tags: string[]; subjects: string[];
} {
  return { id, text, type: 'fact', createdAt: 1, tags, subjects };
}

function fakeClient(output: string) {
  return { configured: true, complete: async () => ({ text: output }) };
}

describe('groupForReflection', () => {
  it('按 subjects 分桶，同一人的记忆归一组', () => {
    const groups = groupForReflection([
      rec('1', '张三在杭州读研', [], ['100']),
      rec('2', '张三保研了', [], ['100']),
      rec('3', '李四在成都', [], ['200']),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((g) => g.id).sort()).toEqual(['1', '2']);
  });

  it('按 tags 分桶也能成组', () => {
    const groups = groupForReflection([
      rec('1', '喜欢喝冰美式', ['饮料']),
      rec('2', '不喝甜的', ['饮料']),
    ]);
    expect(groups[0]!.map((g) => g.id).sort()).toEqual(['1', '2']);
  });

  it('桶里只有一条时不作为候选', () => {
    expect(groupForReflection([rec('1', '孤零零一条', ['x'])])).toEqual([]);
  });

  it('近重复（同一件事换说法）即使 tags 不同也能成组', () => {
    const groups = groupForReflection([
      rec('1', '卡车络合物的 PASC 私信默认被禁用，单独对话只能靠 @ 触发'),
      rec('2', '卡车络合物（2645780092）的 PASC 私信默认被禁用，与机器人单独对话只能靠 @ 触发'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((g) => g.id).sort()).toEqual(['1', '2']);
  });

  it('maxGroups 限制组数', () => {
    const items = [];
    for (let i = 0; i < 20; i += 1) {
      items.push(rec(`a${i}`, `人物${i}的事`, [], [`s${i}`]));
      items.push(rec(`b${i}`, `人物${i}的另一件事`, [], [`s${i}`]));
    }
    expect(groupForReflection(items, { maxGroups: 3 })).toHaveLength(3);
  });
});

describe('reflectGroup', () => {
  const group = [
    { id: 'm1', text: '张三在杭州读研', type: 'fact' as MemoryType, createdAt: 1 },
    { id: 'm2', text: '张三搬到成都了', type: 'fact' as MemoryType, createdAt: 2 },
  ];

  it('解析合并结果与来源', async () => {
    const client = fakeClient('{"merged":"张三从杭州搬到成都，继续读研","type":"fact","importance":0.8,"superseded":[{"id":"1","reason":"已搬家"}]}');
    const r = await reflectGroup(client, group);
    expect(r?.text).toContain('成都');
    expect(r?.importance).toBe(0.8);
    expect(r?.sourceIds).toEqual(['m1', 'm2']);
    // 模型给的是组内编号，要换算成真实 id
    expect(r?.superseded[0]?.id).toBe('m1');
  });

  it('模型说不用合并时返回 undefined', async () => {
    const r = await reflectGroup(fakeClient('{"merged":""}'), group);
    expect(r).toBeUndefined();
  });

  it('单条不成组', async () => {
    const r = await reflectGroup(fakeClient('{"merged":"x"}'), [group[0]!]);
    expect(r).toBeUndefined();
  });

  it('乱输出不抛错', async () => {
    const r = await reflectGroup(fakeClient('我觉得可以合并'), group);
    expect(r).toBeUndefined();
  });

  it('调用失败不抛错', async () => {
    const client = { configured: true, complete: async () => { throw new Error('boom'); } };
    const r = await reflectGroup(client, group);
    expect(r).toBeUndefined();
  });
});
