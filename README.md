# PASC · 人格模拟智能体桥接器

**P**ersonality-**A**gent-**S**imulator & **C**onnector —— 夹在 **NapCat(QQ)** 和 **OpenClaw(Agent)** 之间的一层中间件。

它的本质是 **筛选器 + 提示词构建器**：

- 群里的每条消息**不一定**都要送给大模型 —— 先用消息池攒一攒，再用小模型（或启发式规则）判断"现在值不值得开口"；
- 真到要开口时，把 **基础提示词 + 人格 + few-shot 样本 + 记忆 + 行为权限** 拼成一份完整 Prompt；
- Agent 回来后不是丢一段散文，而是结构化 JSON：`{ message, execution }`，中间件解析后替它去调 NapCat 的 QQ 接口（发图、发文件、禁言……）。

目标是省钱、省 token，同时让机器人**像人**：会沉默、会挑话头、说话短。

---

## 当前进度

首个里程碑 **端到端最小闭环** 已完成并可运行：

```
NapCat WS 事件 → 过滤 → 消息池 → 判断(小模型/启发式) → Prompt 构建 → Agent → JSON 解析 → 发回 QQ / 执行动作 → 存档
```

| 模块 | 状态 | 说明 |
|---|---|---|
| 消息池 + 主动回复判断 | ✅ | 滑动窗口、按 N 条/间隔节流、置信度阈值、回复冷却、同会话串行 |
| Prompt 构建器 | ✅ | 五类元素按开关注入；超预算时按 历史 → 记忆 → 行为 → 样本 → 人格 顺序裁剪 |
| JSON 标签体系 | ✅ | `message` / `messages` / `execution[]`；容错解析（代码块、前后废话、纯文本兜底） |
| 动作权限闸门 | ✅ | 6 种动作，按 `behavior.*` 开关 + 管理员身份双重校验 |
| NapCat 通道 | ✅ | 正向 WS（含断线重连）+ HTTP API（含 WS 失败降级）+ HTTP 事件上报 |
| Agent 传输层 | ✅ | `mock` / `http` / `gateway`；gateway 已按 OpenClaw 真实协议接通（protocol 4） |
| 聊天记录管理器 | ✅ | SQLite + FTS5(trigram) 全文检索、按会话/用户/时间筛选、统计；支持导入 qq-chat-exporter 导出 |
| 记忆引擎 | ✅ | 类型化记忆、重要性/衰减/访问强化、关键词+向量双路召回、自动抽取、归档与恢复 |
| 人格提纯 + Q/A 自动截取 | ✅ | 规则配对（回复/@/相邻）→ 去重打分 → 模型或统计生成人设 → 导出 txt/JSON、一键导入样本 |
| 人格 / few-shot | ✅ | 存取与注入已通 |
| Web 控制台 | ✅ | 单文件零构建：概览（SSE 实时流）/ 会话（头像 + 动作流水）/ 人格 / 记忆 / 提纯 / 设置；深色浅色双主题 |
| 记忆的 Embedding 检索 | 🟡 | 已实现 OpenAI 兼容 `/embeddings` 双路召回；未配置模型时自动退化为关键词 |
| 群管理 / 发图 / 发文件 | ✅ | 动作已接通 NapCat，需在配置里开权限 |

---

## 快速开始（不需要 QQ，也不需要模型 API）

```bash
pnpm install
pnpm doctor          # 环境自检: Node / SQLite / 端口 / NapCat / 模型端点 / 存档

# 终端 A: 一个假的 NapCat(扮演 QQ 服务端, 会按剧本推消息)
pnpm --filter @pasc/fake-napcat start

# 终端 B: PASC
pnpm --filter @pasc/server start
```

打开 <http://127.0.0.1:7788> 就是控制台。假 NapCat 连上后会自动走一段剧本：

