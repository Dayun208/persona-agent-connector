import { describe, expect, it } from 'vitest';
import { buildExportFilename, pairsToFewShotText, pairsToJson, pairsToPromptBlock, type QaPair } from '@pasc/core';

const pair = (i: number): QaPair => ({
  id: `p${i}`,
  sceneKey: 'group:123456',
  asker: { id: '20001', name: '老陈' },
  target: { id: '10001', name: '小明' },
  question: `问题 ${i}`,
  answer: `回答 ${i}`,
  questionAt: 1_700_000_000_000 + i,
  answerAt: 1_700_000_001_000 + i,
  link: 'adjacent',
  role: 'answerer',
  score: 0.5,
});

describe('pairsToFewShotText', () => {
  it('带头部与成对样本', () => {
    const text = pairsToFewShotText([pair(1), pair(2)], { targetName: '小明', sceneKey: 'group:1' });
    expect(text).toContain('# PASC few-shot 样本');
    expect(text).toContain('# 目标人格: 小明');
    expect(text).toContain('# 条数: 2');
    expect(text).toContain('### 示例 1');
    expect(text).toContain('有人: 问题 1');
    expect(text).toContain('你: 回答 1');
    expect(text.trimEnd().endsWith('你: 回答 2')).toBe(true);
  });

  it('可以关闭头部', () => {
    const text = pairsToFewShotText([pair(1)], { includeHeader: false });
    expect(text.startsWith('### 示例 1')).toBe(true);
  });

  it('空列表也能导出', () => {
    const text = pairsToFewShotText([], { includeHeader: false });
    expect(text.trim()).toBe('');
  });
});

describe('pairsToJson / pairsToPromptBlock', () => {
  it('JSON 可再解析', () => {
    const json = JSON.parse(pairsToJson([pair(1)])) as { pairs: QaPair[] };
    expect(json.pairs).toHaveLength(1);
    expect(json.pairs[0]!.question).toBe('问题 1');
  });

  it('Prompt 片段限制条数', () => {
    const block = pairsToPromptBlock([pair(1), pair(2), pair(3)], 2);
    expect(block).toContain('示例 1');
    expect(block).toContain('示例 2');
    expect(block).not.toContain('示例 3');
  });
});

describe('buildExportFilename', () => {
  it('清洗非法字符', () => {
    expect(buildExportFilename('小 明/测试', 'txt')).toMatch(/^pasc-fewshot-小_明_测试-\d{4}-\d{2}-\d{2}\.txt$/);
  });

  it('空名字有兜底', () => {
    expect(buildExportFilename('///', 'json')).toContain('persona');
    expect(buildExportFilename('', 'json')).toContain('persona');
  });
});
