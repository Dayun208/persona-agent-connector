import { EventEmitter } from 'node:events';
import type { ChatMessage, Logger, NapCatConfig, Scene, Segment } from '@pasc/core';
import { parseOneBotEvent, type OneBotEvent } from './parse.js';
import { HttpTransport } from './http.js';
import { WsTransport, type NapCatStatus } from './ws.js';

/** 事件名 → 参数元组(Node EventEmitter 泛型要求) */
export interface NapCatEvents {
  message: [msg: ChatMessage];
  status: [status: NapCatStatus];
  error: [error: Error];
  /** 原始事件, 调试用 */
  raw: [event: OneBotEvent];
}

export interface NapCatClientOptions {
  config: NapCatConfig;
  /** 机器人 QQ, 可留空, 从事件的 self_id 学习 */
  selfId?: string;
  logger: Logger;
}

/** OneBot 出站消息段 */
export type OutboundSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'at'; data: { qq: string } }
  | { type: 'image'; data: { file: string } }
  | { type: 'reply'; data: { id: string } };

/**
 * NapCat 通道客户端 —— 收消息、发指令。
 *
 * 收发分离:
 *   - 事件: protocol=ws 走 WS; protocol=http 由 server 的 /napcat/event webhook 喂进来
 *   - 指令: 优先 WS, 失败自动降级到 HTTP
 */
export class NapCatClient extends EventEmitter<NapCatEvents> {
  private ws: WsTransport | undefined;
  private readonly http: HttpTransport;
  private statusValue: NapCatStatus = 'idle';
  private learnedSelfId: string;

  constructor(private readonly opts: NapCatClientOptions) {
    super();
    this.learnedSelfId = opts.selfId ?? opts.config.selfId ?? '';
    this.http = new HttpTransport({
      baseURL: opts.config.httpAddress,
      token: opts.config.accessToken,
      logger: opts.logger.child('http'),
    });
  }

  get status(): NapCatStatus {
    return this.statusValue;
  }

  get selfId(): string {
    return this.learnedSelfId;
  }

  get protocol(): NapCatConfig['protocol'] {
    return this.opts.config.protocol;
  }

  start(): void {
    if (this.opts.config.protocol === 'http') {
      this.setStatus('connected');
      this.opts.logger.info('NapCat 通道运行在 HTTP 模式, 事件请指向 POST /napcat/event');
      return;
    }
    this.ws = new WsTransport({
      url: this.opts.config.address,
      token: this.opts.config.accessToken,
      logger: this.opts.logger.child('ws'),
      reconnect: this.opts.config.reconnect,
    });
    this.ws.on('status', (s) => this.setStatus(s));
    this.ws.on('event', (event) => this.handleRawEvent(event));
    this.ws.on('error', (err) => {
      // EventEmitter 在没有 error 监听时会直接抛出，这里做保护
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });
    this.ws.start();
  }

  async stop(): Promise<void> {
    await this.ws?.stop();
    this.ws = undefined;
    this.setStatus('closed');
  }

  /** HTTP 上报(webhook)或其它入口喂进来的原始事件 */
  handleRawEvent(event: OneBotEvent): void {
    if (!this.learnedSelfId && event.self_id) {
      this.learnedSelfId = String(event.self_id);
    }
    this.emit('raw', event);
    const msg = parseOneBotEvent(event, { selfId: this.learnedSelfId });
    if (msg) {
      // seq 由消息池统一分配, 这里先占位
      this.emit('message', msg);
    }
  }

