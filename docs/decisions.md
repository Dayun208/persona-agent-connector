# 关键设计取舍

对应需求文档第八章「关键设计决策(需开发者注意)」的五条。每条写清楚：**问题 → 选择 → 理由 → 代价 → 以后要改的话改哪**。

---

## 1. OpenClaw 连接方式：插件、管线，还是 HTTP？

**问题**：需求里 `openclaw.connection` 标注"未定"。而这决定了整个中间件是"挂在 OpenClaw 内部的插件"还是"外部的服务"。

**选择**：外部服务 + `AgentTransport` 可插拔接口（`mock` / `http` / `gateway`）。

```ts
interface AgentTransport {
  send(req: { system, user, meta }): Promise<{ text, latencyMs, transport }>;
  health(): Promise<{ ok, detail }>;
}
```

**理由**：
- 需求里 OpenClaw 的接口形态还没定死，先把"PASC 需要什么"抽象出来，比猜协议更稳；
- 三种实现在同一个接口下，切换只改一行配置，管线、Prompt、权限全部不动；
- `mock` 让"没装 QQ、没装 OpenClaw"的环境也能跑通并做 CI。

**代价**：`gateway` 传输目前是按"最小请求/响应信封"猜的，真实联通前不可用。

**以后要改哪**：只改 `packages/agent/src/gateway.ts` 里的 `buildRequest` / `readResponse`。若 OpenClaw 只能以插件形式嵌入，则整个 `packages/server` 可以变成一个插件入口，`core` 与 `napcat` 不用动。

---

## 2. 人格提示词放哪：OpenClaw 的 markdown，还是 PASC 维护？

**问题**：OpenClaw 本身会把 markdown 特征自动送进 LLM 上下文，那还有必要在 PASC 里再维护一份人格吗？

**选择**：**PASC 维护人格库并注入 Prompt**，同时保留"导出去写进 OpenClaw markdown"的可能。

**理由**：
- 人格的**切换与 AB 测试**发生在中间件侧才有意义（今天用 A 人格、明天用 B，按群切换）；
- few-shot、记忆、行为权限必须和人格一起拼装，分散在两个系统里会互相踩踏；
- 人格提纯的产物本来就落在 PASC 的聊天记录库里，写出去再读回来反而绕。

**代价**：同一份人格可能有两处副本（PASC 和 OpenClaw 的 markdown），需要人工保持同步。

**以后的取舍点**：如果实测发现 OpenClaw 的 markdown 注入效果更好，把 `prompt.inject.persona` 关掉、只在其 markdown 里维护即可 —— 开关已经留好了。

---

## 3. 记忆模块：要不要自己做？

**问题**：OpenClaw 自带 embedding，中间件再实现一套记忆是否重复造轮子？

**选择**：**保留存储与检索接口，默认关闭**（`memory.enabled=false`），检索先用字符 n-gram 兜底，Embedding 接口预留。

**理由**：
- 需求的核心是"把高相关的事实/关系塞进 Prompt"，这件事必须在**构建 Prompt 的那一刻**发生；如果让 OpenClaw 自己做，中间件就失去了对 Prompt 的完全控制；
- 但全量记忆推理确实更适合 Agent 侧，所以默认关，避免双份记忆互相矛盾；
- 先做"筛选转发"（`MemoryStore.search` 取 topK），不做"自动沉淀"，那是里程碑 3。

**代价**：默认关闭时，记忆能力等于没有。

**以后的取舍点**：`memory.enabled=true` 后，若发现与 OpenClaw 记忆冲突，可以只让 PASC 管"群内事实"、OpenClaw 管"用户画像"。

---

## 4. 回复机制：@ 与自动检测并存

**选择**：`pipeline.replyMode = mention | auto | both`（默认 `both`），两条路径共用同一套 Prompt 构建与权限校验。

**理由**：
- @ 是强信号，**不花判断模型的 token**（代码里 `source: 'bypass'`）；
- 自动检测是"像人"的关键，但必须有三道闸门：消息池节流（`judgeEveryN` / `judgeIntervalMs`）、置信度阈值（`replyThreshold`）、回复冷却（`replyCooldownMs`）；
- 同一会话的"判断"和"回复"串行执行（`SceneQueue`），不同群并行 —— 既不重复触发，也不互相阻塞。

