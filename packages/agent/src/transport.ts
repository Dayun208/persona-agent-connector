import type { AgentConfig, Logger } from '@pasc/core';

/** 发送给 Agent 的一次请求(已经是构建好的 Prompt) */
export interface AgentRequest {
  system: string;
  user: string;
  meta: {
    sceneKey: string;
    sceneLabel: string;
    triggerId: string;
    reason: string;
    personaName?: string;
    /** 人格 id（用于隔离 OpenClaw 会话，切人格即换会话） */
    personaId?: string;
    /** 目标子 Agent; OpenClaw 多 agent 时用来路由 */
    agentId?: string;
  };
}

export interface AgentResponse {
  /** Agent 返回的原始文本, 由上层用 parseAgentOutput 解析 */
  text: string;
  latencyMs: number;
  transport: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface AgentHealth {
  ok: boolean;
  detail: string;
}

export interface AgentTransport {
  readonly name: string;
  send(req: AgentRequest): Promise<AgentResponse>;
  health(): Promise<AgentHealth>;
  close?(): Promise<void>;
}

export type AgentTransportFactory = (config: AgentConfig, logger: Logger) => AgentTransport;
