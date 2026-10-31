import type { AgentConfig, Logger } from '@pasc/core';
import type { AgentTransport } from './transport.js';
import { MockTransport } from './mock.js';
import { HttpAgentTransport } from './http.js';
import { GatewayAgentTransport } from './gateway.js';

/** 按配置创建 Agent 传输层。切换后端只改配置, 管线代码不动。 */
export function createAgentTransport(cfg: AgentConfig, logger: Logger): AgentTransport {
  switch (cfg.transport) {
    case 'http':
      return new HttpAgentTransport(cfg, logger.child('http'));
    case 'gateway':
      return new GatewayAgentTransport(cfg, logger.child('gateway'));
    case 'mock':
    default:
      return new MockTransport({ latencyMs: cfg.mockLatencyMs, logger: logger.child('mock') });
  }
}
