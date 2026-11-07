# 手动启动指南

> 下面用 `$HOME` 表示你的用户目录；项目路径按实际 clone 位置替换。
>
> 正常开机后 launchd 会自己把服务拉起来。这份文档是给"要自己按顺序起一遍"或"某个服务没起来"时用的。
>
> 一条命令自检：`curl -s http://127.0.0.1:7788/api/health | json_pp` —— 三个 status 都是 connected/ok 就齐了。

---

## 依赖关系

```
① 容器运行时（colima）           Docker 环境
      ↓
② NapCat 容器                   QQ 协议端，暴露 3001(WS) / 6099(WebUI)
      ↓                         ⚠️ 需要扫码登录
③ oMLX（本地模型，:8000）        判断模型 Qwen3.5-9B
④ Embedding 服务（:8010）        向量召回
      ↓
⑤ OpenClaw Gateway（:18789）    Agent 运行时
      ↓
⑥ PASC（:7788）                 中间件本体 + 控制台
```

**②③④ 和 ⑤ 互不依赖，可以并行起。⑥ 要等它们都就绪。**

---

## 全部启动（一条命令）

```bash
launchctl kickstart -k gui/$(id -u)/local.colima.autostart 2>/dev/null
launchctl kickstart -k gui/$(id -u)/local.omlx.autostart
launchctl kickstart -k gui/$(id -u)/local.pasc.embed
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
docker start pasc-napcat
launchctl kickstart -k gui/$(id -u)/ai.pasc.server
```

两分钟后自检：

```bash
curl -s http://127.0.0.1:7788/api/health | python3 -m json.tool | head -30
```

---

## 逐个手动起

### ① 容器运行时

```bash
colima status          # 已经在跑就不管
colima start           # 没跑就起（首次会比较慢）
docker info | head -3  # 确认能连上 docker
```

> 用的是 colima，不是 Docker Desktop。`docker context ls` 里带 `*` 的那个才是当前生效的。

### ② NapCat 容器

```bash
docker start pasc-napcat
docker logs -f --tail 30 pasc-napcat
```

**看到这几行说明要扫码：**

```
[Login] Login Error, ErrType: 1  ErrCode: 3
请扫描下面的二维码，然后在手Q上授权登录：
二维码已保存到 /app/napcat/cache/qrcode.png
```

把二维码取出来扫（用**机器人账号**的手机 QQ）：

```bash
docker cp pasc-napcat:/app/napcat/cache/qrcode.png /tmp/qq-qr.png
open /tmp/qq-qr.png
```

日志里出现 `二维码解码URL: https://txz.qq.com/p?k=...` 时，也可以把那个链接丢进任意二维码生成网站。

**扫完之后**，日志会打出登录成功，端口 3001 才真正开始接 WebSocket。

```bash
nc -z 127.0.0.1 3001 && echo 3001 通
```

### ③ 判断模型（oMLX）

```bash
launchctl kickstart -k gui/$(id -u)/local.omlx.autostart
# 或者直接开应用
open -a oMLX
```

验证：

```bash
curl -s http://127.0.0.1:8000/v1/models | python3 -c "import sys,json;print([m['id'] for m in json.load(sys.stdin)['data']])"
```

应该能看到 `Qwen3.5-9B-MLX-4bit`。

> ⚠️ 别在这里加载 GLM-4.6V / GLM-OCR —— 它们会把 Qwen 挤出显存，判断模型随即超时降级。
> 识图现在走 DeepSeek 云端，不需要本地视觉模型。

### ④ Embedding 服务

```bash
launchctl kickstart -k gui/$(id -u)/local.pasc.embed
```

手动起（调试用，前台看日志）：

```bash
"$HOME/.local/python3.11/bin/python3" -u \
  "$HOME/Library/Application Support/pasc/embed/embed_server.py" \
  --port 8010
```

验证：

```bash
curl -s http://127.0.0.1:8010/v1/models | head -c 200
```

### ⑤ OpenClaw Gateway

```bash
openclaw gateway status     # 看状态
openclaw gateway start      # 起服务
openclaw gateway restart    # 改完配置后重启
openclaw gateway run        # 前台跑，看日志用
```

验证：

```bash
curl -s http://127.0.0.1:18789/health | head -c 200
```

### ⑥ PASC

```bash
launchctl kickstart -k gui/$(id -u)/ai.pasc.server
```

手动前台跑（改代码调试时用这个，能看到实时日志）：

```bash
cd "$(git rev-parse --show-toplevel)/packages/server"
node --import tsx --disable-warning=ExperimentalWarning src/index.ts
```

> 不要用 `pnpm dev` —— pnpm 在 launchd 下会挂住（0% CPU 不动）。

验证：

```bash
curl -s http://127.0.0.1:7788/api/health | python3 -m json.tool
open http://127.0.0.1:7788
```

---

## 自检清单

```bash
# 1. 端口都在听
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(7788|8010|18789|8000|3001)\b'

# 2. PASC 健康
curl -s http://127.0.0.1:7788/api/health | python3 -c "
import sys,json;d=json.load(sys.stdin)
print('napcat', d['napcat']['status'])
print('agent ', d['agent']['ok'])
print('judge ', d['judge']['mode'])
print('记忆  ', d['stores']['memories'])"

# 3. 最近有没有消息进来
curl -s 'http://127.0.0.1:7788/api/messages?limit=3&desc=1' | python3 -m json.tool | head -20
```

---

## 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `napcat: closed` + 日志 `socket hang up` 刷屏 | QQ 登录态失效，NapCat 在等扫码 | 取二维码扫码（见 ②） |
| 登录后仍然连不上 | NapCat 刚启动，WS 服务还没就绪 | 等 10 秒；PASC 每 30 秒自动重试 |
| 判断模型超时降级 | oMLX 显存被别的模型占了 | 只留 Qwen，别加载视觉模型 |
| `git push` 连不上 | 代理 7897 没起 | 先试直连；不行再开代理 |
| PASC 起来但没回复 | 判断节流（每 N 条才判一次）或群里没 @ 它 | 看控制台「实时事件」里的 判/默 两行 |
| 控制台打不开 | 服务端口被占 | `lsof -iTCP:7788` 看是谁 |

---

## 停机

```bash
launchctl bootout gui/$(id -u)/ai.pasc.server   # 停 PASC
launchctl bootout gui/$(id -u)/ai.openclaw.gateway
docker stop pasc-napcat
launchctl bootout gui/$(id -u)/local.pasc.embed
```

只想临时停 PASC：`launchctl kill SIGTERM gui/$(id -u)/ai.pasc.server`（launchd 会按 KeepAlive 再拉起来，要彻底停用 `bootout`）。