```
[QQ → PASC] 老陈: 今天有人试过那个新的推理框架吗
[QQ → PASC] 阿琳: 没有诶, 好用吗
[QQ → PASC] 老陈: 据说挺快的, 就是文档稀烂
[QQ → PASC] 测试用户: 这个报错怎么解决啊, 一直说 module not found
[QQ ← PASC] 群123456  这个我大概知道一点, 不过不确定, 你可以先试试看
[QQ → PASC] 测试用户: @我 发张图
[QQ ← PASC] 群123456  行, 给你一张
[QQ ← PASC] 群123456  [图片](https://picsum.photos/seed/pasc/600/400)
```

注意前 3 条闲聊**没有**触发任何模型调用 —— 这就是"经济化"的意思。

也可以不连 NapCat，直接在控制台"模拟一条消息"，或：

```bash
curl -X POST http://127.0.0.1:7788/api/simulate \
  -H 'content-type: application/json' \
  -d '{"text":"这个报错怎么解决啊","groupId":"123456"}'
```

---

## 接入准备（真实环境）

装好 NapCat 和 OpenClaw 之后，真正容易卡住的不是主流程，而是"哪一环没起来"。所以准备了三件小工具：

### 1. `pnpm doctor` —— 一条命令体检

```
  ✓ Node 版本            v22.22.3 (darwin/arm64)
  ✓ SQLite (node:sqlite) 可用
  ✓ 数据目录               …/pasc/data
  ✓ 配置文件               …/pasc/data/config.json (已加载)
  ✓ PASC 端口             127.0.0.1:7788 已被 PASC 占用(说明服务在跑)
  ✓ NapCat WebSocket      已连接 ws://127.0.0.1:3001
  ! 模型端点               没有探测到可用模型
    → 启动 Ollama / LM Studio 后重试
  ✓ 聊天记录库              157 条消息 · 0.1 MB
  ! 人格 markdown         未配置 openclaw.personaFile
```

NapCat 的检查只做一次 WebSocket 握手（不引入 `ws` 依赖），失败时会给出"连不上 / 握手被拒 / 超时"这三种可区分的结论。

### 2. 模型探测 —— 不用对着文档猜端口

控制台「配置 → 模型探测」，或：

```bash
curl http://127.0.0.1:7788/api/models/probe
```

会并行试 `11434`(Ollama) / `1234`(LM Studio) / `8000`(vLLM) / `8080`，加上配置里已填的地址，返回每个端点有哪些模型，并给出"哪个当判断模型、哪个当提取模型"的建议。点一下就把配置写好并热生效。

### 3. 人格双轨 —— 避免"套娃人格"

这是接入真实 OpenClaw 时最容易踩的坑：**PASC 注入一遍人格，OpenClaw 自己又注入一遍**，模型收到两套人设，说话就会精分。

三种姿态，按你的 OpenClaw 现状选：

| 姿态 | 配置 | 适用 |
|---|---|---|
| A. PASC 注入（默认） | `prompt.inject.persona=true` | OpenClaw 是个"干净"的通用 agent |
| B. 交给 OpenClaw | `prompt.inject.persona=false` + 导出人格 markdown | OpenClaw 已有高度定制的人格（推荐给已有环境的用户） |
| C. 混合 | PASC 只注入 few-shot / 记忆，人设归 OpenClaw | 想让"说话风格"和"人设"分开维护 |

B/C 需要把提纯结果写进 OpenClaw 能读的 markdown —— 这正是需求文档 §8.1 的建议：

```bash
curl -X POST http://127.0.0.1:7788/api/personas/<id>/export \
  -H 'content-type: application/json' -d '{"path":"/path/to/openclaw/persona.md"}'
```

配置 `openclaw.personaFile` 后，每次保存当前人格都会自动同步一份过去。

### 多 Agent 路由

OpenClaw 可以挂多个子 agent（每个一套人格）。用 `openclaw.agentId` 指定投递给谁，中间件会把它塞进请求的 `meta.agentId` 与 gateway 的 `params.agentId`：

```json
{ "openclaw": { "agentId": "group-helper", "personaFile": "/path/to/openclaw/persona.md" } }
```


---

## 接真实 NapCat

1. 在 NapCat 里开启 **WebSocket 服务端**（正向 WS，默认 `ws://127.0.0.1:3001`），填好 token。
2. 改 `data/config.json`：

