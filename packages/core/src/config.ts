import { z } from 'zod';
import { DEFAULT_BASE_PROMPT } from './prompt-defaults.js';

/**
 * 配置模型
 *
 * 说明: 需求文档里用的是 `napcat.address` / `judge_model.message_pool_capacity`
 * 这类点分 + 下划线写法; 代码里统一改成 camelCase, 映射关系见 README 的配置表。
 * 新增字段一律给默认值, 这样老配置文件可以无缝升级。
 */

const LlmBaseSchema = z.object({
  baseURL: z.string(),
  apiKey: z.string().default(''),
  model: z.string(),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().max(32768).default(512),
  timeoutMs: z.number().int().positive().default(30_000),
  /**
   * 是否让模型"思考"。
   * auto = 仅当端点是本机时发送 enable_thinking:false(本地 Qwen 这类思考模型会把
   * 思维链写进正文, 对判断/提纯都是噪声); on/off = 强制。
   */
  enableThinking: z.enum(['auto', 'on', 'off']).default('auto'),
});

const LlmConfigSchema = LlmBaseSchema.extend({
  baseURL: z.string().default('http://127.0.0.1:11434/v1'),
  model: z.string().default('qwen2.5:7b-instruct'),
}).default({});

/**
 * 判断模型的默认值是"空地址"。
 * 理由: 大部分用户没有本地 Ollama, 默认填一个连不上的地址会让每次判断都白等一次超时。
 * 填了 baseURL + model 才会走小模型, 否则自动走启发式。
 */
const JudgeLlmSchema = LlmBaseSchema.extend({
  baseURL: z.string().default(''),
  model: z.string().default(''),
  maxTokens: z.number().int().positive().default(256),
}).default({});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;

const ServerConfigSchema = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(7788),
    /** 可选: 访问控制台的 Bearer Token, 留空表示不鉴权(仅建议本机使用) */
    accessToken: z.string().default(''),
  })
  .default({});

const NapCatConfigSchema = z
  .object({
    protocol: z.enum(['ws', 'http']).default('ws'),
    /** 正向 WebSocket 地址: PASC 主动连过去收事件 + 发指令 */
    address: z.string().default('ws://127.0.0.1:3001'),
    /** HTTP API 地址, protocol=http 时用于发指令; protocol=ws 时作为断线兜底 */
    httpAddress: z.string().default('http://127.0.0.1:3000'),
    accessToken: z.string().default(''),
    /** 机器人自己的 QQ 号, 留空则从事件里的 self_id 学习 */
    selfId: z.string().default(''),
    reconnect: z
      .object({
        enabled: z.boolean().default(true),
        minDelayMs: z.number().int().positive().default(1_000),
        maxDelayMs: z.number().int().positive().default(30_000),
      })
      .default({}),
  })
  .default({});

const AgentConfigSchema = z
  .object({
    /** mock = 本地假 Agent; http = 任意 JSON/OpenAI 兼容端点; gateway = OpenClaw Gateway (实验性) */
    transport: z.enum(['mock', 'http', 'gateway']).default('mock'),
    address: z.string().default('http://127.0.0.1:8080/agent'),
    token: z.string().default(''),
    timeoutMs: z.number().int().positive().default(60_000),
    /** http 传输的请求体格式 */
    httpPayload: z.enum(['pasc', 'openai']).default('pasc'),
    /** 会话前缀: OpenClaw 侧会看到 pasc:group:123456 这样的 sessionKey */
    sessionPrefix: z.string().default('pasc'),
    /**
     * OpenClaw 的 chat.send 只接受一条 message, system 怎么给:
     *   inline  = system + user 合成一条(默认, PASC 完全掌控 Prompt)
     *   message = 只发 user, 人设交给 OpenClaw 自己的 markdown
     */
    systemMode: z.enum(['inline', 'message']).default('inline'),
    /**
     * 允许 Agent 联网搜索。
     * OpenClaw 自身已接好 web.search（默认 parallel-free，无需 key），
     * 这里只控制"要不要在 Prompt 里提示它可以用"，关掉能省掉一次工具往返的延迟。
     */
    webSearch: z.boolean().default(true),
    /**
     * 目标子 Agent 标识。
     * OpenClaw 可以挂多个子 agent(每个有自己的人格), 中间件要把消息投给指定的那个,
     * 否则会投到默认 agent 上, 人格就被"套娃"了。
     */
    agentId: z.string().default(''),
    /**
     * 人格同步文件路径(markdown)。
     * 需求文档 §8.1 建议把人格写进 OpenClaw 的 markdown, 让 OpenClaw 自己注入。
     * 填了以后保存人格时会顺带同步一份过去; 留空则不同步。
     */
    personaFile: z.string().default(''),
    /** mock 传输的模拟延迟 */
    mockLatencyMs: z.number().int().min(0).default(300),
  })
  .default({});

const VisionConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * agent    = 把图片附给 Agent（DeepSeek Flash 原生支持视觉，不占本地显存）★推荐
     * ocr      = 只读图上的文字（快，2 秒左右，适合截图/梗图）
     * describe = 描述画面内容（慢，15~30 秒，适合照片）
     * auto     = 先 OCR，读不到字再描述
     */
    mode: z.enum(['agent', 'ocr', 'describe', 'auto']).default('agent'),
    api: z
      .object({
        baseURL: z.string().default('http://127.0.0.1:8000/v1'),
        apiKey: z.string().default(''),
        model: z.string().default('GLM-OCR'),
        describeModel: z.string().default('GLM-4.6V-Flash-MLX-6bit'),
        timeoutMs: z.number().int().positive().default(45_000),
      })
      .default({}),
    /** 单条消息最多处理几张图 */
    maxImages: z.number().int().min(1).max(4).default(2),
    /** OCR 结果短于这个字数就认为"图上没字" */
    minText: z.number().int().min(0).default(2),
    /** 容器内路径 → 宿主机路径的映射（NapCat 跑在 Docker 里） */
    mountFrom: z.string().default('/app/.config/QQ'),
    mountTo: z.string().default(''),
  })
  .default({});

const JudgeConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    api: JudgeLlmSchema,
    /** 消息池容量(每个会话) */
    messagePoolCapacity: z.number().int().positive().default(60),
    /** 每次判断喂给判断模型的消息条数 */
    judgeWindow: z.number().int().positive().default(12),
    /** 每积累 N 条新消息触发一次判断 */
    judgeEveryN: z.number().int().positive().default(4),
    /** 两次判断之间的最小间隔, 防止刷屏时烧 token */
    judgeIntervalMs: z.number().int().min(0).default(5_000),
    /** 判断模型给出的置信度 >= 该值才唤醒大模型 */
    replyThreshold: z.number().min(0).max(1).default(0.6),
    /** 两次主动回复之间的冷却 */
    replyCooldownMs: z.number().int().min(0).default(20_000),
    minMessages: z.number().int().positive().default(2),
    /** 没有配置判断模型时, 启发式判断的随机开口概率 */
    autoReplyProbability: z.number().min(0).max(1).default(0.25),
  })
  .default({});

const EmbeddingApiSchema = z
  .object({
    baseURL: z.string().default(''),
    apiKey: z.string().default(''),
    model: z.string().default(''),
    dimensions: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().default(30_000),
  })
  .default({});

const EmbeddingConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    api: EmbeddingApiSchema,
  })
  .default({});

const MemoryTtlSchema = z
  .object({
    fact: z.number().int().positive().default(180),
    preference: z.number().int().positive().default(60),
    relationship: z.number().int().positive().default(90),
    plan: z.number().int().positive().default(2),
    event: z.number().int().positive().default(7),
    unknown: z.number().int().positive().default(30),
  })
  .default({});

const MemoryWeightsSchema = z
  .object({
    relevance: z.number().min(0).max(1).default(0.5),
    importance: z.number().min(0).max(1).default(0.25),
    recency: z.number().min(0).max(1).default(0.25),
  })
  .default({});

const MemoryConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    topK: z.number().int().positive().default(5),
    minScore: z.number().min(0).max(1).default(0.34),
    /** 每日新鲜度衰减率(参考 LivingMemory 的 importance_decay.decay_rate) */
    decayRate: z.number().min(0).default(0.01),
    /** 每被访问一次, 衰减率打折的比例 */
    accessResistance: z.number().min(0).max(1).default(0.5),
    /** 访问次数带来的最终分数加成(每次, 有上限) */
    accessBoost: z.number().min(0).default(0.04),
    weights: MemoryWeightsSchema,
    /** weighted = 分数级融合, rrf = 排名级融合 */
    fusion: z.enum(['weighted', 'rrf']).default('weighted'),
    rrfK: z.number().int().positive().default(60),
    /** 各类型记忆的存活天数 */
    ttlDays: MemoryTtlSchema,
    /** 生命力低于该阈值的记忆进入归档 */
    archiveThreshold: z.number().min(0).max(1).default(0.05),
    /** 新增记忆与已有记忆相似度超过该值时合并 */
    mergeThreshold: z.number().min(0).max(1).default(0.85),
    /** 是否用 LLM 从对话里自动抽取记忆 */
    autoExtract: z
      .object({
        enabled: z.boolean().default(false),
        /** 每积累多少条对话触发一次 */
        everyNTurns: z.number().int().positive().default(10),
        minImportance: z.number().min(0).max(1).default(0.4),
        maxPerRun: z.number().int().positive().default(5),
      })
      .default({}),
  })
  .default({});

const InjectConfigSchema = z
  .object({
    base: z.boolean().default(true),
    persona: z.boolean().default(true),
    samples: z.boolean().default(true),
    memory: z.boolean().default(false),
    behavior: z.boolean().default(true),
    history: z.boolean().default(true),
  })
  .default({});

const PromptConfigSchema = z
  .object({
    base: z.string().default(DEFAULT_BASE_PROMPT),
    inject: InjectConfigSchema,
    /** 注入的历史消息条数 */
    historyLimit: z.number().int().positive().default(20),
    /** 注入的 few-shot 条数 */
    sampleLimit: z.number().int().positive().default(4),
    /** prompt 字符预算, 超出时从最旧的历史开始裁剪 */
    maxPromptChars: z.number().int().positive().default(12_000),
  })
  .default({});

const BehaviorConfigSchema = z
  .object({
    allowGroupManage: z.boolean().default(true),
    allowFileSend: z.boolean().default(false),
    allowSendImage: z.boolean().default(true),
    allowRecall: z.boolean().default(false),
    allowPoke: z.boolean().default(true),
    /** 普通群友能否间接触发 execution(非管理员) */
    allowUserActions: z.boolean().default(false),
    admins: z.array(z.string()).default([]),
    /** 屏蔽 OpenClaw 原生指令, 避免暴露 */
    blockedCommands: z
      .array(z.string())
      .default(['/status', '/reset', '/new', '/help', '/model', '/compact', '/agents']),
  })
  .default({});

const LogConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    file: z.string().default(''),
    bufferSize: z.number().int().positive().default(500),
  })
  .default({});

const ArchiveConfigSchema = z
  .object({
    /** sqlite = 结构化存储 + FTS5 全文检索; jsonl = 旧的追加式存档 */
    driver: z.enum(['sqlite', 'jsonl']).default('sqlite'),
    /** 数据库文件路径, 留空则用 <dataDir>/pasc.db */
    path: z.string().default(''),
    /** 单次导入的文件大小上限(MB) */
    maxImportMb: z.number().int().positive().default(200),
  })
  .default({});

const ExtractionConfigSchema = z
  .object({
    /** 提问与回答之间允许的最大时间间隔 */
    windowMs: z.number().int().positive().default(180_000),
    /** 同一个人连续发言多少毫秒内合并成一条(模拟连珠炮) */
    mergeGapMs: z.number().int().positive().default(15_000),
    /** 答案少于多少字符就丢弃(过滤"嗯""好"这类) */
    minAnswerChars: z.number().int().positive().default(2),
    /** 一次最多产出多少条 Q/A */
    maxPairs: z.number().int().positive().default(60),
    /** 是否也提取"目标用户 @ 别人、别人回答"的反向对 */
    includeTargetAsks: z.boolean().default(false),
  })
  .default({});

