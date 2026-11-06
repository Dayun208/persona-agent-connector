import { describe, expect, it } from 'vitest';
import { PromptBuilder } from '@pasc/core';
import type { PascConfig } from '@pasc/core';

const cfg = {
  base: '基础约束',
  historyLimit: 20,
  sampleLimit: 2,
  budgetChars: 12000,
  maxPromptChars: 12000,
  inject: { base: true, persona: true, samples: true, memory: true, behavior: true, history: true },
} as unknown as PascConfig['prompt'];
const builder = new PromptBuilder({ getConfig: () => cfg, guard: { describeForPrompt: () => '可用动作' } as never });

function build(devMode: boolean) {
  return builder.build({
    scene: { kind: 'group', groupId: '1' } as never,
    trigger: {
      id: 'm1', sceneKey: 'group:1', scene: { kind: 'group', groupId: '1' },
      senderId: '100', senderName: '甲', text: '在吗', timestamp: 1, seq: 1, isSelf: false,
      mentionsSelf: false, segments: [],
    } as never,
    history: [],
    reason: 'mention',
    persona: { id: 'p', name: '二小', description: 'x', content: '## 人格正文\n我是二小', updatedAt: 1 } as never,
    samples: [{ id: 's', question: 'q', answer: 'a', tags: [], createdAt: 1, source: 'x' }] as never,
    memories: [{ id: '1', text: '记忆内容', tags: [], createdAt: 1, score: 0.9, type: 'fact', importance: 0.5, accessCount: 0, lastAccessedAt: 1, keywordScore: 0, vectorScore: 0, freshness: 1 }] as never,
    actionsText: '可用动作',
    webSearch: false,
    vision: false,
    devMode,
  } as never);
}

describe('开发模式', () => {
  it('默认注入人格与样本', () => {
    const b = build(false);
    expect(b.system).toContain('我是二小');
  });

  it('开发模式下跳过人格、样本、记忆，但保留基础约束与协议', () => {
    const b = build(true);
    expect(b.system).not.toContain('我是二小');
    expect(b.system).toContain('基础约束');
    expect(b.system).toContain('输出格式');
    expect(b.sections).not.toContain('persona');
  });
});
