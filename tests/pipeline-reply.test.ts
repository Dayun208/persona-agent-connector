import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '@pasc/core';
import { Pipeline } from '../packages/server/src/pipeline';

/** 按顺序返回预设输出的假 Agent */
function makePipeline(outputs: string[], overrides: Record<string, unknown> = {}) {
  const cfg = normalizeConfig({
    openclaw: { transport: 'mock' },
    ...overrides,
  });
  const calls: Array<{ system: string; user: string }> = [];
  const sent: string[] = [];
  const deps = {
    getConfig: () => cfg,
    napcat: { sendText: async (_s: unknown, text: string) => { sent.push(text); }, selfId: '999' },
    getAgent: () => ({
      send: async (req: { system: string; user: string }) => {
        calls.push({ system: req.system, user: req.user });
        const text = outputs[Math.min(calls.length - 1, outputs.length - 1)] ?? '{"message":""}';
        return { text, latencyMs: 1 };
      },
    }),
    pool: {
      nextSeq: () => 1, push() {}, before: () => [], history: () => [], state: () => ({ lastReplyAt: 0 }),
      size: () => 0, markReplied() {}, markJudged() {},
    },
    builder: { build: () => ({ system: 'SYS', user: 'USER', total: 0, chars: 0, sections: [], estimatedTokens: 0 }) },
    judge: { decide: async () => ({ shouldReply: true, confidence: 0.99, reason: '@ 了我', source: 'model' }), passesThreshold: () => true },
    guard: { check: () => ({ ok: false, reason: 'x' }), describeForPrompt: () => '' },
    archive: { append() {} },
    personas: { getActive: () => undefined, summary: () => '' },
    samples: { pick: () => [] },
    memorySearch: async () => [],
    stats: {
      messagesIn: 0, messagesFiltered: 0, directTriggers: 0, judgeRuns: 0, judgeHits: 0, replies: 0,
      executions: 0, executionRejected: 0, errors: 0,
      recordError() {}, recordReply() {}, recordJudge() {}, recordAgent() {}, recordPrompt() {},
    },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    emit: () => {},
  } as never;
  return { pipeline: new Pipeline(deps), calls, sent };
}

const mention = (text = '在吗') => ({
  id: `m-${Math.random()}`, sceneKey: 'group:1', scene: { kind: 'group' as const, groupId: '1' },
  senderId: '10001', senderName: '甲', text, timestamp: Date.now(), seq: 1,
  isSelf: false, mentionsSelf: true, atTargets: ['999'], segments: [],
}) as never;

describe('被 @ 时不许沉默', () => {
  it('首次空输出会带提示重试，第二次有内容就发送', async () => {
    const { pipeline, calls, sent } = makePipeline(['{"message":""}', '{"message":"在的"}']);
    await pipeline.ingest(mention());
    expect(calls).toHaveLength(2);
    expect(calls[1]!.system).toContain('必须回应');
    expect(sent.join()).toContain('在的');
  });

  it('重试还是空就不发消息（至少不刷屏）', async () => {
    const { pipeline, calls, sent } = makePipeline(['{"message":""}', '{"message":""}']);
    await pipeline.ingest(mention());
    expect(calls).toHaveLength(2);
    expect(sent).toHaveLength(0);
  });

  it('首次就正常回复时不重试', async () => {
    const { pipeline, calls } = makePipeline(['{"message":"在的"}']);
    await pipeline.ingest(mention());
    expect(calls).toHaveLength(1);
  });

  it('没被 @ 的消息不会走"必须回应"重试', async () => {
    const { pipeline, calls } = makePipeline(['{"message":""}']);
    await pipeline.ingest({ ...(mention() as object), mentionsSelf: false, atTargets: [] } as never);
    // 没点名时是否回复由判断节流决定，这里只确认不会出现"重试用的第二次调用"
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});