  /** 调 OneBot 动作, 优先 WS, 失败降级 HTTP */
  async call(action: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.ws?.connected) {
      try {
        return await this.ws.call(action, params);
      } catch (err) {
        if (!this.http.configured) throw err;
        this.opts.logger.warn(`WS 调用 ${action} 失败, 降级 HTTP`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return this.http.call(action, params);
  }

  async sendText(scene: Scene, text: string, opts: { quoteMessageId?: string } = {}): Promise<unknown> {
    const segments: OutboundSegment[] = [];
    if (opts.quoteMessageId) segments.push({ type: 'reply', data: { id: opts.quoteMessageId } });
    segments.push({ type: 'text', data: { text } });
    return this.sendSegments(scene, segments);
  }

  async sendSegments(scene: Scene, segments: OutboundSegment[]): Promise<unknown> {
    return this.call(scene.kind === 'group' ? 'send_group_msg' : 'send_private_msg', {
      ...(scene.kind === 'group' ? { group_id: scene.groupId } : { user_id: scene.userId }),
      message: segments,
    });
  }

  async sendImage(scene: Scene, params: { url?: string; file?: string }): Promise<unknown> {
    const target = params.url ?? params.file ?? '';
    if (!target) throw new Error('send_image 缺少 url/file');
    const segments: OutboundSegment[] = [
      { type: 'image', data: { file: /^https?:\/\//i.test(target) ? target : `file://${target}` } },
    ];
    return this.sendSegments(scene, segments);
  }

  async sendFile(groupId: string, params: { file: string; name?: string }): Promise<unknown> {
    return this.call('upload_group_file', {
      group_id: groupId,
      file: params.file,
      name: params.name ?? params.file.split('/').pop() ?? 'file',
    });
  }

  async setGroupWholeBan(groupId: string, enable: boolean): Promise<unknown> {
    return this.call('set_group_whole_ban', { group_id: groupId, enable });
  }

  async setGroupName(groupId: string, name: string): Promise<unknown> {
    return this.call('set_group_name', { group_id: groupId, group_name: name });
  }

  async setGroupAdmin(groupId: string, userId: string, enable: boolean): Promise<unknown> {
    return this.call('set_group_admin', { group_id: groupId, user_id: userId, enable });
  }

  async setGroupSpecialTitle(groupId: string, userId: string, title: string): Promise<unknown> {
    return this.call('set_group_special_title', { group_id: groupId, user_id: userId, special_title: title });
  }

  /** 表情回应（NapCat 扩展） */
  async react(messageId: string, emojiId = '128077'): Promise<unknown> {
    return this.call('set_msg_emoji_like', { message_id: messageId, emoji_id: emojiId });
  }

  /** 名片点赞 */
  async sendLike(userId: string, times = 1): Promise<unknown> {
    return this.call('send_like', { user_id: userId, times: Math.max(1, Math.min(10, times)) });
  }

  async deleteMessage(messageId: string): Promise<unknown> {
    return this.call('delete_msg', { message_id: Number(messageId) || messageId });
  }

  async groupBan(groupId: string, userId: string, durationSec: number): Promise<unknown> {
    return this.call('set_group_ban', { group_id: groupId, user_id: userId, duration: durationSec });
  }

  async groupKick(groupId: string, userId: string): Promise<unknown> {
    return this.call('set_group_kick', { group_id: groupId, user_id: userId, reject_add_request: false });
  }

  async setCard(groupId: string, userId: string, card: string): Promise<unknown> {
    return this.call('set_group_card', { group_id: groupId, user_id: userId, card });
  }

  async poke(scene: Scene, userId: string): Promise<unknown> {
    if (scene.kind === 'group') {
      return this.call('group_poke', { group_id: scene.groupId, user_id: userId });
    }
    return this.call('friend_poke', { user_id: userId });
  }

  /**
   * 取图片在容器里的真实路径。
   *
   * 刚收到的图 NapCat 不一定马上缓存好，第一次调 get_image 可能直接返回错误；
   * 隔几百毫秒重试通常就有了。所以这里做 3 次退避重试，并把最后一次的错误带出来。
   */
  async getImage(file: string): Promise<{ file?: string; url?: string; error?: string } | undefined> {
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const raw = (await this.call('get_image', { file })) as { data?: { file?: string; url?: string } };
        if (raw?.data?.file) return raw.data;
        lastError = '返回里没有 file 字段';
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
    }
    return { error: lastError };
  }

  /** 好友列表（用于设置页选择管理员） */
  async getFriendList(): Promise<Array<{ userId: string; nickname: string; remark: string }>> {
    const raw = (await this.call('get_friend_list', {})) as unknown;
    const arr = Array.isArray(raw) ? raw : ((raw as { data?: unknown })?.data as unknown[] | undefined) ?? [];
    return (arr as Array<Record<string, unknown>>)
      .map((f) => ({
        userId: String(f.user_id ?? f.userId ?? ''),
        nickname: String(f.nickname ?? f.remark ?? ''),
        remark: String(f.remark ?? ''),
      }))
      .filter((f) => f.userId);
  }

  async getLoginInfo(): Promise<{ userId: string; nickname: string } | undefined> {
    try {
      const data = (await this.call('get_login_info', {})) as { user_id?: number; nickname?: string };
      if (data?.user_id !== undefined) {
        this.learnedSelfId = String(data.user_id);
        return { userId: String(data.user_id), nickname: data.nickname ?? '' };
      }
    } catch {
      /* 连不上就算了, 不影响主流程 */
    }
    return undefined;
  }

  /** 给控制台的健康检查 */
  async health(): Promise<{ ok: boolean; detail: string }> {
    if (this.opts.config.protocol === 'http') {
      const ok = await this.http.ping();
      return { ok, detail: ok ? 'HTTP API 可达' : 'HTTP API 不可达' };
    }
    const ok = this.ws?.connected ?? false;
    return { ok, detail: ok ? 'WebSocket 已连接' : `WebSocket ${this.status}` };
  }

  private setStatus(status: NapCatStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.emit('status', status);
  }
}

/** 便于上层构造出站消息段 */
export const seg = {
  text: (text: string): OutboundSegment => ({ type: 'text', data: { text } }),
  at: (qq: string): OutboundSegment => ({ type: 'at', data: { qq } }),
  image: (file: string): OutboundSegment => ({ type: 'image', data: { file } }),
  reply: (id: string): OutboundSegment => ({ type: 'reply', data: { id } }),
};

/** 把内部 Segment 转成 OneBot 出站段(send_image 等复用) */
export function toOutbound(segment: Segment): OutboundSegment | undefined {
  if (segment.type === 'text') return { type: 'text', data: { text: segment.text } };
  if (segment.type === 'at') return { type: 'at', data: { qq: segment.qq } };
  if (segment.type === 'image') {
    const file = segment.url ?? segment.file;
    return file ? { type: 'image', data: { file } } : undefined;
  }
  return undefined;
}
