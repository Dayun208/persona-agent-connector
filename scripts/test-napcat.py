#!/usr/bin/env python3
"""测试用 NapCat 实例（pasc-napcat-test）的 OneBot 客户端。

用途：用一个独立的 QQ 小号扮演"群友"，给机器人主号发消息，
      从而在不打扰真人的前提下跑通整条链路。

用法：
  ./scripts/test-napcat.py info                    # 看登录的是哪个号
  ./scripts/test-napcat.py send <uin> <文本>        # 私聊发消息
  ./scripts/test-napcat.py group <gid> <文本>       # 群发消息
  ./scripts/test-napcat.py at <gid> <uin> <文本>    # 群里 @ 某人再说话
  ./scripts/test-napcat.py api <动作> '<json参数>'   # 直接调任意 OneBot 接口

环境变量：
  TEST_NAPCAT_URL   测试实例的 HTTP 端口，默认 http://127.0.0.1:3100
  TEST_NAPCAT_TOKEN 该实例的 OneBot token，默认空（未设 token 时）
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("TEST_NAPCAT_URL", "http://127.0.0.1:3100").rstrip("/")
TOKEN = os.environ.get("TEST_NAPCAT_TOKEN", "")


def call(action: str, payload: dict | None = None, timeout: float = 15.0) -> dict:
    data = json.dumps(payload or {}).encode()
    req = urllib.request.Request(
        f"{BASE}/{action}",
        data=data,
        headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as err:
        return {"status": "http_error", "retcode": err.code, "body": err.read().decode(errors="replace")[:300]}
    except Exception as err:  # noqa: BLE001
        return {"status": "failed", "error": str(err)}


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1

    cmd = argv[0]
    if cmd == "info":
        print(json.dumps(call("get_login_info"), ensure_ascii=False, indent=2))
        return 0

    if cmd == "send" and len(argv) >= 3:
        r = call("send_private_msg", {"user_id": int(argv[1]), "message": argv[2]})
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("status") == "ok" else 2

    if cmd == "reply" and len(argv) >= 4:
        # 引用回复某条消息
        msg = [{"type": "reply", "data": {"id": str(argv[2])}}, {"type": "text", "data": {"text": argv[3]}}]
        r = call("send_group_msg", {"group_id": int(argv[1]), "message": msg})
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("status") == "ok" else 2

    if cmd == "at" and len(argv) >= 4:
        # 群里 @ 某人再说话：at 段 + 文本段
        msg = [{"type": "at", "data": {"qq": str(argv[2])}}, {"type": "text", "data": {"text": " " + argv[3]}}]
        r = call("send_group_msg", {"group_id": int(argv[1]), "message": msg})
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("status") == "ok" else 2

    if cmd == "group" and len(argv) >= 3:
        r = call("send_group_msg", {"group_id": int(argv[1]), "message": argv[2]})
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get("status") == "ok" else 2

    if cmd == "api" and len(argv) >= 2:
        params = json.loads(argv[2]) if len(argv) >= 3 else {}
        print(json.dumps(call(argv[1], params), ensure_ascii=False, indent=2))
        return 0

    print(__doc__)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
