import type { ChatMessage, Scene, Segment } from '@pasc/core';
import { sceneKeyOf } from '@pasc/core';

/** OneBot v11 消息段 */
export interface OneBotSegment {
  type: string;
  data: Record<string, unknown>;
}

/** OneBot v11 事件(NapCat 转发出来的原始形态) */
export interface OneBotEvent {
  post_type?: string;
  message_type?: 'group' | 'private';
  sub_type?: string;
  message_id?: number | string;
  group_id?: number | string;
  user_id?: number | string;
  self_id?: number | string;
  raw_message?: string;
  message?: string | OneBotSegment[];
  sender?: {
    user_id?: number | string;
    nickname?: string;
    card?: string;
  };
  time?: number;
  echo?: unknown;
  [key: string]: unknown;
}

export interface ParseOptions {
  selfId?: string;
  /** 用本地时间兜底(事件没带 time 时) */
  now?: number;
}

const CQ_AT = /\[CQ:at,qq=([^,\]]+)[^\]]*\]/g;
const CQ_IMAGE = /\[CQ:image,([^\]]*)\]/g;
const CQ_FACE = /\[CQ:face,id=([^\],]+)[^\]]*\]/g;
const CQ_ANY = /\[CQ:([a-zA-Z_]+),?([^\]]*)\]/g;

/**
 * 把 NapCat/OneBot 事件归一化成 PASC 内部的 ChatMessage。
 * 不是消息事件就返回 undefined。
 */
export interface PokeEvent {
  /** 戳人的人 */
  operatorId: string;
  /** 被戳的人 */
  targetId: string;
  scene: Scene;
  timestamp: number;
}

/**
 * 解析"戳一戳"通知。
 * OneBot 11 里它是 notice + notify + poke，群聊和私聊的字段位置还不一样：
 *   群：group_id + user_id（戳人的人）+ target_id（被戳的人）
 *   私聊：user_id（戳人的人）+ target_id
 */
export function parsePokeEvent(event: OneBotEvent): PokeEvent | undefined {
  const e = event as unknown as Record<string, unknown>;
  if (e['post_type'] !== 'notice') return undefined;
  if (e['notice_type'] !== 'notify') return undefined;
  if (e['sub_type'] !== 'poke') return undefined;

  const groupId = e['group_id'];
  const operatorId = String(e['user_id'] ?? '');
  const targetId = String(e['target_id'] ?? '');
  if (!operatorId || !targetId) return undefined;

  const scene: Scene = groupId !== undefined && groupId !== null && String(groupId) !== ''
    ? { kind: 'group', groupId: String(groupId) }
    : { kind: 'private', userId: operatorId };

  const time = typeof e['time'] === 'number' ? e['time'] : Math.floor(Date.now() / 1000);
  return { operatorId, targetId, scene, timestamp: time * 1000 };
}

export function parseOneBotEvent(event: OneBotEvent, opts: ParseOptions = {}): ChatMessage | undefined {
  const postType = event.post_type;
  if (postType !== 'message' && postType !== 'message_sent') return undefined;

  const messageType = event.message_type;
  if (messageType !== 'group' && messageType !== 'private') return undefined;

  const selfId = String(opts.selfId ?? event.self_id ?? '');
  const userId = String(event.user_id ?? event.sender?.user_id ?? '');

  const scene = messageType === 'group'
    ? ({ kind: 'group', groupId: String(event.group_id ?? '') } as const)
    : ({ kind: 'private', userId } as const);

  const segments = toSegments(event.message, event.raw_message);
  const atTargets = segments.filter((s) => s.type === 'at').map((s) => (s as { qq: string }).qq);

  const senderName =
    event.sender?.card?.trim() ||
    event.sender?.nickname?.trim() ||
    userId ||
    '未知用户';

  return {
    id: String(event.message_id ?? ''),
    seq: 0, // 由消息池分配
    scene,
    sceneKey: sceneKeyOf(scene),
    senderId: userId,
    senderName,
    segments,
    text: flattenSegments(segments),
    atTargets,
    mentionsSelf: selfId !== '' && atTargets.includes(selfId),
    timestamp: (event.time ? event.time * 1000 : (opts.now ?? Date.now())),
    isSelf: postType === 'message_sent' || (selfId !== '' && userId === selfId),
    raw: event,
  };
}

