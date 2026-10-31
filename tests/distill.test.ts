import { describe, expect, it } from 'vitest';
import {
  analyzeStyle,
  distillPersona,
  extractQaPairs,
  heuristicPersona,
  parsePersonaMarkdown,
  buildTranscript,
  extractPhrases,
  stripThinkingTrace,
  type ChatClient,
} from '@pasc/core';
import { makeMessage } from './helpers.js';

const TARGET = '10001';

function userMessages(texts: string[]) {
  return texts.map((text, i) =>
    makeMessage({ senderId: TARGET, senderName: '小明', text, timestamp: Date.now() + i * 1000 }),
  );
}

describe('analyzeStyle', () => {
  it('统计平均长度/问句率/语气词', () => {
    const stats = analyzeStyle(userMessages(['这个怎么弄啊', '我觉得还行吧', '真的吗？', '笑死我了哈哈哈哈']));
    expect(stats.messageCount).toBe(4);
    expect(stats.avgChars).toBeGreaterThan(0);
    expect(stats.questionRate).toBeGreaterThan(0);
    expect(stats.particles.length).toBeGreaterThan(0);
    expect(stats.samplePhrases.length).toBeGreaterThan(0);
  });

  it('空样本不会崩', () => {
    const stats = analyzeStyle([]);
    expect(stats.messageCount).toBe(0);
    expect(stats.avgChars).toBe(0);
  });

  it('识别表情使用', () => {
    const stats = analyzeStyle(userMessages(['好的😂', '哈哈哈😄']));
    expect(stats.emojiRate).toBeGreaterThan(0);
  });
});

describe('heuristicPersona', () => {
  it('生成带结构的人设草稿', () => {
    const draft = heuristicPersona('小明', userMessages(['在吗', '这个怎么弄啊', '我觉得还行吧']));
    expect(draft.source).toBe('heuristic');
    expect(draft.content).toContain('## 说话习惯');
    expect(draft.content).toContain('## 禁忌');
    expect(draft.description.length).toBeGreaterThan(0);
    expect(draft.description.length).toBeLessThanOrEqual(60);
  });
});

describe('parsePersonaMarkdown', () => {
  it('解析名字/简介/正文', () => {
    const parsed = parsePersonaMarkdown(
      ['# 小明', '一句话简介: 群里最爱接话的人', '', '## 性格', '- 嘴碎但无害'].join('\n'),
      'fallback',
    );
    expect(parsed!.name).toBe('小明');
    expect(parsed!.description).toBe('群里最爱接话的人');
    expect(parsed!.content).toContain('## 性格');
    expect(parsed!.content.startsWith('# 小明')).toBe(true);
  });

  it('没有简介时自动补', () => {
    const parsed = parsePersonaMarkdown('# 阿琳\n\n## 性格\n- 温和', '阿琳');
    expect(parsed!.description.length).toBeGreaterThan(0);
  });

  it('空内容返回 undefined', () => {
    expect(parsePersonaMarkdown('   ', 'x')).toBeUndefined();
  });
});

describe('distillPersona', () => {
  const pairs = extractQaPairs(
    [
      makeMessage({ senderId: '20001', senderName: '老陈', text: '这个怎么弄啊', timestamp: Date.now() }),
      makeMessage({ senderId: TARGET, senderName: '小明', text: '先装依赖再跑', timestamp: Date.now() + 3000 }),
    ],
    { targetId: TARGET },
  ).pairs;

  const messages = userMessages(['先装依赖再跑', '这个我熟']);

  const cfg = {
    api: { baseURL: '', apiKey: '', model: '', temperature: 0.4, maxTokens: 900, timeoutMs: 30_000, enableThinking: 'auto' as const },
    maxSamples: 40,
    maxChars: 9_000,
  };

  it('没有模型时回退统计草稿', async () => {
    const draft = await distillPersona(
      { target: { id: TARGET, name: '小明' }, sceneKey: 'group:1', pairs, messages },
      { getConfig: () => cfg, getClient: () => undefined },
    );
    expect(draft.source).toBe('heuristic');
    expect(draft.content.length).toBeGreaterThan(20);
  });

  it('有模型时解析模型输出', async () => {
    const fake = {
      configured: true,
      complete: async () => ({
        text: '# 小明\n一句话简介: 嘴碎的技术宅\n\n## 性格\n- 爱接话\n\n## 说话习惯\n- 短句',
        latencyMs: 1,
        model: 'fake',
      }),
    } as unknown as ChatClient;

    const draft = await distillPersona(
      { target: { id: TARGET, name: '小明' }, sceneKey: 'group:1', pairs, messages },
      { getConfig: () => cfg, getClient: () => fake },
    );
    expect(draft.source).toBe('model');
    expect(draft.name).toBe('小明');
    expect(draft.description).toContain('嘴碎');
    expect(draft.usedSamples).toBeGreaterThan(0);
  });

  it('模型调用失败时回退, 并给出 warning', async () => {
    const broken = {
      configured: true,
      complete: async () => {
        throw new Error('boom');
      },
    } as unknown as ChatClient;

    const draft = await distillPersona(
      { target: { id: TARGET, name: '小明' }, sceneKey: 'group:1', pairs, messages },
      { getConfig: () => cfg, getClient: () => broken },
    );
    expect(draft.source).toBe('heuristic');
    expect(draft.warnings.length).toBeGreaterThan(0);
  });
});