```json
{
  "napcat": {
    "protocol": "ws",
    "address": "ws://127.0.0.1:3001",
    "httpAddress": "http://127.0.0.1:3000",
    "accessToken": "你的token",
    "selfId": "机器人QQ号"
  }
}
```

3. 重启 PASC。控制台顶部的 NapCat 指示灯变绿即可。

> **HTTP 模式**：把 `protocol` 改成 `http`，并在 NapCat 里把事件上报地址配成
> `http://<PASC地址>:7788/napcat/event`。这样事件走 webhook、指令走 HTTP API。
> WS 模式下如果 WS 调用失败，也会自动降级到 `httpAddress`。

---

## 接 OpenClaw / 任意 Agent

`openclaw.transport` 三选一：

| 值 | 适用场景 | 说明 |
|---|---|---|
| `mock` | 没接真 Agent 时跑通链路、写测试 | 规则化假回复 |
| `http` | 自建 Agent 服务，或任意 OpenAI 兼容端点 | `{system,user,meta}` 或 `{model,messages}` |
| `gateway` | **OpenClaw 官方 Gateway**（已实测接通） | WS 协议 v4：`connect` 握手 + `chat.send` + `chat` 事件流 |

### 接 OpenClaw（实测可用）

```json
{
  "openclaw": {
    "transport": "gateway",
    "address": "ws://127.0.0.1:18789",
    "token": "<~/.openclaw/openclaw.json 里的 gateway.auth.token>",
    "agentId": "main",
    "sessionPrefix": "pasc",
    "systemMode": "inline",
    "timeoutMs": 60000
  }
}
```

用 `openclaw gateway --port 18789` 起网关，token 在 `~/.openclaw/openclaw.json` 的
`gateway.auth.token`。完整的握手字段、事件流、三个必踩的坑都记在
[openclaw-integration.md](docs/openclaw-integration.md)，这里只列结论：

1. **首帧必须是 `connect`**，且 `client.id` / `client.mode` 是枚举校验（用 `gateway-client` + `backend`）；
2. **指定 `agentId` 时 sessionKey 必须写成 `agent:<id>:<key>`**，否则报 `agentId does not match session key`；
3. **agentId 必须真实存在**，先用 `agents.list` 查（默认是 `main`）。

### 思考型模型

本地 Qwen3 这类模型会把思维链写进正文。PASC 默认 `enableThinking: "auto"`：
**只对本机端点**发 `enable_thinking: false`，云端不发（避免 400）。
实测判断从 13.7s 降到 8.8s，提纯从超时降到 22s，输出也不再带 `Thinking Process:`。


---

## 人格提纯与样本提取（模块三）

控制台「人格提纯」页，或直接用 API。

**流程**：选会话 → 选目标用户 → 提取 Q/A → 生成人格 → 保存/导入/导出

```bash
# 1. 看某个群里有哪些人
curl "http://127.0.0.1:7788/api/users?sceneKey=group:123456"

# 2. 提取这个人的问答片段（按质量打分并去重）
curl "http://127.0.0.1:7788/api/extract/qas?senderId=20001&sceneKey=group:123456&limit=20"

# 3. 生成人格：配了提取模型就用模型，没配就退回统计草稿
curl -X POST http://127.0.0.1:7788/api/extract/distill \
  -H 'content-type: application/json' \
  -d '{"senderId":"20001","sceneKey":"group:123456","save":true}'

# 4. 把片段导入 few-shot 样本库
curl -X POST http://127.0.0.1:7788/api/extract/import \
  -H 'content-type: application/json' \
  -d '{"senderId":"20001","sceneKey":"group:123456","limit":10}'

# 5. 导出 txt / json
curl -OJ "http://127.0.0.1:7788/api/extract/export?senderId=20001&sceneKey=group:123456&format=txt"
```

**配对规则**（`packages/core/src/extractor.ts`）：

| 优先级 | 依据 | 说明 |
|---|---|---|
| 1 | `reply` 段 | 目标用户显式回复了某条消息 → 精准配对 |
| 2 | `at` | 目标用户 @ 了某人 → 取那个人刚才的发言 |
| 3 | 时间相邻 | 兜底：取最近一条别人的发言（默认 180 秒内） |

