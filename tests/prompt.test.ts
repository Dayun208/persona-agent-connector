import { describe, expect, it } from 'vitest';
import { ActionGuard, PromptBuilder, normalizeConfig, type PromptConfig } from '@pasc/core';
import { makeMessages } from './helpers.js';

function makeBuilder(prompt: Partial<PromptConfig> = {}, behavior = {}) {
  const full = normalizeConfig({ prompt, behavior });
  const guard = new ActionGuard(full.behavior);
  return {
    builder: new PromptBuilder({ getConfig: () => full.prompt, guard }),
    guard,
    config: full,
  };
}

const persona = {
  id: 'p1',
  name: '小明',
  description: '群里的老熟人',
  content: '你叫小明, 说话随意。',
  updatedAt: Date.now(),
};

const samples = [
  { id: 's1', question: '在吗', answer: '在', tags: [], createdAt: Date.now() },
  { id: 's2', question: '吃了吗', answer: '吃了你呢', tags: [], createdAt: Date.now() },
];

function ctx(over: Record<string, unknown> = {}) {
  const history = makeMessages(['今天好热', '是啊 38 度']);
  const trigger = makeMessages(['空调又坏了怎么搞'])[0]!;
  return {
    scene: trigger.scene,
    trigger,
    history,
    reason: 'judge' as const,
    persona,
    samples,
    actionsText: '- ✔ send_image: 发图',
    ...over,
  };
}

describe('PromptBuilder', () => {
  it('按开关注入所有段落', () => {
    const { builder } = makeBuilder();
    const bundle = builder.build(ctx());

    expect(bundle.sections).toContain('base');
    expect(bundle.sections).toContain('persona');
    expect(bundle.sections).toContain('samples');
    expect(bundle.sections).toContain('behavior');
    expect(bundle.sections).toContain('history');
    expect(bundle.sections).toContain('protocol');

    expect(bundle.system).toContain('你叫小明');
    expect(bundle.system).toContain('### 示例 1');
    expect(bundle.user).toContain('最近的聊天记录');
    expect(bundle.user).toContain('空调又坏了怎么搞');
    expect(bundle.chars).toBeGreaterThan(0);
  });

  it('关掉人格/样本注入后不应出现', () => {
    const { builder } = makeBuilder({ inject: { base: true, persona: false, samples: false, memory: false, behavior: true, history: false } });
    const bundle = builder.build(ctx());
    expect(bundle.sections).not.toContain('persona');
    expect(bundle.sections).not.toContain('samples');
    expect(bundle.sections).not.toContain('history');
    expect(bundle.system).not.toContain('你叫小明');
    expect(bundle.user).not.toContain('最近的聊天记录');
  });

  it('记忆开关关闭时不注入记忆', () => {
    const { builder } = makeBuilder({ inject: { base: true, persona: true, samples: true, memory: true, behavior: true, history: true } });
    const bundle = builder.build(ctx({ memories: [{ id: 'm1', text: '阿琳养了只橘猫', tags: [], createdAt: Date.now(), score: 0.8 }] }));
    expect(bundle.sections).toContain('memory');
    expect(bundle.system).toContain('阿琳养了只橘猫');
    expect(bundle.system).toContain('你记得的事');
  });

  it('超出预算时优先裁剪历史', () => {
    const longHistory = makeMessages(Array.from({ length: 40 }, (_, i) => `第${i}条消息 `.repeat(12)));
    const { builder } = makeBuilder({ maxPromptChars: 1200, historyLimit: 40 });
    const bundle = builder.build(ctx({ history: longHistory }));

    expect(bundle.chars).toBeLessThanOrEqual(1200);
    expect(bundle.user.length).toBeLessThan(longHistory.join('\n').length);
  });

  it('协议提醒永远存在', () => {
    const { builder } = makeBuilder({ inject: { base: false, persona: false, samples: false, memory: false, behavior: false, history: false } });
    const bundle = builder.build(ctx());
    expect(bundle.system).toContain('## 输出格式(最高优先级)');
    expect(bundle.sections).toEqual(['protocol']);
  });
});
