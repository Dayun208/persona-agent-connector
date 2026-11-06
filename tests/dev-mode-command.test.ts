import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '@pasc/core';
import { Pipeline } from '../packages/server/src/pipeline';

function makePipeline(admins: string[]) {
  const agentCalls: Array<{ system: string; user: string }> = [];
  const builtCtx: Array<{ devMode?: boolean; triggerText?: string }> = [];
  const cfg = normalizeConfig({
    behavior: { admins },
    devMode: { ttlMs: 60_000, prefix: '#dev' },
  });
  const sent: string[] = [];
  const deps = {
    getConfig: () => cfg,
    napcat: { sendText: async (_scene: unknown, body: string) => { sent.push(body); } },
    getAgent: () => ({
      send: async (req: { system: string; user: string }) => {
        agentCalls.push({ system: req.system, user: req.user });
        return { text: JSON.stringify({ message: 'ok' }), latencyMs: 1 };
      },
    }),
    pool: { nextSeq: () => 1, push() {}, before: () => [], contextBefore: () => [], history: () => [], state: () => ({}), size: () => 0, markReplied() {}, markJudged() {} },
    builder: {
      build: (ctx: { devMode?: boolean; trigger?: { text?: string } }) => {
        builtCtx.push({ devMode: ctx.devMode, triggerText: ctx.trigger?.text });
        return { system: '', user: '', total: 0, chars: 0, sections: [], estimatedTokens: 0 };
      },
    },
    judge: { decide: async () => ({ shouldReply: false, confidence: 0, reason: '', source: 'heuristic' }), passesThreshold: () => false },
    guard: { check: () => ({ ok: false, reason: 'x' }), describeForPrompt: () => '' },
    archive: { append() {} },
    personas: { getActive: () => undefined, summary: () => '' },
    samples: { pick: () => [] },
    memorySearch: async () => [],
    stats: { messagesIn: 0, messagesFiltered: 0, directTriggers: 0, judgeRuns: 0, judgeHits: 0, replies: 0, executions: 0, executionRejected: 0, errors: 0, recordError() {}, recordReply() {}, recordJudge() {}, recordAgent() {}, recordPrompt() {} },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    emit: () => {},
    statusReport: async (topic?: string) =>
      topic === 'napcat' ? 'NapCat　connected · 账号 1' : ['PASC　运行中 · 1 分钟', 'NapCat　connected', '今日　收 0 · 回复 0'].join('\n'),
  } as never;
  return { pipeline: new Pipeline(deps), sent, agentCalls, builtCtx };
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

describe('单条消息命令', () => {
  it('#dev judge <文本> 只返回判断，不改变会话状态', async () => {
    const { pipeline, sent } = makePipeline(['999']);
    await pipeline.ingest(msg('999', '#dev judge 今天天气不错'));
    await new Promise((r) => setTimeout(r, 30));
    expect(pipeline.isDevMode('group:1')).toBe(false);
    expect(sent.join()).toContain('判断');
  });

  it('#dev ask <文本> 跳过人格回答，且不改变会话状态', async () => {
    const { pipeline, agentCalls, builtCtx } = makePipeline(['999']);
    await pipeline.ingest(msg('999', '#dev ask 在吗'));
    await new Promise((r) => setTimeout(r, 60));
    expect(pipeline.isDevMode('group:1')).toBe(false);
    expect(agentCalls).toHaveLength(1);
    // 构建 Prompt 时带上了单条 devMode，且正文是命令后面的内容
    expect(builtCtx[0]!.devMode).toBe(true);
    expect(builtCtx[0]!.triggerText).toBe('在吗');
  });

  it('非管理员用单条命令不生效', async () => {
    const { pipeline, sent } = makePipeline(['999']);
    await pipeline.ingest(msg('111', '#dev judge 你好'));
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toHaveLength(0);
  });
});

describe('前缀', () => {
  it('不带 # 的裸 dev 不再生效', async () => {
    const { pipeline, sent } = makePipeline(['999']);
    await pipeline.ingest(msg('999', 'dev on'));
    expect(pipeline.isDevMode('group:1')).toBe(false);
    expect(sent.join()).not.toContain('开发模式');
  });

  it('/dev 和 !dev 也不再生效', async () => {
    const a = makePipeline(['999']);
    await a.pipeline.ingest(msg('999', '/dev on'));
    expect(a.pipeline.isDevMode('group:1')).toBe(false);

    const b = makePipeline(['999']);
    await b.pipeline.ingest(msg('999', '!dev on'));
    expect(b.pipeline.isDevMode('group:1')).toBe(false);
  });

  it('developer 这种普通单词不会被误判', async () => {
    const { pipeline, sent } = makePipeline(['999']);
    await pipeline.ingest(msg('999', 'developer 是啥意思'));
    expect(pipeline.isDevMode('group:1')).toBe(false);
    expect(sent.join()).not.toContain('开发模式');
  });

  it('@机器人 + #dev ask 走单条命令', async () => {
    const { pipeline, builtCtx } = makePipeline(['999']);
    await pipeline.ingest(msg('999', '@2959515696 #dev ask 你好'));
    await new Promise((r) => setTimeout(r, 60));
    expect(builtCtx[0]?.devMode).toBe(true);
    expect(builtCtx[0]?.triggerText).toBe('你好');
  });
});

describe('#status 命令', () => {
  it('管理员拿到真实状态报告', async () => {
    const { pipeline, sent, agentCalls } = makePipeline(['999']);
    await pipeline.ingest(msg('999', '#status'));
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.join()).toContain('PASC');
    // 状态报告不经过大模型
    expect(agentCalls).toHaveLength(0);
  });

  it('带话题只回对应项', async () => {
    const { pipeline, sent } = makePipeline(['999']);
    await pipeline.ingest(msg('999', '#status napcat'));
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.join()).toContain('NapCat');
    expect(sent.join()).not.toContain('今日');
  });

  it('非管理员不生效', async () => {
    const { pipeline, sent } = makePipeline(['999']);
    await pipeline.ingest(msg('111', '#status'));
    await new Promise((r) => setTimeout(r, 40));
    expect(sent).toHaveLength(0);
  });

  it('@机器人 后照样能用', async () => {
    const { pipeline, sent } = makePipeline(['999']);
    await pipeline.ingest(msg('999', '@2959515696 #status'));
    await new Promise((r) => setTimeout(r, 60));
    expect(sent.join()).toContain('PASC');
  });
});

describe('图片附件隔离', () => {
  it('A 会话的图不会被 B 会话的回复带走', async () => {
    const { pipeline, agentCalls } = makePipeline(['999']);
    // A 会话收到带图的消息（不会触发回复），B 会话随后正常回复
    const withImage = {
      ...(msg('111', '看这张图') as Record<string, unknown>),
      segments: [{ type: 'image', file: 'x.png' }],
    };
    await pipeline.ingest(withImage as never);
    await pipeline.ingest(msg('111', '随便说句'));
    await new Promise((r) => setTimeout(r, 60));
    // 没有任何调用带上附件
    expect(agentCalls.every((c) => !(c as { attachments?: unknown }).attachments)).toBe(true);
  });
});