其余细节：

- **连发合并**：同一人 15 秒内的多条消息合并成一段回答（更像人）。
- **噪声过滤**：纯 `[图片]`/`[表情]`、长度不足的回答直接丢弃。
- **机器人发言不参与配对**：否则会把中间件自己的接话当成"提问"。
- **去重**：同一问题得到同一回答只保留分数最高的一条。
- **反向提取**：勾选后还会抽取"目标提问、别人回答"的片段（用于理解 ta 关心什么）。

**两种提纯方式**：

| 方式 | 触发条件 | 输出 |
|---|---|---|
| 模型提纯 | `distill.api.baseURL` + `model` 已配置 | 400 字以内的结构化人设（性格/说话习惯/口头禅/禁忌） |
| 统计草稿 | 未配置或调用失败 | 平均句长、提问率、语气词、反复出现的说法、参考短句 |

统计草稿不能代替人写，但它把"翻几百条聊天记录"变成"改一份草稿"。


---

## 聊天记录：SQLite + 导入

存档从 JSONL 升级成 SQLite（`data/pasc.db`），老的 `messages.jsonl` 会在首次启动时自动迁移并改名留档。

- **表结构**：`messages` 存结构化字段，`messages_fts` 是 FTS5 外部内容表，触发器自动同步。
- **中文检索**：用 FTS5 的 `trigram` 分词器 —— 默认的 `unicode61` 会把整句中文当成一个词，而 trigram 支持任意子串匹配，不需要额外装分词器。
- **去重**：`UNIQUE(scene_key, id)`，重复投递、重复导入都会被忽略。
- **来源标记**：`source` 字段区分 `live`（实时抓取）/ `bot`（机器人自己）/ `qce`（导入）/ `migrated`。

### 导入 qq-chat-exporter 的导出

