#!/usr/bin/env python3
"""
本地 Embedding 服务 —— 给 PASC 提供一个"真能用"的 OpenAI 兼容 /v1/embeddings。

为什么不用 oMLX 的 mxbai-embed-large-v1：
  实测它对中文是退化的 —— "猫"/"狗"/"鱼" 三个字返回完全相同的向量
  （余弦相似度 1.0000），任意两段无关文本也在 0.7 上下挤成一团。
  这种向量做召回会把所有记忆拉平成同一个分数，比没有更糟。

这里用 fastembed（ONNX Runtime，不需要 PyTorch）+ BAAI/bge-small-zh-v1.5（512 维，约 90MB），
中文语义区分为已验证可用。

用法：
  python3 scripts/embed_server.py            # 默认 127.0.0.1:8010
  python3 scripts/embed_server.py --port 8010 --model BAAI/bge-small-zh-v1.5

接口：
  POST /v1/embeddings  {"model": "...", "input": ["文本", ...]}  → {"data":[{"embedding":[...],"index":0}]}
  GET  /health                                                   → {"ok":true,"model":"..."}
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_model = None
_model_name = ""
_started = time.time()


def get_model(name: str):
    global _model, _model_name
    if _model is None:
        from fastembed import TextEmbedding

        _model = TextEmbedding(model_name=name)
        _model_name = name
    return _model


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 安静一点，别刷屏
        return

    def _send(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, {"ok": True, "model": _model_name, "uptimeSec": round(time.time() - _started)})
        if self.path.startswith("/v1/models"):
            return self._send(200, {"data": [{"id": _model_name, "object": "model"}]})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/v1/embeddings"):
            return self._send(404, {"error": "not found"})

        length = int(self.headers.get("content-length") or 0)
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._send(400, {"error": "invalid json"})

        raw = req.get("input")
        texts = [raw] if isinstance(raw, str) else list(raw or [])
        if not texts:
            return self._send(400, {"error": "input 不能为空"})

        try:
            model = get_model(_model_name or "BAAI/bge-small-zh-v1.5")
            vectors = list(model.embed(texts))
        except Exception as err:  # noqa: BLE001
            return self._send(500, {"error": f"embedding 失败: {err}"})

        data = [
            {"object": "embedding", "index": i, "embedding": [float(x) for x in vec]}
            for i, vec in enumerate(vectors)
        ]
        self._send(
            200,
            {
                "object": "list",
                "model": _model_name,
                "data": data,
                "usage": {"prompt_tokens": sum(len(t) for t in texts), "total_tokens": sum(len(t) for t in texts)},
            },
        )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8010)
    ap.add_argument("--model", default="BAAI/bge-small-zh-v1.5")
    args = ap.parse_args()

    global _model_name
    _model_name = args.model
    print(f"[embed] 加载模型 {args.model} …", flush=True)
    get_model(args.model)  # 预热，避免第一个请求超时
    print(f"[embed] 就绪 http://{args.host}:{args.port}/v1/embeddings", flush=True)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[embed] 退出", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
