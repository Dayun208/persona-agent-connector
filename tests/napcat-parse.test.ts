import { describe, expect, it } from 'vitest';
import { flattenSegments, parseCQString, parseOneBotEvent, toSegments, type OneBotEvent } from '@pasc/napcat';

const SELF = '99999';

function groupEvent(over: Record<string, unknown> = {}): OneBotEvent {
  return {
    post_type: 'message',
    message_type: 'group',
    message_id: 42,
    group_id: 123456,
    user_id: 10001,
    self_id: Number(SELF),
    sender: { user_id: 10001, nickname: '测试用户' },
    time: 1_700_000_000,
    message: [{ type: 'text', data: { text: '你好' } }],
    ...over,
  };
}

describe('parseOneBotEvent', () => {
  it('归一化群消息', () => {
    const msg = parseOneBotEvent(groupEvent(), { selfId: SELF });
    expect(msg).toBeDefined();
    expect(msg!.scene).toEqual({ kind: 'group', groupId: '123456' });
    expect(msg!.sceneKey).toBe('group:123456');
    expect(msg!.text).toBe('你好');
    expect(msg!.senderName).toBe('测试用户');
    expect(msg!.timestamp).toBe(1_700_000_000_000);
  });

  it('识别 @ 机器人', () => {
    const msg = parseOneBotEvent(
      groupEvent({
        message: [
          { type: 'at', data: { qq: SELF } },
          { type: 'text', data: { text: ' 在吗' } },
        ],
      }),
      { selfId: SELF },
    );
    expect(msg!.mentionsSelf).toBe(true);
    expect(msg!.atTargets).toEqual([SELF]);
    expect(msg!.text).toBe('@99999 在吗');
  });

  it('@ 别人不算 @ 我', () => {
    const msg = parseOneBotEvent(
      groupEvent({ message: [{ type: 'at', data: { qq: '20001' } }, { type: 'text', data: { text: ' hi' } }] }),
      { selfId: SELF },
    );
    expect(msg!.mentionsSelf).toBe(false);
  });

  it('非消息事件返回 undefined', () => {
    expect(parseOneBotEvent(groupEvent({ post_type: 'notice' }), { selfId: SELF })).toBeUndefined();
  });

  it('支持纯 CQ 码字符串', () => {
    const msg = parseOneBotEvent(
      groupEvent({
        message: `[CQ:at,qq=${SELF}] 看图 [CQ:image,file=a.jpg,url=https://x/a.jpg]`,
      }),
      { selfId: SELF },
    );
    expect(msg!.mentionsSelf).toBe(true);
    expect(msg!.text).toContain('[图片]');
    expect(msg!.segments.some((s) => s.type === 'image')).toBe(true);
  });

  it('识别机器人自己发的消息', () => {
    const msg = parseOneBotEvent(groupEvent({ user_id: Number(SELF) }), { selfId: SELF });
    expect(msg!.isSelf).toBe(true);
  });
});

describe('段落处理', () => {
  it('flattenSegments 生成可读文本', () => {
    const segments = toSegments([
      { type: 'text', data: { text: '看这个 ' } },
      { type: 'image', data: { url: 'x' } },
      { type: 'face', data: { id: '1' } },
      { type: 'at', data: { qq: 'all' } },
    ]);
    expect(flattenSegments(segments)).toBe('看这个 [图片][表情]@全体成员');
  });

  it('parseCQString 还原转义字符', () => {
    const segs = parseCQString('[CQ:at,qq=1] &#91;abc&#93;');
    expect(segs[0]).toEqual({ type: 'at', qq: '1' });
    expect(segs[1]).toEqual({ type: 'text', text: ' [abc]' });
  });
});
