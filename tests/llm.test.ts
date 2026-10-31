import { describe, expect, it } from 'vitest';
import { isLocalEndpoint, shouldDisableThinking, normalizeConfig } from '@pasc/core';

describe('思考开关', () => {
  it('识别本机端点', () => {
    expect(isLocalEndpoint('http://127.0.0.1:8000/v1')).toBe(true);
    expect(isLocalEndpoint('http://localhost:11434/v1')).toBe(true);
    expect(isLocalEndpoint('https://api.deepseek.com/v1')).toBe(false);
    expect(isLocalEndpoint('not-a-url')).toBe(false);
  });

  it('auto 只对本机端点关思考', () => {
    expect(shouldDisableThinking({ baseURL: 'http://127.0.0.1:8000/v1', enableThinking: 'auto' })).toBe(true);
    expect(shouldDisableThinking({ baseURL: 'https://api.deepseek.com', enableThinking: 'auto' })).toBe(false);
  });

  it('显式 on/off 优先', () => {
    expect(shouldDisableThinking({ baseURL: 'https://api.deepseek.com', enableThinking: 'off' })).toBe(true);
    expect(shouldDisableThinking({ baseURL: 'http://127.0.0.1:8000/v1', enableThinking: 'on' })).toBe(false);
  });

  it('配置里默认是 auto', () => {
    expect(normalizeConfig({}).distill.api.enableThinking).toBe('auto');
    expect(normalizeConfig({}).judgeModel.api.enableThinking).toBe('auto');
  });

  it('提纯默认超时放宽到 120 秒', () => {
    expect(normalizeConfig({}).distill.api.timeoutMs).toBe(120_000);
    expect(normalizeConfig({}).judgeModel.api.timeoutMs).toBe(30_000);
  });
});
