import { describe, expect, it } from 'vitest';
import { extractQaPairs, groupUtterances, isMeaningfulText, scorePair } from '@pasc/core';
import { makeMessage } from './helpers.js';

const TARGET = '10001';
const OTHER = '20001';

function msg(senderId: string, text: string, offsetSec: number, extra: Record<string, unknown> = {}) {
  const base = Date.now();
  return makeMessage({
    senderId,
    senderName: senderId === TARGET ? '小明' : '老陈',
    text,
    timestamp: base + offsetSec * 1000,
    ...(extra as object),
  });
}

describe('groupUtterances', () => {
  it('同一人短时间连发合并成一段', () => {
    const msgs = [msg(OTHER, '在吗', 0), msg(OTHER, '问你个事', 3), msg(OTHER, '很急', 6)];
    const utt = groupUtterances(msgs, 15_000);
    expect(utt).toHaveLength(1);
    expect(utt[0]!.text).toBe('在吗\n问你个事\n很急');
    expect(utt[0]!.messageIds).toHaveLength(3);
  });

  it('超过合并窗口就断开', () => {
    const msgs = [msg(OTHER, '一', 0), msg(OTHER, '二', 30)];
    expect(groupUtterances(msgs, 15_000)).toHaveLength(2);
  });

  it('不同人不合并', () => {
    const msgs = [msg(OTHER, '一', 0), msg(TARGET, '二', 1)];
    expect(groupUtterances(msgs, 15_000)).toHaveLength(2);
  });
});

describe('isMeaningfulText', () => {
  it('过滤纯表情/图片', () => {
    expect(isMeaningfulText('[图片]')).toBe(false);
    expect(isMeaningfulText('[表情][表情]')).toBe(false);
  });
  it('保留正常文字', () => {
    expect(isMeaningfulText('在的')).toBe(true);
  });
  it('尊重最小长度', () => {
    expect(isMeaningfulText('嗯', 2)).toBe(false);
    expect(isMeaningfulText('嗯嗯', 2)).toBe(true);
  });
});

