import { describe, expect, it } from 'vitest';
import { parseAgentOutput, splitForHumanStyle, stripBlockedCommands } from '@pasc/core';

describe('parseAgentOutput', () => {
  it('解析标准 JSON', () => {
    const out = parseAgentOutput('{"message":"你好啊","execution":{"action":"send_image","params":{"url":"https://x/y.png"}}}');
    expect(out.messages).toEqual(['你好啊']);
    expect(out.executions).toHaveLength(1);
    expect(out.executions[0]?.action).toBe('send_image');
    expect(out.executions[0]?.params.url).toBe('https://x/y.png');
    expect(out.usedFallback).toBe(false);
  });

  it('剥掉 markdown 代码块', () => {
    const out = parseAgentOutput('```json\n{"message":"OK"}\n```');
    expect(out.messages).toEqual(['OK']);
    expect(out.warnings).toHaveLength(0);
  });

  it('容忍 JSON 前后的废话', () => {
    const out = parseAgentOutput('好的, 这就是回复:\n{"message":"笑死"}\n希望有帮助!');
    expect(out.messages).toEqual(['笑死']);
  });

  it('支持 messages 数组(分段连发)', () => {
    const out = parseAgentOutput('{"messages":["先说一句","再说一句"]}');
    expect(out.messages).toEqual(['先说一句', '再说一句']);
  });

  it('支持 execution 数组', () => {
    const out = parseAgentOutput(
      '{"message":"都办好了","execution":[{"action":"send_image","params":{"url":"a"}},{"action":"poke","params":{"userId":"1"}}]}',
    );
    expect(out.executions.map((e) => e.action)).toEqual(['send_image', 'poke']);
  });

  it('空 message 表示不发言', () => {
    const out = parseAgentOutput('{"message":""}');
    expect(out.messages).toHaveLength(0);
    expect(out.executions).toHaveLength(0);
  });

  it('完全不是 JSON 时兜底为纯文本', () => {
    const out = parseAgentOutput('我觉得这个方案不太行');
    expect(out.messages).toEqual(['我觉得这个方案不太行']);
    expect(out.usedFallback).toBe(true);
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it('字符串字面量也当消息', () => {
    const out = parseAgentOutput('"就这?"');
    expect(out.messages).toEqual(['就这?']);
  });

  it('裸 action 对象(没有 message)也能识别', () => {
    const out = parseAgentOutput('{"action":"recall","params":{}}');
    expect(out.executions).toHaveLength(1);
    expect(out.messages).toHaveLength(0);
  });
});

describe('stripBlockedCommands', () => {
  const blocked = ['/status', '/reset'];

  it('屏蔽指定指令', () => {
    expect(stripBlockedCommands('/status 看看', blocked)).toEqual({ text: '', stripped: true });
  });

  it('不误伤普通消息', () => {
    expect(stripBlockedCommands('/etc 是配置目录', blocked).stripped).toBe(false);
    expect(stripBlockedCommands('今天 /status 好像挂了', blocked).stripped).toBe(false);
  });
});

describe('splitForHumanStyle', () => {
  it('单行不拆', () => {
    expect(splitForHumanStyle('一句话就说完')).toEqual(['一句话就说完']);
  });

  it('按空行/换行拆成多条', () => {
    expect(splitForHumanStyle('第一句\n第二句\n第三句')).toEqual(['第一句', '第二句', '第三句']);
  });

  it('超过上限的部分合并到最后一条', () => {
    const parts = splitForHumanStyle('1\n2\n3\n4\n5', 3);
    expect(parts).toHaveLength(3);
    expect(parts[2]).toBe('3\n4\n5');
  });
});
