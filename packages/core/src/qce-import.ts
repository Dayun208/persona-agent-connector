import type { ChatMessage, Scene, Segment } from './types.js';
import { sceneKeyOf } from './types.js';

/**
 * qq-chat-exporter (QCE) 导出文件导入器。
 *
 * 为什么要支持它: QCE 能把 QQ NT 本地库导出成 JSON/JSONL, 是"冷启动"人格提纯最省事的数据源
 * —— 不需要机器人先跑几个月的群聊。
 *
 * 注意: 这里只做格式兼容, 不复制 QCE 的代码(QCE 为 GPL-3.0)。
 * 字段取自 qq-chat-export-core/src/types.rs 的公开结构:
 *   { chatInfo: {name,type,selfUin,peerUin,...}, messages: [ {id,timestamp,sender,content{text,elements,mentions}} ] }
 * 同时容忍常见变体(裸数组、data.messages、JSONL 分块)。
 */

export interface QceChatInfo {
  name: string;
  type: string;
  participantCount?: number;
  selfUin?: string;
  selfUid?: string;
  peerUin?: string;
  peerUid?: string;
}

export interface QceImportOptions {
  /** QCE 的 chatInfo 不一定带群号, 允许外部指定 */
  groupId?: string;
  /** 直接指定 sceneKey(优先于推断) */
  sceneKey?: string;
  selfId?: string;
  /** 是否保留已撤回/系统消息 */
  includeSystem?: boolean;
}

export interface QceImportResult {
  chatInfo: QceChatInfo;
  messages: ChatMessage[];
  skipped: number;
  warnings: string[];
  sceneKey: string;
}

interface QceSender {
  uid?: string;
  uin?: string | number;
  name?: string;
  nickname?: string;
  groupCard?: string;
  remark?: string;
}

interface QceElement {
  type?: string;
  data?: Record<string, unknown>;
}

interface QceMessage {
  id?: string | number;
  seq?: string | number;
  timestamp?: number | string;
  time?: string;
  sender?: QceSender;
  type?: string;
  content?: {
    text?: string;
    elements?: QceElement[];
    mentions?: Array<{ uid?: string; uin?: string | number; name?: string; type?: string }>;
  };
  recalled?: boolean;
  system?: boolean;
}

/**
 * 解析一次 QCE 导出。输入可以是:
 *   - 完整导出对象 { chatInfo, messages }
 *   - 只有 messages 的包装对象
 *   - 裸消息数组
 *   - { data: { messages } } 之类的嵌套
 */
export function parseQceExport(input: unknown, opts: QceImportOptions = {}): QceImportResult {
  const warnings: string[] = [];

  if (Array.isArray(input)) {
    return finalize({ chatInfo: {}, messages: input as QceMessage[] }, opts, warnings);
  }
  if (!input || typeof input !== 'object') {
    throw new Error('QCE 导入: 输入不是对象或数组');
  }

  const root = input as Record<string, unknown>;
  const messages = firstArray(root, ['messages', 'data.messages', 'records', 'list']);
  const chatInfo = firstObject(root, ['chatInfo', 'chat_info', 'chat']);

  if (!messages) {
    // 逐条消息的导出(每条一个字段完整的对象)
    if (looksLikeMessage(root)) {
      return finalize({ chatInfo: {}, messages: [root as QceMessage] }, opts, warnings);
    }
    throw new Error('QCE 导入: 找不到 messages 数组');
  }

  return finalize({ chatInfo, messages }, opts, warnings);
}

/** QCE 的分块导出(jl / jsonl): 每行可能是一条消息, 也可能是一个带 messages 的块 */
export function parseQceJsonl(text: string, opts: QceImportOptions = {}): QceImportResult {
  const warnings: string[] = [];
  const collected: QceMessage[] = [];
  let chatInfo: Record<string, unknown> = {};

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      warnings.push('有一行不是合法 JSON, 已跳过');
      continue;
    }
    if (Array.isArray(value)) {
      collected.push(...(value as QceMessage[]));
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const obj = value as Record<string, unknown>;
    if (obj.chatInfo && typeof obj.chatInfo === 'object') chatInfo = obj.chatInfo as Record<string, unknown>;
    if (Array.isArray(obj.messages)) {
      collected.push(...(obj.messages as QceMessage[]));
      continue;
    }
    if (looksLikeMessage(obj)) collected.push(obj as QceMessage);
  }

  return finalize({ chatInfo, messages: collected }, opts, warnings);
}

