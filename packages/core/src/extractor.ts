import type { ChatMessage } from './types.js';
import type { ExtractionConfig } from './config.js';

/**
 * Q/A 自动截取 —— 模块三的地基。
 *
 * 目标: 从群聊记录里找出"有人提问 → 目标用户作答"的片段,
 * 作为 few-shot 样本注入 Prompt, 让通用模型也能答出目标人格的味道。
 *
 * 这里刻意不依赖任何模型: 先做规则配对, 再用 LLM 只做"提纯"这一层,
 * 这样即使没有 API Key, 也能抽出一份可用的样本集。
 */

export interface Utterance {
  senderId: string;
  senderName: string;
  /** 合并后的文本(多条连发用换行拼接) */
  text: string;
  /** 被合并的原始消息 id */
  messageIds: string[];
  timestamp: number;
  atTargets: string[];
  /** 这条发言回复了哪条消息 */
  replyTo?: string;
}

export interface QaPair {
  id: string;
  sceneKey: string;
  /** 提问方 */
  asker: { id: string; name: string };
  /** 目标用户 */
  target: { id: string; name: string };
  question: string;
  answer: string;
  questionAt: number;
  answerAt: number;
  /** 配对依据: 显式回复 / @ 了对方 / 时间上相邻 */
  link: 'reply' | 'at' | 'adjacent';
  /** 目标用户在这对里是回答者还是提问者 */
  role: 'answerer' | 'asker';
  /** 0~1, 越高越适合当样本 */
  score: number;
}

export interface ExtractOptions {
  targetId: string;
  sceneKey?: string;
  windowMs?: number;
  mergeGapMs?: number;
  minAnswerChars?: number;
  maxPairs?: number;
  includeTargetAsks?: boolean;
  /**
   * 是否剔除"机器人自己发的消息"(默认 true)。
   * 提取某个人的人格时, 机器人自己的接话不该被当成提问;
   * 但如果目标就是机器人账号, 它的发言要保留。
   */
  excludeSelf?: boolean;
}

/** 纯噪声的占位文本, 不能当作有效发言 */
const NOISE = /^(\[图片\]|\[表情\]|\[语音\]|\[视频\]|\[文件:[^\]]*\]|\[卡片\]|\[合并转发\])+$/;

export function isMeaningfulText(text: string, minChars = 2): boolean {
  const stripped = text.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '');
  if (stripped.length < minChars) return false;
  return !NOISE.test(text.trim());
}

/**
 * 把同一人短时间内连发的消息合并成一条"发言"。
 * 例如 [在吗][在的][怎么了] 三条 3 秒内的消息, 应该视为一段回答。
 */
export function groupUtterances(messages: ChatMessage[], mergeGapMs = 15_000): Utterance[] {
  const out: Utterance[] = [];
  for (const msg of messages) {
    if (!msg.text.trim()) continue;
    const last = out[out.length - 1];
    const replySeg = msg.segments.find((s) => s.type === 'reply');
    if (
      last &&
      last.senderId === msg.senderId &&
      msg.timestamp - last.timestamp <= mergeGapMs &&
      !(replySeg && msg.segments[0]?.type === 'reply') // 明确回复别人的消息不合并
    ) {
      last.text = `${last.text}\n${msg.text}`;
      last.messageIds.push(msg.id);
      last.timestamp = msg.timestamp;
      last.atTargets = unique([...last.atTargets, ...msg.atTargets]);
      continue;
    }
    out.push({
      senderId: msg.senderId,
      senderName: msg.senderName,
      text: msg.text,
      messageIds: [msg.id],
      timestamp: msg.timestamp,
      atTargets: [...msg.atTargets],
      ...(replySeg && replySeg.type === 'reply' ? { replyTo: replySeg.messageId } : {}),
    });
  }
  return out;
}

export interface ExtractResult {
  pairs: QaPair[];
  utterances: Utterance[];
  stats: {
    scanned: number;
    targetUtterances: number;
    rejected: number;
  };
}

