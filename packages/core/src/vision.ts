import { readFile } from 'node:fs/promises';
import type { VisionConfig } from './config.js';

/**
 * 图片理解 —— 把 QQ 消息里的图片变成一段文字，交给后面的模型用。
 *
 * 为什么不让 Agent 直接看图：
 *   DeepSeek 全系（v4-flash / v4-pro）是纯文本模型，
 *   OpenClaw 会直接报 "Model does not support images"。
 *   所以识图这一步必须在本地做掉，把结果当文本喂过去。
 *
 * 两种模式，速度差一个数量级：
 *   ocr      —— GLM-OCR 读图上的字，约 2 秒。QQ 群里的截图/梗图/表情包
 *               绝大多数信息都在文字里，这个就够。
 *   describe —— GLM-4.6V 描述画面，15~30 秒。照片才需要。
 *   auto     —— 先 OCR，读不到字再描述。
 */
export interface VisionResult {
  kind: 'ocr' | 'describe';
  text: string;
  latencyMs: number;
}

export interface VisionDeps {
  fetchImpl?: typeof fetch;
  /** 容器内路径 → 宿主机可读路径 */
  resolvePath?: (containerPath: string) => string;
}

const OCR_PROMPT = '把图片里出现的文字原样输出，不要解释、不要加标点修饰。如果没有文字，只输出 (无文字)。';
const DESCRIBE_PROMPT = '用一句中文说明这张图里是什么。只给结论，不要描述你的推理过程。';

/** 去掉部分模型爱加的思考过程和外层包裹 */
export function cleanVisionText(raw: string): string {
  let t = String(raw ?? '').trim();
  t = t.replace(/^<\|begin_of_box\|>/i, '').replace(/<\|end_of_box\|>$/i, '');
  t = t.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
  const close = t.lastIndexOf('<｜end▁of▁thinking｜>');
  if (close >= 0) t = t.slice(close + '<｜end▁of▁thinking｜>'.length).trim();
  const think = /Thinking Process:/i.exec(t);
  if (think && think.index === 0) {
    const nl = t.lastIndexOf('\n\n');
    if (nl > 0) t = t.slice(nl).trim();
  }
  return t.trim();
}

async function callVision(
  imageDataUri: string,
  model: string,
  prompt: string,
  cfg: VisionConfig,
  deps: VisionDeps,
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = cfg.api.baseURL.replace(/\/+$/, '') + '/chat/completions';
  const body = {
    model,
    max_tokens: 200,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUri } },
        ],
      },
    ],
  };
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.api.apiKey ? { authorization: `Bearer ${cfg.api.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.api.timeoutMs),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`视觉模型返回 HTTP ${res.status}: ${raw.slice(0, 160)}`);
  const json = JSON.parse(raw) as { choices?: Array<{ message?: { content?: string } }> };
  return cleanVisionText(json.choices?.[0]?.message?.content ?? '');
}

function toDataUri(buf: Buffer, file: string): string {
  const ext = /\.(png|gif|webp|jpe?g)$/i.exec(file)?.[1]?.toLowerCase() ?? 'jpeg';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${buf.toString('base64')}`;
}

/**
 * 理解一张图。文件读不到、模型超时都返回 undefined —— 识图失败不该阻塞聊天。
 */
export async function understandImage(
  file: string,
  cfg: VisionConfig,
  deps: VisionDeps = {},
): Promise<VisionResult | undefined> {
  const hostPath = deps.resolvePath ? deps.resolvePath(file) : file;
  let buf: Buffer;
  try {
    buf = await readFile(hostPath);
  } catch {
    return undefined;
  }
  if (buf.byteLength === 0) return undefined;

  const dataUri = toDataUri(buf, file);
  const started = Date.now();

  if (cfg.mode === 'ocr' || cfg.mode === 'auto') {
    try {
      const text = await callVision(dataUri, cfg.api.model, OCR_PROMPT, cfg, deps);
      const cleaned = text.replace(/\(无文字\)|（无文字）/g, '').trim();
      if (cleaned.length >= cfg.minText) {
        return { kind: 'ocr', text: cleaned.slice(0, 400), latencyMs: Date.now() - started };
      }
      if (cfg.mode === 'ocr') return { kind: 'ocr', text: '', latencyMs: Date.now() - started };
    } catch {
      if (cfg.mode === 'ocr') return undefined;
    }
  }

  try {
    const text = await callVision(dataUri, cfg.api.describeModel, DESCRIBE_PROMPT, cfg, deps);
    if (!text) return undefined;
    return { kind: 'describe', text: text.slice(0, 200), latencyMs: Date.now() - started };
  } catch {
    return undefined;
  }
}

/** 拼进消息文本里的形式 */
export function renderImageNote(result: VisionResult | undefined): string {
  if (!result || !result.text) return '';
  return result.kind === 'ocr' ? `[图片文字] ${result.text}` : `[图片] ${result.text}`;
}
