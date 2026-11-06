import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ActionGuard,
  ChatClient,
  DEFAULT_CONFIG,
  JudgeEngine,
  Logger,
  EmbeddingClient,
  MemoryEngine,
  extractMemoryCandidates,
  MessageArchive,
  SqliteArchive,
  MessagePool,
  PersonaStore,
  PromptBuilder,
  SampleStore,
  Stats,
  normalizeConfig,
  probeModelEndpoints,
  suggestDistillModel,
  suggestJudgeModel,
  LOCAL_MODEL_CANDIDATES,
  writePersonaMarkdown,
  parseQceExport,
  parseQceJsonl,
  readJsonFile,
  writeJsonFile,
  type BehaviorConfig,
  type ChatMessage,
  type LogEntry,
  type MemoryHit,
  type MessageArchiveLike,
  type PascConfig,
  type PromptBundle,
  type TriggerReason,
} from '@pasc/core';
import { NapCatClient, type NapCatStatus } from '@pasc/napcat';
import { createAgentTransport, probeAgent, type AgentTransport } from '@pasc/agent';
import type { CompleteOptions, LlmMessage } from '@pasc/core';
import { Pipeline, type PipelineEvent } from './pipeline.js';
import { findUnknownConfigKeys, ExecutionLog, AuditLog, MemoryGraph, extractGraph, distillPersona, extractQaPairs, extractEpisode, extractionOptionsFrom, collectUserMessages, type TextCompleter, type AuditRecord } from '@pasc/core';

export interface RuntimePaths {
  home: string;
  dataDir: string;
  configPath: string;
  personasFile: string;
  samplesFile: string;
  memoryFile: string;
  archiveFile: string;
  databaseFile: string;
  logFile: string;
  executionsFile: string;
  auditFile: string;
  graphFile: string;
}

export function resolvePaths(home: string): RuntimePaths {
  const dataDir = join(home, 'data');
  return {
    home,
    dataDir,
    configPath: join(dataDir, 'config.json'),
    personasFile: join(dataDir, 'personas.json'),
    samplesFile: join(dataDir, 'samples.jsonl'),
    memoryFile: join(dataDir, 'memory.jsonl'),
    archiveFile: join(dataDir, 'messages.jsonl'),
    databaseFile: join(dataDir, 'pasc.db'),
    logFile: join(home, 'logs', 'pasc.log'),
    executionsFile: join(dataDir, 'executions.jsonl'),
    auditFile: join(dataDir, 'audit.jsonl'),
    graphFile: join(dataDir, 'memory-graph.json'),
  };
}

/** 事件总线: 管线事件 + 日志统一推给 SSE 订阅者 */
export class EventBus {
  private readonly subs = new Set<(event: PipelineEvent) => void>();
  private readonly ring: PipelineEvent[] = [];

  publish(event: PipelineEvent): void {
    this.ring.push(event);
    if (this.ring.length > 300) this.ring.shift();
    for (const fn of this.subs) {
      try {
        fn(event);
      } catch {
        /* ignore */
      }
    }
  }

