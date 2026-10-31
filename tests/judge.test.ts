import { describe, expect, it } from 'vitest';
import { JudgeEngine, normalizeConfig, type JudgeConfig } from '@pasc/core';
import { makeMessage } from './helpers.js';

function makeJudge(opts: { random?: () => number; judge?: Partial<JudgeConfig>; persona?: string } = {}) {
  const cfg = normalizeConfig({ judgeModel: opts.judge ?? {} }).judgeModel;
  return new JudgeEngine({
    getConfig: () => cfg,
    getClient: () => undefined, // 强制走启发式
    getPersonaSummary: () => opts.persona ?? '小明: 群里的老熟人',
    ...(opts.random ? { random: opts.random } : {}),
    logger: undefined,
  });
}

function input(text: string, over: { mentionsSelf?: boolean; lastReplyAt?: number; now?: number } = {}) {
  const msg = makeMessage({ text, mentionsSelf: over.mentionsSelf });
  return {
    scene: msg.scene,
    messages: [msg],
    trigger: msg,
    personaSummary: '小明',
    lastReplyAt: over.lastReplyAt ?? 0,
    now: over.now ?? 1_000_000,
  };
}

describe('JudgeEngine 启发式', () => {
  it('@ 我时直接放行, 不消耗模型调用', async () => {
    const engine = makeJudge();
    const d = await engine.decide(input('看看这个', { mentionsSelf: true }));
    expect(d.shouldReply).toBe(true);
    expect(d.source).toBe('bypass');
  });

  it('问句倾向回复', async () => {
    const engine = makeJudge();
    const d = await engine.decide(input('这个报错怎么解决啊'));
    expect(d.shouldReply).toBe(true);
    expect(d.confidence).toBeGreaterThanOrEqual(0.6);
    expect(d.source).toBe('heuristic');
  });

  it('无意义短句且随机不中时不回复', async () => {
    const engine = makeJudge({ random: () => 0.99 });
    const d = await engine.decide(input('哈哈哈哈'));
    expect(d.shouldReply).toBe(false);
  });

  it('随机命中时开口', async () => {
    const engine = makeJudge({ random: () => 0.0 });
    const d = await engine.decide(input('今天天气不错'));
    expect(d.shouldReply).toBe(true);
    expect(d.confidence).toBeLessThan(0.7);
  });

  it('纯表情消息不回复', async () => {
    const engine = makeJudge();
    const d = await engine.decide(input(''));
    expect(d.shouldReply).toBe(false);
  });

  it('刚回过话会压制随机开口', async () => {
    const engine = makeJudge({ random: () => 0.0 });
    const d = await engine.decide(input('随便聊聊', { lastReplyAt: 999_000, now: 1_000_000 }));
    expect(d.shouldReply).toBe(false);
  });

  it('阈值判断: 低置信度不触发', () => {
    const engine = makeJudge();
    expect(engine.passesThreshold({ shouldReply: true, confidence: 0.3, reason: '', source: 'heuristic' })).toBe(false);
    expect(engine.passesThreshold({ shouldReply: true, confidence: 0.9, reason: '', source: 'heuristic' })).toBe(true);
    expect(engine.passesThreshold({ shouldReply: false, confidence: 1, reason: '', source: 'heuristic' })).toBe(false);
  });
});