const DistillConfigSchema = z
  .object({
    /** 提取模型: 用来把聊天记录提炼成人格描述 */
    api: LlmBaseSchema.extend({
      baseURL: z.string().default(''),
      model: z.string().default(''),
      temperature: z.number().min(0).max(2).default(0.4),
      maxTokens: z.number().int().positive().default(900),
      // 本地 9B 写 400 字人设很容易超过 30 秒, 默认给足
      timeoutMs: z.number().int().positive().default(120_000),
    }).default({}),
    /** 喂给提取模型的最大样本条数 */
    maxSamples: z.number().int().positive().default(40),
    /** 喂给提取模型的最大字符数 */
    maxChars: z.number().int().positive().default(9_000),
  })
  .default({});

const PipelineConfigSchema = z
  .object({
    /** mention = 只回应 @; auto = 只靠判断模型; both = 两者并行 */
    replyMode: z.enum(['mention', 'auto', 'both']).default('both'),
    triggerKeywords: z.array(z.string()).default([]),
    /** 回复时是否引用原消息 */
    quoteReply: z.boolean().default(false),
    /** 拟人化延迟区间(毫秒), 让回复看起来像人打的 */
    humanizeDelayMs: z.tuple([z.number().int().min(0), z.number().int().min(0)]).default([400, 1_200]),
    /** 同一条消息的重复投递去重窗口 */
    dedupeWindowMs: z.number().int().min(0).default(5_000),
    /** 非空时只处理这些群 */
    groupWhitelist: z.array(z.string()).default([]),
    /** 这些用户的消息直接忽略 */
    userBlacklist: z.array(z.string()).default([]),
    /** 是否处理私聊 */
    handlePrivate: z.boolean().default(true),
  })
  .default({});

export const PascConfigSchema = z
  .object({
    server: ServerConfigSchema,
    napcat: NapCatConfigSchema,
    openclaw: AgentConfigSchema,
    vision: VisionConfigSchema,
    judgeModel: JudgeConfigSchema,
    embedding: EmbeddingConfigSchema,
    memory: MemoryConfigSchema,
    prompt: PromptConfigSchema,
    behavior: BehaviorConfigSchema,
    log: LogConfigSchema,
    pipeline: PipelineConfigSchema,
    archive: ArchiveConfigSchema,
    extraction: ExtractionConfigSchema,
    distill: DistillConfigSchema,
  })
  .default({});

export type PascConfig = z.infer<typeof PascConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type NapCatConfig = z.infer<typeof NapCatConfigSchema>;
export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;
export type VisionConfig = z.infer<typeof VisionConfigSchema>;
export type BehaviorConfig = z.infer<typeof BehaviorConfigSchema>;
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
export type ExtractionConfig = z.infer<typeof ExtractionConfigSchema>;
export type ArchiveConfig = z.infer<typeof ArchiveConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;
export type DistillConfig = z.infer<typeof DistillConfigSchema>;
export type PromptConfig = z.infer<typeof PromptConfigSchema>;

/** 只填了默认值的完整配置, 作为 deepMerge 的基底 */
export const DEFAULT_CONFIG: PascConfig = PascConfigSchema.parse({});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 递归合并: 用户配置覆盖默认值, 数组整体替换 */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const prev = (base as Record<string, unknown>)[key];
    out[key] = isPlainObject(prev) && isPlainObject(value) ? deepMerge(prev, value) : value;
  }
  return out as T;
}

/** 把任意输入(部分配置/旧配置)补齐 + 校验成完整配置, 失败时抛出 readable 错误 */
export function normalizeConfig(input: unknown): PascConfig {
  const merged = deepMerge(DEFAULT_CONFIG, input ?? {});
  const result = PascConfigSchema.safeParse(merged);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`配置校验失败:\n${detail}`);
  }
  return result.data;
}