参考 [shuakami/qq-chat-exporter](https://github.com/shuakami/qq-chat-exporter) 的 JSON 结构做了兼容（只对齐格式，没有使用它的代码 —— 上游是 GPL-3.0）。

控制台「聊天记录」页填本地路径即可，或：

```bash
curl -X POST http://127.0.0.1:7788/api/import/qce \
  -H 'content-type: application/json' \
  -d '{"filePath":"/Users/you/Downloads/群聊导出.json","dryRun":true}'   # 先试运行看条数
```

支持：

| 输入 | 说明 |
|---|---|
| `.json`（完整导出） | `{ chatInfo, messages: [...] }`，也容忍裸数组 / `data.messages` |
| `.jsonl`（分块导出） | 每行一条消息，或每行一个带 `messages` 的块 |
| 字段 | `sender.uin/uid/name/groupCard`、`content.text/elements/mentions`、`timestamp`(毫秒或秒)、`recalled`/`system` |

如果导出里没有群号，可以用 `groupId` 覆盖；也可以直接给 `sceneKey` 把多次导入归到同一个会话。

导入后这条数据链就通了：**导入历史 → 按用户提纯人格 → 生成 few-shot → 注入 Prompt**。

---

## 记忆系统

参考 [lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory) 的思路，按 PASC 的"轻量中间件"定位做了裁剪：

| 能力 | PASC 的实现 |
|---|---|
| 类型化记忆 | `fact` / `preference` / `relationship` / `plan` / `event` / `unknown` |
| 生命周期 | 每种类型有 TTL（计划 2 天、事件 7 天、偏好 60 天、关系 90 天、事实 180 天） |
| 衰减 | 新鲜度 = `exp(-有效衰减率 × 距上次访问天数)` |
| 访问强化 | 每访问一次衰减率打折，且最终分数有加成（有上限） |
| 双路召回 | 关键词（字符 n-gram）+ 向量（OpenAI 兼容 `/embeddings`），支持 `weighted` / `rrf` 两种融合 |
| 综合打分 | `w_rel×相关性 + w_imp×重要性 + w_rec×新鲜度`，再乘访问加成 |
| 去重合并 | 相似度超过 `mergeThreshold` 的记忆合并（取更长的表述、更高的重要性） |
| 归档而非删除 | 到期或生命力过低的记忆进入 `archived`，可恢复 |
| 自动整理 | 每 `everyNTurns` 轮对话调一次提取模型，把对话整理成几条记忆 |

**与 OpenClaw 自带记忆的分工**：PASC 只管"群内事实 → 注入 Prompt"这一小段，不做全量记忆推理。`memory.enabled` 默认关闭，打开后才会召回和注入。

### 配置

```json
{
  "memory": {
    "enabled": true,
    "topK": 5,
    "minScore": 0.34,
    "decayRate": 0.01,
    "autoExtract": { "enabled": true, "everyNTurns": 10, "minImportance": 0.4 }
  },
  "embedding": {
    "enabled": true,
    "api": {
      "baseURL": "https://api.siliconflow.cn/v1",
      "apiKey": "sk-...",
      "model": "BAAI/bge-m3",
      "dimensions": 1024
    }
  },
  "prompt": { "inject": { "memory": true } }
}
```

不配 Embedding 也能用，只是召回质量会差一些（关键词兜底）。

### 调试

控制台「记忆」页可以：检索（看 score / 关键词分 / 向量分 / 新鲜度）、手动添加、执行衰减、从最近对话抽取。

```bash
curl "http://127.0.0.1:7788/api/memory/search?q=阿琳的猫&topK=5"
curl -X POST http://127.0.0.1:7788/api/memory/decay
curl -X POST http://127.0.0.1:7788/api/memory/extract \
  -H 'content-type: application/json' -d '{"sceneKey":"group:888999"}'
```


---

## 配置说明

配置文件在 `data/config.json`（首次启动自动生成完整默认值），控制台的「配置」页可以直接改、保存即热生效。

> 命名约定：需求文档里写的是 `judge_model.message_pool_capacity` 这种点分下划线，代码里统一成 camelCase（`judgeModel.messagePoolCapacity`）。

### 连接

| 字段 | 默认 | 说明 |
|---|---|---|
| `server.host` / `server.port` | `127.0.0.1` / `7788` | 控制台与 API 监听地址 |
| `server.accessToken` | `""` | 非空时 `/api/*` 需要 `Authorization: Bearer <token>` |
| `napcat.protocol` | `ws` | `ws`（正向 WebSocket）或 `http`（HTTP API + webhook） |
| `napcat.address` | `ws://127.0.0.1:3001` | WS 地址 |
| `napcat.httpAddress` | `http://127.0.0.1:3000` | HTTP API 地址（也做 WS 失败兜底） |
| `napcat.accessToken` | `""` | NapCat 的 access token |
| `napcat.selfId` | `""` | 机器人 QQ；留空会从事件的 `self_id` 自动学习 |
| `napcat.reconnect.*` | 开 / 1s / 30s | 断线重连的指数退避 |

### 判断模型（省钱的核心）

| 字段 | 默认 | 说明 |
|---|---|---|
| `judgeModel.enabled` | `true` | 关掉后只保留 @ 与关键词触发 |
| `judgeModel.api.baseURL` | `""` | **留空 = 走启发式**，不产生任何网络请求 |
| `judgeModel.api.model` | `""` | 例如 `qwen2.5:7b-instruct`、`deepseek-chat` |
| `judgeModel.messagePoolCapacity` | `60` | 每个会话的上下文窗口（改完需重启） |
| `judgeModel.judgeWindow` | `12` | 每次交给判断模型的消息条数 |
| `judgeModel.judgeEveryN` | `4` | 每积累 N 条新消息才判断一次 |
| `judgeModel.judgeIntervalMs` | `5000` | 两次判断的最小间隔 |
| `judgeModel.replyThreshold` | `0.6` | 判断置信度 ≥ 此值才唤醒大模型 |
| `judgeModel.replyCooldownMs` | `20000` | 两次主动回复的冷却 |
| `judgeModel.autoReplyProbability` | `0.25` | 无模型时，闲聊被随机接话的概率 |

### Prompt

| 字段 | 默认 | 说明 |
|---|---|---|
| `prompt.base` | 内置框架提示词 | 基础约束：像人 / 只吐 JSON / 不暴露身份 |
| `prompt.inject.base` | `true` | 是否注入基础提示词 |
| `prompt.inject.persona` | `true` | 是否注入人格 |
| `prompt.inject.samples` | `true` | 是否注入 few-shot |
| `prompt.inject.memory` | `false` | 是否注入记忆 |
| `prompt.inject.behavior` | `true` | 是否注入"可用动作"说明 |
| `prompt.inject.history` | `true` | 是否注入聊天历史 |
| `prompt.historyLimit` | `20` | 注入多少条历史 |
| `prompt.sampleLimit` | `4` | 注入多少条样本 |
| `prompt.maxPromptChars` | `12000` | 字符预算，超出按优先级裁剪 |

### 行为控制

| 字段 | 默认 | 说明 |
|---|---|---|
| `behavior.allowGroupManage` | `true` | 群管理（禁言/踢人/改名片） |
| `behavior.allowFileSend` | `false` | 发送文件 |
| `behavior.allowSendImage` | `true` | 发送图片 |
| `behavior.allowRecall` | `false` | 撤回消息 |
| `behavior.allowPoke` | `true` | 戳一戳 |
| `behavior.allowUserActions` | `false` | 普通群友能否间接触发高危动作 |
| `behavior.admins` | `[]` | 管理员 QQ 列表 |
| `behavior.blockedCommands` | `/status` 等 | 屏蔽的 OpenClaw 原生指令，命中即不转发 |

### 流水线

| 字段 | 默认 | 说明 |
|---|---|---|
| `pipeline.replyMode` | `both` | `mention` 只回 @ / `auto` 只靠判断 / `both` 两者并行 |
| `pipeline.triggerKeywords` | `[]` | 命中即唤醒的关键词 |
| `pipeline.quoteReply` | `false` | 回复时是否引用原消息 |
| `pipeline.humanizeDelayMs` | `[400,1200]` | 多段回复之间的随机延迟 |
| `pipeline.dedupeWindowMs` | `5000` | 重复投递去重窗口 |
| `pipeline.groupWhitelist` | `[]` | 非空时只处理这些群 |
| `pipeline.userBlacklist` | `[]` | 忽略这些用户 |
| `pipeline.handlePrivate` | `true` | 是否处理私聊 |

### 存档

| 字段 | 默认 | 说明 |
|---|---|---|
| `archive.driver` | `sqlite` | `sqlite` 或 `jsonl`（老实现，兜底用） |
| `archive.path` | `""` | 数据库路径，留空用 `data/pasc.db` |
| `archive.maxImportMb` | `200` | 单次导入文件大小上限 |

### 记忆

| 字段 | 默认 | 说明 |
|---|---|---|
| `memory.enabled` | `false` | 是否启用记忆召回/写入 |
| `memory.topK` / `minScore` | `5` / `0.34` | 召回条数与分数下限 |
| `memory.decayRate` | `0.01` | 每日新鲜度衰减率 |
| `memory.accessResistance` | `0.5` | 每次访问把有效衰减率打折多少 |
| `memory.weights.*` | `0.5/0.25/0.25` | 相关性 / 重要性 / 新鲜度 的权重 |
| `memory.fusion` | `weighted` | `weighted` 分数级融合或 `rrf` 排名级融合 |
| `memory.ttlDays.*` | 见上表 | 各类型记忆的存活天数 |
| `memory.mergeThreshold` | `0.85` | 相似度超过即合并 |
| `memory.autoExtract.enabled` | `false` | 是否每 N 轮自动抽取记忆 |
| `memory.autoExtract.everyNTurns` | `10` | 触发阈值 |
| `embedding.enabled` + `embedding.api.*` | 关 | OpenAI 兼容 Embedding；不配就退化为关键词召回 |

### 提取与提纯

| 字段 | 默认 | 说明 |
|---|---|---|
| `distill.api.baseURL` / `model` | `""` | 提取模型；留空则用统计草稿 |
| `distill.maxSamples` | `40` | 喂给提取模型的问答片段上限 |
| `distill.maxChars` | `9000` | 材料字符预算 |
| `extraction.windowMs` | `180000` | 问答配对的最大时间间隔 |
| `extraction.mergeGapMs` | `15000` | 同人连发的合并间隔 |
| `extraction.minAnswerChars` | `2` | 回答最短长度 |
| `extraction.maxPairs` | `60` | 单次提取上限 |
| `extraction.includeTargetAsks` | `false` | 是否提取反向问答 |

其余：`openclaw.*`（Agent 传输）、`embedding.*`（预留）、`memory.*`（记忆开关与检索参数）、`log.*`（日志级别/文件）。

---

## JSON 标签协议

Agent 的输出必须是一个 JSON 对象（解析器容错：代码块、前后废话、纯文本都能兜住）。

```json
{
  "message": "要发到群里的文本",
  "execution": {
    "action": "send_image",
    "target": "当前会话",
    "params": { "url": "https://example.com/cat.png" }
  }
}
```

`execution` 可以是数组，一次做多个动作；`messages` 数组可以分段连发（更像人连珠炮）。

| 动作 | 权限开关 | 必要参数 |
|---|---|---|
| `send_message` | — | `params.text` |
| `send_image` | `allowSendImage` | `params.url` 或 `params.file` |
| `send_file` | `allowFileSend` | `params.file`（仅群聊） |
| `group_manage` | `allowGroupManage` | `params.op`(ban/kick/set_card) + `userId` |
| `recall` | `allowRecall` | 可选 `messageId`（默认撤回自己上一条） |
| `poke` | `allowPoke` | `params.userId` |

高危动作（`send_file`/`group_manage`/`recall`）还要求触发消息来自 `behavior.admins` 里的管理员，除非显式打开 `behavior.allowUserActions`。

---

## 目录结构

```
pasc/
├── packages/
│   ├── core/          # 领域模型、配置、消息池、判断引擎、Prompt 构建、JSON 协议、存储、记忆引擎、QCE 导入
│   ├── napcat/        # OneBot 事件解析 + WS/HTTP 通道
│   ├── agent/         # AgentTransport 接口 + mock/http/gateway 三种实现
│   ├── server/        # 编排管线、HTTP API、SSE、控制台
│   └── fake-napcat/   # 本地演练器(假 QQ)
├── tests/             # 172 个单测
├── docs/decisions.md  # 关键设计取舍
├── docs/references.md # 参考项目(qq-chat-exporter / LivingMemory)的取舍说明
├── docs/openclaw-integration.md # OpenClaw Gateway 协议实录
└── data/              # 运行时生成: config.json / personas.json / samples.jsonl / messages.jsonl
```

## 开发

```bash
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest, 172 个用例
pnpm dev           # 同时起 server 与 fake-napcat
```

## 安全提示

- 控制台默认只监听 `127.0.0.1`；要暴露到局域网请务必设置 `server.accessToken`。
- `/napcat/event` webhook 在未设 token 时是开放的，公网部署请加 token 或反代鉴权。
- Agent 能做的事完全由 `behavior.*` 决定 —— 宁可先全关，确认链路后再逐个放开。
- 消息会用 JSONL 明文存在 `data/messages.jsonl`，注意隐私与磁盘占用。

## Roadmap

- [x] 人格提纯：从群聊记录自动提炼人格描述（模块三）
- [x] 自动 QA 截取：识别"提问—回答"并导出 `*.txt` few-shot（模块三）
- [x] 聊天记录升级 SQLite + FTS，替代内存窗口
- [x] 记忆模块接 Embedding 检索（双路召回），与 OpenClaw 自带记忆做取舍
- [ ] React 版控制台（现在是无构建单页）
- [ ] 提纯结果对比：同一用户多次提纯的 diff 与回滚
- [ ] 记忆图谱（实体-关系）与可视化
- [ ] QCE 的 HTML/Excel 导出格式与资源文件导入
- [ ] OpenClaw Gateway 真实协议接入
- [ ] 私聊 / 多群人格切换

---

## 许可证

MIT © PASC contributors

用之前请先读一遍 [安全提示](#安全提示)：这个项目会把 QQ 账号的很高权限交给一个语言模型，跑在公开群里之前请务必想清楚。
