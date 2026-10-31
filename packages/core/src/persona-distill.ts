import type { ChatMessage } from './types.js';
import type { DistillConfig } from './config.js';
import type { ChatClient } from './llm.js';
import type { Logger } from './logger.js';
import type { QaPair } from './extractor.js';
import { isMeaningfulText } from './extractor.js';
import { truncate } from './text.js';

/**
 * 人格提纯 —— 把一堆聊天记录变成一段可注入 Prompt 的人格描述。
 *
 * 两条路径:
 *   1. 配了提取模型 → 让模型读样本、写人设(质量好)
 *   2. 没配 → 用统计特征生成一份"草稿人设"(离线可用, 给人一个改的起点)
 *
 * 无论哪条路径, 输出都是同一种 markdown 结构, 保证 Prompt 构建器不用关心来源。
 */

export interface PersonaStats {
  messageCount: number;
  avgChars: number;
  questionRate: number;
  exclaimRate: number;
  emojiRate: number;
  /** 高频/代表性说法(按整句片段统计, 不是字符二元组) */
  topPhrases: string[];
  /** 这些说法是否是"重复出现"的(true)还是"较长但只出现一次"的(false) */
  phrasesRepeated: boolean;
  /** 高频开头 */
  topOpeners: string[];
  /** 常用语气词 */
  particles: string[];
  /** 代表性短句(已去重) */
  samplePhrases: string[];
}

export interface PersonaDraft {
  name: string;
  description: string;
  /** markdown 正文 */
  content: string;
  source: 'model' | 'heuristic';
  stats: PersonaStats;
  usedSamples: number;
  warnings: string[];
}

const PARTICLES = ['啊', '吧', '呢', '吗', '哈', '呀', '哦', '嘛', '咯', '啦', '呗', 'emmm', 'hhh'];
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const PUNCT = /[\s\u3000-\u303f\uff00-\uffef!-/:-@[-`{-~]/g;
const CLAUSE_SPLIT = /[，,。.！!？?；;：:、\s]+/;

/** 去掉 [图片] 之类的占位符, 只留真正说出口的内容 */
export function spokenText(text: string): string {
  return text.replace(/\[[^\]]*\]/g, '').trim();
}

/**
 * 从发言里抽"常用说法"。
 *
 * 不用字符 n-gram —— 那会抽出 "天有""人试" 这种跨词边界的噪声。
 * 改为按标点切成分句, 统计"有多少条不同的消息用过这个分句",
 * 重复出现的优先, 没有重复时退化为"较有代表性的长分句"。
 */
export function extractPhrases(texts: string[]): { phrases: string[]; repeated: boolean } {
  const docFreq = new Map<string, number>();
  const firstSeen = new Map<string, number>();

  texts.forEach((text, idx) => {
    const clauses = text.split(CLAUSE_SPLIT).filter((c) => c.length >= 2 && c.length <= 14);
    for (const clause of new Set(clauses)) {
      docFreq.set(clause, (docFreq.get(clause) ?? 0) + 1);
      if (!firstSeen.has(clause)) firstSeen.set(clause, idx);
    }
  });

  const repeated = [...docFreq.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 8)
    .map(([p]) => p);

  if (repeated.length > 0) return { phrases: repeated, repeated: true };

  const representative = [...docFreq.keys()]
    .sort((a, b) => b.length - a.length || (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0))
    .slice(0, 3);
  return { phrases: representative, repeated: false };
}

/** 纯统计, 不调模型 */
export function analyzeStyle(messages: ChatMessage[]): PersonaStats {
  const texts = messages.map((m) => spokenText(m.text)).filter((t) => t.length > 0);
  const count = texts.length || 1;

  const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
  const questions = texts.filter(
    (t) => /[?？]/.test(t) || /(怎么|为什么|为啥|如何|有没有|能不能|是不是|多少|哪里|哪个)/.test(t) || /[吗呢]\s*$/.test(t),
  ).length;
  const exclaims = texts.filter((t) => /[!！]/.test(t)).length;
  const emojis = texts.filter((t) => EMOJI.test(t) || /[（(][^)）]{1,6}[)）]/.test(t)).length;

  const particleHits = PARTICLES.map((p) => ({
    p,
    n: texts.reduce((sum, t) => sum + (t.includes(p) ? 1 : 0), 0),
  }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 6)
    .map((x) => x.p);

  const openerCount = new Map<string, number>();
  for (const t of texts) {
    const opener = t.replace(PUNCT, '').slice(0, 2);
    if (opener.length >= 1) openerCount.set(opener, (openerCount.get(opener) ?? 0) + 1);
  }
  const topOpeners = [...openerCount.entries()]
    .filter(([k, v]) => v >= 2 && k.length >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k]) => k);

  const { phrases, repeated } = extractPhrases(texts);

  // 去重后再选短句, 否则重复的同一句会占满 5 个坑
  const samplePhrases = [...new Set(texts)]
    .filter((t) => t.length >= 4 && t.length <= 40)
    .sort((a, b) => a.length - b.length)
    .slice(0, 5);

  return {
    messageCount: texts.length,
    avgChars: Number((totalChars / count).toFixed(1)),
    questionRate: Number((questions / count).toFixed(2)),
    exclaimRate: Number((exclaims / count).toFixed(2)),
    emojiRate: Number((emojis / count).toFixed(2)),
    topPhrases: phrases,
    phrasesRepeated: repeated,
    topOpeners,
    particles: particleHits,
    samplePhrases,
  };
}

/** 用统计特征拼一份可读的草稿人设 */
export function heuristicPersona(name: string, messages: ChatMessage[]): PersonaDraft {
  const stats = analyzeStyle(messages);

  const traits: string[] = [];
  if (stats.avgChars <= 8) traits.push('说话简短');
  else if (stats.avgChars <= 20) traits.push('句子不长');
  else traits.push('话比较多');
  if (stats.questionRate >= 0.2) traits.push('爱提问');
  if (stats.exclaimRate >= 0.15) traits.push('语气偏兴奋');
  if (stats.emojiRate >= 0.2) traits.push('常用表情');
  if (stats.particles.length > 0) traits.push(`常带"${stats.particles.slice(0, 3).join('/')}"`);

  const description = truncate(`${name}: ${traits.join(', ')}`, 60);

  const lines: string[] = [
    `# ${name}`,
    '',
    '> 这是根据聊天记录自动统计生成的草稿, 建议手动补充性格与禁忌。',
    '',
    '## 说话习惯',
    `- 样本 ${stats.messageCount} 条, 平均每条约 ${stats.avgChars} 字。`,
  ];

  if (stats.topPhrases.length > 0) {
    lines.push(
      stats.phrasesRepeated
        ? `- 反复出现的说法: ${stats.topPhrases.slice(0, 6).join('、')}。`
        : `- 较有代表性的说法: ${stats.topPhrases.join('、')}。`,
    );
  }
  if (stats.topOpeners.length > 0) lines.push(`- 常用开头: ${stats.topOpeners.join('、')}。`);
  lines.push(
    stats.particles.length > 0
      ? `- 语气词: ${stats.particles.join('、')}。`
      : '- 很少用语气词, 句子偏干脆。',
  );
  lines.push(
    `- 提问占比 ${Math.round(stats.questionRate * 100)}%, 感叹号 ${Math.round(stats.exclaimRate * 100)}%, 表情 ${Math.round(stats.emojiRate * 100)}%。`,
    '',
    '## 参考短句',
    ...(stats.samplePhrases.length > 0 ? stats.samplePhrases.map((s) => `- ${s}`) : ['- (样本不足)']),
    '',
    '## 性格',
    '- (草稿未推断, 请补充: 外向/内向、幽默感、热心程度、是否爱抬杠……)',
    '',
    '## 禁忌',
    '- (请补充: 不聊什么、不站什么队、不做什么事)',
  );

  return {
    name,
    description,
    content: lines.join('\n'),
    source: 'heuristic',
    stats,
    usedSamples: stats.messageCount,
    warnings: [],
  };
}

