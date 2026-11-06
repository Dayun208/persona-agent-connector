import type { ChatClient, CompleteOptions, LlmMessage } from './llm.js';
import type { Logger } from './logger.js';
import { extractJsonValue } from './json-utils.js';
import type { ChatMessage } from './types.js';
import type { MemoryType } from './memory-engine.js';
import { MEMORY_TYPES } from './memory-engine.js';
import { spokenText } from './persona-distill.js';

/**
 * 用 LLM 从对话里抽取长期记忆(对应 LivingMemory 的"自动整理")。
 *
 * 原则是"宁缺毋滥": 一次只抽几条, importance 低的直接丢弃,
 * 让记忆库保持干净 —— 脏记忆比没有记忆更糟。
 */

export interface MemoryCandidate {
  text: string;
  type: MemoryType;
  importance: number;
  tags: string[];
  subjects: string[];
}

export interface ExtractMemoriesResult {
  candidates: MemoryCandidate[];
  warnings: string[];
  /** 模型原始输出, 便于排查 */
  raw?: string;
}

export const MEMORY_EXTRACT_PROMPT = `你是一个长期记忆整理器。阅读群聊片段, 抽取值得长期记住的信息。

只记录这几类:
- 稳定事实: 职业、所在城市、设备、宠物、长期习惯
- 偏好: 明确表达过的喜欢/讨厌
- 关系: 谁和谁是什么关系(同事、同学、情侣、父子...)
- 计划: 近期确定要做的事(带时间感)
- 重要事件: 已经发生的、值得记住的事

不要记录: 一次性的闲聊、临时情绪、玩笑、表情包、已经过时/被否定的信息。

输出一个 JSON 数组, 每个元素:
{"text": "一句完整的中文陈述, 第三人称, 不超过 50 字", "type": "fact|preference|relationship|plan|event", "importance": 0.0~1.0, "tags": ["关键词"], "subjects": ["相关QQ号"]}

要求:
- 最多输出 %MAX% 条, 宁缺毋滥
- 找不到值得记的就输出 []
- 只输出 JSON 数组, 不要任何解释`;

/** 把消息列表压成给抽取模型看的一段对话 */
/**
 * 把对话渲染成模型能读的格式。
 * 带上昵称、QQ 号和时间 —— 没有时间模型就无法把"下周三"换算成具体日期，
 * 不区分 Bot 自己说的话，就会把自己的发言记成别人说的。
 */
