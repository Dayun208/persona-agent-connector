import type {
  ActionGuard,
  ChatMessage,
  JudgeDecision,
  JudgeEngine,
  Logger,
  MemoryHit,
  MessageArchiveLike,
  MessagePool,
  PersonaStore,
  PromptBuilder,
  PromptBundle,
  SampleStore,
  Stats,
  TriggerReason,
} from '@pasc/core';
import {
  parseAgentOutput,
  shouldRunJudge,
  understandImage,
  renderImageNote,
  splitForHumanStyle,
  stripBlockedCommands,
  sceneLabel,
  type Execution,
  type ParsedAgentOutput,
  type PascConfig,
} from '@pasc/core';
import type { NapCatClient } from '@pasc/napcat';
import type { AgentTransport, AgentAttachment } from '@pasc/agent';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';

export type PipelineEventType =
  | 'message'
  | 'judge'
  | 'prompt'
  | 'reply'
  | 'execution'
  | 'skip'
  | 'error'
  | 'log'
  | 'status';

export interface PipelineEvent {
  type: PipelineEventType;
  ts: number;
  data: Record<string, unknown>;
}

export interface PipelineDeps {
  getConfig: () => PascConfig;
  napcat: NapCatClient;
  getAgent: () => AgentTransport;
  pool: MessagePool;
  builder: PromptBuilder;
  judge: JudgeEngine;
  guard: ActionGuard;
  archive: MessageArchiveLike;
  personas: PersonaStore;
  samples: SampleStore;
  memorySearch: (query: string, topK?: number) => Promise<MemoryHit[]>;
  stats: Stats;
  logger: Logger;
  emit: (event: PipelineEvent) => void;
  /** 动作执行流水（可选，落盘供前端展示） */
  executions?: { append: (record: import('@pasc/core').ExecutionRecord) => Promise<void> };
  now?: () => number;
  random?: () => number;
}

interface ReplyContext {
  trigger: ChatMessage;
  reason: TriggerReason;
  matchedKeyword?: string;
  decision?: JudgeDecision;
}

/** 最近发送的机器人消息, 供 recall 使用 */
interface SentRecord {
  sceneKey: string;
  messageId: string;
  text: string;
  at: number;
}

/**
 * 核心管线: 过滤 → 入池 → 判断/触发 → 构建 Prompt → 调 Agent → 解析 JSON → 执行 → 存档。
 *
 * 并发控制: 同一会话的"判断"和"回复"串行执行(SceneQueue), 不同群之间完全并行。
 * 这样既不会对同一个群重复触发, 也不会因为别的群在算而拖慢。
 */
export class Pipeline {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly seen = new Map<string, number>();
  private readonly sent: SentRecord[] = [];
  /** 图片识别结果缓存：image file → 文本（同一张图只识别一次） */
  private readonly imageNotes = new Map<string, string>();
  /** 待附给 Agent 的图片（处理完即清空） */
  private readonly pendingAttachments: AgentAttachment[] = [];

  constructor(private readonly deps: PipelineDeps) {}

  private get now(): () => number {
    return this.deps.now ?? Date.now;
  }

  private get random(): () => number {
    return this.deps.random ?? Math.random;
  }

