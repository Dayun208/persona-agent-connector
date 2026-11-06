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
export function formatDialogue(messages: ChatMessage[], maxChars = 6_000): string {
  const lines = messages
    .map((m) => {
      const text = spokenText(m.text);
      if (!text) return '';
      return `${m.senderName}(${m.senderId}): ${text}`;
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
