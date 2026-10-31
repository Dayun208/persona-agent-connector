/**
 * 无分词器的中文友好文本相似度。
 *
 * 里程碑 1 先用字符二元组(uni-gram + bi-gram)做重叠打分,
 * 等 embedding 模块接上以后, 这里会退化成"没有向量时的兜底策略"。
 */

const PUNCT = /[\s\u3000-\u303f\uff00-\uffef!-/:-@[-`{-~]/g;

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(PUNCT, ' ');
}

/** 生成字符 n-gram 集合 */
export function shingles(text: string, n = 2): Set<string> {
  const norm = normalizeText(text);
  const out = new Set<string>();
  const compact = norm.replace(/\s+/g, '');
  for (let i = 0; i + n <= compact.length; i += 1) {
    out.add(compact.slice(i, i + n));
  }
  if (compact.length > 0 && compact.length < n) out.add(compact);
  return out;
}

/** 归一化重叠系数: |A∩B| / min(|A|,|B|), 值域 [0,1] */
export function similarity(a: string, b: string): number {
  if (!a.trim() || !b.trim()) return 0;
  const sa = shingles(a);
  const sb = shingles(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  for (const gram of small) if (large.has(gram)) inter += 1;
  return inter / small.size;
}

/** 取前 n 个字符, 超长补省略号 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}
