import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '@pasc/core';
import { Pipeline } from '../packages/server/src/pipeline';

function makePipeline(admins: string[]) {
  const cfg = normalizeConfig({
    behavior: { admins },
    devMode: { ttlMs: 60_000, prefix: '#dev' },
  });
  const sent: string[] = [];
  const deps = {
    getConfig: () => cfg,
    napcat: { sendText: async (_scene: unknown, body: string) => { sent.push(body); } },
    getAgent: () => ({ send: async () => ({ text: '{}', latencyMs: 1 }) }),
    pool: { nextSeq: () => 1, push() {}, history: () => [], state: () => ({}), size: () => 0, markReplied() {}, markJudged() {} },
    builder: { build: () => ({ system: '', user: '', total: 0, chars: 0, sections: [], estimatedTokens: 0 }) },
    judge: { decide: async () => ({ shouldReply: false, confidence: 0, reason: '', source: 'heuristic' }), passesThreshold: () => false },
    guard: { check: () => ({ ok: false, reason: 'x' }), describeForPrompt: () => '' },
    archive: { append() {} },
    personas: { getActive: () => undefined, summary: () => '' },
    samples: { pick: () => [] },
    memorySearch: async () => [],
    stats: { messagesIn: 0, messagesFiltered: 0, directTriggers: 0, judgeRuns: 0, judgeHits: 0, replies: 0, executions: 0, executionRejected: 0, errors: 0, recordError() {}, recordReply() {}, recordJudge() {}, recordAgent() {}, recordPrompt() {} },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    emit: () => {},
  } as never;
  return { pipeline: new Pipeline(deps), sent };
}

const msg = (senderId: string, text: string) => ({
  id: `m-${Math.random()}`, sceneKey: 'group:1', scene: { kind: 'group', groupId: '1' },
  senderId, senderName: 'x', text, timestamp: Date.now(), seq: 1, isSelf: false,
  mentionsSelf: false, segments: [],
}) as never;

describe('开发模式命令', () => {
  it('非管理员发 #dev on 不生效也不回复', async () => {
    const { pipeline, sent } = makePipeline(['999']);
    await pipeline.ingest(msg('111', '#dev on'));
    expect(pipeline.isDevMode('group:1')).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('管理员 #dev on 生效并回复', async () => {
    const { pipeline, sent } = makePipeline(['999']);
    await pipeline.ingest(msg('999', '#dev on'));
    expect(pipeline.isDevMode('group:1')).toBe(true);
    expect(sent.join()).toContain('开发模式已开');
  });

  it('#dev off 关闭', async () => {
    const { pipeline } = makePipeline(['999']);
    await pipeline.ingest(msg('999', '#dev on'));
    await pipeline.ingest(msg('999', '#dev off'));
    expect(pipeline.isDevMode('group:1')).toBe(false);
  });

  it('#dev 无参数时返回状态与关键参数', async () => {
    const { pipeline, sent } = makePipeline(['999']);
    await pipeline.ingest(msg('999', '#dev'));
    expect(sent.join()).toContain('开发模式');
    expect(sent.join()).toContain('阈值');
  });
});

describe('@ 前缀', () => {
  it('群里 @机器人 再打命令也能识别', async () => {
    const { pipeline, sent } = makePipeline(['999']);
    await pipeline.ingest(msg('999', '@2959515696 #dev on'));
    expect(pipeline.isDevMode('group:1')).toBe(true);
    expect(sent.join()).toContain('开发模式已开');
  });

  it('不相关的 @ 消息不会被误判成命令', async () => {
    const { pipeline, sent } = makePipeline(['999']);
    await pipeline.ingest(msg('999', '@2959515696 今天吃什么'));
    expect(pipeline.isDevMode('group:1')).toBe(false);
    expect(sent.join()).not.toContain('开发模式');
  });
});
