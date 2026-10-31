import { describe, expect, it } from 'vitest';
import { extractAssistantText } from '@pasc/agent';

describe('extractAssistantText', () => {
  it('数组 content', () => {
    const msg = { role: 'assistant', content: [{ type: 'text', text: '等于' }, { type: 'text', text: '2嘛' }] };
    expect(extractAssistantText(msg)).toBe('等于2嘛');
  });

  it('字符串 content', () => {
    expect(extractAssistantText({ content: '直接是字符串' })).toBe('直接是字符串');
  });

  it('忽略非文本段', () => {
    const msg = { content: [{ type: 'image', url: 'x' }, { type: 'text', text: '有用' }] };
    expect(extractAssistantText(msg)).toBe('有用');
  });

  it('异常输入返回空串', () => {
    expect(extractAssistantText(undefined)).toBe('');
    expect(extractAssistantText(null)).toBe('');
    expect(extractAssistantText('字符串')).toBe('');
    expect(extractAssistantText({})).toBe('');
  });
});
