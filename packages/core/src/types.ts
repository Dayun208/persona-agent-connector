/**
 * PASC 领域模型
 *
 * 这里刻意与 OneBot/NapCat 的原始协议解耦: 平台适配层负责把 OneBot 事件
 * 归一化成 ChatMessage, 后续的消息池、判断引擎、Prompt 构建器、存档都只认
 * 这一套类型。
 */

export type SceneKind = 'group' | 'private';

export interface GroupScene {
  kind: 'group';
  groupId: string;
}

export interface PrivateScene {
  kind: 'private';
  userId: string;
}

export type Scene = GroupScene | PrivateScene;

/** 归一化后的消息片段 */
export type Segment =
  | { type: 'text'; text: string }
  | { type: 'at'; qq: string; name?: string }
  | { type: 'image'; url?: string; file?: string; summary?: string }
  | { type: 'face'; id: string }
  | { type: 'reply'; messageId: string }
  | { type: 'file'; name: string; url?: string; size?: number }
  | { type: 'other'; rawType: string; data: Record<string, unknown> };

export interface ChatMessage {
  /** 平台内唯一 id (OneBot message_id) */
  id: string;
  /** 本地自增序号, 用于稳定排序 */
  seq: number;
  scene: Scene;
  /** 'group:123456' | 'private:10001' */
  sceneKey: string;
  senderId: string;
  senderName: string;
  segments: Segment[];
  /** 拍平后的纯文本 (含 [图片] 之类的占位) */
  text: string;
  /** 被 @ 的 QQ 号, 'all' 表示 @全体成员 */
  atTargets: string[];
  mentionsSelf: boolean;
  /** 毫秒时间戳 */
  timestamp: number;
  isSelf: boolean;
  raw?: unknown;
}

export function sceneKeyOf(scene: Scene): string {
  return scene.kind === 'group' ? `group:${scene.groupId}` : `private:${scene.userId}`;
}

export function sceneLabel(scene: Scene): string {
  return scene.kind === 'group' ? `群 ${scene.groupId}` : `私聊 ${scene.userId}`;
}

/** 把毫秒时间戳格式化为 HH:MM:SS, 供 prompt 里的对话记录使用 */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 渲染成 Prompt 里的一行对话: `[12:00:01] 张三(10001): 你好` */
export function renderMessageLine(msg: ChatMessage, opts: { withTime?: boolean } = {}): string {
  const time = opts.withTime === false ? '' : `[${formatClock(msg.timestamp)}] `;
  // 注意: 拍平文本里已经包含 @xxx, 这里不要再拼一次
  return `${time}${msg.senderName}(${msg.senderId}): ${msg.text}`.trimEnd();
}