export interface DistillInput {
  target: { id: string; name: string };
  sceneKey: string;
  pairs: QaPair[];
  /** 目标用户的全部发言, 用于统计与风格样本 */
  messages: ChatMessage[];
}

export interface DistillDeps {
  getConfig: () => DistillConfig;
  /** 未配置提取模型时返回 undefined */
  getClient: () => ChatClient | undefined;
  logger?: Logger;
}

export async function distillPersona(input: DistillInput, deps: DistillDeps): Promise<PersonaDraft> {
  const client = deps.getClient();
  if (!client?.configured) {
    return heuristicPersona(input.target.name, input.messages);
  }

  const cfg = deps.getConfig();
  const { transcript, usedSamples } = buildTranscript(input, cfg);

  try {
    const res = await client.complete(
      [
        { role: 'system', content: DISTILL_SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ],
      { temperature: cfg.api.temperature, maxTokens: cfg.api.maxTokens },
    );
    const parsed = parsePersonaMarkdown(res.text, input.target.name);
    if (!parsed) {
      deps.logger?.warn('提取模型输出无法解析, 回退到统计草稿', { preview: res.text.slice(0, 200) });
      return { ...heuristicPersona(input.target.name, input.messages), warnings: ['模型输出格式不符, 已回退到统计草稿'] };
    }
    return {
      name: parsed.name,
      description: parsed.description,
      content: parsed.content,
      source: 'model',
      stats: analyzeStyle(input.messages),
      usedSamples,
      warnings: [],
    };
  } catch (err) {
    deps.logger?.warn('提取模型调用失败, 回退到统计草稿', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ...heuristicPersona(input.target.name, input.messages),
      warnings: [`提取模型调用失败: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

export const DISTILL_SYSTEM_PROMPT = `你是人物性格分析器。用户会给你一个微信/QQ 群成员的大量真实发言(含少量对话上下文), 你要据此写出一份可以驱动角色扮演的人设。

要求:
1. 只输出 markdown, 不要任何解释性前后缀。
2. 严格用下面的结构:

# 名字
一句话简介: 不超过 30 字的概括

## 性格
3~5 条, 每条一句话, 用行为描述而不是形容词堆砌。例如"被调侃会自嘲一句, 不生气"。

## 说话习惯
3~5 条: 句子长短、标点偏好、常用词、语气词、是否用表情、回复节奏。

## 口头禅
2~4 个真实出现过的词或短语, 逗号分隔。

## 禁忌
2~3 条: 从样本里看不到的也要按"普通群友"的常理补, 但要谨慎。

写作原则:
- 从样本里找证据, 不要凭空编造身份、职业、经历。
- 如果样本太少, 在最后一节写"## 备注"说明样本不足。
- 全文控制在 400 字以内。`;

/** 把 Q/A 片段 + 独立发言拼成给提取模型看的材料 */
export function buildTranscript(
  input: DistillInput,
  cfg: Pick<DistillConfig, 'maxSamples' | 'maxChars'>,
): { transcript: string; usedSamples: number } {
  const lines: string[] = [];
  lines.push(`【目标】${input.target.name}(${input.target.id})`);
  lines.push(`【场景】${input.sceneKey}`);
  lines.push('');

  const pairs = input.pairs.slice(0, cfg.maxSamples);
  if (pairs.length > 0) {
    lines.push(`【对话片段】共 ${pairs.length} 段(有人提问 → ${input.target.name} 作答)`);
    pairs.forEach((p, i) => {
      lines.push(`--- 片段 ${i + 1} ---`);
      lines.push(`${p.asker.name}: ${p.question}`);
      lines.push(`${input.target.name}: ${p.answer}`);
    });
    lines.push('');
  }

  const standalone = [...new Set(input.messages.map((m) => spokenText(m.text)))]
    .filter((t) => t.length >= 2)
    .slice(-60);

  if (standalone.length > 0) {
    lines.push(`【${input.target.name} 的其它发言】`);
    for (const t of standalone) lines.push(`- ${t}`);
  }

  let transcript = lines.join('\n');
  if (transcript.length > cfg.maxChars) transcript = transcript.slice(0, cfg.maxChars);
  return { transcript, usedSamples: pairs.length + standalone.length };
}

/** 解析模型输出: 第一行 # 名字, 第二行 一句话简介:, 其余作为正文 */
export function parsePersonaMarkdown(
  text: string,
  fallbackName: string,
): { name: string; description: string; content: string } | undefined {
  const cleaned = stripThinkingTrace(text);
  if (!cleaned) return undefined;

  const lines = cleaned.split('\n');
  let name = fallbackName;
  let description = '';
  const body: string[] = [];
  let sawHeading = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!sawHeading && /^#\s+/.test(trimmed)) {
      name = trimmed.replace(/^#\s+/, '').trim() || fallbackName;
      sawHeading = true;
      continue;
    }
    const descMatch = /^(?:一句话简介|简介|概括)\s*[:：]\s*(.+)$/.exec(trimmed);
    if (descMatch && !description) {
      description = descMatch[1]!.trim();
      continue;
    }
    body.push(line);
  }

  const content = body.join('\n').trim();
  if (!content) return undefined;
  if (!description) {
    const firstLine = content.split('\n').find((l) => l.trim() && !l.startsWith('#'));
    description = truncate(firstLine?.trim() ?? name, 60);
  }
  return { name, description, content: `# ${name}\n\n${content}` };
}

/**
 * 剥离思维链。
 *
 * 本地思考型模型(Qwen3 等)会把 "Thinking Process:" 直接写进 content,
 * 甚至先输出一遍标题再开始思考。这里做两件事:
 *   1. 有 <｜end▁of▁thinking｜> 标签就取标签之后;
 *   2. 有 "Thinking Process/思考过程" 且有多个 `# 标题` 时, 取最后一个标题开始的内容。
 */
export function stripThinkingTrace(text: string): string {
  const cleaned = text.replace(/^```(?:markdown|md)?\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!cleaned) return '';

  const thinkClose = cleaned.lastIndexOf('<｜end▁of▁thinking｜>');
  if (thinkClose !== -1) return cleaned.slice(thinkClose + '<｜end▁of▁thinking｜>'.length).trim();

  const marker = /(Thinking Process|思考过程|分析过程|Reasoning)\s*[:：]/i;
  if (marker.test(cleaned)) {
    const headings = [...cleaned.matchAll(/^#\s+\S/gm)].map((m) => m.index ?? -1).filter((i) => i > 0);
    if (headings.length > 0) return cleaned.slice(Math.max(...headings)).trim();
  }
  return cleaned;
}

/** 判断一段发言是否值得进入样本(对外暴露, 便于服务端过滤) */
export function isUsableSample(message: ChatMessage, minChars = 2): boolean {
  return isMeaningfulText(message.text, minChars);
}
