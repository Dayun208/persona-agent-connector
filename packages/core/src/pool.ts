import type { ChatMessage } from './types.js';

/** 单个会话(一个群/一个私聊)的运行时状态 */
export interface SceneState {
  sceneKey: string;
  totalMessages: number;
  /** 距离上次判断累积的新消息数 */
  newSinceJudge: number;
  judged: number;
  replied: number;
  lastMessageAt: number;
  lastJudgeAt: number;
  lastReplyAt: number;
  /** 判断或回复正在进行中, 防止并发重复唤醒 */
  busy: boolean;
}

export interface JudgeGate {
  /** 每积累 N 条新消息判断一次 */
  everyN: number;
  /** 两次判断的最小间隔 */
  intervalMs: number;
  /** 池子里至少要有这么多条才判断 */
  minMessages: number;
}

/**
 * 消息池: 每个会话维护一个容量固定的滑动窗口 + 判断节流状态。
 * 这是"节省 token"的第一道闸门 —— 不是每条消息都会流到 LLM。
 */
export class MessagePool {
  private readonly buffers = new Map<string, ChatMessage[]>();
  private readonly states = new Map<string, SceneState>();
  private seqCounter = 0;

  constructor(private readonly capacity = 60) {}

  /** 分配全局自增序号 */
  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  push(msg: ChatMessage): SceneState {
    const key = msg.sceneKey;
    let buf = this.buffers.get(key);
    if (!buf) {
      buf = [];
      this.buffers.set(key, buf);
    }
    buf.push(msg);
    if (buf.length > this.capacity) buf.splice(0, buf.length - this.capacity);

    const state = this.state(key);
    state.totalMessages += 1;
    state.newSinceJudge += 1;
    state.lastMessageAt = msg.timestamp;
    return state;
  }

  state(sceneKey: string): SceneState {
    let s = this.states.get(sceneKey);
    if (!s) {
      s = {
        sceneKey,
        totalMessages: 0,
        newSinceJudge: 0,
        judged: 0,
        replied: 0,
        lastMessageAt: 0,
        lastJudgeAt: 0,
        lastReplyAt: 0,
        busy: false,
      };
      this.states.set(sceneKey, s);
    }
    return s;
  }

  /**
   * 用历史存档预热消息池(进程重启后还能接上之前的对话)。
   * 只填窗口, 不计入 newSinceJudge —— 否则一重启就会立刻触发一次判断。
   */
  restore(messages: ChatMessage[]): void {
    for (const msg of messages) {
      let buf = this.buffers.get(msg.sceneKey);
      if (!buf) {
        buf = [];
        this.buffers.set(msg.sceneKey, buf);
      }
      buf.push(msg);
      if (buf.length > this.capacity) buf.splice(0, buf.length - this.capacity);
      const state = this.state(msg.sceneKey);
      state.totalMessages = Math.max(state.totalMessages, buf.length);
      state.lastMessageAt = Math.max(state.lastMessageAt, msg.timestamp);
      this.seqCounter = Math.max(this.seqCounter, msg.seq);
    }
  }

  /** 最近 limit 条消息(时间正序) */
  history(sceneKey: string, limit = this.capacity): ChatMessage[] {
    const buf = this.buffers.get(sceneKey) ?? [];
    return buf.slice(-limit);
  }

  /** 除最后一条外的上下文, 用于"当前要回应的消息"单独呈现 */
  /**
   * 取 seq 严格小于给定值的最近 limit 条。
   * 用于构建"以某条消息为触发点"的上下文 —— 如果期间又来了新消息,
   * contextBefore 会把触发消息本身也算进历史, 导致它在 Prompt 里出现两次。
   */
  before(sceneKey: string, seq: number, limit = this.capacity): ChatMessage[] {
    const buf = this.buffers.get(sceneKey) ?? [];
    if (!seq) return this.contextBefore(sceneKey, limit);
    return buf.filter((m) => m.seq < seq).slice(-limit);
  }

  contextBefore(sceneKey: string, limit = this.capacity): ChatMessage[] {
    const buf = this.buffers.get(sceneKey) ?? [];
    return buf.slice(0, -1).slice(-limit);
  }

  size(sceneKey: string): number {
    return this.buffers.get(sceneKey)?.length ?? 0;
  }

  markJudged(sceneKey: string, at = Date.now()): void {
    const s = this.state(sceneKey);
    s.judged += 1;
    s.newSinceJudge = 0;
    s.lastJudgeAt = at;
  }

  markReplied(sceneKey: string, at = Date.now()): void {
    const s = this.state(sceneKey);
    s.replied += 1;
    s.lastReplyAt = at;
  }

  setBusy(sceneKey: string, busy: boolean): void {
    this.state(sceneKey).busy = busy;
  }

  clear(sceneKey?: string): void {
    if (sceneKey) {
      this.buffers.delete(sceneKey);
      this.states.delete(sceneKey);
      return;
    }
    this.buffers.clear();
    this.states.clear();
  }

  stats(): { scenes: number; messages: number; capacity: number } {
    let messages = 0;
    for (const buf of this.buffers.values()) messages += buf.length;
    return { scenes: this.buffers.size, messages, capacity: this.capacity };
  }

  allSceneKeys(): string[] {
    return [...this.buffers.keys()];
  }
}

/**
 * 判断闸门: 决定"现在要不要花一次小模型调用"。
 * 抽成纯函数便于单测, 也便于以后做更复杂的策略(如按群活跃度自适应)。
 */
export function shouldRunJudge(state: SceneState, gate: JudgeGate, poolSize: number, now = Date.now()): boolean {
  if (state.busy) return false;
  if (poolSize < gate.minMessages) return false;
  if (state.newSinceJudge < gate.everyN) return false;
  if (state.lastJudgeAt !== 0 && now - state.lastJudgeAt < gate.intervalMs) return false;
  return true;
}

/**
 * 粗略估算 token 数: 中文按 1 字 ≈ 1 token, 英文按 4 字符 ≈ 1 token。
 * 只用于控制台展示和 prompt 预算, 不追求和具体 tokenizer 完全一致。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 4);
}
