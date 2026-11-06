import { describe, expect, it } from 'vitest';
import { extractJsonValue, stripCodeFence } from '@pasc/core';

describe('extractJsonValue', () => {
  it('裸对象', () => {
    expect(extractJsonValue('{"a":1}')).toEqual({ a: 1 });
  });

  it('代码块包裹', () => {
    expect(extractJsonValue('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('前后有废话', () => {
    expect(extractJsonValue('好的：\n{"a":1}\n以上')).toEqual({ a: 1 });
  });

  it('从数组里提出完整数组，而不是第一个对象', () => {
    const v = extractJsonValue('[{"a":1},{"b":2}]');
    expect(Array.isArray(v)).toBe(true);
    expect((v as unknown[]).length).toBe(2);
  });

  it('带废话的数组', () => {
    const v = extractJsonValue('结果如下：\n[{"a":1}]\n以上。');
    expect(Array.isArray(v)).toBe(true);
  });

  it('字符串里的括号不会打乱配对', () => {
    expect(extractJsonValue('{"a":"} 不是结尾"}')).toEqual({ a: '} 不是结尾' });
  });
});

describe('stripCodeFence', () => {
  it('去掉 json 围栏', () => {
    expect(stripCodeFence('```json\n[]\n```')).toBe('[]');
  });

  it('没有围栏时原样返回', () => {
    expect(stripCodeFence('[]')).toBe('[]');
  });
});
