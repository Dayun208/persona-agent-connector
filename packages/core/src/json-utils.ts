/**
 * 宽松 JSON 提取工具。
 *
 * 现实里模型经常会这样回答:
 *   - 直接给 JSON
 *   - 包在 ```json ... ``` 里
 *   - 前面先来一句"好的,这就是回复:"
 *   - 末尾多一个解释段落
 * 所以不能直接 JSON.parse, 要能把它"刨"出来。
 */

/** 去掉 markdown 代码围栏 */
export function stripCodeFence(text: string): string {
  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/;
  const m = fence.exec(text);
  return (m?.[1] ?? text).trim();
}

/**
 * 从任意文本里提取第一个可解析的 JSON 值(对象或数组)。
 * 用括号配对扫描, 会正确处理字符串内的括号和转义。
 */
export function extractJsonValue(text: string): unknown {
  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;

  const unfenced = stripCodeFence(text);
  const unfencedParse = tryParse(unfenced);
  if (unfencedParse !== undefined) return unfencedParse;

  // 按最早出现的开括号来试：否则 " [{...},{...}] " 会先命中 '{'，
  // 只解析出第一个对象，把数组整个丢掉
  const braces = [
    ['{', '}'] as const,
    ['[', ']'] as const,
  ]
    .map((pair) => ({ pair, at: unfenced.indexOf(pair[0]) }))
    .filter((x) => x.at !== -1)
    .sort((a, b) => a.at - b.at)
    .map((x) => x.pair);

  for (const [open, close] of braces) {
    const start = unfenced.indexOf(open);
    if (start === -1) continue;
    const candidate = scanBalanced(unfenced, start, open, close);
    if (!candidate) continue;
    const parsed = tryParse(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function tryParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 从 start 位置的 open 字符开始, 返回配平后的子串 */
function scanBalanced(text: string, start: number, open: string, close: string): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
