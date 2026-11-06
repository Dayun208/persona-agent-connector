import type { Logger } from './logger.js';
import { extractJsonValue } from './json-utils.js';
import { similarity } from './text.js';
import type { MemoryType } from './memory-engine.js';

/**
 * 记忆反思。
 *
 * 自动抽取是"来一条记一条"，聊久了同一件事会散成好几条：
 *   张三在杭州读研
 *   张三保研了
 *   张三不在杭州了，搬到成都
 *
 * 反思做两件事：
 *   1. 合并：同主题的多条压成一条更概括的，原始条目保留但标记为已合并（可追溯）
 *   2. 矛盾：新说法推翻旧说法时，把旧的标记为过时，避免召回时两条都冒出来
 *
 * 不做的：不允许模型凭空补细节。合并只允许用原文已有信息。
 */

export interface ReflectSource {
  id: string;
  text: string;
  type: MemoryType;
  createdAt: number;
}

export interface ReflectedMemory {
  /** 合并后的表述 */
  text: string;
  type: MemoryType;
  /** 0~1，合并后通常比单条更重要 */
  importance: number;
  /** 参与合并的记忆 id */
  sourceIds: string[];
  /** 如果这组里有互相矛盾的说法，记下被推翻的 id 与原因 */
  superseded: Array<{ id: string; reason: string }>;
}

export interface ReflectionResult {
  merged: ReflectedMemory[];
  total: number;
  warnings: string[];
}

/** 供抽取复用的最小客户端接口（与 TextCompleter 结构一致） */
export interface ReflectCompleter {
  configured: boolean;
  complete(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    opts?: unknown,
  ): Promise<{ text: string }>;
}

export const REFLECT_PROMPT = `你在整理长期记忆。下面是一组相关的记忆条目，每条带 [编号]。

任务：
1. 如果它们说的是同一件事，合并成一条更完整、更准确的表述。
2. 如果互相矛盾（比如"在杭州"和"搬到成都"），以时间更晚的为准，并把较早的那条放进 superseded。
3. 只使用原文里已有的信息，不要推断、不要补充细节。
4. 如果它们其实没关系，就不要合并，merged 返回空。

输出 JSON，不要输出别的内容：
{
  "merged": "合并后的表述（一条，尽量简洁完整）",
  "type": "fact|preference|relationship|plan|event|episode|unknown",
  "importance": 0.0-1.0,
  "superseded": [{"id": "被推翻的编号", "reason": "为什么过时"}]
}

不值得合并时输出：{"merged": ""}`;

/**
 * 把一组记忆交给模型反思。
 * 返回 undefined 表示"模型认为不该合并"。
 */
export async function reflectGroup(
  client: ReflectCompleter,
  group: ReflectSource[],
  opts: { logger?: Logger } = {},
): Promise<ReflectedMemory | undefined> {
  if (group.length < 2) return undefined;

  const block = group.map((m, i) => `[${i + 1}] ${m.text}`).join('\n');
  let raw = '';
  try {
    const res = await client.complete(
      [
        { role: 'system', content: REFLECT_PROMPT },
        { role: 'user', content: `记忆条目：\n${block}` },
      ],
      { temperature: 0.1, maxTokens: 600, json: true },
    );
    raw = res.text;
  } catch (err) {
    opts.logger?.debug('反思调用失败', { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }

  const parsed = extractJsonValue(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const text = typeof obj.merged === 'string' ? obj.merged.trim() : '';
  if (!text) return undefined;

  const types: MemoryType[] = ['fact', 'preference', 'relationship', 'plan', 'event', 'episode', 'unknown'];
  const type = types.includes(obj.type as MemoryType) ? (obj.type as MemoryType) : group[0]!.type;

  const importanceRaw = typeof obj.importance === 'number' ? obj.importance : 0.6;
  const importance = Math.min(1, Math.max(0, importanceRaw));

  // 模型返回的是组内编号，这里换算回真实记忆 id
  const superseded: Array<{ id: string; reason: string }> = [];
  if (Array.isArray(obj.superseded)) {
    for (const item of obj.superseded) {
      const o = item as Record<string, unknown>;
      const idx = Number(o.id);
      const target = Number.isInteger(idx) ? group[idx - 1] : undefined;
      if (!target) continue;
      superseded.push({ id: target.id, reason: typeof o.reason === 'string' ? o.reason.trim() : '' });
    }
  }

  return { text, type, importance, sourceIds: group.map((m) => m.id), superseded };
}

/**
 * 找出值得反思的候选组。
 *
 * 用最朴素的办法：按主题词（实体/关键词）分桶，桶里条数 ≥ 2 才送模型。
 * 全量两两比较记忆的文本相似度虽然更准，但几百条就是几万次比较，
 * 而且同一件事换种说法相似度可能很低 —— 反而主题词更稳。
 */
export function groupForReflection(
  records: Array<{ id: string; text: string; type: MemoryType; createdAt: number; tags: string[]; subjects: string[] }>,
  opts: { minGroupSize?: number; maxGroups?: number } = {},
): ReflectSource[][] {
  const minGroupSize = opts.minGroupSize ?? 2;
  const maxGroups = opts.maxGroups ?? 8;

  // 先处理"近重复"：同一件事换了个说法，tags/subjects 未必一致，
  // 光按主题词分桶会漏掉，这类恰恰最该合并
  const groups: ReflectSource[][] = [];
  const used = new Set<string>();
  const list = records.slice(0, 300);
  for (let i = 0; i < list.length && groups.length < maxGroups; i += 1) {
    const a = list[i]!;
    if (used.has(a.id)) continue;
    const cluster = [a];
    for (let j = i + 1; j < list.length && cluster.length < 6; j += 1) {
      const b = list[j]!;
      if (used.has(b.id)) continue;
      if (similarity(a.text, b.text) >= 0.5) cluster.push(b);
    }
    if (cluster.length < minGroupSize) continue;
    for (const item of cluster) used.add(item.id);
    groups.push(cluster.map((r) => ({ id: r.id, text: r.text, type: r.type, createdAt: r.createdAt })));
  }

  const buckets = new Map<string, typeof records>();
  const push = (key: string, item: (typeof records)[number]): void => {
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  };

  for (const record of records) {
    // 只按 subjects（人）和 tags 分桶，避免"的""了"这类词导致大杂烩
    for (const subject of record.subjects) push(`s:${subject}`, record);
    for (const tag of record.tags.slice(0, 3)) push(`t:${tag}`, record);
  }

  // 同一个记忆可能落在多个桶里，按 id 去重后再筛
  const seen = new Set<string>();
  // 近重复已经用掉的条目不再参与主题桶，避免重复送模型
  const seenIds = used;
  // 桶越大越值得先看
  const ordered = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [, items] of ordered) {
    if (groups.length >= maxGroups) break;
    const uniqueItems = [...new Map(items.map((i) => [i.id, i])).values()].filter((i) => !seenIds.has(i.id));
    if (uniqueItems.length < minGroupSize) continue;
    const key = uniqueItems.map((i) => i.id).sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(
      uniqueItems
        .slice(0, 6)
        .map((r) => ({ id: r.id, text: r.text, type: r.type, createdAt: r.createdAt })),
    );
  }
  return groups;
}