  /** 消息入口(NapCat 事件或 /api/simulate) */
  async ingest(msg: ChatMessage, opts: { force?: boolean; trigger?: TriggerReason } = {}): Promise<void> {
    const cfg = this.deps.getConfig();
    const { pool, stats, archive, logger, emit } = this.deps;

    msg.seq = pool.nextSeq();
    // 图片先转成文字再入库：DeepSeek 没有视觉能力，识图必须在本地做掉
    if (cfg.vision.enabled) await this.enrichImages(msg, cfg);
    archive.append(msg);
    stats.messagesIn += 1;

    const skip = this.shouldIgnore(msg, cfg);
    if (skip) {
      stats.messagesFiltered += 1;
      logger.debug('消息被过滤', { reason: skip, scene: msg.sceneKey, sender: msg.senderId });
      emit({ type: 'skip', ts: this.now(), data: { messageId: msg.id, sceneKey: msg.sceneKey, reason: skip } });
      return;
    }

    pool.push(msg);
    emit({
      type: 'message',
      ts: this.now(),
      data: {
        id: msg.id,
        sceneKey: msg.sceneKey,
        senderId: msg.senderId,
        senderName: msg.senderName,
        text: msg.text,
        mentionsSelf: msg.mentionsSelf,
      },
    });

    if (opts.force) {
      await this.enqueue(msg.sceneKey, () => this.runReply({ trigger: msg, reason: opts.trigger ?? 'manual' }));
      return;
    }

    // ---- 直接触发: @ / 回复我 / 关键词 ----
    if (cfg.pipeline.replyMode !== 'auto') {
      if (msg.mentionsSelf) {
        stats.directTriggers += 1;
        await this.enqueue(msg.sceneKey, () => this.runReply({ trigger: msg, reason: 'mention' }));
        return;
      }
    }

    // 引用回复 / 关键词只在 both 模式生效；mention 模式严格只认 @
    if (cfg.pipeline.replyMode === 'both') {
      if (this.isReplyToSelf(msg)) {
        stats.directTriggers += 1;
        logger.debug('消息引用了机器人, 直接触发', { sceneKey: msg.sceneKey, messageId: msg.id });
        await this.enqueue(msg.sceneKey, () => this.runReply({ trigger: msg, reason: 'reply' }));
        return;
      }
      const keyword = this.matchKeyword(msg, cfg);
      if (keyword) {
        stats.directTriggers += 1;
        await this.enqueue(msg.sceneKey, () => this.runReply({ trigger: msg, reason: 'keyword', matchedKeyword: keyword }));
        return;
      }
    }

    // ---- 判断触发: 消息池积累到阈值后花一次小模型调用 ----
    if (cfg.pipeline.replyMode === 'mention') return;

    const state = pool.state(msg.sceneKey);
    const gate = {
      everyN: cfg.judgeModel.judgeEveryN,
      intervalMs: cfg.judgeModel.judgeIntervalMs,
      minMessages: cfg.judgeModel.minMessages,
    };
    if (!shouldRunJudge(state, gate, pool.size(msg.sceneKey), this.now())) return;

    state.busy = true;
    await this.enqueue(msg.sceneKey, async () => {
      try {
        await this.runJudge(msg);
      } finally {
        state.busy = false;
      }
    });
  }

  /** 仅跑判断, 不回复(供控制台"试判断") */
  async judgeOnly(msg: ChatMessage): Promise<JudgeDecision> {
    const { judge, personas, pool } = this.deps;
    const cfg = this.deps.getConfig();
    return judge.decide({
      scene: msg.scene,
      messages: [...pool.history(msg.sceneKey, cfg.judgeModel.judgeWindow), msg],
      trigger: msg,
      personaSummary: personas.summary(),
      lastReplyAt: pool.state(msg.sceneKey).lastReplyAt,
      now: this.now(),
    });
  }

  /** 构建一次 Prompt 但不发送(供控制台预览) */
  async previewPrompt(msg: ChatMessage, reason: TriggerReason = 'manual'): Promise<PromptBundle> {
    const cfg = this.deps.getConfig();
    const { pool, personas, samples, guard, builder } = this.deps;

    const history = pool.contextBefore(msg.sceneKey, cfg.prompt.historyLimit);
    const contextText = history.map((m) => m.text).join('\n') + '\n' + msg.text;
    const isAdmin = cfg.behavior.admins.includes(msg.senderId);
    const memories = cfg.memory.enabled ? await this.deps.memorySearch(contextText, cfg.memory.topK) : [];

    return builder.build({
      scene: msg.scene,
      trigger: msg,
      history,
      reason,
      persona: personas.getActive(),
      samples: samples.pick(contextText, cfg.prompt.sampleLimit),
      memories,
      actionsText: guard.describeForPrompt({ isAdmin, allowUserActions: cfg.behavior.allowUserActions }),
      members: this.recentMembers(msg.sceneKey, msg),
      webSearch: cfg.openclaw.webSearch,
      vision: cfg.vision.enabled,
      secondsSinceLastReply: this.secondsSinceLastReply(msg.sceneKey),
    });
  }

