import type { ActionGuard } from './actions.js';
import type { PromptConfig } from './config.js';
import type { Logger } from './logger.js';
import type { MemoryHit } from './memory.js';
import type { Persona } from './persona.js';
import type { Sample } from './sampling.js';
import type { ChatMessage, Scene } from './types.js';
import { renderMessageLine, sceneLabel } from './types.js';
import { estimateTokens } from './pool.js';
import type { TriggerReason } from './judge.js';

export interface PromptBuildContext {
  scene: Scene;
  /** 当前要回应的那条消息 */
  trigger: ChatMessage;
  /** 触发消息之前的上下文(不含 trigger) */
  history: ChatMessage[];
  reason: TriggerReason;
  persona?: Persona | undefined;
  samples?: Sample[];
  memories?: MemoryHit[];
  /** 由 ActionGuard 生成的可用动作说明, 为空则不注入行为段落 */
  actionsText?: string;
  /** 是否允许联网搜索（由 openclaw.webSearch 控制） */
  webSearch?: boolean;
  /** 是否启用了识图（由 vision.enabled 控制） */
  vision?: boolean;
  /** 开发模式：这个人格在当前会话被临时停用，只保留基础约束与协议 */
  devMode?: boolean;
  /** 本会话最近出现的成员（供模型把昵称映射成 QQ 号） */
  members?: Array<{ id: string; name: string }>;
  /** 触发关键词(便于模型知道自己为什么被叫) */
  matchedKeyword?: string;
  /** 距离上次机器人发言的秒数 */
  secondsSinceLastReply?: number;
}

export interface PromptBundle {
  system: string;
  user: string;
  /** 本次实际注入了哪些段落, 给控制台/调试用 */
  sections: string[];
  chars: number;
  estimatedTokens: number;
}

const REASON_HINTS: Record<TriggerReason, string> = {
  mention: '有人 @ 了你, 你需要回应 ta。',
  reply: '有人直接回复了你的上一条消息, 你应当接话。',
  keyword: '有人提到了触发词, 你可以自然地接一句。',
  judge: '根据上下文判断, 现在适合你插一句话。',
  manual: '管理员手动触发了这次回复。',
};

/** 段落元信息: priority 越小越先被丢 */
interface Block {
  id: 'base' | 'persona' | 'samples' | 'memory' | 'members' | 'behavior' | 'protocol';
  text: string;
  priority: number;
}

/** 超预算时的丢弃顺序(从低价值到高价值) */
const DROP_ORDER: Array<Block['id']> = ['memory', 'behavior', 'samples', 'persona'];

/**
 * Prompt 构建器 —— 项目的核心。
 *
 * 把"基础提示词 / 人格 / few-shot / 记忆 / 行为控制"按开关拼成一份完整 Prompt, 并做预算裁剪:
 *   1. 先丢最旧的历史消息
 *   2. 再按 记忆 → 行为 → 样本 → 人格 的顺序丢段落
 *   3. 最后才截断基础提示词, 并打日志
 * 协议提醒(只输出 JSON)永远保留, 否则整个标签体系会崩。
 */
export class PromptBuilder {
  constructor(
    private readonly deps: {
      getConfig: () => PromptConfig;
      guard: ActionGuard;
      logger?: Logger;
    },
  ) {}