describe('buildTranscript', () => {
  it('包含片段与独立发言, 并遵守字符上限', () => {
    const pairs = extractQaPairs(
      [
        makeMessage({ senderId: '20001', senderName: '老陈', text: '怎么弄', timestamp: Date.now() }),
        makeMessage({ senderId: TARGET, senderName: '小明', text: '这样弄', timestamp: Date.now() + 1000 }),
      ],
      { targetId: TARGET },
    ).pairs;
    const { transcript } = buildTranscript(
      { target: { id: TARGET, name: '小明' }, sceneKey: 'group:1', pairs, messages: userMessages(['这样弄', '嗯嗯']) },
      { maxSamples: 10, maxChars: 200 },
    );
    expect(transcript).toContain('小明');
    expect(transcript.length).toBeLessThanOrEqual(200);
  });
});

describe('extractPhrases', () => {
  it('抽出重复出现的分句, 而不是字符二元组', () => {
    const { phrases, repeated } = extractPhrases([
      '据说挺快的, 就是文档稀烂',
      '确实, 据说挺快的',
      '据说挺快的啊',
      '我也觉得文档稀烂',
    ]);
    expect(repeated).toBe(true);
    expect(phrases).toContain('据说挺快的');
    // 不应出现跨词边界的二元组
    expect(phrases.every((p) => p.length >= 2)).toBe(true);
    expect(phrases).not.toContain('天有');
  });

  it('没有重复时退化为代表性长句', () => {
    const { phrases, repeated } = extractPhrases(['今天天气不错', '随便聊聊吧', '我在吃饭']);
    expect(repeated).toBe(false);
    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases.length).toBeLessThanOrEqual(3);
  });

  it('忽略单字分句与纯符号', () => {
    const { phrases } = extractPhrases(['好, 的, 了', '好, 的, 了']);
    expect(phrases.every((p) => p.length >= 2)).toBe(true);
  });
});

describe('heuristicPersona 输出结构', () => {
  it('保留 markdown 空行, 且样本句去重', () => {
    const draft = heuristicPersona('老陈', userMessages(['据说挺快的, 就是文档稀烂', '据说挺快的, 就是文档稀烂']));
    expect(draft.content).toContain('# 老陈\n\n>');
    expect(draft.content).toContain('\n\n## 说话习惯');
    const samples = draft.stats.samplePhrases;
    expect(new Set(samples).size).toBe(samples.length);
  });
});

describe('stripThinkingTrace', () => {
  it('剥掉 Thinking Process 段, 保留最后一个标题之后的内容', () => {
    const raw = `# 夜航

Thinking Process:
1. 分析请求
2. 提取特征

# 夜航
一句话简介: 群里的技术宅

## 性格
- 说话直接`;
    const out = stripThinkingTrace(raw);
    expect(out.startsWith('# 夜航')).toBe(true);
    expect(out).not.toContain('Thinking Process');
    expect(out).toContain('技术宅');
  });

  it('没有思维链时原样返回', () => {
    const raw = '# 小明\n\n## 性格\n- 爱接话';
    expect(stripThinkingTrace(raw)).toBe(raw);
  });

  it('剥掉代码围栏', () => {
    expect(stripThinkingTrace('```markdown\n# 小明\n```')).toBe('# 小明');
  });
});