  private async runJudge(trigger: ChatMessage): Promise<void> {
    const cfg = this.deps.getConfig();
    const { judge, personas, pool, stats, logger, emit } = this.deps;
    const sceneKey = trigger.sceneKey;
    const state = pool.state(sceneKey);

    stats.judgeRuns += 1;
    const started = this.now();
    let decision: JudgeDecision;
    try {
      decision = await judge.decide({
        scene: trigger.scene,
        messages: pool.history(sceneKey, cfg.judgeModel.judgeWindow),
        trigger,
        personaSummary: personas.summary(),
        lastReplyAt: state.lastReplyAt,
        now: this.now(),
      });
    } catch (err) {
      stats.recordError(err);
      logger.error('判断失败', { error: err instanceof Error ? err.message : String(err) });
      emit({ type: 'error', ts: this.now(), data: { stage: 'judge', error: String(err) } });
      pool.markJudged(sceneKey, started);
      return;
    }

    stats.recordJudge(this.now() - started);
    pool.markJudged(sceneKey, started);

    emit({
      type: 'judge',
      ts: this.now(),
      data: {
        sceneKey,
        shouldReply: decision.shouldReply,
        confidence: decision.confidence,
        reason: decision.reason,
        source: decision.source,
      },
    });

    const passed = judge.passesThreshold(decision);
    this.deps.logger[passed ? 'info' : 'debug']('判断结果', {
      sceneKey,
      shouldReply: decision.shouldReply,
      confidence: decision.confidence,
      reason: decision.reason,
      source: decision.source,
      passed,
    });

    if (passed) stats.judgeHits += 1;

    if (!passed) {
      emit({ type: 'skip', ts: this.now(), data: { sceneKey, reason: `置信度不足: ${decision.confidence.toFixed(2)}` } });
      return;
    }
    if (state.lastReplyAt > 0 && this.now() - state.lastReplyAt < cfg.judgeModel.replyCooldownMs) {
      emit({ type: 'skip', ts: this.now(), data: { sceneKey, reason: '冷却中, 暂不重复插话' } });
      return;
    }

    await this.runReply({ trigger, reason: 'judge', decision });
  }

  private async runReply(ctx: ReplyContext): Promise<void> {
    const cfg = this.deps.getConfig();
    const { pool, personas, samples, guard, builder, getAgent, stats, logger, emit, archive } = this.deps;
    const trigger = ctx.trigger;
    const sceneKey = trigger.sceneKey;
    const state = pool.state(sceneKey);

    try {
      const history = pool.before(sceneKey, trigger.seq, cfg.prompt.historyLimit);
      const contextText = [...history.map((m) => m.text), trigger.text].join('\n');
      const memories = cfg.memory.enabled ? await this.deps.memorySearch(contextText, cfg.memory.topK) : [];
      const isAdmin = cfg.behavior.admins.includes(trigger.senderId);
      // 管理员明确下达的动作指令，不能被角色扮演"做不到"搪塞过去
      const actionsText = (() => {
        const base = guard.describeForPrompt({ isAdmin, allowUserActions: cfg.behavior.allowUserActions });
        if (!isAdmin) return base;
        return `${base}\n\n【管理员指令】当前消息来自管理员。如果他明确要求执行上面 ✔ 开头的某个动作，`
          + `必须用 execution 字段真的发起，不要在正文里推脱"没权限/做不到"——执行由中间件完成。`;
      })();
      const persona = personas.getActive();

      const bundle = builder.build({
        scene: trigger.scene,
        trigger,
        history,
        reason: ctx.reason,
        persona,
        samples: samples.pick(contextText, cfg.prompt.sampleLimit),
        memories,
        actionsText,
        members: this.recentMembers(sceneKey, trigger),
        webSearch: cfg.openclaw.webSearch,
        vision: cfg.vision.enabled,
        ...(ctx.matchedKeyword ? { matchedKeyword: ctx.matchedKeyword } : {}),
        secondsSinceLastReply: this.secondsSinceLastReply(sceneKey),
      });

      stats.recordPrompt(bundle.chars, bundle.estimatedTokens);
      emit({
        type: 'prompt',
        ts: this.now(),
        data: { sceneKey, sections: bundle.sections, chars: bundle.chars, tokens: bundle.estimatedTokens, reason: ctx.reason },
      });

      const agent = getAgent();
      const attachments = this.pendingAttachments.splice(0, this.pendingAttachments.length);
      const response = await agent.send({
        system: bundle.system,
        user: bundle.user,
        ...(attachments.length > 0 ? { attachments } : {}),
        meta: {
          sceneKey,
          sceneLabel: sceneLabel(trigger.scene),
          triggerId: trigger.id,
          reason: ctx.reason,
          ...(persona ? { personaName: persona.name, personaId: persona.id } : {}),
          ...(cfg.openclaw.agentId ? { agentId: cfg.openclaw.agentId } : {}),
        },
      });
      stats.recordAgent(response.latencyMs);

      const parsed = parseAgentOutput(response.text);
      if (parsed.warnings.length > 0) {
        logger.warn('Agent 输出有异常', { warnings: parsed.warnings, preview: response.text.slice(0, 120) });
      }

      await this.deliver(trigger, parsed, isAdmin);
      pool.markReplied(sceneKey, this.now());
      void archive; // 存档已由 deliver 内的 appendSelfMessage 完成
    } catch (err) {
      stats.recordError(err);
      logger.error('回复流程失败', { error: err instanceof Error ? err.message : String(err), sceneKey });
      emit({ type: 'error', ts: this.now(), data: { stage: 'reply', error: err instanceof Error ? err.message : String(err) } });
    }
  }