  subscribe(fn: (event: PipelineEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  recent(n = 100): PipelineEvent[] {
    return this.ring.slice(-n);
  }
}

/**
 * 运行时: 把配置、存储、NapCat、Agent、管线装配到一起。
 * 所有"需要热更新"的对象都通过 getter 取配置, 所以改配置不用重启进程。
 */
export class Runtime {
  readonly bus = new EventBus();
  readonly stats = new Stats();
  readonly paths: RuntimePaths;
  readonly executions: ExecutionLog;

  private configValue: PascConfig;
  private logger: Logger;
  private napcatClient!: NapCatClient;
  private readonly distillBusy = new Set<string>();
  private autoDistillTimer?: NodeJS.Timeout;
  private agentTransport!: AgentTransport;
  private pool!: MessagePool;
  private personas!: PersonaStore;
  private samples!: SampleStore;
  private memories!: MemoryEngine;
  private embedder: EmbeddingClient | undefined;
  private embedderKey = '';
  private memoryTurns = new Map<string, number>();
  private memoryBusy = new Set<string>();
  private decayTimer: NodeJS.Timeout | undefined;
  private archive!: MessageArchiveLike;
  private guard!: ActionGuard;
  private judge!: JudgeEngine;
  private builder!: PromptBuilder;
  private pipeline!: Pipeline;
  private startedAt = Date.now();
  private readonly audit: AuditLog;
  private graph!: MemoryGraph;
  private napcatStatus: NapCatStatus = 'idle';

  private constructor(
    home: string,
    config: PascConfig,
  ) {
    this.paths = resolvePaths(home);
    this.executions = new ExecutionLog(this.paths.executionsFile);
    this.audit = new AuditLog(this.paths.auditFile);
    this.configValue = config;
    this.logger = Logger.root({
      level: config.log.level,
      file: config.log.file || '',
      bufferSize: config.log.bufferSize,
    });

    // 配置里拼错的键会被 zod 静默丢弃，这里主动报出来
    const unknownKeys = this.unknownConfigKeys(home);
    if (unknownKeys.length > 0) {
      this.logger.warn('配置里有未知字段（不会生效）', { keys: unknownKeys });
    }
  }

  static async create(home: string): Promise<Runtime> {
    const paths = resolvePaths(home);
    const raw = await readJsonFile<unknown>(paths.configPath, null);
    let config: PascConfig;
    try {
      config = normalizeConfig(raw ?? {});
    } catch (err) {
      // 配置坏了不要让进程起不来, 用默认值并提示
      console.error(`[pasc] 配置文件有问题, 已回退默认配置: ${err instanceof Error ? err.message : String(err)}`);
      config = DEFAULT_CONFIG;
    }
    const runtime = new Runtime(home, config);

    // 首次运行把完整配置落盘, 方便用户直接改
    if (raw === null) {
      await writeJsonFile(paths.configPath, config);
    }
    if (!config.log.file) config.log.file = paths.logFile;

    await runtime.init();
    return runtime;
  }

  private async init(): Promise<void> {
    const cfg = this.configValue;

    this.personas = await PersonaStore.open(this.paths.personasFile);
    this.samples = await SampleStore.open(this.paths.samplesFile, { seed: false });
    this.graph = await MemoryGraph.open(this.paths.graphFile);
    this.memories = await MemoryEngine.open(this.paths.memoryFile, {
      getConfig: () => this.configValue.memory,
      // 自检没通过（向量退化）时返回 undefined，记忆引擎自动退回关键词召回
      getEmbedder: () => (this.embeddingQuality.checked && !this.embeddingQuality.ok ? undefined : this.embeddingClient()),
      logger: this.logger.child('memory'),
    });
    this.archive = await this.openArchive(cfg);
    this.pool = new MessagePool(cfg.judgeModel.messagePoolCapacity);
    // 用最近的历史消息预热, 重启后上下文不断档
    this.pool.restore(this.archive.recent(400));
    this.guard = new ActionGuard(cfg.behavior);

    this.napcatClient = new NapCatClient({
      config: cfg.napcat,
      selfId: cfg.napcat.selfId,
      logger: this.logger.child('napcat'),
    });
    this.napcatClient.on('message', (msg) => {
      void this.pipeline.ingest(msg).catch((err) => this.logError('ingest', err));
    });
    this.napcatClient.on('status', (status) => {
      this.napcatStatus = status;
      this.bus.publish({ type: 'status', ts: Date.now(), data: { napcat: status, selfId: this.napcatClient.selfId } });
      this.logger.info('NapCat 状态变化', { status });
    });
    this.napcatClient.on('error', (err) => this.logger.warn('NapCat 通道错误', { error: err.message }));

    this.agentTransport = createAgentTransport(cfg.openclaw, this.logger.child('agent'));

    this.judge = new JudgeEngine({
      getConfig: () => this.configValue.judgeModel,
      getClient: () => this.judgeClient(),
      getPersonaSummary: () => this.personas.summary(),
      logger: this.logger.child('judge'),
    });

    this.builder = new PromptBuilder({
      getConfig: () => this.configValue.prompt,
      guard: this.guard,
      logger: this.logger.child('prompt'),
    });

    this.pipeline = this.buildPipeline();

    this.bus.subscribe((event) => {
      if (event.type === 'reply') {
        const sceneKey = String(event.data.sceneKey ?? '');
        if (sceneKey) this.noteConversationTurn(sceneKey);
      }
    });

    this.logger.subscribe((entry) => {
      this.bus.publish({
        type: 'log',
        ts: entry.ts,
        data: { level: entry.level, scope: entry.scope, msg: entry.msg, ...(entry.data ?? {}) },
      });
    });
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.napcatClient.start();
    this.startDecayLoop();
    this.startAutoDistillLoop();
    void this.ensureEmbeddingQuality();
    this.logger.info('PASC 已启动', {
      home: this.paths.home,
      napcat: `${this.configValue.napcat.protocol} ${this.configValue.napcat.address}`,
      agent: this.agentTransport.name,
    });
  }

  async stop(): Promise<void> {
    if (this.decayTimer) clearInterval(this.decayTimer);
    if (this.autoDistillTimer) clearInterval(this.autoDistillTimer);
    await this.memories.close();
    if (this.archive instanceof SqliteArchive) this.archive.close();
    await this.napcatClient.stop();
    await this.agentTransport.close?.();
    this.logger.info('PASC 已停止');
  }

  get config(): PascConfig {
    return this.configValue;
  }

  get client(): NapCatClient {
    return this.napcatClient;
  }

  get agent(): AgentTransport {
    return this.agentTransport;
  }

  get stores(): { personas: PersonaStore; samples: SampleStore; memories: MemoryEngine; archive: MessageArchiveLike } {
    return {
      personas: this.personas,
      samples: this.samples,
      memories: this.memories,
      archive: this.archive,
    };
  }

  /** 控制台 /api/logs 用 */
  recentLogs(limit = 200): LogEntry[] {
    return this.logger.recent(limit);
  }

  get pipelineRef(): Pipeline {
    return this.pipeline;
  }

  get messagePool(): MessagePool {
    return this.pool;
  }

  /** 局部更新配置: 深合并 → 校验 → 落盘 → 热应用 */
  async updateConfig(patch: unknown): Promise<PascConfig> {
    const next = normalizeConfig(mergeRaw(this.configValue, patch));
    const prev = this.configValue;
    this.configValue = next;

    this.logger.configure({
      level: next.log.level,
      file: next.log.file || this.paths.logFile,
      bufferSize: next.log.bufferSize,
    });
    this.guard.update(next.behavior);

    if (JSON.stringify(prev.napcat) !== JSON.stringify(next.napcat)) {
      await this.restartNapcat(next);
    }
    if (JSON.stringify(prev.openclaw) !== JSON.stringify(next.openclaw)) {
      await this.agentTransport.close?.();
      this.agentTransport = createAgentTransport(next.openclaw, this.logger.child('agent'));
    }

    await writeJsonFile(this.paths.configPath, next);
    this.logger.info('配置已更新');
    return next;
  }

  private buildPipeline(): Pipeline {
    return new Pipeline({
      getConfig: () => this.configValue,
      napcat: this.napcatClient,
      getAgent: () => this.agentTransport,
      pool: this.pool,
      builder: this.builder,
      judge: this.judge,
      guard: this.guard,
      archive: this.archive,
      personas: this.personas,
      samples: this.samples,
      memorySearch: (query: string) => this.memoryHits(query),
      stats: this.stats,
      logger: this.logger.child('pipeline'),
      emit: (event) => this.bus.publish(event),
      statusReport: (topic) => this.statusReport(topic),
      audit: (record) => this.recordAudit(record),
      executions: this.executions,
    });
  }

  private async restartNapcat(next: PascConfig): Promise<void> {
    await this.napcatClient.stop();
    this.napcatClient = new NapCatClient({
      config: next.napcat,
      selfId: next.napcat.selfId,
      logger: this.logger.child('napcat'),
    });
    this.napcatClient.on('message', (msg) => {
      void this.pipeline.ingest(msg).catch((err) => this.logError('ingest', err));
    });
    this.napcatClient.on('status', (status) => {
      this.napcatStatus = status;
      this.bus.publish({ type: 'status', ts: Date.now(), data: { napcat: status } });
      this.logger.info('NapCat 状态变化', { status });
    });
    this.napcatClient.on('error', (err) => this.logger.warn('NapCat 通道错误', { error: err.message }));
    // 注意: pipeline 持有的是旧引用, 这里通过替换 client 并重建 pipeline 保持一致性
    this.pipeline = this.buildPipeline();
    this.napcatClient.start();
  }

  /** 提取模型客户端(未配置返回 undefined, 上层自动回退到统计草稿) */
  distillClient(): ChatClient | undefined {
    const cfg = this.configValue.distill.api;
    if (!cfg.baseURL.trim() || !cfg.model.trim()) return undefined;
    return new ChatClient(cfg, this.logger.child('distill:llm'));
  }

  /** 某个会话的历史消息(时间正序); 不传 sceneKey 就是全量 */
  sceneMessages(sceneKey?: string, limit = 2_000): ChatMessage[] {
    const rows = this.archive.query(sceneKey ? { sceneKey, limit: 1_000_000 } : { limit: 1_000_000 });
    return rows.slice(-limit);
  }

  /** 会话里的参与者, 按发言数排序 */
  participants(sceneKey: string): Array<{ senderId: string; senderName: string; count: number }> {
    return this.archive.countBySender(sceneKey);
  }

  /** 打开存档: sqlite 优先, 老 JSONL 会一次性迁移过去 */
  private async openArchive(cfg: PascConfig): Promise<MessageArchiveLike> {
    if (cfg.archive.driver !== 'sqlite') {
      return MessageArchive.open(this.paths.archiveFile);
    }
    try {
      const dbFile = cfg.archive.path || this.paths.databaseFile;
      const sqlite = SqliteArchive.open(dbFile);

      // 老用户升级: 把 messages.jsonl 灌进 SQLite, 成功后改名留档
      if (sqlite.size === 0) {
        const legacy = join(this.paths.dataDir, 'messages.jsonl');
        try {
          const migrated = sqlite.migrateJsonl(legacy);
          if (migrated > 0) {
            this.logger.info('已把 JSONL 存档迁移到 SQLite', { migrated });
            const { rename } = await import('node:fs/promises');
            await rename(legacy, `${legacy}.migrated`).catch(() => undefined);
          }
        } catch {
          /* 没有旧文件就跳过 */
        }
      }
      return sqlite;
    } catch (err) {
      this.logger.error('SQLite 打开失败, 回退到 JSONL 存档', {
        error: err instanceof Error ? err.message : String(err),
      });
      return MessageArchive.open(this.paths.archiveFile);
    }
  }

  /** Embedding 客户端: 未启用或没填地址时返回 undefined(自动退化为关键词召回) */
  embeddingClient(): EmbeddingClient | undefined {
    const cfg = this.configValue.embedding;
    const key = JSON.stringify(cfg.api);
    if (!cfg.enabled) return undefined;
    if (!cfg.api.baseURL.trim() || !cfg.api.model.trim()) return undefined;
    if (!this.embedder || this.embedderKey !== key) {
      this.embedder = new EmbeddingClient(cfg.api);
      this.embedderKey = key;
    }
    return this.embedder;
  }

  /**
   * 记忆召回。
   * 注意: 这里不判断 memory.enabled —— 是否注入 Prompt 由管线决定,
   * 但控制台的"召回测试"需要在关闭注入时也能工作。
   */
  async memoryHits(query: string, topK?: number): Promise<MemoryHit[]> {
    const hits = await this.memories.search(query, topK ? { topK } : {});
    return hits;
  }

  get memory(): MemoryEngine {
    return this.memories;
  }

  /** 手动/自动触发一次记忆抽取 */
  /**
   * 记忆抽取用的"客户端"。
   *   distill → 本地蒸馏模型
   *   agent   → OpenClaw 的专用 agent（DeepSeek），不占本地显存、质量更好
   */
  private extractClient(): TextCompleter | undefined {
    const provider = this.configValue.memoryExtract.provider;
    if (provider === 'agent') {
      const agentId = this.configValue.memoryExtract.agentId;
      return {
        configured: true,
        complete: async (msgs: LlmMessage[]) => {
          const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
          const user = msgs.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
          const res = await this.agentTransport.send({
            system,
            user,
            meta: {
              sceneKey: 'pasc:extract',
              sceneLabel: '记忆抽取',
              triggerId: '',
              reason: 'manual',
              agentId,
            },
          });
          return { text: res.text };
        },
      };
    }
    return this.distillClient();
  }

  async runMemoryExtraction(sceneKey?: string): Promise<{
    candidates: number;
    added: number;
    merged: number;
    warnings: string[];
  }> {
    const client = this.extractClient();
    if (!client?.configured) throw new Error('未配置提取模型 (memoryExtract.provider / distill.api)');

    const cfg = this.configValue.memory;
    const messages = this.sceneMessages(sceneKey, 40);
    if (messages.length === 0) return { candidates: 0, added: 0, merged: 0, warnings: ['没有可用消息'] };

    const extracted = await extractMemoryCandidates(client, messages, {
      maxItems: cfg.autoExtract.maxPerRun,
      minImportance: cfg.autoExtract.minImportance,
      logger: this.logger.child('memory'),
    });

    const ingested = await this.memories.ingest(extracted.candidates, {
      ...(sceneKey ? { sceneKey } : {}),
      sourceIds: messages.slice(-20).map((m) => m.id),
    });
    // 再压一条"会话摘要"：原子事实记不住聊天的前因后果，摘要可以
    let episodeAdded = 0;
    try {
      const { episode, warning } = await extractEpisode(client, messages, {
        minImportance: cfg.autoExtract.minImportance,
      });
      if (episode) {
        const got = await this.memories.ingest(
          [
            {
              text: episode.canonical,
              type: 'episode',
              importance: episode.importance,
              tags: [...episode.topics, ...episode.participants].slice(0, 8),
              subjects: episode.participants,
            },
          ],
          { ...(sceneKey ? { sceneKey } : {}), sourceIds: messages.slice(-20).map((m) => m.id) },
        );
        episodeAdded = got.added;
      } else if (warning) {
        this.logger.debug('会话摘要未生成', { reason: warning });
      }
    } catch (err) {
      this.logger.warn('会话摘要失败', { error: err instanceof Error ? err.message : String(err) });
    }

    await this.memories.flush();

    // 图谱跟着记忆走：抽取完成后异步更新，不阻塞对话
    void this.updateGraph(ingested.records.map((r) => ({ id: r.id, text: r.text })), sceneKey).catch(() => undefined);

    this.logger.info('记忆抽取完成', {
      sceneKey: sceneKey ?? 'all',
      candidates: extracted.candidates.length,
      added: ingested.added,
      merged: ingested.merged,
      episode: episodeAdded,
    });

    return {
      candidates: extracted.candidates.length,
      added: ingested.added,
      merged: ingested.merged,
      warnings: extracted.warnings,
    };
  }

  /** 每 N 轮对话自动抽一次记忆(参考 LivingMemory 的"达到轮次阈值后整理") */
  noteConversationTurn(sceneKey: string): void {
    const cfg = this.configValue.memory;
    if (!cfg.enabled || !cfg.autoExtract.enabled) return;
    if (!this.distillClient()?.configured) return;
    if (this.memoryBusy.has(sceneKey)) return;

    const turns = (this.memoryTurns.get(sceneKey) ?? 0) + 1;
    this.memoryTurns.set(sceneKey, turns);
    if (turns < cfg.autoExtract.everyNTurns) return;

    this.memoryTurns.set(sceneKey, 0);
    this.memoryBusy.add(sceneKey);
    void this.runMemoryExtraction(sceneKey)
      .catch((err: unknown) => this.logger.warn('自动记忆抽取失败', { error: err instanceof Error ? err.message : String(err) }))
      .finally(() => this.memoryBusy.delete(sceneKey));
  }

  private startDecayLoop(): void {
    const run = (): void => {
      try {
        const result = this.memories.decay();
        if (result.archived > 0) this.logger.info('记忆衰减归档', result);
      } catch (err) {
        this.logger.warn('记忆衰减失败', { error: err instanceof Error ? err.message : String(err) });
      }
    };
    run();
    this.decayTimer = setInterval(run, 6 * 60 * 60 * 1000);
    this.decayTimer.unref?.();
  }

  /** 会话列表: 以存档为准(导入的历史也会出现在这里), 再叠加运行时判断/回复计数 */
  /** 针对某个目标用户跑一次提纯，返回草稿（不落库） */
  async distillFromTarget(input: {
    senderId: string;
    sceneKey?: string;
    name?: string;
    limit?: number;
  }): Promise<{ draft: { name: string; description: string; content: string }; pairs: number; targetMessages: number } | { error: string }> {
    const messages = this.sceneMessages(input.sceneKey);
    const opts = extractionOptionsFrom(this.config.extraction, input.senderId, input.sceneKey);
    const extracted = extractQaPairs(messages, { ...opts, ...(input.limit ? { maxPairs: input.limit } : {}) });
    const target = collectUserMessages(messages, input.senderId);
    if (extracted.pairs.length === 0 && target.length === 0) {
      return { error: '这个用户在当前会话里没有可用发言' };
    }
    const targetName = target[0]?.senderName ?? input.senderId;
    const draft = await distillPersona(
      {
        target: { id: input.senderId, name: input.name ?? targetName },
        sceneKey: input.sceneKey ?? 'all',
        pairs: extracted.pairs,
        messages: target,
      },
      { getConfig: () => this.config.distill, getClient: () => this.distillClient() },
    );
    return { draft, pairs: extracted.pairs.length, targetMessages: target.length };
  }

  /** 对某个人格执行一次提纯并把结果写回人格正文 */
  async distillPersonaById(id: string): Promise<{ ok: boolean; error?: string; pairs?: number }> {
    const store = this.stores.personas;
    const persona = store.get(id);
    if (!persona) return { ok: false, error: '人格不存在' };
    const t = persona.distill;
    if (!t?.senderId) return { ok: false, error: '这个人格还没设置提纯目标用户' };

    const r = await this.distillFromTarget({
      senderId: t.senderId,
      ...(t.sceneKey ? { sceneKey: t.sceneKey } : {}),
      ...(t.senderName ? { name: t.senderName } : {}),
    });
    if ('error' in r) return { ok: false, error: r.error };

    // 护栏 1：问答对是硬门槛 —— 没有"别人问、ta 答"的结构，提纯只会得到空话
    const MIN_PAIRS = 8;
    if (r.pairs < MIN_PAIRS) {
      return {
        ok: false,
        error: `问答对太少（${r.pairs} 对，需要 ≥ ${MIN_PAIRS} 对）。这个会话里缺少"别人提问 → 目标回答"的结构，`
          + '先去一个有对话的群，或调低 extraction 的配对要求',
      };
    }
    // 护栏 2：草稿不能明显比现有内容短，避免用一页空话替换掉厚人格
    const draftLen = r.draft.content.trim().length;
    const oldLen = persona.content.trim().length;
    if (draftLen < 400 || (oldLen > 600 && draftLen < oldLen * 0.6)) {
      return { ok: false, error: `提纯结果太短（${draftLen} 字，现有 ${oldLen} 字），已放弃覆盖` };
    }

    // 覆盖前先把旧正文存一份，出问题能回滚
    await this.backupPersona(persona.id, persona.content);

    store.upsert({
      id: persona.id,
      name: persona.name,
      description: r.draft.description || persona.description,
      content: r.draft.content,
      distill: { ...t, lastRunAt: Date.now(), lastMessageCount: 0 },
    });
    await store.flush();
    this.logger.info('人格提纯完成', { persona: persona.name, pairs: r.pairs });
    return { ok: true, pairs: r.pairs };
  }

  /** 覆盖人格前留一份旧正文 */
  private async backupPersona(id: string, content: string): Promise<void> {
    try {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const dir = join(this.paths.dataDir, 'persona-history');
      await mkdir(dir, { recursive: true });
      const name = `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
      await writeFile(join(dir, name), content, 'utf8');
    } catch {
      /* 备份失败不阻塞主流程 */
    }
  }

  /** 自动提纯：目标用户攒够新发言就重跑 */
  private startAutoDistillLoop(): void {
    const run = async (): Promise<void> => {
      for (const persona of this.stores.personas.list()) {
        const t = persona.distill;
        if (!t?.auto || !t.senderId || this.distillBusy.has(persona.id)) continue;
        const since = t.lastRunAt ?? 0;
        const fresh = this.stores.archive.query({
          senderId: t.senderId,
          ...(t.sceneKey ? { sceneKey: t.sceneKey } : {}),
          ...(since ? { since } : {}),
          limit: 500,
        }).length;
        if (fresh < 30) continue;
        this.distillBusy.add(persona.id);
        try {
          const r = await this.distillPersonaById(persona.id);
          if (!r.ok) this.logger.warn('自动提纯失败', { persona: persona.name, error: r.error });
        } catch (err) {
          this.logger.warn('自动提纯异常', { error: err instanceof Error ? err.message : String(err) });
        } finally {
          this.distillBusy.delete(persona.id);
        }
      }
    };
    this.autoDistillTimer = setInterval(() => void run(), 10 * 60 * 1000);
    this.autoDistillTimer.unref?.();
  }

  /** 向量质量自检结果：坏掉的 embedding 不能用来做召回 */
  embeddingQuality: { checked: boolean; ok: boolean; reason?: string; meanSimilarity?: number; stdSimilarity?: number } = {
    checked: false,
    ok: false,
  };
  embeddingCheckPromise?: Promise<void>;

  async ensureEmbeddingQuality(): Promise<void> {
    const embedder = this.embeddingClient();
    if (!embedder?.configured) {
      this.embeddingQuality = { checked: true, ok: false, reason: '未配置 embedding 模型' };
      return;
    }
    if (this.embeddingQuality.checked) return;
    this.embeddingCheckPromise ??= (async () => {
      const { checkEmbeddingQuality } = await import('@pasc/core');
      const q = await checkEmbeddingQuality(embedder);
      this.embeddingQuality = {
        checked: true,
        ok: q.ok,
        ...(q.reason ? { reason: q.reason } : {}),
        meanSimilarity: Number(q.meanSimilarity.toFixed(3)),
        stdSimilarity: Number(q.stdSimilarity.toFixed(3)),
      };
      if (!q.ok) {
        this.logger.warn('Embedding 自检未通过，已停用向量召回，改用关键词', {
          reason: q.reason,
          mean: q.meanSimilarity.toFixed(3),
          std: q.stdSimilarity.toFixed(4),
        });
      } else {
        this.logger.info('Embedding 自检通过', {
          mean: q.meanSimilarity.toFixed(3),
          std: q.stdSimilarity.toFixed(4),
        });
      }
    })();
    await this.embeddingCheckPromise;
  }

  /** 供外部脚本使用的一次性对话通道 */
  getAgent(): AgentTransport {
    return this.agent;
  }

  /** 当前账号的好友（离线时返回空数组） */
  async listFriends(): Promise<Array<{ userId: string; nickname: string; remark: string }>> {
    try {
      return await this.napcatClient.getFriendList();
    } catch {
      return [];
    }
  }

  sceneSummaries(): Array<{
    sceneKey: string;
    label: string;
    totalMessages: number;
    judged: number;
    replied: number;
    lastMessageAt: number;
    lastText: string;
    /** 距离上次判断累积的新消息数（判断门槛的关键指标） */
    newSinceJudge: number;
    lastJudgeAt: number;
    lastReplyAt: number;
    busy: boolean;
  }> {
    const keys = new Map<string, { count: number; lastAt: number }>();

    if (this.archive instanceof SqliteArchive) {
      for (const scene of this.archive.stats().scenes) keys.set(scene.sceneKey, { count: scene.count, lastAt: scene.lastAt });
    } else {
      for (const key of this.pool.allSceneKeys()) {
        keys.set(key, { count: this.pool.size(key), lastAt: 0 });
      }
    }
    for (const key of this.pool.allSceneKeys()) {
      if (!keys.has(key)) keys.set(key, { count: this.pool.size(key), lastAt: 0 });
    }

    return [...keys.entries()]
      .map(([sceneKey, info]) => {
        const state = this.pool.state(sceneKey);
        const gate = {
          newSinceJudge: state.newSinceJudge,
          lastJudgeAt: state.lastJudgeAt,
          lastReplyAt: state.lastReplyAt,
          busy: state.busy,
        };
        const last = this.archive.query({ sceneKey, limit: 1, desc: true });
        return {
          sceneKey,
          label: sceneKey.startsWith('group:') ? `群 ${sceneKey.slice(6)}` : `私聊 ${sceneKey.slice(8)}`,
          totalMessages: info.count,
          judged: state.judged,
          replied: state.replied,
          lastMessageAt: last[0]?.timestamp ?? info.lastAt,
          lastText: last[0]?.text ?? '',
          ...gate,
        };
      })
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  /**
   * 探测模型端点: 常见的本地端口 + 配置里已经填过的地址。
   * 解决"本机跑着 Ollama 但忘了端口 / 没启动"这类问题。
   */
  async probeModels(extra: string[] = []): Promise<{
    endpoints: Array<{ baseURL: string; label: string; ok: boolean; models: string[]; latencyMs: number; error?: string }>;
    suggestion: { judge?: { baseURL: string; model: string }; distill?: { baseURL: string; model: string } };
  }> {
    const cfg = this.configValue;
    const configured = [cfg.judgeModel.api.baseURL, cfg.distill.api.baseURL, cfg.embedding.api.baseURL, ...extra].filter(
      (u) => u.trim().length > 0,
    );
    const locals = LOCAL_MODEL_CANDIDATES.map((c) => c.baseURL);
    const results = await probeModelEndpoints([...configured, ...locals]);

    const labelOf = (baseURL: string): string =>
      LOCAL_MODEL_CANDIDATES.find((c) => c.baseURL === baseURL)?.label ?? '已配置';

    const endpoints = results.map((r) => ({ ...r, label: labelOf(r.baseURL) }));
    const firstUsable = endpoints.find((e) => e.ok && e.models.length > 0);

    return {
      endpoints,
      suggestion: firstUsable
        ? {
            judge: { baseURL: firstUsable.baseURL, model: suggestJudgeModel(firstUsable.models) ?? '' },
            distill: { baseURL: firstUsable.baseURL, model: suggestDistillModel(firstUsable.models) ?? '' },
          }
        : {},
    };
  }

  /** 一键把探测结果写进配置(判断模型 / 提取模型) */
  async applyModel(target: 'judge' | 'distill', baseURL: string, model: string): Promise<void> {
    if (!baseURL.trim() || !model.trim()) throw new Error('baseURL 与 model 都不能为空');
    if (target === 'judge') {
      await this.updateConfig({ judgeModel: { api: { baseURL, model } } });
    } else {
      await this.updateConfig({ distill: { api: { baseURL, model } } });
    }
  }

  /** 把当前人格同步成 OpenClaw 能读的 markdown */
  async exportPersona(personaId?: string, filePath?: string): Promise<{ file: string; bytes: number; persona: string }> {
    const store = this.personas;
    const persona = personaId ? store.get(personaId) : store.getActive();
    if (!persona) throw new Error('找不到该人格');

    const file = filePath?.trim() || this.configValue.openclaw.personaFile.trim();
    if (!file) throw new Error('没有指定导出路径, 也没配置 openclaw.personaFile');

    const bytes = await writePersonaMarkdown(file, persona, { source: this.configValue.openclaw.agentId || 'pasc' });
    this.logger.info('人格已导出为 markdown', { persona: persona.name, file, bytes });
    return { file, bytes, persona: persona.name };
  }

  /** 保存人格后自动同步(只在配置了 personaFile 且是当前人格时) */
  async autoSyncPersona(personaId: string): Promise<void> {
    const file = this.configValue.openclaw.personaFile.trim();
    if (!file) return;
    if (this.personas.activeId !== personaId) return;
    try {
      await this.exportPersona(personaId, file);
    } catch (err) {
      this.logger.warn('人格自动同步失败', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 存档统计(SQLite 才有完整统计, 否则退化) */
  archiveStats(): Record<string, unknown> | undefined {
    if (this.archive instanceof SqliteArchive) {
      return { ...this.archive.stats(), driver: 'sqlite', fts: this.archive.hasFts };
    }
    return { driver: 'jsonl', total: this.archive.size };
  }

  /** 导入 QCE 导出文件 */
  async importQce(opts: {
    filePath: string;
    groupId?: string;
    sceneKey?: string;
    selfId?: string;
    includeSystem?: boolean;
    dryRun?: boolean;
  }): Promise<{
    imported: number;
    parsed: number;
    skipped: number;
    sceneKey: string;
    chatName: string;
    warnings: string[];
    total: number;
  }> {
    const { readFile, stat } = await import('node:fs/promises');
    const info = await stat(opts.filePath);
    const limit = this.config.archive.maxImportMb * 1024 * 1024;
    if (info.size > limit) {
      throw new Error(`文件 ${Math.round(info.size / 1024 / 1024)}MB 超过上限 ${this.config.archive.maxImportMb}MB`);
    }

    const raw = await readFile(opts.filePath, 'utf8');
    const parseOpts = {
      ...(opts.groupId ? { groupId: opts.groupId } : {}),
      ...(opts.sceneKey ? { sceneKey: opts.sceneKey } : {}),
      ...(opts.selfId ? { selfId: opts.selfId } : {}),
      includeSystem: opts.includeSystem ?? false,
    };

    const isJsonl = /\.jsonl$|\.jl$/i.test(opts.filePath);
    const result = isJsonl ? parseQceJsonl(raw, parseOpts) : parseQceExport(JSON.parse(raw), parseOpts);

    let imported = 0;
    if (opts.dryRun) {
      imported = result.messages.length;
    } else {
      imported = this.archive instanceof SqliteArchive
        ? this.archive.importMany(result.messages, 'qce')
        : countImported(this.archive, result.messages);
    }

    this.logger.info(opts.dryRun ? 'QCE 导入试运行' : 'QCE 导入完成', {
      file: opts.filePath,
      parsed: result.messages.length,
      imported,
      sceneKey: result.sceneKey,
    });

    return {
      imported,
      parsed: result.messages.length,
      skipped: result.skipped,
      sceneKey: result.sceneKey,
      chatName: result.chatInfo.name,
      warnings: result.warnings,
      total: this.archive.size,
    };
  }

  async health(): Promise<Record<string, unknown>> {
    const agentHealth = await this.agentTransport.health().catch((err: unknown) => ({
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    }));
    return {
      ok: true,
      version: '0.1.0',
      uptimeMs: Date.now() - this.startedAt,
      napcat: {
        protocol: this.configValue.napcat.protocol,
        status: this.napcatStatus,
        selfId: this.napcatClient.selfId,
        address: this.configValue.napcat.address,
      },
      agent: { name: this.agentTransport.name, ...agentHealth },
      judge: {
        mode: this.judgeClient()?.configured ? 'model' : 'heuristic',
        model: this.configValue.judgeModel.api.model,
      },
      stores: {
        personas: this.personas.list().length,
        samples: this.samples.size,
        memories: this.memories.size,
        archived: this.archive.size,
      },
      pool: this.pool.stats(),
    };
  }

  /**
   * 给 QQ 命令用的状态报告。
   * 全部读本地真实状态，不经过大模型 —— 所以准确、即时、零成本。
   */
  /** 读原始配置文件，找出 schema 不认识的键 */
  private unknownConfigKeys(home: string): string[] {
    try {
      const file = join(home, 'data', 'config.json');
      const raw = readFileSync(file, 'utf8');
      return findUnknownConfigKeys(JSON.parse(raw));
    } catch {
      return [];
    }
  }

  /**
   * 把新写入的记忆并进图谱。
   * 用和抽取同一套客户端（默认 DeepSeek），异步跑，失败只记日志。
   */
  private async updateGraph(records: Array<{ id: string; text: string }>, sceneKey?: string): Promise<void> {
    if (records.length === 0) return;
    const client = this.extractClient();
    if (!client?.configured) return;

    const { data, warning } = await extractGraph(client, records.map((r) => r.text));
    if (!data) {
      if (warning) this.logger.debug('图谱抽取未产出', { reason: warning });
      return;
    }
    // 一次抽多条的实体，挂到这一批的第一条记忆上即可，能追溯即可
    const memoryId = records[0]?.id ?? '';
    this.graph.merge(data.entities, data.relations, memoryId, this.qqToNickname(sceneKey));
    await this.graph.save();
    this.logger.info('记忆图谱更新', {
      entities: data.entities.length,
      relations: data.relations.length,
      nodes: this.graph.nodeCount,
      edges: this.graph.edgeCount,
    });
  }

  /** QQ 号 → 昵称，让图上显示人名而不是号码 */
  private qqToNickname(sceneKey?: string): ((name: string) => string) | undefined {
    if (!sceneKey) return undefined;
    try {
      const rows = this.archive.countBySender(sceneKey);
      const map = new Map(rows.map((r) => [r.senderId, r.senderName || r.senderId]));
      return (name: string) => (/^\d{5,}$/.test(name) ? (map.get(name) ?? name) : name);
    } catch {
      return undefined;
    }
  }

  /** 前端用：整张图的快照 */
  graphSnapshot(): ReturnType<MemoryGraph['snapshot']> {
    return this.graph.snapshot();
  }

  /** 前端用：某个实体的详情 */
  graphAbout(nodeId: string) {
    return this.graph.about(nodeId);
  }

  /** 全量重建：把现有记忆重新过一遍 */
  async rebuildGraph(): Promise<{ nodes: number; edges: number; batches: number }> {
    const client = this.extractClient();
    if (!client?.configured) throw new Error('未配置抽取模型');
    await this.graph.clear();

    const all = this.memories.list({ limit: 500 }).filter((m) => m.status === 'active');
    let batches = 0;
    // 每次 8 条，避免一次塞太多导致模型漏抽
    for (let i = 0; i < all.length; i += 8) {
      const batch = all.slice(i, i + 8);
      const { data } = await extractGraph(client, batch.map((m) => m.text));
      if (data && (data.entities.length > 0 || data.relations.length > 0)) {
        this.graph.merge(data.entities, data.relations, batch[0]!.id, this.qqToNickname(batch[0]!.sceneKey));
        batches += 1;
      }
    }
    await this.graph.save();
    return { nodes: this.graph.nodeCount, edges: this.graph.edgeCount, batches };
  }

  /** 管理员命令审计：append-only，不阻塞主流程 */
  private recordAudit(record: {
    sceneKey: string;
    senderId: string;
    senderName?: string;
    command: string;
    detail?: string;
    ok: boolean;
    reason?: string;
  }): void {
    this.audit
      .append({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: Date.now(), ...record })
      .catch(() => undefined);
  }

  /** 给前端/接口读审计记录 */
  async recentAudits(limit = 100): Promise<AuditRecord[]> {
    return this.audit.recent({ limit });
  }

  async statusReport(topic?: string): Promise<string> {
    const t = (topic || '').trim().toLowerCase();
    const want = (key: string): boolean => !t || t.includes(key);
    const lines: string[] = [];
    const uptimeMin = Math.round((Date.now() - this.startedAt) / 60000);
    const s = this.stats.snapshot();

    if (want('pasc') || want('all')) {
      lines.push(`PASC　运行中 · ${uptimeMin} 分钟`);
    }
    if (want('napcat') || want('all')) {
      const self = this.napcatClient.selfId || this.config.napcat.selfId || '—';
      lines.push(`NapCat　${this.napcatStatus} · 账号 ${self}`);
    }
    if (want('gateway') || want('gw') || want('all')) {
      try {
        const probe = await this.probeAgent();
        lines.push(`Gateway　${probe.ok ? 'ok' : '不可用'} · ${probe.detail}`);
      } catch (err) {
        lines.push(`Gateway　探测失败 · ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (want('model') || want('judge') || want('all')) {
      const j = this.config.judgeModel;
      lines.push(`判断模型　${j.enabled ? (j.api.model || '未配置') : '已关闭'} · 阈值 ${j.replyThreshold}`);
    }
    if (want('embed') || want('memory') || want('all')) {
      const q = this.embeddingQuality;
      const h = this.stores.memories.embeddingHealth();
      lines.push(
        `向量　${q.checked ? (q.ok ? 'ok' : `降级(${q.reason ?? '退化'})`) : '未检测'} · ${h.embedded}/${h.total} 已向量化`,
      );
    }
    if (want('queue') || want('pool') || want('all')) {
      const pool = this.pool.allSceneKeys();
      lines.push(`消息池　${pool.length} 个会话 · ${pool.reduce((n, k) => n + this.pool.size(k), 0)} 条`);
    }
    if (want('stat') || want('all')) {
      lines.push(`今日　收 ${s.messagesIn} · 判断 ${s.judgeRuns} · 回复 ${s.replies} · 错误 ${s.errors}`);
    }
    if (lines.length === 0) {
      return `未知项：${topic}\n可用：#status [pasc|napcat|gateway|model|embed|pool|stat]`;
    }
    return lines.join('\n');
  }

  async probeAgent(): Promise<{ ok: boolean; detail: string; sample?: string }> {
    return probeAgent(this.agentTransport);
  }

  /** 控制台"模拟一条消息"入口, 无需 QQ 即可验证整条链路 */
  async simulate(input: {
    text: string;
    senderId?: string;
    senderName?: string;
    groupId?: string;
    scene?: 'group' | 'private';
    force?: boolean;
    reason?: TriggerReason;
  }): Promise<{ message: ChatMessage; reply?: PromptBundle }> {
    const senderId = input.senderId ?? '10001';
    const senderName = input.senderName ?? '测试用户';
    const scene =
      input.scene === 'private'
        ? ({ kind: 'private', userId: senderId } as const)
        : ({ kind: 'group', groupId: input.groupId ?? '123456' } as const);

    const message: ChatMessage = {
      id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      seq: 0,
      scene,
      sceneKey: scene.kind === 'group' ? `group:${scene.groupId}` : `private:${scene.userId}`,
      senderId,
      senderName,
      segments: [{ type: 'text', text: input.text }],
      text: input.text,
      atTargets: [],
      mentionsSelf: input.text.includes('[at]'),
      timestamp: Date.now(),
      isSelf: false,
    };

    await this.pipeline.ingest(message, {
      force: input.force ?? true,
      trigger: input.reason ?? 'manual',
    });
    return { message };
  }

  private judgeClient(): ChatClient | undefined {
    const cfg = this.configValue.judgeModel.api;
    if (!cfg.baseURL.trim() || !cfg.model.trim()) return undefined;
    return new ChatClient(cfg, this.logger.child('judge:llm'));
  }

  private logError(stage: string, err: unknown): void {
    this.logger.error(`运行时错误 (${stage})`, { error: err instanceof Error ? err.message : String(err) });
    this.stats.recordError(err);
  }
}

/** 配置 patch 用: 只做一层对象合并, 交给 normalizeConfig 补全 */
function mergeRaw(base: unknown, patch: unknown): unknown {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const prev = out[k];
    out[k] =
      typeof prev === 'object' && prev !== null && typeof v === 'object' && v !== null && !Array.isArray(v)
        ? mergeRaw(prev, v)
        : v;
  }
  return out;
}

export type { BehaviorConfig };

/** 非 SQLite 存档的导入: 无返回值, 只能按条数逼近 */
function countImported(archive: MessageArchiveLike, messages: ChatMessage[]): number {
  const before = archive.size;
  for (const msg of messages) archive.append(msg);
  return Math.max(0, archive.size - before);
}