**代价**：`both` 下如果判断模型过于宽松，可能出现"@ 之后又主动插话"的连续发言；靠冷却时间兜底。

---

## 5. 屏蔽 OpenClaw 原生指令

**选择**：两层屏蔽。
1. **入站**：群友发的 `/status`、`/reset` 等命中 `behavior.blockedCommands` 的消息直接丢弃，不转发给 Agent；
2. **出站**：Agent 回复里如果整条就是这些指令，剥离掉不发送。

**理由**：暴露内部指令既是安全风险也是"人设崩塌"——真人不会回一句 `/status ok`。

**代价**：如果以后确实需要让管理员在群里用指令，需要单开白名单（目前没有）。

---

## 6. 为什么先做"端到端最小闭环"而不是把八大模块铺开

六条痛点里，**省 token** 和 **像人** 是靠"消息池 + 判断 + Prompt 构建"这三件事兑现的；人格提纯、记忆、聊天记录管理都是**增强**。

先把主链路跑通，才能尽早拿到两个关键经验值：
- 判断模型的漏报/误报到底多严重（决定 `judgeEveryN` 与阈值怎么调）；
- 一份完整 Prompt 的实际字符数（决定历史条数与 few-shot 数量）。

这两个数字会反过来决定模块三、四的实现方式，所以不宜先写。

---

## 7. 聊天记录：为什么从 JSONL 换成 SQLite

**问题**：里程碑 1 用 JSONL + 内存窗口跑通了，要不要升级？

**选择**：`node:sqlite` + FTS5（trigram），保留 JSONL 作为降级实现（`archive.driver=jsonl`）。

**理由**：
- 人格提纯的质量直接取决于"能翻多少历史"，内存窗口上限 2 万条且重启即丢；
- 按用户/时间/关键词查询在 SQL 里是一行 WHERE，在 JSONL 里要全量扫；
- 选内置 `node:sqlite` 而不是 `better-sqlite3`，是为了零原生编译 —— 换机器不用重装；
- FTS5 用 `trigram` 而不是默认 `unicode61`：中文没有空格，默认分词会把整句当一个词，trigram 支持任意子串，且不需要额外分词器。

**代价**：
- 启动时有一条 `ExperimentalWarning`（可用 `NODE_OPTIONS=--disable-warning=ExperimentalWarning` 关掉）；
- vite 的内置模块表里没有 `node:sqlite`，所以代码里用 `createRequire` 动态加载；
- SQLite 单写者，批量导入走事务串行执行。

**以后要改哪**：`archive-sqlite.ts` 一个文件；接口 `MessageArchiveLike` 保持稳定。

---

## 8. 为什么支持导入 qq-chat-exporter 的导出

**问题**：机器人刚部署时没有任何历史，人格提纯无从谈起。

**选择**：实现 QCE JSON/JSONL 的导入器（`qce-import.ts`），并在控制台暴露"填本地路径导入"。

**理由**：
- 冷启动是"人格模拟"这类项目的真实瓶颈 —— 没有几千条历史，4 条 few-shot 都挑不出来；
- QCE 是 QQ NT 生态里最成熟的导出工具（5900+ star），兼容它等于兼容一大半用户；
- 只做导入、不做导出，避免把中间件做成第二个导出器。

**代价**：
- 要跟随 QCE 的字段演进（已做兼容：裸数组 / `data.messages` / JSONL 分块 / 秒级时间戳）；
- QCE 是 GPL-3.0，本项目只对齐格式、不复制代码，许可证上互不影响。

**以后要改哪**：`qce-import.ts` 的 `parseMessage` / `elementToSegment`。

---

## 9. 记忆：为什么"自己做"，但只做一小段

**问题**：OpenClaw 自带 embedding 与记忆，PASC 再做一套是不是重复？

**选择**：做"类型化记忆 + 生命周期 + 双路召回"这一小段，默认关闭（`memory.enabled=false`）。

