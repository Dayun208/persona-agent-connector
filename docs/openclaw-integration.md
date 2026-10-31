# OpenClaw Gateway 接入实录

这份文档记录的是**实测通过的**协议细节，不是推测。环境：

| 项 | 值 |
|---|---|
| OpenClaw | `2026.6.8` |
| 协议版本 | 4 |
| Gateway | `ws://127.0.0.1:18789`（`openclaw gateway --port 18789`） |
| 认证 | `gateway.auth.mode = "token"`，token 在 `~/.openclaw/openclaw.json` |
| Agent | `main`（DeepSeek V4 Flash） |

---

## 1. 握手

### 1.1 服务端先发挑战

```json
{"type":"event","event":"connect.challenge","payload":{"nonce":"a061784e-…","ts":1793463452601}}
```

### 1.2 客户端首发 `connect`

首帧必须是 `connect`，否则会被判 `invalid handshake: first request must be connect`。

```json
{
  "type": "req",
  "id": "pasc-<uuid>",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 4,
    "client": {
      "id": "gateway-client",
      "version": "0.1.0",
      "platform": "darwin",
      "mode": "backend",
      "displayName": "PASC"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "auth": { "token": "<gateway.auth.token>" },
    "locale": "zh-CN",
    "userAgent": "pasc/0.1.0"
  }
}
```

> **坑 1**：`client.id` 和 `client.mode` 是**枚举校验**的，猜错会返回
> `invalid connect params: at /client/id: must be equal to one of the allowed values`。
> 允许值来自 `gateway-protocol/src/schema/frames.d.ts`：
>
> - `client.id`：`openclaw-android | cli | openclaw-control-ui | fingerprint | gateway-client | openclaw-ios | openclaw-macos | node-host | openclaw-probe | test | openclaw-tui | webchat | webchat-ui`
> - `client.mode`：`backend | cli | node | probe | test | ui | webchat`
>
> 第三方桥接用 `gateway-client` + `backend`。

### 1.3 服务端回 `hello-ok`

```json
{
  "type": "res", "id": "pasc-…", "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 4,
    "server": { "version": "2026.6.8", "connId": "a4d9e22f-…" },
    "features": { "methods": ["health", "status", "chat.send", "chat.history", "…"] },
    "auth": { "role": "operator", "scopes": ["operator.read", "operator.write"] },
    "policy": { "maxPayload": 26214400, "tickIntervalMs": 15000 }
  }
}
```

---

## 2. 发消息：`chat.send`

**非阻塞**：立即返回 `{runId, status:"started"}`，回答通过 `chat` 事件流式回来。

```json
{
  "type": "req", "id": "pasc-…", "method": "chat.send",
  "params": {
    "sessionKey": "agent:main:pasc:group:123456",
    "message": "<PASC 构建的完整 Prompt>",
    "idempotencyKey": "<uuid>",
    "deliver": false,
    "timeoutMs": 60000,
    "agentId": "main"
  }
}
```

### 2.1 事件流

```json
{"type":"event","event":"chat","payload":{"runId":"…","seq":1,"state":"delta","deltaText":"等于"}}
{"type":"event","event":"chat","payload":{"runId":"…","seq":2,"state":"delta","deltaText":"2嘛～"}}
{"type":"event","event":"chat","payload":{"runId":"…","seq":3,"state":"final",
  "message":{"role":"assistant","content":[{"type":"text","text":"等于2嘛～"}]}}}
```

- `state=delta` 带 `deltaText`（增量），`state=final` 带完整 `message`；
- `message.content` 是数组，取 `type:"text"` 的 `text` 拼接；
- 事件可能**先于 ack 到达**，客户端要按 `runId` 缓存早到事件。

### 2.2 会话键必须带 agent 前缀

> **坑 2**：指定了 `agentId` 时，`sessionKey` 必须写成 `agent:<agentId>:<key>`，
> 否则报 `agentId "main" does not match session key "pasc:test"`。

PASC 的策略：`agent:<agentId>:<sessionPrefix>:<sceneKey>`，例如
`agent:main:pasc:group:123456`。不指定 `agentId` 时退回 `<prefix>:<sceneKey>`，走默认 agent。

> **坑 3**：`agentId` 填了不存在的值会直接 `Unknown agent id "pasc-group-helper"`。
> 用 `agents.list` 先查一下真实 id（默认是 `main`）。

---

## 3. 三处必须适配的地方

### 3.1 双重人设

OpenClaw 的 agent 有自己的 system prompt（用户可能已经高度定制）。PASC 再注入一套 base prompt，
模型会收到两份人设。实测：`inline` 模式下 agent 多数时候仍会遵守 PASC 的 JSON 协议
（会回 `{"message": ""}` 表示不发言），但语气会偏向它自己的人设。

三种处置，配置 `openclaw.systemMode`：

| 值 | 行为 | 适用 |
|---|---|---|
| `inline`（默认） | `system + "\n\n---\n\n" + user` 合成一条 | 想让 PASC 掌控 Prompt |
| `message` | 只发 `user` | agent 已有定制人设（推荐配合导出的 markdown） |

### 3.2 思考型本地模型

本地 Qwen3.5 会把思维链**直接写进 content**：

```
Thinking Process:
1. **Analyze the Request:** ...
```

实测加 `enable_thinking: false` + `chat_template_kwargs: {enable_thinking: false}` 后输出变干净。
PASC 的策略：`enableThinking: "auto"` —— **仅本机端点**自动关思考，云端不认识的参数会 400
（客户端在 400/422 时会去掉可选参数重试一次）。

另外 `persona-distill.ts` 里还有 `stripThinkingTrace()` 兜底：遇到 `Thinking Process:` 且有多个
`# 标题` 时取最后一个标题之后的内容。

### 3.3 超时

本地 9B 写一段 400 字人设实测 **22~52 秒**（开思考时更久）。`distill.api.timeoutMs` 默认已调到 120 秒；
判断模型保持 30 秒。

---

## 4. 实测延迟（M 系列 Mac，9B 4bit）

| 动作 | 开思考 | 关思考 |
|---|---|---|
| 判断一次（200 tokens） | 13.7s | 8.8s |
| 提纯一次（900 tokens） | 52s（超时） | 22s |
| OpenClaw 回复（云端 DeepSeek） | — | 1.3~2.8s |

---

## 5. 可以直接复制的配置

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
  },
  "judgeModel": {
    "api": { "baseURL": "http://127.0.0.1:8000/v1", "model": "Qwen3.5-9B-MLX-4bit", "maxTokens": 200 }
  },
  "distill": {
    "api": { "baseURL": "http://127.0.0.1:8000/v1", "model": "Qwen3.5-9B-MLX-4bit", "timeoutMs": 120000 }
  },
  "embedding": {
    "enabled": true,
    "api": { "baseURL": "http://127.0.0.1:8000/v1", "model": "mxbai-embed-large-v1" }
  }
}
```

> oMLX 默认监听 `127.0.0.1:8000`，模型目录 `~/.omlx/models`。
> 用 `omlx-cli start` 启动，`omlx-cli stop` 停止。

---

## 6. 还没做的

- `chat.history` / `sessions.*` 没接：PASC 自己维护上下文，不需要 OpenClaw 的历史；
- 工具调用（exec / 群管理）：目前靠 PASC 的 JSON 标签体系，没有走 OpenClaw 的 tool 通道；
- 设备身份（`connect.params.device`）：token 模式下不需要，pairing 模式才有用。
