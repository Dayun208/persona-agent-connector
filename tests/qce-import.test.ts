import { describe, expect, it } from 'vitest';
import { parseQceExport, parseQceJsonl } from '@pasc/core';

const SELF_UIN = '99999';

function sampleExport() {
  return {
    metadata: { name: 'QQChatExporter', version: '4.5.0' },
    chatInfo: {
      name: '测试群',
      type: 'group',
      peerUin: '123456',
      selfUin: SELF_UIN,
      participantCount: 3,
    },
    messages: [
      {
        id: 'm1',
        seq: '1',
        timestamp: 1_700_000_000_000,
        sender: { uin: '20001', uid: 'u_20001', name: '老陈', groupCard: '陈哥' },
        type: 'type_1',
        content: {
          text: '这个报错怎么解决啊',
          elements: [{ type: 'text', data: { text: '这个报错怎么解决啊' } }],
          mentions: [],
        },
      },
      {
        id: 'm2',
        seq: '2',
        timestamp: 1_700_000_010_000,
        sender: { uin: '20002', uid: 'u_20002', name: '阿琳' },
        content: {
          text: '看图 [图片]',
          elements: [
            { type: 'text', data: { text: '看图 ' } },
            { type: 'image', data: { url: 'https://example.com/a.png', fileName: 'a.png' } },
          ],
          mentions: [{ uid: 'u_99999', uin: SELF_UIN, name: '小明', type: 'user' }],
        },
      },
      {
        id: 'm3',
        seq: '3',
        timestamp: 1_700_000_020_000,
        sender: { uin: SELF_UIN, name: '小明' },
        content: { text: '装依赖就行了', elements: [{ type: 'text', data: { text: '装依赖就行了' } }] },
      },
      {
        id: 'm4',
        system: true,
        sender: { uin: '0', name: '系统' },
        content: { text: '[撤回了一条消息]', elements: [] },
      },
    ],
  };
}

describe('parseQceExport', () => {
  it('解析完整导出', () => {
    const r = parseQceExport(sampleExport());
    expect(r.messages).toHaveLength(3); // 系统消息默认跳过
    expect(r.sceneKey).toBe('group:123456');
    expect(r.skipped).toBe(1);
    expect(r.chatInfo.name).toBe('测试群');
  });

  it('字段映射正确', () => {
    const [m1, m2, m3] = parseQceExport(sampleExport()).messages;
    expect(m1!.senderId).toBe('20001');
    expect(m1!.senderName).toBe('陈哥'); // 群名片优先
    expect(m1!.timestamp).toBe(1_700_000_000_000);
    expect(m2!.segments.some((s) => s.type === 'image')).toBe(true);
    expect(m2!.atTargets).toContain(SELF_UIN);
    expect(m3!.isSelf).toBe(true);
  });

  it('支持裸数组', () => {
    const r = parseQceExport(sampleExport().messages);
    expect(r.messages.length).toBe(3);
    expect(r.sceneKey.startsWith('group:')).toBe(true);
  });

  it('支持嵌套 data.messages', () => {
    const r = parseQceExport({ data: { messages: sampleExport().messages } });
    expect(r.messages.length).toBe(3);
  });

  it('可以强制指定群号', () => {
    const r = parseQceExport(sampleExport(), { groupId: '777888' });
    expect(r.sceneKey).toBe('group:777888');
  });

  it('私聊场景', () => {
    const r = parseQceExport({
      chatInfo: { type: 'private', peerUin: '20001', selfUin: SELF_UIN },
      messages: sampleExport().messages,
    });
    expect(r.sceneKey).toBe('private:20001');
  });

  it('保留系统消息', () => {
    const r = parseQceExport(sampleExport(), { includeSystem: true });
    expect(r.messages).toHaveLength(4);
  });

  it('没有 sender 的消息被跳过', () => {
    const r = parseQceExport({ messages: [{ id: 'x', content: { text: 'hi' } }] });
    expect(r.messages).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it('拿不到 messages 时抛错', () => {
    expect(() => parseQceExport({ foo: 1 })).toThrow(/messages/);
  });
});

describe('parseQceJsonl', () => {
  it('逐行解析消息与分块', () => {
    const lines = [
      JSON.stringify({ chatInfo: { name: '群', type: 'group', peerUin: '123456', selfUin: SELF_UIN } }),
      JSON.stringify(sampleExport().messages[0]),
      JSON.stringify({ messages: [sampleExport().messages[1]] }),
    ].join('\n');
    const r = parseQceJsonl(lines);
    expect(r.messages).toHaveLength(2);
    expect(r.sceneKey).toBe('group:123456');
  });

  it('坏行会被跳过并给出警告', () => {
    const r = parseQceJsonl(`not-json\n${JSON.stringify(sampleExport().messages[0])}`);
    expect(r.messages).toHaveLength(1);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});
