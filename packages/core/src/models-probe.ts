/**
 * 本地模型端点探测。
 *
 * 真实痛点: 用户机器上跑着 Ollama / LM Studio / vLLM, 但忘了端口、
 * 或者根本没启动。与其让人对着文档猜地址, 不如让程序自己去试一遍。
 */

export interface ModelProbeResult {
  baseURL: string;
  ok: boolean;
  /** 端点暴露的模型 id 列表 */
  models: string[];
  latencyMs: number;
  error?: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 常见本地推理框架的默认端口 */
export const LOCAL_MODEL_CANDIDATES: Array<{ baseURL: string; label: string }> = [
  { baseURL: 'http://127.0.0.1:11434/v1', label: 'Ollama' },
  { baseURL: 'http://127.0.0.1:1234/v1', label: 'LM Studio' },
  { baseURL: 'http://127.0.0.1:8000/v1', label: 'vLLM / 通用 OpenAI 兼容' },
  { baseURL: 'http://127.0.0.1:8080/v1', label: 'llama.cpp / 其它' },
  { baseURL: 'http://127.0.0.1:3001/v1', label: '自定义' },
];

export function resolveModelsEndpoint(baseURL: string): string {
  const base = baseURL.trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/models$/i.test(base)) return base;
  return `${base}/models`;
}

/** 探测一组端点, 返回每个端点的可用模型 */
export async function probeModelEndpoints(
  candidates: string[],
  opts: ProbeOptions = {},
): Promise<ModelProbeResult[]> {
  const timeoutMs = opts.timeoutMs ?? 1_500;
  const doFetch = opts.fetchImpl ?? fetch;

  return Promise.all(
    [...new Set(candidates.filter(Boolean))].map(async (baseURL) => {
      const started = Date.now();
      const url = resolveModelsEndpoint(baseURL);
      try {
        const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
          return { baseURL, ok: false, models: [], latencyMs: Date.now() - started, error: `HTTP ${res.status}` };
        }
        const json = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string; id?: string }> };
        const models = Array.isArray(json.data)
          ? json.data.map((m) => m.id).filter((id): id is string => Boolean(id))
          : Array.isArray(json.models)
            ? json.models.map((m) => m.name ?? m.id).filter((id): id is string => Boolean(id))
            : [];
        return { baseURL, ok: true, models, latencyMs: Date.now() - started };
      } catch (err) {
        // undici 的 fetch 失败只会给一句 "fetch failed", 真正的原因在 cause 里
        const e = err as { message?: string; cause?: { code?: string; message?: string } };
        const code = e.cause?.code ?? '';
        const raw = e.cause?.message ?? e.message ?? String(err);
        const error =
          code === 'ECONNREFUSED' || /ECONNREFUSED/.test(raw)
            ? '连接被拒绝(服务未启动)'
            : /timeout|aborted|ETIMEDOUT/i.test(raw)
              ? '连接超时(可能没启动)'
              : raw.slice(0, 120);
        return { baseURL, ok: false, models: [], latencyMs: Date.now() - started, error };
      }
    }),
  );
}

/** 探测结果里挑一个适合当"判断模型"的小模型 */
export function suggestJudgeModel(models: string[]): string | undefined {
  const prefer = ['qwen2.5:3b', 'qwen2.5:7b', 'qwen2.5', 'qwen3', 'llama3.2', 'gemma', 'deepseek', 'glm'];
  for (const key of prefer) {
    const hit = models.find((m) => m.toLowerCase().includes(key));
    if (hit) return hit;
  }
  return models[0];
}

/** 探测结果里挑一个适合当"提取模型"的更大模型 */
export function suggestDistillModel(models: string[]): string | undefined {
  const prefer = ['qwen2.5:14b', 'qwen2.5:32b', 'qwen2.5:7b', 'qwen3', 'deepseek', 'llama3.3', 'glm'];
  for (const key of prefer) {
    const hit = models.find((m) => m.toLowerCase().includes(key));
    if (hit) return hit;
  }
  return models[0];
}
