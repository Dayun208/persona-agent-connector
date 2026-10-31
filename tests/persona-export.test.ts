import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL_MODEL_CANDIDATES,
  probeModelEndpoints,
  renderPersonaMarkdown,
  resolveModelsEndpoint,
  suggestDistillModel,
  suggestJudgeModel,
  writePersonaMarkdown,
  type Persona,
} from '@pasc/core';

function fakeFetch(handler: (url: string) => unknown): typeof fetch {
  return (async (input: string | URL | Request) => {
    const result = handler(String(input));
    if (result instanceof Error) throw result;
    return {
      ok: true,
      status: 200,
      json: async () => result,
    } as unknown as Response;
  }) as typeof fetch;
}

describe('resolveModelsEndpoint', () => {
  it('补齐 /models', () => {
    expect(resolveModelsEndpoint('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1/models');
    expect(resolveModelsEndpoint('http://x/v1/models/')).toBe('http://x/v1/models');
  });
});

describe('probeModelEndpoints', () => {
  it('OpenAI 风格响应解析出模型列表', async () => {
    const fetchImpl = fakeFetch(() => ({ data: [{ id: 'qwen2.5:7b' }, { id: 'llama3.2' }] }));
    const results = await probeModelEndpoints(['http://127.0.0.1:11434/v1'], { fetchImpl });
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.models).toEqual(['qwen2.5:7b', 'llama3.2']);
  });

  it('兼容 Ollama 的 {models:[{name}]}', async () => {
    const fetchImpl = fakeFetch(() => ({ models: [{ name: 'qwen3:8b' }] }));
    const results = await probeModelEndpoints(['http://127.0.0.1:11434/v1'], { fetchImpl });
    expect(results[0]!.models).toEqual(['qwen3:8b']);
  });

  it('连接失败时给出可读错误', async () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' } });
    const fetchImpl = fakeFetch(() => err);
    const results = await probeModelEndpoints(['http://127.0.0.1:11434/v1'], { fetchImpl });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toContain('连接被拒绝');
  });

  it('未知错误保留原始信息', async () => {
    const fetchImpl = fakeFetch(() => new Error('something weird'));
    const results = await probeModelEndpoints(['http://a/v1'], { fetchImpl });
    expect(results[0]!.error).toContain('something weird');
  });

  it('去重端点', async () => {
    const fetchImpl = fakeFetch(() => ({ data: [] }));
    const results = await probeModelEndpoints(['http://a/v1', 'http://a/v1', 'http://b/v1'], { fetchImpl });
    expect(results).toHaveLength(2);
  });

  it('候选列表包含常见本地端口', () => {
    const urls = LOCAL_MODEL_CANDIDATES.map((c) => c.baseURL);
    expect(urls.some((u) => u.includes('11434'))).toBe(true);
    expect(urls.some((u) => u.includes('1234'))).toBe(true);
  });
});

describe('模型推荐', () => {
  it('判断模型优先选小模型', () => {
    expect(suggestJudgeModel(['qwen2.5:32b', 'qwen2.5:7b', 'llama3.2'])).toBe('qwen2.5:7b');
  });

  it('提取模型优先选更大的模型', () => {
    expect(suggestDistillModel(['qwen2.5:7b', 'qwen2.5:32b'])).toBe('qwen2.5:32b');
  });

  it('没有偏好时退回第一个', () => {
    expect(suggestJudgeModel(['mystery-model'])).toBe('mystery-model');
    expect(suggestDistillModel([])).toBeUndefined();
  });
});

const persona: Persona = {
  id: 'p1',
  name: '小明',
  description: '群里的老熟人',
  content: '# 小明\n\n## 性格\n- 爱接话',
  updatedAt: 1_700_000_000_000,
};

describe('人格导出', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('渲染带元信息的 markdown', () => {
    const md = renderPersonaMarkdown(persona, { source: 'agent-1', generatedAt: 1_700_000_000_000 });
    expect(md).toContain('由 PASC');
    expect(md).toContain('persona: 小明');
    expect(md).toContain('## 性格');
    expect(md).toContain('> 群里的老熟人');
    expect(md).toContain('source: agent-1');
  });

  it('内容为空时至少写出名字', () => {
    const md = renderPersonaMarkdown({ ...persona, content: '   ' });
    expect(md).toContain('# 小明');
  });

  it('写入文件并返回字节数', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pasc-persona-'));
    const file = join(dir, 'nested', 'persona.md');
    const bytes = await writePersonaMarkdown(file, persona);
    expect(bytes).toBeGreaterThan(0);
    expect(readFileSync(file, 'utf8')).toContain('小明');
  });
});
