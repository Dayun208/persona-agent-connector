import type { ChatClient } from './llm.js';
import type { QaPair } from './extractor.js';

/**
 * 用模型给候选 Q/A 配对打分，挑出"最像这个人在说话"的 few-shot 样本。
 *
 * 为什么需要它：
 *   规则配对只看结构（谁回谁、隔多久），能保证"是问答"，但保证不了"像人"。
 *   一堆 "嗯/在/好的" 和一条带口癖、有情绪、有信息量的回复，规则分可能差不多。
 *   模型能看懂语气和内容，适合做这一步。
 *
 * 成本控制：
 *   配对数量可能上百，所以分批送（默认每批 25 对），只让模型输出"保留哪些 + 分数 + 一句理由"。
 */
export interface PairFilterOptions {
  /** 最多保留多少对 */
  maxKeep?: number;
  /** 每批送多少对给模型 */
  batchSize?: number;
  /** 目标用户的昵称，帮助模型判断"像不像他" */
  targetName?: string;
  /** 额外要求，比如"保留带口癖的" */
  hint?: string;
}

export interface PairVerdict {
  id: string;
  score: number;
  reason: string;
}

export interface PairFilterResult {
  kept: PairVerdict[];
  /** 因为"同一个问题配了多条回答"被去掉的数量 */
  deduped: number;
  /** 送进模型的批次数 */
  batches: number;
  /** 模型没按格式回答的批次 */
  failedBatches: number;
}

const SYSTEM = [
  '你在帮人挑选"少样本示例"（few-shot），用来教另一个模型模仿某个人的说话方式。',
  '判断标准，按重要性排序：',
  '1. 像这个人说话 —— 有口癖、语气词、个人风格，而不是通用礼貌用语；',
  '2. 有实际内容 —— 能看出性格、喜好、经历，而不是"嗯""在""好的"这种空话；',
  '3. 问答要成立 —— 问题能自然引出这个回答，回答是对问题的真实回应；',
  '4. 长度适中 —— 一两句最好，太长的段子不适合当样本。',
  '',
  '示例价值低的（要坚决丢掉）：纯表情、单字回复、"收到""好的"、复读对方的话、',
  '没有上下文的碎片、明显的报错/系统消息。',
  '',
  '只输出 JSON，格式：',
  '{"keep":[{"i":1,"score":0.86,"why":"带口癖「捏」，能看出性格"}]}',
  'i 是条目编号，score 是 0~1 的示例价值，why 用一句中文说明。',
  '不保留的条目不要出现在 keep 里。',
].join('\n');

function renderPairs(pairs: QaPair[], offset: number): string {
  return pairs
    .map((p, idx) => {
      const q = p.question.replace(/\s+/g, ' ').slice(0, 120);
      const a = p.answer.replace(/\s+/g, ' ').slice(0, 160);
      return `#${offset + idx + 1}\n对方: ${q}\n这个人: ${a}`;
    })
    .join('\n\n');
}

function clamp01(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** 解析模型输出；容忍多余文字和 markdown 代码块 */
export function parseVerdicts(raw: string): Array<{ i: number; score: number; why: string }> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const arr = (obj as { keep?: unknown }).keep;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) => {
      const rec = item as Record<string, unknown>;
      const i = Number(rec.i ?? rec.index ?? rec.id);
      return { i, score: clamp01(rec.score ?? rec.value), why: String(rec.why ?? rec.reason ?? '').slice(0, 80) };
    })
    .filter((v) => Number.isInteger(v.i) && v.i > 0);
}

export async function filterPairsWithAI(
  pairs: QaPair[],
  client: ChatClient,
  opts: PairFilterOptions = {},
): Promise<PairFilterResult> {
  const maxKeep = Math.max(1, Math.min(200, opts.maxKeep ?? 20));
  const batchSize = Math.max(5, Math.min(50, opts.batchSize ?? 25));
  const targetName = opts.targetName ?? '这个人';

  const kept: PairVerdict[] = [];
  let batches = 0;
  let failedBatches = 0;

  for (let offset = 0; offset < pairs.length; offset += batchSize) {
    const chunk = pairs.slice(offset, offset + batchSize);
    batches += 1;
    const user = [
      `【要模仿的人】${targetName}`,
      opts.hint ? `【额外要求】${opts.hint}` : '',
      '【候选问答】',
      renderPairs(chunk, offset),
      '',
      `从这些候选里挑出最适合当示例的，最多 ${maxKeep} 条。只输出 JSON。`,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const { value } = await client.completeJson(
        [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: user },
        ],
        { temperature: 0, maxTokens: 1200, json: true },
      );
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
      const verdicts = parseVerdicts(text);
      if (verdicts.length === 0) {
        failedBatches += 1;
        continue;
      }
      for (const v of verdicts) {
        const globalIdx = offset + v.i - 1;
        const pair = pairs[globalIdx];
        if (!pair) continue;
        kept.push({ id: pair.id, score: v.score, reason: v.why });
      }
    } catch {
      failedBatches += 1;
    }
  }

  kept.sort((a, b) => b.score - a.score);

  // 同一条提问常常被规则配出好几条回答（连续发言），AI 会全部留下，
  // 但作为 few-shot 它们是重复的 —— 每个问题只保留分最高的一条。
  const seenQuestion = new Set<string>();
  const deduped: PairVerdict[] = [];
  for (const verdict of kept) {
    const pair = pairs.find((p) => p.id === verdict.id);
    const key = (pair?.question ?? '').replace(/\s+/g, '').slice(0, 40);
    if (key && seenQuestion.has(key)) continue;
    if (key) seenQuestion.add(key);
    deduped.push(verdict);
  }

  return { kept: deduped.slice(0, maxKeep), deduped: kept.length - deduped.length, batches, failedBatches };
}