  /** 把一次动作压成一句人话，写进执行流水 */
  private summarizeExecution(execution: Execution): string {
    const p = (execution.params ?? {}) as Record<string, unknown>;
    switch (execution.action) {
      case 'group_manage': {
        const op = String(p.op ?? '');
        const user = p.userId ? ` ${p.userId}` : '';
        if (op === 'ban') return `禁言${user} ${p.durationSec ?? 600} 秒`;
        if (op === 'kick') return `踢出${user}`;
        if (op === 'set_card') return `改名片${user} → ${p.card ?? ''}`;
        if (op === 'whole_ban') return `全员禁言 ${p.enable === false ? '关' : '开'}`;
        if (op === 'set_name') return `改群名 → ${p.name ?? ''}`;
        if (op === 'set_admin') return `${p.enable === false ? '取消' : '设置'}管理员${user}`;
        if (op === 'special_title') return `设头衔${user} → ${p.title ?? ''}`;
        return `群管理 ${op}`;
      }
      case 'send_file':
        return `发送文件 ${p.name || p.file || ''}`;
      case 'send_image':
        return '发送图片';
      case 'recall':
        return '撤回消息';
      case 'poke':
        return `戳一戳 ${p.userId ?? ''}`;
      case 'react':
        return `表情回应 ${p.emojiId ?? ''}`;
      case 'like':
        return `点赞 ${p.userId ?? ''}`;
      case 'send_message':
        return '另发一条消息';
      default:
        return execution.action;
    }
  }

