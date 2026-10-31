import type { ChatMessage, Scene } from '@pasc/core';
import { sceneKeyOf } from '@pasc/core';

export function makeMessage(partial: Partial<ChatMessage> & { text: string }): ChatMessage {
  const scene: Scene = partial.scene ?? { kind: 'group', groupId: '123456' };
  const sceneKey = sceneKeyOf(scene);
  return {
    id: partial.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
    seq: partial.seq ?? 0,
    scene,
    sceneKey,
    senderId: partial.senderId ?? '10001',
    senderName: partial.senderName ?? '测试用户',
    segments: partial.segments ?? [{ type: 'text', text: partial.text }],
    text: partial.text,
    atTargets: partial.atTargets ?? [],
    mentionsSelf: partial.mentionsSelf ?? false,
    timestamp: partial.timestamp ?? Date.now(),
    isSelf: partial.isSelf ?? false,
    ...(partial.raw !== undefined ? { raw: partial.raw } : {}),
  };
}

export function makeMessages(texts: string[], overrides: Partial<ChatMessage>[] = []): ChatMessage[] {
  return texts.map((text, i) => makeMessage({ text, seq: i + 1, ...(overrides[i] ?? {}) }));
}
