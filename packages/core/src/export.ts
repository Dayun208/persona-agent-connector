import type { QaPair } from './extractor.js';

export interface ExportOptions {
  /** 标题栏信息, 默认带 */
  includeHeader?: boolean;
  /** 目标人格名, 用于文件名与标题 */
  targetName?: string;
  sceneKey?: string;
  generatedAt?: number;
}

/**
 * 导出 few-shot 文本。
 *
 * 格式刻意保持人类可读 + 可直接粘贴进 Prompt 两种用途:
 * 头部几行 # 注释说明来源, 后面是 "有人: ... / 你: ..." 的成对样本。
 */
export function pairsToFewShotText(pairs: QaPair[], opts: ExportOptions = {}): string {
  const lines: string[] = [];
  const includeHeader = opts.includeHeader ?? true;

  if (includeHeader) {
    const time = new Date(opts.generatedAt ?? Date.now());
    const pad = (n: number) => String(n).padStart(2, '0');
    lines.push('# PASC few-shot 样本');
    if (opts.targetName) lines.push(`# 目标人格: ${opts.targetName}`);
    if (opts.sceneKey) lines.push(`# 场景: ${opts.sceneKey}`);
    lines.push(`# 生成时间: ${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`);
    lines.push(`# 条数: ${pairs.length}`);
    lines.push('');
  }

  pairs.forEach((pair, i) => {
    lines.push(`### 示例 ${i + 1}`);
    lines.push(`有人: ${pair.question.trim()}`);
    lines.push(`你: ${pair.answer.trim()}`);
    if (i !== pairs.length - 1) lines.push('');
  });

  return lines.join('\n') + '\n';
}

/** 导出为 JSON, 便于再导入或做数据集 */
export function pairsToJson(pairs: QaPair[]): string {
  return JSON.stringify({ version: 1, exportedAt: Date.now(), pairs }, null, 2);
}

/** 生成安全的文件名 */
export function buildExportFilename(targetName: string, ext: 'txt' | 'json'): string {
  const cleaned = targetName
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  const safe = cleaned || 'persona';
  const stamp = new Date().toISOString().slice(0, 10);
  return `pasc-fewshot-${safe}-${stamp}.${ext}`;
}

/** 把样本直接转成可注入 Prompt 的片段(与 PromptBuilder 里的格式保持一致) */
export function pairsToPromptBlock(pairs: QaPair[], limit = 4): string {
  return pairs
    .slice(0, limit)
    .map((p, i) => `### 示例 ${i + 1}\n有人: ${p.question}\n你: ${p.answer}`)
    .join('\n\n');
}