  /**
   * 处理消息里的图片。
   *   mode=agent → 读出图片字节挂到 this.pendingAttachments，交给 Agent 自己看
   *   其它模式   → 本地视觉模型转成文字，拼进正文
   */
  private async enrichImages(msg: ChatMessage, cfg: PascConfig): Promise<void> {
    const images = msg.segments.filter((seg) => seg.type === 'image') as Array<{ type: 'image'; file?: string; url?: string }>;
    if (images.length === 0) return;

    const { napcat, logger } = this.deps;
    const notes: string[] = [];

    // 走 Agent 视觉：不调本地模型，把图片字节附上去即可
    if (cfg.vision.mode === 'agent') {
      for (const img of images.slice(0, cfg.vision.maxImages)) {
        if (!img.file) {
          logger.warn('图片缺 file 字段，无法取回', { sceneKey: msg.sceneKey });
          continue;
        }
        const info = await napcat.getImage(img.file);
        if (!info?.file) {
          logger.warn('get_image 失败，图片无法附上', { file: img.file, error: info?.error ?? '未知' });
          continue;
        }
        try {
          const buf = await readFile(this.toHostPath(info.file, cfg));
          this.pendingAttachments.push({
            mimeType: img.file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
            fileName: img.file,
            dataBase64: buf.toString('base64'),
          });
          msg.text = `${msg.text}\n[图片]`.trim();
          logger.info('图片已附到请求上', { file: img.file, bytes: buf.byteLength });
        } catch (err) {
          logger.warn('图片读取失败', { file: img.file, path: this.toHostPath(info.file, cfg), error: err instanceof Error ? err.message : String(err) });
        }
      }
      return;
    }

    for (const img of images.slice(0, cfg.vision.maxImages)) {
      const key = img.file || img.url || '';
      if (!key) continue;

      const cached = this.imageNotes.get(key);
      if (cached !== undefined) {
        if (cached) notes.push(cached);
        continue;
      }

      const info = img.file ? await napcat.getImage(img.file) : undefined;
      const containerPath = info?.file || '';
      if (!containerPath) {
        this.imageNotes.set(key, '');
        continue;
      }

      const result = await understandImage(containerPath, cfg.vision, {
        resolvePath: (p) => this.toHostPath(p, cfg),
      });
      const note = renderImageNote(result);
      this.imageNotes.set(key, note);
      if (this.imageNotes.size > 500) {
        const first = this.imageNotes.keys().next().value;
        if (first !== undefined) this.imageNotes.delete(first);
      }
      if (note) {
        notes.push(note);
        logger.debug('图片识别完成', { file: img.file, kind: result?.kind, ms: result?.latencyMs });
      }
    }

    if (notes.length > 0) msg.text = `${msg.text}\n${notes.join('\n')}`.trim();
  }

  /** 容器内路径 → 宿主机路径（NapCat 跑在 Docker 里） */
  private toHostPath(containerPath: string, cfg: PascConfig): string {
    const from = cfg.vision.mountFrom.replace(/\/+$/, '');
    if (!from || !containerPath.startsWith(from)) return containerPath;
    const to = (cfg.vision.mountTo || `${homedir()}/pasc-docker/napcat/qq`).replace(/\/+$/, '');
    return to + containerPath.slice(from.length);
  }

