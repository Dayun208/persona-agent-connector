import { describe, expect, it } from 'vitest';
import { analyzeStyle, heuristicPersona, spokenText } from '@pasc/core';

function msgs(texts: string[], sender = '100'): never {
  return texts.map((text, i) => ({
    id: `m${i}`,
    sceneKey: 'group:1',
    scene: { kind: 'group', groupId: '1' },
    senderId: sender,
    senderName: '测试',
    text,
    timestamp: 1_700_000_000_000 + i * 60_000,
    seq: i + 1,
    isSelf: false,
    mentionsSelf: false,
    segments: [],
  })) as never;
}

describe('spokenText', () => {
  it('去掉图片占位', () => {
    expect(spokenText('哈哈[图片]真好看')).toBe('哈哈真好看');
  });

  it('去掉 @ 与表情占位', () => {
    expect(spokenText('@123456 [动画表情] 在吗')).toContain('在吗');
    expect(spokenText('@123456 [动画表情] 在吗')).not.toContain('@123456');
  });

  it('全占位时返回空串', () => {
    expect(spokenText('[图片]').trim()).toBe('');
  });
});

describe('analyzeStyle', () => {
  it('统计条数与长度', () => {
    const stats = analyzeStyle(msgs(['今天好热啊', '不想动', '想吃冰的']));
    expect(stats.messageCount).toBe(3);
    expect(stats.avgChars).toBeGreaterThan(0);
  });

  it('识别出高频口癖', () => {
    const stats = analyzeStyle(msgs(['呃呃真的吗', '呃呃这也行', '呃呃算了']));
    expect(JSON.stringify(stats)).toContain('呃呃');
  });

  it('空输入不炸', () => {
    const stats = analyzeStyle([]);
    expect(stats.messageCount).toBe(0);
  });
});

describe('heuristicPersona', () => {
  it('没有人格模型时也能生成草稿', () => {
    const draft = heuristicPersona('二小', msgs(['呃呃这也行', '不然呢', '呃呃算了']));
    expect(draft.name).toBe('二小');
    expect(draft.content.length).toBeGreaterThan(20);
  });

  it('发言太少时给出明确提示', () => {
    const draft = heuristicPersona('二小', msgs(['在']));
    expect(draft.content.length).toBeGreaterThan(0);
  });
});
