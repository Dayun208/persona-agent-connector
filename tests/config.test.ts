import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, deepMerge, normalizeConfig, resolveEndpoint } from '@pasc/core';
import { findUnknownConfigKeys } from '@pasc/core';

describe('配置', () => {
  it('空配置也能补全成完整配置', () => {
    const cfg = normalizeConfig({});
    expect(cfg.server.port).toBe(7788);
    expect(cfg.napcat.protocol).toBe('ws');
    expect(cfg.judgeModel.messagePoolCapacity).toBe(60);
    expect(cfg.prompt.base.length).toBeGreaterThan(100);
    expect(cfg.behavior.blockedCommands).toContain('/status');
  });

  it('局部覆盖不影响其它字段', () => {
    const cfg = normalizeConfig({ napcat: { protocol: 'http' }, behavior: { allowFileSend: true } });
    expect(cfg.napcat.protocol).toBe('http');
    expect(cfg.napcat.address).toBe(DEFAULT_CONFIG.napcat.address);
    expect(cfg.behavior.allowFileSend).toBe(true);
    expect(cfg.behavior.allowGroupManage).toBe(true);
  });

  it('类型错误会抛出可读错误', () => {
    expect(() => normalizeConfig({ server: { port: 'not-a-number' } })).toThrow(/配置校验失败/);
  });

  it('deepMerge 递归合并对象、整体替换数组', () => {
    const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
    expect(merged).toEqual({ a: { b: 1, c: 3 }, list: [9] });
  });

  it('未知字段不会破坏配置', () => {
    const cfg = normalizeConfig({ unknownTop: 1, napcat: { unknown: true } });
    expect(cfg.napcat.protocol).toBe('ws');
  });
});

describe('resolveEndpoint', () => {
  it('补齐 /v1/chat/completions', () => {
    expect(resolveEndpoint('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(resolveEndpoint('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('已经是完整端点时原样返回', () => {
    expect(resolveEndpoint('https://x.com/v1/chat/completions/')).toBe('https://x.com/v1/chat/completions');
  });
});

describe('findUnknownConfigKeys', () => {
  it('拼错的顶层键能被发现', () => {
    expect(findUnknownConfigKeys({ vison: {} })).toContain('vison');
  });

  it('嵌套层级拼错也能发现', () => {
    const keys = findUnknownConfigKeys({ vision: { api: { modle: 'x' } } });
    expect(keys).toContain('vision.api.modle');
  });

  it('合法配置不报未知键', () => {
    expect(findUnknownConfigKeys({ vision: { enabled: true }, behavior: { allowPoke: false } })).toEqual([]);
  });
});