  /** 最近在会话里出现过的成员（去重、带上触发者），用于让模型把昵称映射成 QQ 号 */
  private recentMembers(sceneKey: string, trigger: ChatMessage): Array<{ id: string; name: string }> {
    const seen = new Map<string, string>();
    const push = (id: string, name: string): void => {
      if (!id || id === this.deps.napcat.selfId) return;
      if (!seen.has(id)) seen.set(id, name || id);
    };
    push(trigger.senderId, trigger.senderName);
    for (const m of this.deps.pool.history(sceneKey, 30).slice().reverse()) {
      if (!m.isSelf) push(m.senderId, m.senderName);
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }

  /**
   * 发送一条文本并完成全部记账：统计、sent 记录（供引用触发匹配）、
   * 自消息入池/存档（供后续上下文）、事件广播。
   * deliver 的正文循环和 send_message 动作都必须走这里，否则两套账对不上。
   */
  private async sendAndRecord(
    trigger: ChatMessage,
    scene: ChatMessage['scene'],
    text: string,
    quoteId?: string,
  ): Promise<string> {
    const { napcat, stats, emit } = this.deps;
    const result = (await napcat.sendText(scene, text, quoteId ? { quoteMessageId: quoteId } : {})) as
      | { message_id?: number | string }
      | undefined;
    const messageId = result?.message_id !== undefined ? String(result.message_id) : '';
    stats.recordReply();
    this.rememberSent(trigger.sceneKey, messageId, text);
    this.appendSelfMessage(trigger, text, messageId);
    emit({ type: 'reply', ts: this.now(), data: { sceneKey: trigger.sceneKey, text, messageId } });
    return messageId;
  }

  private async deliver(trigger: ChatMessage, parsed: ParsedAgentOutput, isAdmin: boolean): Promise<void> {
    const cfg = this.deps.getConfig();
    const { napcat, pool, archive, guard, stats, logger, emit } = this.deps;
    const scene = trigger.scene;
    const sceneKey = trigger.sceneKey;

    // ---------- 文本 ----------
    const rawMessages = parsed.messages
      .map((m) => stripBlockedCommands(m, cfg.behavior.blockedCommands))
      .filter((r) => !r.stripped)
      .flatMap((r) => splitForHumanStyle(r.text, 3));

    for (const [index, text] of rawMessages.entries()) {
      await this.humanDelay(index);
      const quoteId = cfg.pipeline.quoteReply && index === 0 ? trigger.id : undefined;
      try {
        await this.sendAndRecord(trigger, scene, text, quoteId);
      } catch (err) {
        stats.recordError(err);
        logger.error('发送消息失败', { error: err instanceof Error ? err.message : String(err) });
        emit({ type: 'error', ts: this.now(), data: { stage: 'send', error: String(err) } });
      }
    }

    // ---------- 动作 ----------
    for (const execution of parsed.executions) {
      const check = guard.check(execution, { isAdmin, allowUserActions: cfg.behavior.allowUserActions });
      if (!check.ok) {
        stats.executionRejected += 1;
        logger.warn('动作被拒绝', { action: execution.action, reason: check.reason });
        emit({ type: 'execution', ts: this.now(), data: { sceneKey, action: execution.action, ok: false, reason: check.reason } });
        void this.deps.executions?.append({
          id: `ex-${this.now()}-${stats.executionRejected}`,
          ts: this.now(),
          sceneKey,
          triggerId: trigger.id,
          action: execution.action,
          ok: false,
          summary: this.summarizeExecution(execution),
          reason: check.reason,
        });
        continue;
      }
      try {
        const detail = await this.dispatchAction(check.execution, trigger);
        stats.executions += 1;
        emit({ type: 'execution', ts: this.now(), data: { sceneKey, action: execution.action, ok: true, detail } });
        void this.deps.executions?.append({
          id: `ex-${this.now()}-${stats.executions}`,
          ts: this.now(),
          sceneKey,
          triggerId: trigger.id,
          action: execution.action,
          ok: true,
          summary: this.summarizeExecution(execution),
        });
      } catch (err) {
        stats.recordError(err);
        const reason = err instanceof Error ? err.message : String(err);
        logger.error('动作执行失败', { action: execution.action, error: reason });
        emit({ type: 'execution', ts: this.now(), data: { sceneKey, action: execution.action, ok: false, reason } });
        void this.deps.executions?.append({
          id: `ex-${this.now()}-err`,
          ts: this.now(),
          sceneKey,
          triggerId: trigger.id,
          action: execution.action,
          ok: false,
          summary: this.summarizeExecution(execution),
          reason,
        });
      }
    }

    if (rawMessages.length === 0 && parsed.executions.length === 0) {
      emit({ type: 'skip', ts: this.now(), data: { sceneKey, reason: 'Agent 选择不发言' } });
    }

    void pool;
    void archive;
  }

  private async dispatchAction(execution: Execution, trigger: ChatMessage): Promise<Record<string, unknown>> {
    const { napcat } = this.deps;
    const scene = resolveTargetScene(execution.target, trigger);
    const params = execution.params ?? {};

    switch (execution.action) {
      case 'send_message': {
        const text = String(params.text ?? '');
        if (!text) throw new Error('send_message 缺少 text');
        const quoteId = this.deps.getConfig().pipeline.quoteReply ? trigger.id : undefined;
        const messageId = await this.sendAndRecord(trigger, scene, text, quoteId);
        return { messageId: messageId || null };
      }
      case 'send_image': {
        const r = await napcat.sendImage(scene, {
          ...(params.url ? { url: String(params.url) } : {}),
          ...(params.file ? { file: String(params.file) } : {}),
        });
        return { sent: true, result: r as Record<string, unknown> };
      }
      case 'send_file': {
        if (scene.kind !== 'group') throw new Error('send_file 目前只支持群聊');
        const r = await napcat.sendFile(scene.groupId, {
          file: String(params.file),
          ...(params.name ? { name: String(params.name) } : {}),
        });
        return { sent: true, result: r as Record<string, unknown> };
      }
      case 'react': {
        const messageId = String(params.messageId ?? trigger.id ?? '');
        if (!messageId) throw new Error('react 缺少 messageId');
        const r = await napcat.react(messageId, String(params.emojiId ?? '128077'));
        return { reacted: true, messageId, result: r as Record<string, unknown> };
      }
      case 'like': {
        const userId = String(params.userId ?? '');
        if (!userId) throw new Error('like 缺少 userId');
        const times = Number(params.times ?? 1);
        const r = await napcat.sendLike(userId, Number.isFinite(times) ? times : 1);
        return { liked: true, userId, result: r as Record<string, unknown> };
      }
      case 'group_manage': {
        if (scene.kind !== 'group') throw new Error('group_manage 只能用于群聊');
        const op = String(params.op ?? '');
        const userId = String(params.userId ?? '');

        // 不需要 userId 的群级操作
        if (op === 'whole_ban') {
          const r = await napcat.setGroupWholeBan(scene.groupId, Boolean(params.enable ?? true));
          return { op, enable: Boolean(params.enable ?? true), result: r as Record<string, unknown> };
        }
        if (op === 'set_name') {
          const name = String(params.name ?? '').trim();
          if (!name) throw new Error('set_name 缺少 name');
          const r = await napcat.setGroupName(scene.groupId, name);
          return { op, name, result: r as Record<string, unknown> };
        }
        if (!userId) throw new Error('group_manage 缺少 userId');
        switch (op) {
          case 'ban': {
            const durationSec = Number(params.durationSec ?? 600);
            await napcat.groupBan(scene.groupId, userId, durationSec);
            return { op, userId, durationSec };
          }
          case 'kick':
            await napcat.groupKick(scene.groupId, userId);
            return { op, userId };
          case 'set_card':
            await napcat.setCard(scene.groupId, userId, String(params.card ?? ''));
            return { op, userId, card: String(params.card ?? '') };
          case 'set_admin': {
            const enable = Boolean(params.enable ?? true);
            await napcat.setGroupAdmin(scene.groupId, userId, enable);
            return { op, userId, enable };
          }
          case 'special_title': {
            const title = String(params.title ?? '').trim();
            if (!title) throw new Error('special_title 缺少 title');
            await napcat.setGroupSpecialTitle(scene.groupId, userId, title);
            return { op, userId, title };
          }
          default:
            throw new Error(`不支持的群管理操作: ${op}`);
        }
      }
      case 'recall': {
        const explicit = params.messageId ? String(params.messageId) : '';
        const last = this.lastSent(scene.kind === 'group' ? `group:${scene.groupId}` : `private:${scene.userId}`);
        const targetId = explicit || last?.messageId || '';
        if (!targetId) throw new Error('recall 找不到可撤回的消息');
        await napcat.deleteMessage(targetId);
        return { recalled: targetId };
      }
      case 'poke': {
        const userId = String(params.userId ?? '');
        if (!userId) throw new Error('poke 缺少 userId');
        await napcat.poke(scene, userId);
        return { poked: userId };
      }
      default:
        throw new Error(`不支持的动作: ${execution.action}`);
    }
  }

  private shouldIgnore(msg: ChatMessage, cfg: PascConfig): string | undefined {
    if (msg.isSelf) return '自己发的消息';
    if (msg.scene.kind === 'private' && !cfg.pipeline.handlePrivate) return '未开启私聊处理';
    if (msg.scene.kind === 'group' && cfg.pipeline.groupWhitelist.length > 0) {
      if (!cfg.pipeline.groupWhitelist.includes(msg.scene.groupId)) return '不在群白名单';
    }
    if (cfg.pipeline.userBlacklist.includes(msg.senderId)) return '用户在黑名单';

    // 重复投递去重
    if (msg.id) {
      const lastSeen = this.seen.get(msg.id);
      const now = this.now();
      if (lastSeen !== undefined && now - lastSeen < cfg.pipeline.dedupeWindowMs) return '重复投递';
      this.seen.set(msg.id, now);
      if (this.seen.size > 2_000) {
        for (const [id, ts] of this.seen) {
          if (now - ts > cfg.pipeline.dedupeWindowMs) this.seen.delete(id);
        }
      }
    }

    // 屏蔽 OpenClaw 原生指令, 避免被群友触发
    if (msg.text.trim().startsWith('/')) {
      const cmd = msg.text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (cfg.behavior.blockedCommands.some((b) => b.toLowerCase() === cmd)) return '屏蔽指令';
    }
    return undefined;
  }

  /**
   * 这条消息是否引用回复了机器人自己发过的消息。
   *
   * 两条来源都要查：
   *   1. 本进程发出去的消息（this.sent，最快）
   *   2. 消息池里标记为 isSelf 的消息（进程重启后 sent 是空的，但池子已从存档预热过）
   */
  private isReplyToSelf(msg: ChatMessage): boolean {
    const replySeg = msg.segments.find((s) => s.type === 'reply') as { type: 'reply'; messageId: string } | undefined;
    const quotedId = replySeg?.messageId;
    if (!quotedId) return false;

    if (this.sent.some((r) => r.messageId && r.messageId === quotedId)) return true;
    return this.deps.pool.history(msg.sceneKey, 200).some((m) => m.isSelf && m.id === quotedId);
  }

  private matchKeyword(msg: ChatMessage, cfg: PascConfig): string | undefined {
    const text = msg.text;
    if (!text) return undefined;
    for (const kw of cfg.pipeline.triggerKeywords) {
      if (kw && text.includes(kw)) return kw;
    }
    return undefined;
  }

  private secondsSinceLastReply(sceneKey: string): number | undefined {
    const state = this.deps.pool.state(sceneKey);
    if (state.lastReplyAt === 0) return undefined;
    return Math.max(0, Math.round((this.now() - state.lastReplyAt) / 1000));
  }

  private async humanDelay(index: number): Promise<void> {
    if (index === 0) return; // 第一条不拖延, 保证响应感
    const [min, max] = this.deps.getConfig().pipeline.humanizeDelayMs;
    const ms = Math.round(min + this.random() * Math.max(0, max - min));
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private rememberSent(sceneKey: string, messageId: string, text: string): void {
    this.sent.push({ sceneKey, messageId, text, at: this.now() });
    if (this.sent.length > 100) this.sent.shift();
  }

  private lastSent(sceneKey: string): SentRecord | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      if (this.sent[i]!.sceneKey === sceneKey) return this.sent[i];
    }
    return undefined;
  }

