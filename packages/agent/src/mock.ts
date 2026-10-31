import type { Logger } from '@pasc/core';
import type { AgentHealth, AgentRequest, AgentResponse, AgentTransport } from './transport.js';

export interface MockTransportOptions {
  latencyMs?: number;
  logger?: Logger;
}

/**
 * 本地 Mock Agent。
 *
 * 作用有两个:
 *   1. 没有 OpenClaw / 没有模型 API 时, 也能把整条链路跑通(演示、自测、CI)
 *   2. 作为协议样板: 它按 JSON 标签体系输出, 用来验证解析器和动作分发
 *
 * 它刻意做得"会做动作": 提到发图/禁言时会带上 execution 字段。
 */
export class MockTransport implements AgentTransport {
  readonly name = 'mock';
  private readonly latencyMs: number;

  constructor(private readonly opts: MockTransportOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 300;
  }

  async health(): Promise<AgentHealth> {
    return { ok: true, detail: 'Mock Agent 始终可用' };
  }

  async send(req: AgentRequest): Promise<AgentResponse> {
    const started = Date.now();
    if (this.latencyMs > 0) await delay(this.latencyMs);

    const trigger = extractTrigger(req.user);
    const payload = composeReply(trigger);
    this.opts.logger?.debug('Mock Agent 生成回复', { trigger, payload });

    return {
      text: JSON.stringify(payload),
      latencyMs: Date.now() - started,
      transport: this.name,
    };
  }
}

/** 从构建好的 prompt 里抠出"你需要回应的消息"那一行 */
export function extractTrigger(prompt: string): string {
  const marker = '## 你需要回应的消息';
  const idx = prompt.indexOf(marker);
  if (idx === -1) return prompt.trim().split('\n').pop() ?? '';
  const rest = prompt.slice(idx + marker.length).split('\n');
  return rest[1]?.trim() ?? '';
}

interface MockPayload {
  message: string;
  execution?:
    | { action: string; target?: string; params: Record<string, unknown> }
    | Array<{ action: string; target?: string; params: Record<string, unknown> }>;
}

/** 规则化的假回复, 覆盖文本 / 发图 / 群管理 / 沉默四种情况 */
export function composeReply(trigger: string): MockPayload {
  const t = trigger.toLowerCase();

  if (/发.{0,2}图|图片|照片|来张|看图/.test(t)) {
    return {
      message: '行, 给你一张',
      execution: {
        action: 'send_image',
        params: { url: 'https://picsum.photos/seed/pasc/600/400' },
      },
    };
  }

  if (/禁言|闭嘴/.test(t)) {
    return {
      message: '那先让他安静十分钟吧',
      execution: {
        action: 'group_manage',
        params: { op: 'ban', userId: '10001', durationSec: 600, reason: '刷屏' },
      },
    };
  }

  if (/你是谁|介绍一下自己|你叫什么/.test(t)) {
    return { message: '我? 就群里一个普通人啊, 聊得来就多聊两句' };
  }

  if (/^(哈哈|hhh|草|笑死|6+|好|嗯)+$/i.test(trigger.trim())) {
    return { message: '' };
  }

  return {
    message: pick([
      '这个我大概知道一点, 不过不确定, 你可以先试试看',
      '嗯……让我想想, 好像不是那么回事',
      '刚看到, 你说得对',
      '这问题还挺有意思的, 展开说说?',
    ]),
  };
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