export function formatDialogue(messages: ChatMessage[], maxChars = 6_000): string {
  const fmtTime = (ts: number): string => {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const lines = messages
    .map((m) => {
      const text = spokenText(m.text);
      if (!text) return '';
      const who = m.isSelf ? `[Bot: ${m.senderName} | ID: ${m.senderId} | ${fmtTime(m.timestamp)}]` : `[${m.senderName} | ID: ${m.senderId} | ${fmtTime(m.timestamp)}]`;
      return `${who} ${text}`;
    })
    .filter(Boolean);

  let out = lines.join('\n');
  if (out.length > maxChars) {
    // 保留最近的对话
    out = out.slice(out.length - maxChars);
    const firstBreak = out.indexOf('\n');
    if (firstBreak > 0) out = out.slice(firstBreak + 1);
  }
  return out;
}

/**
 * 只要"能把一段对话补全成文本"就行 —— 这样本地 ChatClient、
 * OpenClaw 的 agent 适配器都能用同一套抽取逻辑。
 */
export interface TextCompleter {
  configured: boolean;
  complete(messages: LlmMessage[], opts?: CompleteOptions): Promise<{ text: string }>;
}

/**
 * 会话摘要抽取 —— 思路参考 LivingMemory（AGPL-3.0，见 NOTICE）。
 *
 * 和"抽原子事实"不同，这里把一段对话压成一条可回溯的"剧集"：
 *   canonical（客观）用于检索，firstPerson（带人设语气）用于注入时的温度。
 * 关键约束：相对时间必须换算成具体日期，否则"下周三"过一周就失效了。
 */
export interface EpisodeSummary {
  canonical: string;
  firstPerson: string;
  topics: string[];
  keyFacts: string[];
  participants: string[];
  sentiment: 'positive' | 'neutral' | 'negative';
  importance: number;
}

export const EPISODE_PROMPT = `你在整理一段群聊的长期记忆。输出一个 JSON 对象，不要输出任何别的内容。

时间要求：把"今天/明天/昨天/下周/上周"等相对时间，按消息里的时间戳换算成具体日期再写。

人称要求：
- [Bot: ...] 开头的是你自己说的话，用第一人称描述（"我回了…""我建议…"）
- 其余消息必须写具体昵称（"张三说…"），不许用"用户""群友""某人"

字段：
{
  "canonical": "客观中性的摘要，只写参与者、事件、时间、结论，不带语气词",
  "firstPerson": "第一人称回忆，可以带你对气氛的感受",
  "topics": ["主题，最多 5 个"],
  "keyFacts": ["关键事实，最多 5 条，必须带人名和日期"],
  "participants": ["所有发言者昵称"],
  "sentiment": "positive|neutral|negative",
  "importance": 0.0-1.0
}

importance 参考：群体决策/明确计划 0.8+；有结论的讨论 0.6-0.7；日常交流 0.4-0.5；闲聊灌水 0.1-0.3。

没有值得记的内容时，输出 {"canonical":"","firstPerson":"","topics":[],"keyFacts":[],"participants":[],"sentiment":"neutral","importance":0}`;

export async function extractEpisode(
  client: TextCompleter,
  messages: ChatMessage[],
  opts: { minImportance?: number } = {},
): Promise<{ episode?: EpisodeSummary; warning?: string; raw?: string }> {
  const dialogue = formatDialogue(messages);
  if (!dialogue.trim()) return { warning: '没有可用对话' };

  let raw = '';
  try {
    const res = await client.complete(
      [
        { role: 'system', content: EPISODE_PROMPT },
        { role: 'user', content: `群聊片段：\n${dialogue}` },
      ],
      { temperature: 0.2, maxTokens: 700, json: true },
    );
    raw = res.text;
  } catch (err) {
    return { warning: `摘要模型调用失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = extractJsonValue(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { warning: '模型输出不是 JSON 对象', raw };
  }
  const obj = parsed as Record<string, unknown>;
  const text = typeof obj.canonical === 'string' ? obj.canonical.trim() : '';
  if (!text) return { warning: '摘要为空', raw };

  const importance = typeof obj.importance === 'number' ? obj.importance : 0.5;
  const minImportance = opts.minImportance ?? 0.4;
  if (importance < minImportance) return { warning: '重要度不足，已丢弃', raw };

  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : [];

  const sentimentRaw = String(obj.sentiment ?? 'neutral');
  const sentiment = ['positive', 'neutral', 'negative'].includes(sentimentRaw)
    ? (sentimentRaw as EpisodeSummary['sentiment'])
    : 'neutral';

  return {
    episode: {
      canonical: text,
      firstPerson: typeof obj.firstPerson === 'string' ? obj.firstPerson.trim() : text,
      topics: arr(obj.topics).slice(0, 5),
      keyFacts: arr(obj.keyFacts).slice(0, 5),
      participants: arr(obj.participants).slice(0, 10),
      sentiment,
      importance: Math.min(1, Math.max(0, importance)),
    },
    raw,
  };
}

export async function extractMemoryCandidates(
  client: TextCompleter,
  messages: ChatMessage[],
  opts: { maxItems?: number; minImportance?: number; logger?: Logger },
): Promise<ExtractMemoriesResult> {
  const maxItems = opts.maxItems ?? 5;
  const minImportance = opts.minImportance ?? 0.4;
  const dialogue = formatDialogue(messages);

  if (!dialogue.trim()) return { candidates: [], warnings: ['没有可用对话'] };

  const warnings: string[] = [];
  let raw = '';
  try {
    const res = await client.complete(
      [
        { role: 'system', content: MEMORY_EXTRACT_PROMPT.replace('%MAX%', String(maxItems)) },
        { role: 'user', content: `群聊片段:\n${dialogue}` },
      ],
      { temperature: 0.1, maxTokens: 600, json: true },
    );
    raw = res.text;
  } catch (err) {
    return { candidates: [], warnings: [`抽取模型调用失败: ${err instanceof Error ? err.message : String(err)}`] };
  }

  const parsed = extractJsonValue(raw);
  if (!Array.isArray(parsed)) {
    return { candidates: [], warnings: ['模型输出不是 JSON 数组'], raw };
  }

  const candidates: MemoryCandidate[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const text = typeof obj.text === 'string' ? obj.text.trim() : '';
    if (!text) continue;

    const type = MEMORY_TYPES.includes(String(obj.type) as MemoryType) ? (obj.type as MemoryType) : 'unknown';
    const importance = clamp01(typeof obj.importance === 'number' ? obj.importance : 0.5);
    if (importance < minImportance) {
      warnings.push(`丢弃低重要度记忆: ${text.slice(0, 20)}`);
      continue;
    }

    candidates.push({
      text,
      type,
      importance,
      tags: toStringArray(obj.tags).slice(0, 6),
      subjects: toStringArray(obj.subjects).slice(0, 6),
    });
    if (candidates.length >= maxItems) break;
  }

  return { candidates, warnings, raw };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