  /** 把机器人自己的回复也写进池子和存档, 让下一轮上下文知道"我刚说过什么" */
  private appendSelfMessage(trigger: ChatMessage, text: string, messageId: string): void {
    const { pool, archive } = this.deps;
    const self: ChatMessage = {
      id: messageId || `self-${this.now()}`,
      seq: pool.nextSeq(),
      scene: trigger.scene,
      sceneKey: trigger.sceneKey,
      senderId: this.deps.napcat.selfId || 'self',
      senderName: '我',
      segments: [{ type: 'text', text }],
      text,
      atTargets: [],
      mentionsSelf: false,
      timestamp: this.now(),
      isSelf: true,
    };
    pool.push(self);
    archive.appendReply(self);
  }

  /** 同会话串行化 */
  private enqueue<T>(sceneKey: string, task: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sceneKey) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.queues.set(
      sceneKey,
      next.catch(() => undefined),
    );
    return next;
  }
}

/** target 可能是"当前会话"、群号, 也可能为空 */
export function resolveTargetScene(target: string | undefined, trigger: ChatMessage): ChatMessage['scene'] {
  if (!target || target === '当前会话' || target === 'current' || target === 'this') return trigger.scene;
  if (!/^\d{5,}$/.test(target)) return trigger.scene;
  if (trigger.scene.kind === 'group' && target === trigger.scene.groupId) return trigger.scene;
  return { kind: 'group', groupId: target };
}
