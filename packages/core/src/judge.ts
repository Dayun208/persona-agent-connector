import type { ChatClient } from './llm.js';
import type { JudgeConfig } from './config.js';
import type { Logger } from './logger.js';
import type { ChatMessage, Scene } from './types.js';
import { renderMessageLine, sceneLabel } from './types.js';
import { extractJsonValue } from './json-utils.js';
import { JUDGE_SYSTEM_PROMPT } from './prompt-defaults.js';

export type TriggerReason = 'mention' | 'keyword' | 'reply' | 'judge' | 'manual';

export interface JudgeInput {
  scene: Scene;
  /** 判断窗口内的消息(按时间正序, 最后一条即触发消息) */
  messages: ChatMessage[];
  trigger: ChatMessage;
  personaSummary: string;
  /** 机器人最近是否刚说过话, 用于抑制连续插话 */
  lastReplyAt: number;
  now?: number;
}

export interface JudgeDecision {
  shouldReply: boolean;
  confidence: number;
  reason: string;
  style?: string;
  source: 'model' | 'heuristic' | 'bypass';
}

export interface JudgeDeps {
  getConfig: () => JudgeConfig;
  /** 未配置或调用失败时返回 undefined, 引擎会自动降级 */
  getClient: () => ChatClient | undefined;
  getPersonaSummary: () => string;
  logger?: Logger;
  /** 可注入的随机源, 便于测试 */
  random?: () => number;
}

const QUESTION_HINTS = [
  '怎么',
  '为什么',
  '为啥',
  '如何',
  '有没有',
  '谁能',
  '请问',
  '求个',
  '帮我',
  '是不是',
  '能不能',
  '什么情况',
  '哪家',
  '推荐',
];

/**
 * 判断引擎 —— 决定"这条消息值不值得唤醒大模型"。
 *
 * 两条路径:
 *   1. 配了判断模型 → 用小模型做一次廉价的 yes/no + 置信度
 *   2. 没配/调用失败 → 启发式规则(问题句、随机开口), 保证没有 API 也能跑
 *
 * 无论走哪条, 最终都要过 replyThreshold 和冷却时间这两道闸门(由调用方执行)。
 */
export class JudgeEngine {
  constructor(private readonly deps: JudgeDeps) {}

  private get random(): () => number {
    return this.deps.random ?? Math.random;
  }

  async decide(input: JudgeInput): Promise<JudgeDecision> {
    // @ 是强信号, 不必花判断模型的 token
    if (input.trigger.mentionsSelf) {
      return { shouldReply: true, confidence: 0.99, reason: '消息 @ 了我', source: 'bypass' };
    }

    const client = this.deps.getClient();
    if (client?.configured) {
      try {
        return await this.askModel(client, input);
      } catch (err) {
        this.deps.logger?.warn('判断模型调用失败, 降级为启发式', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return this.heuristic(input);
  }

  private async askModel(client: ChatClient, input: JudgeInput): Promise<JudgeDecision> {
    const cfg = this.deps.getConfig();
    const history = input.messages.slice(-cfg.judgeWindow);
    const lines = history.map((m) => renderMessageLine(m)).join('\n');

    const system = [
      JUDGE_SYSTEM_PROMPT,
      '',
      `【机器人设定】${input.personaSummary || '一个普通的群友'}`,
    ].join('\n');

    const userLines = [
      `【会话】${sceneLabel(input.scene)}`,
      '【最近对话】',
      lines,
      '',
      '【待判断】上面最后一条消息之后, 机器人现在应该开口吗?',
      '只输出 JSON。',
    ];
    if (input.lastReplyAt > 0) {
      const secondsAgo = Math.round(((input.now ?? Date.now()) - input.lastReplyAt) / 1000);
      // 只有真的"刚刚"才提示，否则 90 秒前的一句也会被模型当成"刚说过"而选择沉默
      if (secondsAgo < 120) userLines.push(`【提示】机器人在 ${secondsAgo} 秒前发过一条消息，注意别刷屏。`);
    }

    const { value } = await client.completeJson(
      [
        { role: 'system', content: system },
        { role: 'user', content: userLines.join('\n') },
      ],
      { temperature: 0, maxTokens: 200, json: true },
    );

    const obj = (value ?? {}) as Record<string, unknown>;
    const rawShould = obj.shouldReply ?? obj.should_reply ?? obj.reply;
    const shouldReply = rawShould === true || rawShould === 'true' || rawShould === 1;
    const rawConf = obj.confidence ?? obj.score;
    const confidence = clamp01(typeof rawConf === 'number' ? rawConf : shouldReply ? 0.7 : 0.2);

    return {
      shouldReply,
      confidence,
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 120) : '',
      ...(typeof obj.style === 'string' ? { style: obj.style.slice(0, 40) } : {}),
      source: 'model',
    };
  }

  /** 无模型时的启发式判断 */
  heuristic(input: JudgeInput): JudgeDecision {
    const cfg = this.deps.getConfig();
    const text = input.trigger.text.trim();

    if (!text) {
      return { shouldReply: false, confidence: 0, reason: '空消息(纯表情/图片)', source: 'heuristic' };
    }

    const isQuestion = /[?？]/.test(text) || QUESTION_HINTS.some((h) => text.includes(h));
    if (isQuestion && text.length >= 6) {
      return { shouldReply: true, confidence: 0.72, reason: '像是有人在提问', source: 'heuristic' };
    }

    // 刚说过话就压一压, 避免连续刷屏
    const gapMs = (input.now ?? Date.now()) - input.lastReplyAt;
    if (input.lastReplyAt > 0 && gapMs < cfg.replyCooldownMs) {
      return { shouldReply: false, confidence: 0.1, reason: '刚回过话, 先不插嘴', source: 'heuristic' };
    }

    const hit = this.random() < cfg.autoReplyProbability;
    return hit
      ? { shouldReply: true, confidence: 0.62, reason: '随机开口(启发式)', source: 'heuristic' }
      : { shouldReply: false, confidence: 0.15, reason: '话题与机器人无关', source: 'heuristic' };
  }

  /** 用配置里的阈值判断最终是否触发 */
  passesThreshold(decision: JudgeDecision): boolean {
    return decision.shouldReply && decision.confidence >= this.deps.getConfig().replyThreshold;
  }

  /** 给控制台的"试判断"接口用: 直接跑一次判断, 不落库 */
  async dryRun(input: JudgeInput): Promise<JudgeDecision> {
    return this.decide(input);
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