**理由**（参考 LivingMemory 的架构后更确定）：
- 真正影响 Prompt 的是"这一刻召回哪几条"，这件事必须发生在**构建 Prompt 的瞬间**；
- 但全量记忆推理（原子化、图谱、多作用域）是 Agent 侧的活，中间件做会失控；
- 所以只保留：类型 + 重要性 + TTL + 衰减 + 访问强化 + 双路召回 + 归档，共 7 个概念。

**代价**：
- 没有图谱，"谁和谁是什么关系"只能靠 `relationship` 类型的一句话描述；
- 向量存在 JSONL 里，几千条以内没问题，上万条需要换 HNSW；
- 自动抽取依赖 `distill.api`，没配模型时只能手动添加记忆。

**以后要改哪**：`memory-engine.ts` 的 `search()`（融合策略）与 `decay()`（生命周期）。

---

## 10. 人格由谁注入：PASC 还是 OpenClaw

**问题**：需求文档 §8.1 建议把人格写进 OpenClaw 的 markdown；但 PASC 的 Prompt 构建器也要注入人格。
两边都做，模型会收到两套人设；只做 OpenClaw，PASC 又失去了"构建 Prompt"这个核心卖点。

**选择**：做成**双轨可切换**，默认 A，推荐已有 OpenClaw 环境的用户用 B。

| 姿态 | 配置 | 结果 |
|---|---|---|
| A. PASC 注入 | `prompt.inject.persona=true` | PASC 完全掌控 Prompt；OpenClaw 当纯计算通道 |
| B. 交给 OpenClaw | `prompt.inject.persona=false` + 导出 markdown | 人设归 OpenClaw，PASC 只管筛选/样本/记忆 |
| C. 混合 | 关人格、开样本与记忆 | 人设归 OpenClaw，说话风格由 PASC 的 few-shot 调 |

**理由**：
- 用户在 OpenClaw 里已经有"高度定制化的人格"时，A 会和它打架 —— 这是真实接入时最容易踩的坑；
- 但 B 只在 OpenClaw 支持 markdown 人格注入时才成立，不能当默认；
- 所以保留开关 + 提供"导出人格 markdown"这个动作（`POST /api/personas/:id/export`），让人自己选。

**代价**：
- 两套人格如果同时开启，模型输出会漂移；文档里明确写了"三种姿态选一种"；
- B 姿态下 PASC 无法保证人格一致性（它只负责样本与记忆）。

**以后要改哪**：`prompt.inject.persona` 开关；导出动作在 `persona-export.ts`。

---

## 11. 多子 Agent：为什么要 `openclaw.agentId`

**问题**：OpenClaw 可以挂多个子 agent，每个有自己的上下文与人格。中间件如果只发"给默认 agent"，
消息就会投到错误的对象上——表现为"人格对了，但不是我以为的那个"。

**选择**：配置 `openclaw.agentId`，透传到请求的 `meta.agentId` 与 gateway 的 `params.agentId`。

**理由**：
- 这是零成本的路由能力：不改传输协议，只是多带一个字段；
- 未来要"一个群一个子 agent"时，只需把 `agentId` 从全局配置挪到 scene 级配置。

**代价**：目前是全局一个 agent；按群路由还没做（`agentId` 在 meta 里已经留了位置）。

---

## 12. 环境自检：为什么要写 `pnpm doctor`

**问题**：这个项目同时依赖 NapCat、OpenClaw、本地模型三件外部服务。任何一件没起来，
表现都是"机器人不理人"，而日志里未必有线索。

**选择**：一个只读的自检命令，检查 Node/SQLite/端口/NapCat 握手/模型端点/存档/人格文件。

**理由**：
- 排查成本远高于检查成本；一条命令能省掉半小时的"是不是 token 填错了"；
- 只读、不做任何修改，可以放心在"环境很乱"的机器上跑；
- NapCat 探测用一次 HTTP Upgrade 握手，不引 `ws` 依赖（自检工具不该拖运行时依赖）。

**代价**：检查项是硬编码的，新增外部依赖时要同步加检查项。