function finalize(
  input: { chatInfo: Record<string, unknown>; messages: QceMessage[] },
  opts: QceImportOptions,
  warnings: string[],
): QceImportResult {
  const chatInfo = normalizeChatInfo(input.chatInfo);
  const selfId = String(opts.selfId ?? chatInfo.selfUin ?? '');

  const otherSender = input.messages
    .map((m) => String(m.sender?.uin ?? m.sender?.uid ?? ''))
    .find((id) => id && id !== selfId);

  const scene = resolveScene(chatInfo, opts, selfId, otherSender);
  const sceneKey = sceneKeyOf(scene);

  const messages: ChatMessage[] = [];
  let skipped = 0;

  input.messages.forEach((raw, index) => {
    const msg = parseMessage(raw, { scene, sceneKey, selfId, index, includeSystem: opts.includeSystem ?? false });
    if (!msg) {
      skipped += 1;
      return;
    }
    messages.push(msg);
  });

  if (messages.length === 0) warnings.push('解析后没有任何可用消息');

  return { chatInfo, messages, skipped, warnings, sceneKey };
}

function resolveScene(
  info: QceChatInfo,
  opts: QceImportOptions,
  selfId: string,
  otherSender: string | undefined,
): Scene {
  if (opts.sceneKey?.startsWith('group:')) return { kind: 'group', groupId: opts.sceneKey.slice(6) };
  if (opts.sceneKey?.startsWith('private:')) return { kind: 'private', userId: opts.sceneKey.slice(8) };

  if (info.type === 'private' || info.type === 'temp') {
    const userId = info.peerUin ?? info.peerUid ?? otherSender ?? 'unknown';
    return { kind: 'private', userId };
  }

  const groupId = opts.groupId ?? info.peerUin ?? info.peerUid ?? info.name ?? 'unknown';
  return { kind: 'group', groupId };
}

function parseMessage(
  raw: QceMessage,
  ctx: { scene: Scene; sceneKey: string; selfId: string; index: number; includeSystem: boolean },
): ChatMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  if (raw.system && !ctx.includeSystem) return undefined;

  const senderId = String(raw.sender?.uin ?? raw.sender?.uid ?? '');
  if (!senderId) return undefined;

  const segments = buildSegments(raw);
  const text = (raw.content?.text ?? '').trim() || flatten(segments);
  const atTargets = buildMentions(raw, segments);

  return {
    id: String(raw.id ?? raw.seq ?? `qce-${ctx.sceneKey}-${ctx.index}`),
    seq: 0,
    scene: ctx.scene,
    sceneKey: ctx.sceneKey,
    senderId,
    senderName: raw.sender?.groupCard || raw.sender?.name || raw.sender?.nickname || senderId,
    segments,
    text,
    atTargets,
    mentionsSelf: ctx.selfId !== '' && atTargets.includes(ctx.selfId),
    timestamp: normalizeTimestamp(raw.timestamp, raw.time),
    isSelf: ctx.selfId !== '' && senderId === ctx.selfId,
  };
}

function buildSegments(raw: QceMessage): Segment[] {
  const elements = raw.content?.elements;
  const segments: Segment[] = [];

  if (Array.isArray(elements)) {
    for (const el of elements) {
      const seg = elementToSegment(el);
      if (seg) segments.push(seg);
    }
  }

  // 没有结构化元素时, 用纯文本兜底
  if (segments.length === 0 && raw.content?.text) {
    segments.push({ type: 'text', text: raw.content.text });
  }
  return segments;
}

