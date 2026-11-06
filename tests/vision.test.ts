import { describe, expect, it, vi } from 'vitest';
import { cleanVisionText, renderImageNote, understandImage } from '@pasc/core';
import type { VisionConfig } from '@pasc/core';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function cfg(over: Partial<VisionConfig> = {}): VisionConfig {
  return {
    enabled: true,
    mode: 'ocr',
    maxImages: 2,
    minText: 2,
    mountFrom: '/app/.config/QQ',
    mountTo: '',
    api: {
      baseURL: 'http://127.0.0.1:8000/v1',
      apiKey: '',
      model: 'GLM-OCR',
      describeModel: 'GLM-4.6V-Flash-MLX-6bit',
      timeoutMs: 5000,
    },
    ...over,
  } as VisionConfig;
}

function fakeFetch(content: string, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

const dir = mkdtempSync(join(tmpdir(), 'pasc-vision-'));
const img = join(dir, 'a.jpg');
writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

describe('cleanVisionText', () => {
  it('去掉外层标记和思考过程', () => {
    expect(cleanVisionText('<|begin_of_box|>你好<|end_of_box|>')).toBe('你好');
    expect(cleanVisionText('Thinking Process:\n\n先看图片…\n\n图里是一只猫')).toBe('图里是一只猫');
  });
});

describe('understandImage', () => {
  it('OCR 模式读出文字', async () => {
    const r = await understandImage(img, cfg(), { fetchImpl: fakeFetch('释放忍术...') });
    expect(r?.kind).toBe('ocr');
    expect(r?.text).toBe('释放忍术...');
    expect(renderImageNote(r)).toBe('[图片文字] 释放忍术...');
  });

  it('OCR 说没有文字时不返回结果（不触发描述）', async () => {
    const r = await understandImage(img, cfg(), { fetchImpl: fakeFetch('(无文字)') });
    expect(r?.text).toBe('');
  });

  it('auto 模式：OCR 无字时回落到描述', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '(无文字)' } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '一只橘猫在键盘上' } }] })));
    const r = await understandImage(img, cfg({ mode: 'auto' }), { fetchImpl: fetchImpl as never });
    expect(r?.kind).toBe('describe');
    expect(r?.text).toContain('橘猫');
  });

  it('文件不存在时返回 undefined，不抛错', async () => {
    const r = await understandImage(join(dir, 'nope.jpg'), cfg(), { fetchImpl: fakeFetch('x') });
    expect(r).toBeUndefined();
  });

  it('模型报错时返回 undefined', async () => {
    const r = await understandImage(img, cfg(), { fetchImpl: fakeFetch('boom', 500) });
    expect(r).toBeUndefined();
  });

  it('容器路径通过 resolvePath 映射到宿主机', async () => {
    const fetchImpl = fakeFetch('hi');
    const r = await understandImage('/app/.config/QQ/a.jpg', cfg(), {
      fetchImpl,
      resolvePath: () => img,
    });
    expect(r?.text).toBe('hi');
  });
});
