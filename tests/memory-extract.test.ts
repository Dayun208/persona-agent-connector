import { describe, expect, it } from 'vitest';
import { extractMemoryCandidates, formatDialogue, type ChatClient } from '@pasc/core';
import { makeMessages } from './helpers.js';

function fakeClient(output: string): ChatClient {
  return {
    configured: true,
    complete: async () => ({ text: output, latencyMs: 1, model: 'fake' }),
  } as unknown as ChatClient;
}

const messages = makeMessages(['阿琳: 我最近在杭州读研', '老陈: 你养的那只猫叫什么', '阿琳: 叫年糕, 一只橘猫']);

describe('formatDialogue', () => {
  it('渲染成 昵称(QQ): 内容', () => {
    const text = formatDialogue(messages);
    expect(text).toContain('测试用户(10001): 阿琳: 我最近在杭州读研');
    expect(text.split('\n')).toHaveLength(3);
  });

  it('超长时保留最近部分', () => {
    const long = makeMessages(Array.from({ length: 50 }, (_, i) => `第${i}条消息内容`.repeat(5)));
    const text = formatDialogue(long, 200);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toContain('第49条');
  });
});

describe('extractMemoryCandidates', () => {
  it('解析模型输出的 JSON 数组', async () => {
    const out = JSON.stringify([
      { text: '阿琳在杭州读研', type: 'fact', importance: 0.8, tags: ['杭州', '读研'], subjects: ['20002'] },
      { text: '阿琳养了一只叫年糕的橘猫', type: 'fact', importance: 0.7, tags: ['猫'], subjects: [] },
    ]);
    const r = await extractMemoryCandidates(fakeClient(out), messages, { maxItems: 5 });
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]!.type).toBe('fact');
    expect(r.candidates[1]!.text).toContain('年糕');
  });

  it('容忍代码块包裹', async () => {
    const out = '```json\n[{"text":"老陈在写 Go","type":"fact","importance":0.6}]\n```';
    const r = await extractMemoryCandidates(fakeClient(out), messages, {});
    expect(r.candidates).toHaveLength(1);
  });

  it('过滤低重要度记忆', async () => {
    const out = JSON.stringify([
      { text: '不重要的闲聊', type: 'fact', importance: 0.1 },
      { text: '重要事实', type: 'fact', importance: 0.9 },
    ]);
    const r = await extractMemoryCandidates(fakeClient(out), messages, { minImportance: 0.4 });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.text).toBe('重要事实');
    expect(r.warnings.some((w) => w.includes('低重要度'))).toBe(true);
  });

  it('限制条数', async () => {
    const out = JSON.stringify(
      Array.from({ length: 10 }, (_, i) => ({ text: `记忆${i}`, type: 'fact', importance: 0.8 })),
    );
    const r = await extractMemoryCandidates(fakeClient(out), messages, { maxItems: 3 });
    expect(r.candidates).toHaveLength(3);
  });

  it('未知类型落到 unknown', async () => {
    const out = JSON.stringify([{ text: '某事', type: 'weird', importance: 0.8 }]);
    const r = await extractMemoryCandidates(fakeClient(out), messages, {});
    expect(r.candidates[0]!.type).toBe('unknown');
  });

  it('模型输出不是数组时给出警告', async () => {
    const r = await extractMemoryCandidates(fakeClient('我觉得没什么可记的'), messages, {});
    expect(r.candidates).toHaveLength(0);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('模型调用失败时优雅返回', async () => {
    const broken = {
      configured: true,
      complete: async () => {
        throw new Error('boom');
      },
    } as unknown as ChatClient;
    const r = await extractMemoryCandidates(broken, messages, {});
    expect(r.candidates).toHaveLength(0);
    expect(r.warnings[0]).toContain('boom');
  });
});
