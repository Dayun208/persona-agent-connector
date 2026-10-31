import { describe, expect, it } from 'vitest';
import { MessagePool, estimateTokens, shouldRunJudge, type SceneState } from '@pasc/core';
import { makeMessage, makeMessages } from './helpers.js';

describe('MessagePool', () => {
  it('按场景隔离并保持容量上限', () => {
    const pool = new MessagePool(3);
    const msgs = makeMessages(['a', 'b', 'c', 'd']);
    for (const m of msgs) pool.push(m);

    expect(pool.size('group:123456')).toBe(3);
    expect(pool.history('group:123456').map((m) => m.text)).toEqual(['b', 'c', 'd']);
    expect(pool.history('group:999999')).toEqual([]);
  });

  it('contextBefore 不含最后一条', () => {
    const pool = new MessagePool(10);
    makeMessages(['1', '2', '3']).forEach((m) => pool.push(m));
    expect(pool.contextBefore('group:123456').map((m) => m.text)).toEqual(['1', '2']);
  });

  it('markJudged 会清零累积计数并记录时间', () => {
    const pool = new MessagePool(10);
    makeMessages(['1', '2', '3']).forEach((m) => pool.push(m));
    const state = pool.state('group:123456');
    expect(state.newSinceJudge).toBe(3);

    pool.markJudged('group:123456', 1000);
    expect(state.newSinceJudge).toBe(0);
    expect(state.lastJudgeAt).toBe(1000);
    expect(state.judged).toBe(1);
  });

  it('seq 全局自增', () => {
    const pool = new MessagePool(10);
    expect(pool.nextSeq()).toBe(1);
    expect(pool.nextSeq()).toBe(2);
  });
});

describe('shouldRunJudge', () => {
  const baseState = (over: Partial<SceneState> = {}): SceneState => ({
    sceneKey: 'group:1',
    totalMessages: 10,
    newSinceJudge: 0,
    judged: 0,
    replied: 0,
    lastMessageAt: 0,
    lastJudgeAt: 0,
    lastReplyAt: 0,
    busy: false,
    ...over,
  });
  const gate = { everyN: 4, intervalMs: 5_000, minMessages: 2 };

  it('消息不够不判断', () => {
    expect(shouldRunJudge(baseState({ newSinceJudge: 9 }), gate, 1, 10_000)).toBe(false);
  });

  it('新消息没攒够不判断', () => {
    expect(shouldRunJudge(baseState({ newSinceJudge: 3 }), gate, 10, 10_000)).toBe(false);
  });

  it('间隔不够不判断', () => {
    expect(shouldRunJudge(baseState({ newSinceJudge: 5, lastJudgeAt: 9_000 }), gate, 10, 10_000)).toBe(false);
  });

  it('busy 时不再判断', () => {
    expect(shouldRunJudge(baseState({ newSinceJudge: 5, busy: true }), gate, 10, 10_000)).toBe(false);
  });

  it('条件齐备时判断', () => {
    expect(shouldRunJudge(baseState({ newSinceJudge: 5, lastJudgeAt: 1_000 }), gate, 10, 10_000)).toBe(true);
  });
});

describe('estimateTokens', () => {
  it('中文按字计, 英文按 4 字符计', () => {
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('hello')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('MessagePool.restore', () => {
  it('预热窗口但不触发判断', async () => {
    const { MessagePool: Pool } = await import('@pasc/core');
    const pool = new Pool(10);
    const history = makeMessages(['早', '在吗', '在的']);
    history.forEach((m) => (m.seq = 100 + (m.seq || 0)));
    pool.restore(history);

    expect(pool.history('group:123456').map((m) => m.text)).toEqual(['早', '在吗', '在的']);
    expect(pool.state('group:123456').newSinceJudge).toBe(0);
    // 序号接着历史走, 不会和旧消息撞号
    expect(pool.nextSeq()).toBeGreaterThan(100);
  });
});

describe('reply 触发判定', () => {
  it('引用机器人的消息应被视为直接触发', async () => {
    const sent = [{ messageId: '1024' }];
    const msg = { segments: [{ type: 'reply' as const, messageId: '1024' }, { type: 'text' as const, text: '怎么说' }] };
    const isReplyToSelf = (m: { segments: Array<{ type: string; messageId?: string }> }, s: Array<{ messageId: string }>) => {
      const seg = m.segments.find((x) => x.type === 'reply');
      return Boolean(seg?.messageId) && s.some((r) => r.messageId === seg?.messageId);
    };
    expect(isReplyToSelf(msg, sent)).toBe(true);
    expect(isReplyToSelf(msg, [{ messageId: '999' }])).toBe(false);
    expect(isReplyToSelf({ segments: [{ type: 'text' }] }, sent)).toBe(false);
  });
});
