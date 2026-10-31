export interface StatsSnapshot {
  startedAt: number;
  uptimeMs: number;
  /** 收到的原始消息数(含被过滤的) */
  messagesIn: number;
  messagesFiltered: number;
  /** 判断模型被调用的次数 */
  judgeRuns: number;
  /** 判断通过、唤醒了大模型的次数 */
  judgeHits: number;
  /** 因 @ / 关键词直接唤醒的次数 */
  directTriggers: number;
  replies: number;
  executions: number;
  executionRejected: number;
  errors: number;
  /** 构建出的 prompt 数与总字符数 */
  promptBuilds: number;
  promptChars: number;
  estimatedTokens: number;
  /** 判断模型/大模型的平均耗时 */
  judgeLatencyMsAvg: number;
  agentLatencyMsAvg: number;
  lastReplyAt: number;
  lastError?: string;
}

/** 运行期计数器, 给概览面板用 */
export class Stats {
  private readonly startedAt = Date.now();
  messagesIn = 0;
  messagesFiltered = 0;
  judgeRuns = 0;
  judgeHits = 0;
  directTriggers = 0;
  replies = 0;
  executions = 0;
  executionRejected = 0;
  errors = 0;
  promptBuilds = 0;
  promptChars = 0;
  estimatedTokens = 0;
  lastReplyAt = 0;
  lastError: string | undefined;

  private judgeLatencyTotal = 0;
  private judgeLatencyCount = 0;
  private agentLatencyTotal = 0;
  private agentLatencyCount = 0;

  recordJudge(latencyMs: number): void {
    this.judgeLatencyTotal += latencyMs;
    this.judgeLatencyCount += 1;
  }

  recordAgent(latencyMs: number): void {
    this.agentLatencyTotal += latencyMs;
    this.agentLatencyCount += 1;
  }

  recordPrompt(chars: number, tokens: number): void {
    this.promptBuilds += 1;
    this.promptChars += chars;
    this.estimatedTokens += tokens;
  }

  recordReply(): void {
    this.replies += 1;
    this.lastReplyAt = Date.now();
  }

  recordError(err: unknown): void {
    this.errors += 1;
    this.lastError = err instanceof Error ? err.message : String(err);
  }

  snapshot(now = Date.now()): StatsSnapshot {
    return {
      startedAt: this.startedAt,
      uptimeMs: now - this.startedAt,
      messagesIn: this.messagesIn,
      messagesFiltered: this.messagesFiltered,
      judgeRuns: this.judgeRuns,
      judgeHits: this.judgeHits,
      directTriggers: this.directTriggers,
      replies: this.replies,
      executions: this.executions,
      executionRejected: this.executionRejected,
      errors: this.errors,
      promptBuilds: this.promptBuilds,
      promptChars: this.promptChars,
      estimatedTokens: this.estimatedTokens,
      judgeLatencyMsAvg: this.judgeLatencyCount ? Math.round(this.judgeLatencyTotal / this.judgeLatencyCount) : 0,
      agentLatencyMsAvg: this.agentLatencyCount ? Math.round(this.agentLatencyTotal / this.agentLatencyCount) : 0,
      lastReplyAt: this.lastReplyAt,
      lastError: this.lastError,
    };
  }
}