function elementToSegment(el: QceElement): Segment | undefined {
  const type = String(el?.type ?? '');
  const d = (el?.data ?? {}) as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const v = d[key];
    return v === undefined || v === null ? undefined : String(v);
  };

  switch (type) {
    case 'text':
      return { type: 'text', text: str('text') ?? str('content') ?? '' };
    case 'image': {
      const url = str('url') ?? str('localPath');
      const file = str('fileName') ?? str('file');
      return { type: 'image', ...(url ? { url } : {}), ...(file ? { file } : {}) };
    }
    case 'at': {
      const qq = str('uid') ?? str('uin') ?? str('qq');
      return qq ? { type: 'at', qq } : undefined;
    }
    case 'face':
    case 'market_face':
      return { type: 'face', id: str('id') ?? '' };
    case 'reply':
      return { type: 'reply', messageId: str('id') ?? str('messageId') ?? '' };
    case 'file': {
      const url = str('url') ?? str('localPath');
      return {
        type: 'file',
        name: str('fileName') ?? str('name') ?? '文件',
        ...(url ? { url } : {}),
        ...(d.size !== undefined ? { size: Number(d.size) } : {}),
      };
    }
    default:
      return { type: 'other', rawType: type || 'unknown', data: d };
  }
}

function buildMentions(raw: QceMessage, segments: Segment[]): string[] {
  const fromMentions = (raw.content?.mentions ?? [])
    .map((m) => (m.type === 'all' ? 'all' : String(m.uin ?? m.uid ?? '')))
    .filter(Boolean);
  if (fromMentions.length > 0) return [...new Set(fromMentions)];

  return [...new Set(segments.filter((s) => s.type === 'at').map((s) => (s as { qq: string }).qq))];
}

function normalizeTimestamp(ts: number | string | undefined, time: string | undefined): number {
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
    // QCE 用毫秒; 兼容秒级
    return ts < 1e12 ? ts * 1000 : ts;
  }
  if (typeof ts === 'string' && /^\d+$/.test(ts)) {
    const n = Number(ts);
    return n < 1e12 ? n * 1000 : n;
  }
  if (time) {
    // "YYYY-MM-DD HH:mm:ss"
    const parsed = Date.parse(time.replace(' ', 'T'));
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function normalizeChatInfo(raw: Record<string, unknown>): QceChatInfo {
  const pick = (keys: string[]): string | undefined => {
    for (const key of keys) {
      const v = raw[key];
      if (v !== undefined && v !== null && String(v) !== '') return String(v);
    }
    return undefined;
  };
  return {
    name: pick(['name', 'chatName', 'title']) ?? '',
    type: pick(['type', 'chatType']) ?? 'group',
    ...(raw.participantCount !== undefined ? { participantCount: Number(raw.participantCount) } : {}),
    ...(() => {
      const selfUin = pick(['selfUin', 'self_uin']);
      return selfUin ? { selfUin } : {};
    })(),
    ...(() => {
      const peerUin = pick(['peerUin', 'peer_uin', 'groupCode', 'groupCodeStr']);
      return peerUin ? { peerUin } : {};
    })(),
  };
}

function flatten(segments: Segment[]): string {
  return segments
    .map((s) => {
      switch (s.type) {
        case 'text':
          return s.text;
        case 'at':
          return s.qq === 'all' ? '@全体成员' : `@${s.qq}`;
        case 'image':
          return '[图片]';
        case 'face':
          return '[表情]';
        case 'file':
          return `[文件:${s.name}]`;
        case 'reply':
          return '';
        default:
          return '';
      }
    })
    .join('')
    .trim();
}

function firstArray(root: Record<string, unknown>, paths: string[]): QceMessage[] | undefined {
  for (const path of paths) {
    const value = path.split('.').reduce<unknown>((acc, key) => {
      if (!acc || typeof acc !== 'object') return undefined;
      return (acc as Record<string, unknown>)[key];
    }, root);
    if (Array.isArray(value)) return value as QceMessage[];
  }
  return undefined;
}

function firstObject(root: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = root[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return {};
}

function looksLikeMessage(obj: Record<string, unknown>): boolean {
  return (obj.sender !== undefined || obj.content !== undefined) && (obj.id !== undefined || obj.timestamp !== undefined);
}