/**
 * 主体算法: 按时间顺序扫描, 为每条"目标用户的发言"找它的上一条提问。
 *
 * 优先级的判断顺序:
 *   1. 显式回复(reply 段) → 精准
 *   2. 目标 @ 了某人 → 找该用户刚才说的话
 *   3. 时间上最近的、别人的发言 → 兜底
 */
export function extractQaPairs(messages: ChatMessage[], opts: ExtractOptions): ExtractResult {
  const cfg: Required<Omit<ExtractOptions, 'sceneKey'>> & { sceneKey?: string } = {
    targetId: opts.targetId,
    windowMs: opts.windowMs ?? 180_000,
    mergeGapMs: opts.mergeGapMs ?? 15_000,
    minAnswerChars: opts.minAnswerChars ?? 2,
    maxPairs: opts.maxPairs ?? 60,
    includeTargetAsks: opts.includeTargetAsks ?? false,
    excludeSelf: opts.excludeSelf ?? true,
    ...(opts.sceneKey ? { sceneKey: opts.sceneKey } : {}),
  };

  // 机器人自己的发言不参与配对(除非要提纯的就是机器人自己)
  const corpus = cfg.excludeSelf
    ? messages.filter((m) => !m.isSelf || m.senderId === cfg.targetId)
    : messages;

  const utterances = groupUtterances(corpus, cfg.mergeGapMs).sort((a, b) => a.timestamp - b.timestamp);
  const byMessageId = new Map<string, Utterance>();
  for (const u of utterances) for (const id of u.messageIds) byMessageId.set(id, u);

  const pairs: QaPair[] = [];
  const used = new Set<string>();
  let rejected = 0;
  let targetUtterances = 0;

  for (let i = 0; i < utterances.length; i += 1) {
    const answer = utterances[i]!;
    if (answer.senderId !== cfg.targetId) continue;
    targetUtterances += 1;

    if (!isMeaningfulText(answer.text, cfg.minAnswerChars)) {
      rejected += 1;
      continue;
    }

    const question = findQuestion(utterances, i, answer, byMessageId, cfg);
    if (!question) {
      rejected += 1;
      continue;
    }
    if (!isMeaningfulText(question.text, 1)) {
      rejected += 1;
      continue;
    }

    const key = `${question.timestamp}-${answer.timestamp}`;
    if (used.has(key)) continue;
    used.add(key);

    const link = classifyLink(question, answer, byMessageId);
    pairs.push({
      id: key,
      sceneKey: messages[0]?.sceneKey ?? '',
      asker: { id: question.senderId, name: question.senderName },
      target: { id: answer.senderId, name: answer.senderName },
      question: question.text,
      answer: answer.text,
      questionAt: question.timestamp,
      answerAt: answer.timestamp,
      link,
      role: 'answerer',
      score: scorePair(question, answer, link),
    });
  }

  // 反向: 目标用户 @ 别人, 别人作答
  if (cfg.includeTargetAsks) {
    for (let i = 0; i < utterances.length; i += 1) {
      const question = utterances[i]!;
      if (question.senderId !== cfg.targetId) continue;
      const targets = question.atTargets.filter((q) => q !== 'all' && q !== cfg.targetId);
      if (targets.length === 0) continue;

      for (const atId of targets) {
        const answer = utterances
          .slice(i + 1)
          .find((u) => u.senderId === atId && u.timestamp - question.timestamp <= cfg.windowMs);
        if (!answer || !isMeaningfulText(answer.text, cfg.minAnswerChars)) continue;

        const key = `ask-${question.timestamp}-${answer.timestamp}`;
        if (used.has(key)) continue;
        used.add(key);

        pairs.push({
          id: key,
          sceneKey: messages[0]?.sceneKey ?? '',
          asker: { id: question.senderId, name: question.senderName },
          target: { id: answer.senderId, name: answer.senderName },
          question: question.text,
          answer: answer.text,
          questionAt: question.timestamp,
          answerAt: answer.timestamp,
          link: 'at',
          role: 'asker',
          score: scorePair(question, answer, 'at') * 0.7,
        });
      }
    }
  }

  // 同样的问题得到同样的回答, 只留一条(分数取高的)
  const byContent = new Map<string, QaPair>();
  for (const pair of pairs) {
    const key = `${pair.question.trim()}|${pair.answer.trim()}`;
    const prev = byContent.get(key);
    if (!prev || pair.score > prev.score) byContent.set(key, pair);
  }

  const deduped = [...byContent.values()].sort((a, b) => b.score - a.score);
  return {
    pairs: deduped.slice(0, cfg.maxPairs),
    utterances,
    stats: { scanned: corpus.length, targetUtterances, rejected },
  };
}

