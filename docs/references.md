# 参考项目与取舍

两个项目都是"参考设计、不复用代码"。许可证分别是 **GPL-3.0** 与 **AGPL-3.0**，
本项目为独立实现（MIT 风格的私有工程），只对齐**格式与思路**，不引入其源码。

- [shuakami/qq-chat-exporter](https://github.com/shuakami/qq-chat-exporter) — 5963 ★，Rust + Electron
- [lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory](https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory) — 408 ★，Python

---

## 一、从 qq-chat-exporter 学到的

### 1. 导出格式（只做导入兼容）

QCE 的 JSON 结构（取自 `qq-chat-export-core/src/types.rs` 的公开字段）：

```jsonc
{
  "metadata": { "name": "QQChatExporter", "version": "4.x" },
  "chatInfo": { "name", "type": "group|private|temp", "peerUin", "selfUin", "participantCount" },
  "messages": [
    {
      "id": "…", "seq": "1", "timestamp": 1700000000000, "time": "2023-11-15 06:13:20",
      "sender": { "uid", "uin", "name", "nickname", "groupCard", "remark", "title" },
      "type": "type_1",
      "content": {
        "text": "…",
        "elements": [ { "type": "text|image|at|face|reply|file|…", "data": { } } ],
        "resources": [ { "type", "url", "localPath", "fileName" } ],
        "mentions": [ { "uid", "name", "type": "user|all" } ]
      },
      "recalled": false,
      "system": false
    }
  ]
}
```

PASC 的 `qce-import.ts` 按这份结构做映射，并且做了三件 QCE 不关心、但中间件必须做的事：

1. **会话归属**：QCE 不一定在 `chatInfo` 里带群号，所以支持用 `groupId` / `sceneKey` 覆盖；
2. **自己 vs 别人**：用 `chatInfo.selfUin` 标出 `isSelf`，否则导入后会把机器人自己当成群友；
3. **系统消息**：默认丢弃 `system: true` 和已撤回的消息，避免污染人格样本。

### 2. 存储分层

QCE 把"原始消息"和"导出产物"分开，还维护独立的资源索引。PASC 对应地：

- `messages` 表存结构化字段（不是塞一个 JSON blob），索引建在 `(scene_key, timestamp)` 与 `(sender_id, timestamp)`；
- `messages_fts` 单独做全文索引，用外部内容表 + 触发器同步；
- `source` 字段区分 `live` / `bot` / `qce` / `migrated`，出问题能只回滚某一类。

### 3. 没有照搬的部分

| QCE 能力 | PASC 是否需要 | 原因 |
|---|---|---|
| HTML / Excel 导出、现代化查看器 | 否 | 我们是中间件，不做阅读器 |
| 图片/表情资源下载与去重 | 暂缓 | 需要 CDN 拉取与磁盘管理，里程碑 4 |
| 定时导出、多账号 | 否 | 不是同一类产品 |
| 直接读 QQ NT 本地数据库 | 否 | 我们走 NapCat 事件流；冷启动靠导入 QCE |

---

## 二、从 LivingMemory 学到的

LivingMemory 的架构文档把"记忆"拆得很清楚，PASC 借了其中四件事：

### 1. 双路召回 + 融合

- 文档路：BM25（jieba 分词）+ 向量（FAISS）
- 融合：候选扩展 → 分数级/排名级融合 → 加权（相关性/重要性/时间）→ MMR → top_k

PASC 的实现（`memory-engine.ts`）保留了骨架，换掉了重型依赖：

| LivingMemory | PASC |
|---|---|
| FAISS 向量库 | 内存数组 + 余弦（几千条以内够用；上万条再上 HNSW） |
| jieba 分词 BM25 | 字符 n-gram 相似度 + SQLite FTS5（trigram） |
| BM25 + 向量 分数归一化 | `weighted`（min-max 后 0.5/0.5）或 `rrf`（k=60） |
| 相关性/重要性/时间三权 | 同构，默认 `0.5/0.25/0.25` |

### 2. 记忆生命周期

LivingMemory：`importance` 每日按 `decay_rate`（0.01）衰减；窗口内被访问的记忆降低有效衰减率；
原子有类型化 TTL（事件 7 天、计划 2 天、事实 180 天、关系 90 天、偏好 60 天、未知 30 天）。

PASC 直接采用了这套参数与公式：

```
有效衰减率 = decayRate / (1 + accessCount × accessResistance)
新鲜度     = exp(-有效衰减率 × 距上次访问天数)
生命力     = importance × 新鲜度        // 低于 archiveThreshold 就归档
```

### 3. 归档而非删除

LivingMemory 的状态机是 `active / dormant / superseded / expired / forgotten`。
PASC 简化为 `active / archived / forgotten`，但保留"可恢复"这个关键性质 —— 记忆判断错了不该直接丢数据。

### 4. 轮次触发的自动整理

LivingMemory 在"未总结轮次达到阈值（默认 10）"后触发后台总结，并且会按跨天/长空闲切分窗口。
PASC 用同样的阈值语义（`memory.autoExtract.everyNTurns`），但触发点挂在"机器人每条回复"上，
抽取窗口取最近 40 条消息 —— 对群聊场景足够，实现也简单得多。

### 5. 没有照搬的部分

| LivingMemory 能力 | PASC 的选择 | 原因 |
|---|---|---|
| 图谱（实体-关系，3D 可视化） | 暂缓 | 群聊场景下"谁和谁什么关系"用 `relationship` 类型记忆就能表达 |
| 原子化事实（memory_atoms + TTL 状态机） | 暂缓 | 会显著增加复杂度，先看类型化记忆够不够用 |
| FAISS / 影子索引重建 | 不用 | 数据量级差两个数量级 |
| 会话修订号 + 回滚对账 | 不用 | PASC 不接管宿主对话历史，没有回滚概念 |
| 多作用域（legacy/session/user/global） | 简化为 `sceneKey` + `personaId` | 中间件只服务一个 QQ 账号 |

---

## 三、结论

两个项目解决的是"数据的进出两端"：

- QCE 让**历史数据进得来**（冷启动人格提纯的数据源）；
- LivingMemory 让**记忆用得上**（召回质量与生命周期管理）。

PASC 处在两者之间，负责把"进得来的数据"变成"用得上的 Prompt"。所以只取这两头里
与"筛选 / 构建 / 注入"直接相关的设计，其余一律不做 —— 这也是这个项目一开始的定位。
