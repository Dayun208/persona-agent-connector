import { z } from 'zod';
import { stripThinkingTrace } from './persona-distill.js';
import { extractJsonValue } from './json-utils.js';

/**
 * JSON 标签体系 (Agent → 中间件 → NapCat)
 *
 * 需求文档里的最小形态:
 *   { "message": "...", "execution": { "action": "...", "target": "...", "params": {} } }
 * 这里在保持向后兼容的前提下做了三点扩展:
 *   1. execution 允许是数组, 一次回复执行多个动作
 *   2. 允许 messages 数组(分段连发, 更像人)
 *   3. 解析器容错: 代码块、前后缀废话、完全不是 JSON 的纯文本都能兜住
 */

export const ExecutionSchema = z.object({
  action: z.string().min(1),
  target: z.union([z.string(), z.number()]).optional(),
  params: z.record(z.unknown()).optional(),
});

export type Execution = {
  action: string;
  target?: string;
  params: Record<string, unknown>;
};

export const AgentOutputSchema = z.object({
  message: z.string().optional(),
  messages: z.array(z.string()).optional(),
  execution: z.union([ExecutionSchema, z.array(ExecutionSchema)]).optional(),
  /** 容错: 有些模型会写成 executions */
  executions: z.union([ExecutionSchema, z.array(ExecutionSchema)]).optional(),
});

export interface ParsedAgentOutput {
  messages: string[];
  executions: Execution[];
  warnings: string[];
  /** true 表示模型没按协议输出, 被当成纯文本兜底处理 */
  usedFallback: boolean;
  raw: unknown;
}

function normalizeExecutions(value: unknown): Execution[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const out: Execution[] = [];
  for (const item of list) {
    const parsed = ExecutionSchema.safeParse(item);
    if (!parsed.success) continue;
    const exec: Execution = {
      action: parsed.data.action,
      params: parsed.data.params ?? {},
    };
    if (parsed.data.target !== undefined) exec.target = String(parsed.data.target);
    out.push(exec);
  }
  return out;
}

/**
 * 解析 Agent 输出。永不抛异常 —— 最差情况把整段文本当消息发出去。
 */
export function parseAgentOutput(text: string): ParsedAgentOutput {
  const warnings: string[] = [];
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    return { messages: [], executions: [], warnings: ['模型返回为空'], usedFallback: false, raw: text };
  }

  const json = extractJsonValue(trimmed);

  // 模型直接返回了一个字符串字面量, 例如 "\"好的\""
  if (typeof json === 'string') {
    const messages = [json.trim()].filter(Boolean);
    return { messages, executions: [], warnings, usedFallback: false, raw: json };
  }

  if (json && typeof json === 'object') {
    const candidate = Array.isArray(json) ? { execution: json } : (json as Record<string, unknown>);

    // 兼容 { action, target } 这种"只有动作没有 message"的裸执行结构
    if (typeof candidate.action === 'string' && candidate.message === undefined && candidate.messages === undefined) {
      const executions = normalizeExecutions(candidate);
      if (executions.length > 0 && candidate.message === undefined) {
        return { messages: [], executions, warnings: ['输出只有 execution, 没有 message'], usedFallback: false, raw: json };
      }
    }

    const parsed = AgentOutputSchema.safeParse(candidate);
    if (!parsed.success) {
      warnings.push('输出 JSON 结构不符合协议, 已按文本处理');
      // 兜底会把原文直接发到群里：思考型模型常把推理过程写进正文，这里先剥掉
      const cleaned = stripThinkingTrace(trimmed) || trimmed;
      return { messages: [cleaned], executions: [], warnings, usedFallback: true, raw: json };
    }

    const messages = collectMessages(parsed.data.message, parsed.data.messages);
    const executions = [
      ...normalizeExecutions(parsed.data.execution),
      ...normalizeExecutions(parsed.data.executions),
    ];

    if (messages.length === 0 && executions.length === 0) {
      warnings.push('message 与 execution 都为空, 视为不发言');
    }
    return { messages, executions, warnings, usedFallback: false, raw: json };
  }

  warnings.push('未在输出中找到 JSON, 已按纯文本兜底');
  return { messages: [trimmed], executions: [], warnings, usedFallback: true, raw: text };
}

function collectMessages(message?: string, messages?: string[]): string[] {
  const out: string[] = [];
  if (message && message.trim()) out.push(message.trim());
  if (messages) {
    for (const m of messages) {
      if (typeof m === 'string' && m.trim()) out.push(m.trim());
    }
  }
  return out;
}

/** 屏蔽 OpenClaw 原生指令, 避免机器人把 /status 之类暴露给群友 */
export function stripBlockedCommands(text: string, blocked: string[]): { text: string; stripped: boolean } {
  if (blocked.length === 0) return { text, stripped: false };
  const t = text.trim();
  if (!t.startsWith('/')) return { text, stripped: false };
  const cmd = t.split(/\s+/)[0] ?? '';
  if (blocked.some((b) => b.toLowerCase() === cmd.toLowerCase())) {
    return { text: '', stripped: true };
  }
  return { text, stripped: false };
}

/**
 * 把一段文本拆成多条消息, 模拟人类连发。
 * 只在文本里本来就有明显分段(空行/换行)时才拆, 且限制条数。
 */
export function splitForHumanStyle(text: string, maxSegments = 3): string[] {
  if (maxSegments <= 1) return [text].filter(Boolean);
  const parts = text
    .split(/\n{2,}|\n(?=[^\n])/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= 1) return parts;
  const head = parts.slice(0, maxSegments - 1);
  const tail = parts.slice(maxSegments - 1).join('\n');
  return [...head, tail].filter(Boolean);
}
