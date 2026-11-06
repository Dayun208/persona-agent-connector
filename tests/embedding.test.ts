import { describe, expect, it, vi } from 'vitest';
import { checkEmbeddingQuality, cosineSimilarity, EmbeddingClient, l2Normalize, resolveEmbeddingEndpoint } from '@pasc/core';

function clientWith(handler: (input: string[]) => number[][]): EmbeddingClient {
  const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { input: string[] };
    const data = handler(body.input);
    return new Response(
      JSON.stringify({ data: data.map((embedding, index) => ({ embedding, index })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return new EmbeddingClient(
    { baseURL: 'http://127.0.0.1:1/v1', apiKey: '', model: 'test', timeoutMs: 3000 } as never,
    fetchImpl as never,
  );
}

describe('向量工具', () => {
  it('cosineSimilarity：同向为 1，正交为 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('l2Normalize 长度为 1', () => {
    const v = l2Normalize([3, 4]);
    expect(Math.hypot(...v)).toBeCloseTo(1);
  });

  it('空向量不会炸', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(l2Normalize([])).toEqual([]);
  });

  it('端点补全', () => {
    expect(resolveEmbeddingEndpoint('http://x/v1')).toBe('http://x/v1/embeddings');
    expect(resolveEmbeddingEndpoint('http://x/v1/embeddings')).toBe('http://x/v1/embeddings');
  });
});

describe('checkEmbeddingQuality', () => {
  it('正常模型：向量分散，通过', async () => {
    const client = clientWith((inputs) => inputs.map((_, i) => [Math.cos(i), Math.sin(i), 0.3 + i * 0.1]));
    const q = await checkEmbeddingQuality(client, ['猫', '狗', '米饭']);
    expect(q.ok).toBe(true);
    expect(q.meanSimilarity).toBeLessThan(0.999);
  });

  it('退化模型：所有向量几乎一样，判定失败', async () => {
    const client = clientWith((inputs) => inputs.map(() => [0.5, 0.5, 0.5]));
    const q = await checkEmbeddingQuality(client, ['猫', '狗', '鱼']);
    expect(q.ok).toBe(false);
    expect(q.reason).toBeTruthy();
    expect(q.worstPair).toBeTruthy();
  });

  it('未配置时直接返回未通过', async () => {
    const client = new EmbeddingClient({ baseURL: '', apiKey: '', model: '', timeoutMs: 1000 } as never);
    const q = await checkEmbeddingQuality(client);
    expect(q.ok).toBe(false);
    expect(q.reason).toContain('未配置');
  });

  it('服务报错时不抛异常', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const client = new EmbeddingClient(
      { baseURL: 'http://127.0.0.1:1/v1', apiKey: '', model: 'test', timeoutMs: 1000 } as never,
      fetchImpl as never,
    );
    const q = await checkEmbeddingQuality(client, ['猫']);
    expect(q.ok).toBe(false);
    expect(q.reason).toBeTruthy();
  });
});