/** 数组段 / CQ 码字符串 → 归一化段落 */
export function toSegments(message: string | OneBotSegment[] | undefined, raw?: string): Segment[] {
  if (Array.isArray(message)) {
    return message.map(fromOneBotSegment);
  }
  const text = typeof message === 'string' ? message : (raw ?? '');
  if (!text) return [];
  return parseCQString(text);
}

function fromOneBotSegment(seg: OneBotSegment): Segment {
  const d = seg.data ?? {};
  switch (seg.type) {
    case 'text':
      return { type: 'text', text: String(d.text ?? '') };
    case 'at':
      return { type: 'at', qq: String(d.qq ?? '') };
    case 'image':
      return {
        type: 'image',
        ...(d.url ? { url: String(d.url) } : {}),
        ...(d.file ? { file: String(d.file) } : {}),
        ...(d.summary ? { summary: String(d.summary) } : {}),
      };
    case 'face':
      return { type: 'face', id: String(d.id ?? '') };
    case 'reply':
      return { type: 'reply', messageId: String(d.id ?? '') };
    case 'file':
      return {
        type: 'file',
        name: String(d.name ?? d.file ?? '文件'),
        ...(d.url ? { url: String(d.url) } : {}),
        ...(typeof d.file_size === 'number' ? { size: d.file_size } : {}),
      };
    default:
      return { type: 'other', rawType: seg.type, data: d };
  }
}

/** 解析 CQ 码字符串(兼容某些只推 raw_message 的配置) */
export function parseCQString(text: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  const regex = /\[CQ:([a-zA-Z_]+),?([^\]]*)\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > cursor) {
      segments.push({ type: 'text', text: unescapeCQ(text.slice(cursor, match.index)) });
    }
    const type = match[1] ?? '';
    const attrs = parseAttrs(match[2] ?? '');
    segments.push(cqToSegment(type, attrs));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ type: 'text', text: unescapeCQ(text.slice(cursor)) });
  }
  if (segments.length === 0) segments.push({ type: 'text', text: unescapeCQ(text) });
  return segments;
}

function cqToSegment(type: string, attrs: Record<string, string>): Segment {
  switch (type) {
    case 'at':
      return { type: 'at', qq: attrs.qq ?? '' };
    case 'image':
      return {
        type: 'image',
        ...(attrs.url ? { url: attrs.url } : {}),
        ...(attrs.file ? { file: attrs.file } : {}),
      };
    case 'face':
      return { type: 'face', id: attrs.id ?? '' };
    case 'reply':
      return { type: 'reply', messageId: attrs.id ?? '' };
    default:
      return { type: 'other', rawType: type, data: attrs };
  }
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    out[pair.slice(0, idx)] = unescapeCQ(pair.slice(idx + 1));
  }
  return out;
}

function unescapeCQ(text: string): string {
  return text
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/** 拍平成给 LLM 看的纯文本 */
export function flattenSegments(segments: Segment[]): string {
  return segments
    .map((s) => {
      switch (s.type) {
        case 'text':
          return s.text;
        case 'at':
          return s.qq === 'all' ? '@全体成员' : `@${s.qq}`;
        case 'image':
          return s.summary ? `[图片:${s.summary}]` : '[图片]';
        case 'face':
          return '[表情]';
        case 'reply':
          return '';
        case 'file':
          return `[文件:${s.name}]`;
        case 'other':
          return `[${s.rawType}]`;
        default:
          return '';
      }
    })
    .join('')
    .trim();
}

/** 顺带导出, 避免使用方重复写正则 */
export { CQ_AT, CQ_IMAGE, CQ_FACE, CQ_ANY };
