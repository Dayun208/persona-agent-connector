import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Persona } from './persona.js';

/**
 * 把人格导出成 markdown, 供 OpenClaw 直接读取。
 *
 * 需求文档 §8.1 的取舍: "建议写入 OpenClaw 的 markdown 中, 利用它自动把特征
 * markdown 发到 LLM 计算的特性"。所以 PASC 不一定要自己注入人格 ——
 * 把提纯结果同步成一份 markdown, 让 OpenClaw 用它已有的机制加载, 往往更省事,
 * 也不会出现"中间件注入一遍、Agent 又注入一遍"的双重人格。
 */
export interface RenderOptions {
  /** 生成时间, 默认现在 */
  generatedAt?: number;
  /** 来源标注, 便于回溯 */
  source?: string;
}

export function renderPersonaMarkdown(persona: Persona, opts: RenderOptions = {}): string {
  const time = new Date(opts.generatedAt ?? Date.now()).toISOString().slice(0, 19).replace('T', ' ');
  const header = [
    '<!-- 由 PASC (人格模拟智能体桥接器) 生成 -->',
    `<!-- persona: ${persona.name} | id: ${persona.id} | updated: ${time} -->`,
  ];
  if (opts.source) header.push(`<!-- source: ${opts.source} -->`);

  const body = persona.content.trim() || `# ${persona.name}`;
  const description = persona.description.trim();

  return [...header, '', body, '', description ? `> ${description}` : ''].join('\n').replace(/\n{3,}$/, '\n') + '\n';
}

/** 写入文件, 自动建目录; 返回实际写入的字节数 */
export async function writePersonaMarkdown(file: string, persona: Persona, opts: RenderOptions = {}): Promise<number> {
  const content = renderPersonaMarkdown(persona, opts);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return Buffer.byteLength(content);
}