describe('extractQaPairs', () => {
  it('相邻发言配对成功', () => {
    const msgs = [msg(OTHER, '这个报错怎么解决啊', 0), msg(TARGET, '装依赖了吗, 重装试试', 8)];
    const r = extractQaPairs(msgs, { targetId: TARGET });
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.question).toBe('这个报错怎么解决啊');
    expect(r.pairs[0]!.answer).toBe('装依赖了吗, 重装试试');
    expect(r.pairs[0]!.link).toBe('adjacent');
    expect(r.pairs[0]!.role).toBe('answerer');
  });

  it('显式回复优先', () => {
    const q = msg(OTHER, '周末去哪玩', 0);
    const noise = msg('30003', '我投一票', 1);
    const a = makeMessage({
      senderId: TARGET,
      senderName: '小明',
      text: '爬山吧',
      timestamp: Date.now() + 5_000,
      segments: [
        { type: 'reply', messageId: q.id },
        { type: 'text', text: '爬山吧' },
      ],
    });
    const r = extractQaPairs([q, noise, a], { targetId: TARGET });
    expect(r.pairs[0]!.question).toBe('周末去哪玩');
    expect(r.pairs[0]!.link).toBe('reply');
  });

  it('@ 指定对象时优先找那个人的话', () => {
    const a1 = msg(OTHER, '随便说一句', 0);
    const q2 = msg('30003', '阿琳你猫呢', 2);
    const answer = msg(TARGET, '@30003 在睡觉', 5, { atTargets: ['30003'] });
    const r = extractQaPairs([a1, q2, answer], { targetId: TARGET });
    expect(r.pairs[0]!.question).toBe('阿琳你猫呢');
    expect(r.pairs[0]!.link).toBe('at');
  });

  it('纯表情回答会被丢弃', () => {
    const msgs = [msg(OTHER, '在吗', 0), msg(TARGET, '[图片]', 3)];
    const r = extractQaPairs(msgs, { targetId: TARGET });
    expect(r.pairs).toHaveLength(0);
    expect(r.stats.rejected).toBeGreaterThan(0);
  });

  it('超时窗口外的不配对', () => {
    const msgs = [msg(OTHER, '老早的问题', 0), msg(TARGET, '迟到的回答', 3600)];
    const r = extractQaPairs(msgs, { targetId: TARGET, windowMs: 60_000 });
    expect(r.pairs).toHaveLength(0);
  });

  it('目标用户连续发言不会自己问自己', () => {
    const msgs = [msg(OTHER, '问题', 0), msg(TARGET, '答案一', 2), msg(TARGET, '答案二', 4)];
    const r = extractQaPairs(msgs, { targetId: TARGET });
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.answer).toContain('答案二');
  });

  it('反向提取: 目标提问、别人回答', () => {
    const q = msg(TARGET, '@20001 你这个怎么弄的', 0, { atTargets: ['20001'] });
    const a = msg(OTHER, '这样这样再那样', 10);
    const r = extractQaPairs([q, a], { targetId: TARGET, includeTargetAsks: true });
    expect(r.pairs.some((p) => p.role === 'asker')).toBe(true);
  });

  it('maxPairs 生效且按分数排序', () => {
    const msgs = [];
    for (let i = 0; i < 10; i += 1) {
      msgs.push(msg(OTHER, `问题 ${i}?`, i * 30));
      msgs.push(msg(TARGET, `回答 ${i}`, i * 30 + 5));
    }
    const r = extractQaPairs(msgs, { targetId: TARGET, maxPairs: 3 });
    expect(r.pairs).toHaveLength(3);
    const scores = r.pairs.map((p) => p.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});

describe('scorePair', () => {
  it('带问号的提问得分更高', () => {
    const a = { senderId: OTHER, senderName: 'a', text: '随便说说', messageIds: [], timestamp: 0, atTargets: [] };
    const q = { ...a, text: '这个怎么解决?' };
    const ans = { senderId: TARGET, senderName: 'b', text: '这样这样这样', messageIds: [], timestamp: 1, atTargets: [] };
    expect(scorePair(q, ans, 'adjacent')).toBeGreaterThan(scorePair(a, ans, 'adjacent'));
  });

  it('过短回答扣分', () => {
    const q = { senderId: OTHER, senderName: 'a', text: '怎么弄', messageIds: [], timestamp: 0, atTargets: [] };
    const short = { senderId: TARGET, senderName: 'b', text: '嗯', messageIds: [], timestamp: 1, atTargets: [] };
    const normal = { ...short, text: '这样弄就行了' };
    expect(scorePair(q, short, 'adjacent')).toBeLessThan(scorePair(q, normal, 'adjacent'));
  });
});

describe('机器人自身发言的处理', () => {
  it('不把机器人的接话当成提问', () => {
    const base = Date.now();
    const bot = makeMessage({ senderId: '99999', senderName: '我', text: '要不要我帮你们看看', isSelf: true, timestamp: base });
    const human = makeMessage({ senderId: '20001', senderName: '老陈', text: '这个怎么弄', timestamp: base + 1_000 });
    const answer = makeMessage({ senderId: TARGET, senderName: '小明', text: '这样弄就行了', timestamp: base + 2_000 });
    const r = extractQaPairs([bot, human, answer], { targetId: TARGET });
    expect(r.pairs[0]!.question).toBe('这个怎么弄');
  });

  it('目标就是机器人自己时保留其发言', () => {
    const base = Date.now();
    const human = makeMessage({ senderId: '20001', senderName: '老陈', text: '在吗', timestamp: base });
    const bot = makeMessage({ senderId: '99999', senderName: '我', text: '在的', isSelf: true, timestamp: base + 1_000 });
    const r = extractQaPairs([human, bot], { targetId: '99999' });
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.answer).toBe('在的');
  });
});

describe('去重', () => {
  it('相同问答只保留一条', () => {
    const base = Date.now();
    const make = (offset: number) => [
      makeMessage({ senderId: '20001', senderName: '老陈', text: '怎么弄', timestamp: base + offset }),
      makeMessage({ senderId: TARGET, senderName: '小明', text: '这样弄', timestamp: base + offset + 1000 }),
    ];
    const r = extractQaPairs([...make(0), ...make(60_000)], { targetId: TARGET });
    expect(r.pairs).toHaveLength(1);
  });

  it('不同问答都保留', () => {
    const base = Date.now();
    const msgs = [
      makeMessage({ senderId: '20001', senderName: '老陈', text: '问题一', timestamp: base }),
      makeMessage({ senderId: TARGET, senderName: '小明', text: '回答一', timestamp: base + 1000 }),
      makeMessage({ senderId: '20001', senderName: '老陈', text: '问题二', timestamp: base + 2000 }),
      makeMessage({ senderId: TARGET, senderName: '小明', text: '回答二', timestamp: base + 3000 }),
    ];
    expect(extractQaPairs(msgs, { targetId: TARGET }).pairs).toHaveLength(2);
  });
});