  build(ctx: PromptBuildContext): PromptBundle {
    const cfg = this.deps.getConfig();
    const inject = cfg.inject;

    // ---------- system 段落 ----------
    const blocks: Block[] = [];
    if (inject.base && cfg.base.trim()) {
      // 联网提示按开关注入，而不是写死在 base 文本里 —— 已经存过配置的老用户也能生效
      const searchHint = ctx.webSearch
        ? '\n\n【联网】需要最新信息(价格/新闻/版本号/比分, 或你明显不知道的事实)时可以先用联网搜索查证再回答；'
          + '查完只给结论，不要念搜索结果，也不要说"我搜了一下"。日常闲聊不用搜。'
        : '';
      const imageHint = ctx.vision
        ? '\n\n【图片】消息里如果带了图，你是能直接看到的。看图说话就行，'
          + '不用提"图片附件""识别结果"这类技术词。'
        : '';
      // 被 @ / 私聊时必须回应 —— 这条不依赖已存的 base 文本，保证老配置也生效
      const mustReplyHint = ctx.trigger.mentionsSelf || ctx.trigger.scene.kind === 'private'
        ? '\n\n【必须回应】这条消息直接指向你（@ 你 或 私聊），不要输出空 message，必须开口说一句。'
        : '';
      blocks.push({ id: 'base', text: cfg.base.trim() + searchHint + imageHint + mustReplyHint, priority: 90 });
    }

    if (inject.persona && !ctx.devMode && ctx.persona?.content.trim()) {
      blocks.push({
        id: 'persona',
        text: [
          '## 你的人格设定',
          ctx.persona.content.trim(),
          '',
          '> 【必须遵守】如果上面的聊天记录里你自称过别的名字、或用过不同的说话风格，那是切换人格前的旧记录。',
          '> 一律以本节设定为准，不要沿用历史里的旧身份。',
        ].join('\n'),
        priority: 70,
      });
    }

    if (inject.samples && !ctx.devMode) {
      const samples = ctx.samples ?? [];
      if (samples.length > 0) {
        const lines = samples.map((s, i) => `### 示例 ${i + 1}\n有人: ${s.question}\n你: ${s.answer}`);
        blocks.push({
          id: 'samples',
          text: `## 风格示例(学习语气和分寸, 不要照抄内容)\n${lines.join('\n\n')}`,
          priority: 60,
        });
      }
    }

    if (inject.memory && !ctx.devMode && ctx.memories && ctx.memories.length > 0) {
      const lines = ctx.memories.map((m) => `- ${m.text}`);
      blocks.push({
        id: 'memory',
        text: `## 你记得的事(只在相关时自然提起, 不要主动炫耀)\n${lines.join('\n')}`,
        priority: 40,
      });
    }

    if (inject.behavior && ctx.members && ctx.members.length > 0) {
      const roster = ctx.members
        .slice(0, 12)
        .map((m) => `${m.name}(${m.id})`)
        .join('、');
      blocks.push({
        id: 'members',
        text: [
          '## 本会话成员',
          `最近出现的成员：${roster}`,
          '需要指定 params.userId 时，直接用括号里的数字；不要编造不存在的 QQ 号。',
        ].join('\n'),
        priority: 66,
      });
    }

    if (inject.behavior && ctx.actionsText) {
      blocks.push({
        id: 'behavior',
        text: `## 可用动作\n你可以通过在 JSON 里加 execution 字段来执行下面的动作。没有列出的动作一律不可用:\n${ctx.actionsText}`,
        priority: 50,
      });
    }

    // 协议段永远存在且优先级最高
    blocks.push({ id: 'protocol', text: buildProtocolReminder(), priority: 100 });

    // ---------- user 段落 ----------
    const head = `## 会话\n${sceneLabel(ctx.scene)}`;
    const tail = [
      '## 你需要回应的消息',
      renderMessageLine(ctx.trigger),
      '',
      `## 说明\n${REASON_HINTS[ctx.reason]}`,
      ...(ctx.matchedKeyword ? [`触发词: ${ctx.matchedKeyword}`] : []),
      ...(ctx.secondsSinceLastReply !== undefined
        ? [`你上次发言是 ${ctx.secondsSinceLastReply} 秒前, 不要重复刚才说过的话。`]
        : []),
      '',
      '只输出 JSON, 不要输出其他任何内容。',
    ].join('\n');

    let history = inject.history ? ctx.history.slice(-cfg.historyLimit) : [];
    let historyDropped = !inject.history;

    const renderHistory = (msgs: ChatMessage[]): string =>
      msgs.length > 0 ? `## 最近的聊天记录\n${msgs.map((m) => renderMessageLine(m)).join('\n')}` : '';

    const dropped = new Set<Block['id']>();

    const compose = (): { system: string; user: string; total: number; sections: string[] } => {
      const active = blocks.filter((b) => !dropped.has(b.id));
      const system = active.map((b) => b.text).join('\n\n');
      const user = [head, renderHistory(history), tail].filter((s) => s.length > 0).join('\n\n');
      const sections: string[] = active.map((b) => String(b.id));
      if (!historyDropped && history.length > 0) sections.push('history');
      return { system, user, total: system.length + user.length, sections };
    };

    let state = compose();

    // 1) 先裁历史
    while (state.total > cfg.maxPromptChars && history.length > 0) {
      history = history.slice(1);
      state = compose();
    }
    if (history.length === 0) historyDropped = true;

    // 2) 再按优先级丢段落
    for (const id of DROP_ORDER) {
      if (state.total <= cfg.maxPromptChars) break;
      if (dropped.has(id)) continue;
      if (!blocks.some((b) => b.id === id)) continue;
      dropped.add(id);
      state = compose();
      this.deps.logger?.debug('Prompt 超预算, 丢段落', { dropped: id, total: state.total });
    }

    // 3) 兜底: 截断基础提示词尾部(协议段保留)
    if (state.total > cfg.maxPromptChars) {
      const baseBlock = blocks.find((b) => b.id === 'base' && !dropped.has('base'));
      if (baseBlock) {
        const over = state.total - cfg.maxPromptChars;
        baseBlock.text = truncateKeepingHead(baseBlock.text, Math.max(120, baseBlock.text.length - over));
        state = compose();
      }
      this.deps.logger?.warn('Prompt 仍超预算, 已截断基础提示词', { total: state.total, limit: cfg.maxPromptChars });
    }

    return {
      system: state.system,
      user: state.user,
      sections: state.sections,
      chars: state.total,
      estimatedTokens: estimateTokens(state.system) + estimateTokens(state.user),
    };
  }

  /** 控制台用: 生成一次 prompt 但不调用模型 */
  preview(ctx: PromptBuildContext): PromptBundle {
    return this.build(ctx);
  }
}

function truncateKeepingHead(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

function buildProtocolReminder(): string {
  return [
    '## 输出格式(最高优先级)',
    '只输出一个 JSON 对象: {"message": "要发送的文本"}',
    '需要动作时: {"message": "文本", "execution": {"action": "动作名", "target": "目标", "params": {}}}',
    '不想说话时: {"message": ""}',
    '不要输出 markdown 代码块, 不要输出 JSON 以外的任何字符。',
  ].join('\n');
}