function findQuestion(
  utterances: Utterance[],
  index: number,
  answer: Utterance,
  byMessageId: Map<string, Utterance>,
  cfg: { targetId: string; windowMs: number },
): Utterance | undefined {
  // 1) 显式回复
  if (answer.replyTo) {
    const quoted = byMessageId.get(answer.replyTo);
    if (quoted && quoted.senderId !== cfg.targetId) return quoted;
  }

  // 2) 目标 @ 了谁 → 找那个人刚才的发言
  for (const atId of answer.atTargets) {
    if (atId === 'all' || atId === cfg.targetId) continue;
    for (let j = index - 1; j >= 0; j -= 1) {
      const u = utterances[j]!;
      if (answer.timestamp - u.timestamp > cfg.windowMs) break;
      if (u.senderId === atId) return u;
    }
  }

  // 3) 时间上最近的一条别人的发言
  for (let j = index - 1; j >= 0; j -= 1) {
    const u = utterances[j]!;
    if (answer.timestamp - u.timestamp > cfg.windowMs) return undefined;
    if (u.senderId === cfg.targetId) continue; // 自己连续发言, 继续往前找
    return u;
  }
  return undefined;
}

function classifyLink(question: Utterance, answer: Utterance, byMessageId: Map<string, Utterance>): QaPair['link'] {
  if (answer.replyTo && byMessageId.get(answer.replyTo) === question) return 'reply';
  if (answer.atTargets.includes(question.senderId)) return 'at';
  return 'adjacent';
}

/**
 * 打分: 决定哪些对子更适合当 few-shot。
 * 显式回复最可靠, 其次是 @, 再其次是时间相邻;
 * 问题里带问号、回答有一定长度都会加分。
 */
export function scorePair(question: Utterance, answer: Utterance, link: QaPair['link']): number {
  let score = 0.35;
  if (link === 'reply') score += 0.3;
  else if (link === 'at') score += 0.2;
  else score += 0.05;

  if (/[?？]|怎么|为什么|如何|有没有|推荐|求/.test(question.text)) score += 0.15;

  const len = answer.text.length;
  if (len >= 6 && len <= 60) score += 0.15;
  else if (len > 60) score += 0.05;
  else if (len < 4) score -= 0.15;

  if (isMeaningfulText(question.text, 3)) score += 0.05;
  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

/** 取默认参数, 供服务端从配置里读 */
export function extractionOptionsFrom(config: ExtractionConfig, targetId: string, sceneKey?: string): ExtractOptions {
  return {
    targetId,
    windowMs: config.windowMs,
    mergeGapMs: config.mergeGapMs,
    minAnswerChars: config.minAnswerChars,
    maxPairs: config.maxPairs,
    includeTargetAsks: config.includeTargetAsks,
    ...(sceneKey ? { sceneKey } : {}),
  };
}

/** 按目标用户筛选其全部发言(用于人格统计) */
export function collectUserMessages(messages: ChatMessage[], userId: string): ChatMessage[] {
  return messages.filter((m) => m.senderId === userId && m.text.trim().length > 0);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
