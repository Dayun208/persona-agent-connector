import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '@pasc/core';
import { parsePokeEvent } from '../packages/napcat/src/parse';
import { Pipeline } from '../packages/server/src/pipeline';

describe('parsePokeEvent', () => {
  it('群里的戳一戳', () => {
    const e = parsePokeEvent({
      post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
      group_id: 123456, user_id: 10001, target_id: 20002, time: 1700000000,
    } as never);
    expect(e).toEqual({
      operatorId: '10001', targetId: '20002',
      scene: { kind: 'group', groupId: '123456' }, timestamp: 1_700_000_000_000,
    });
  });

  it('私聊的戳一戳', () => {
    const e = parsePokeEvent({
      post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
      user_id: 10001, target_id: 20002, time: 1700000000,
    } as never);
    expect(e?.scene).toEqual({ kind: 'private', userId: '10001' });
  });

  it('不是 poke 的通知返回 undefined', () => {
    expect(parsePokeEvent({ post_type: 'notice', notice_type: 'group_increase' } as never)).toBeUndefined();
    expect(parsePokeEvent({ post_type: 'message' } as never)).toBeUndefined();
  });

  it('缺 target_id 时返回 undefined', () => {
    expect(parsePokeEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 1 } as never)).toBeUndefined();
  });
});

function makePipeline(overrides: Record<string, unknown> = {}) {
  const cfg = normalizeConfig({ ...overrides });
  const judged: unknown[] = [];
  const replies: string[] = [];
  const deps = {
    getConfig: () => cfg,
    napcat: { sendText: async () => {}, selfId: '999' },
    getAgent: () => ({ send: async () => ({ text: '{"message":"好啊"}', latencyMs: 1 }) }),
    pool: {
      nextSeq: () => 1, push() {}, before: () => [], history: () => [], state: () => ({ lastReplyAt: 0 }),
      size: () => 0, markReplied() {}, markJudged() {},
    },
    builder: { build: () => ({ system: '', user: '', total: 0, chars: 0, sections: [], estimatedTokens: 0 }) },
    judge: {
      decide: async (input: { trigger: { text: string } }) => { judged.push(input); return { shouldReply: true, confidence: 0.9, reason: '被戳了', source: 'model' }; },
      passesThreshold: () => true,
    },
    guard: { check: () => ({ ok: false, reason: 'x' }), describeForPrompt: () => '' },
    archive: { append() {} },
    personas: { getActive: () => undefined, summary: () => '' },
    samples: { pick: () => [] },
    memorySearch: async () => [],
    stats: { messagesIn: 0, messagesFiltered: 0, directTriggers: 0, judgeRuns: 0, judgeHits: 0, replies: 0, executions: 0, executionRejected: 0, errors: 0, recordError() {}, recordReply() {}, recordJudge() {}, recordAgent() {}, recordPrompt() {} },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    emit: () => {},
  } as never;
  return { pipeline: new Pipeline(deps), judged, replies };
}

const poke = (target = '999', operator = '10001') => ({
  operatorId: operator, targetId: target,
  scene: { kind: 'group' as const, groupId: '123' }, timestamp: Date.now(),
});

describe('Pipeline.onPoke', () => {
  it('被戳的是机器人 → 立刻跑判断', async () => {
    const { pipeline, judged } = makePipeline();
    await pipeline.onPoke(poke());
    expect(judged).toHaveLength(1);
    expect((judged[0] as { trigger: { text: string } }).trigger.text).toContain('戳');
  });

  it('戳的不是机器人 → 不判断', async () => {
    const { pipeline, judged } = makePipeline();
    await pipeline.onPoke(poke('555'));
    expect(judged).toHaveLength(0);
  });

  it('机器人自己戳自己 → 不判断（防自激）', async () => {
    const { pipeline, judged } = makePipeline();
    await pipeline.onPoke(poke('999', '999'));
    expect(judged).toHaveLength(0);
  });

  it('开关关掉后不处理', async () => {
    const { pipeline, judged } = makePipeline({ pipeline: { replyToPoke: false } });
    await pipeline.onPoke(poke());
    expect(judged).toHaveLength(0);
  });

  it('冷却期内第二次戳不再判断', async () => {
    const { pipeline, judged } = makePipeline({ pipeline: { pokeCooldownMs: 60_000 } });
    await pipeline.onPoke(poke());
    await pipeline.onPoke(poke());
    expect(judged).toHaveLength(1);
  });
});
