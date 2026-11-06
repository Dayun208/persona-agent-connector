import { readFile } from 'node:fs/promises';
import type { ChatMessage, QaPair } from '@pasc/core';
import {
  buildExportFilename,
  collectUserMessages,
  distillPersona,
  filterPairsWithAI,
  extractQaPairs,
  extractionOptionsFrom,
  pairsToFewShotText,
  pairsToJson,
  sceneKeyOf,
} from '@pasc/core';
import { Router } from './router.js';
import type { Runtime } from './runtime.js';

const DASHBOARD_URL = new URL('./dashboard.html', import.meta.url);
const LEGACY_URL = new URL('./dashboard-legacy.html', import.meta.url);
let dashboardCache: string | undefined;
let legacyCache: string | undefined;

/**
 * HTTP 接口层。设计原则:
 *   - 只做参数校验与格式转换, 业务逻辑全在 Runtime / Pipeline 里
 *   - 所有会影响运行状态的写操作都要立即落盘
 */
export function createApi(runtime: Runtime): Router {
  const router = new Router();

  // ---------------- 基础 ----------------
  router.get('/api/health', async () => ({ json: await runtime.health() }));

  router.get('/api/stats', async () => {
    const stores = runtime.stores;
    return {
      json: {
        stats: runtime.stats.snapshot(),
        pool: runtime.messagePool.stats(),
        stores: {
          personas: stores.personas.list().length,
          samples: stores.samples.size,
          memories: stores.memories.size,
          archived: stores.archive.size,
        },
        config: {
          replyMode: runtime.config.pipeline.replyMode,
          judgeMode: runtime.config.judgeModel.enabled ? 'on' : 'off',
          memoryEnabled: runtime.config.memory.enabled,
          inject: runtime.config.prompt.inject,
        },
      },
    };
  });

  router.get('/api/logs', async (ctx) => {
    const limit = Number(ctx.query.get('limit') ?? 200);
    return { json: { items: runtime.recentLogs(limit) } };
  });

  // ---------------- 配置 ----------------
  router.get('/api/config', async () => ({ json: runtime.config }));

  router.put('/api/config', async (ctx) => {
    const next = await runtime.updateConfig(ctx.body);
    return { json: { ok: true, config: next } };
  });

  // ---------------- 实时事件 (SSE) ----------------
  router.get('/api/events', async (ctx) => {
    const { req, res } = ctx;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    const send = (event: unknown): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // 先把手头的快照推过去, 控制台一打开就有内容
    send({ type: 'snapshot', ts: Date.now(), data: { stats: runtime.stats.snapshot(), recent: runtime.bus.recent(50) } });

    const unsubscribe = runtime.bus.subscribe((event) => send(event));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return { handled: true };
  });

  // ---------------- 消息与场景 ----------------
  router.get('/api/messages', async (ctx) => {
    const limit = clampInt(ctx.query.get('limit'), 100, 1, 1000);
    const offset = clampInt(ctx.query.get('offset'), 0, 0, 1_000_000);
    const items = runtime.stores.archive.query({
      ...(ctx.query.get('sceneKey') ? { sceneKey: ctx.query.get('sceneKey')! } : {}),
      ...(ctx.query.get('senderId') ? { senderId: ctx.query.get('senderId')! } : {}),
      ...(ctx.query.get('keyword') ? { keyword: ctx.query.get('keyword')! } : {}),
      ...(ctx.query.get('desc') === '1' ? { desc: true } : {}),
      limit,
      offset,
    });
    return { json: { total: runtime.stores.archive.size, items } };
  });

  router.get('/api/friends', async () => {
    const items = await runtime.listFriends();
    return { json: { items, ok: items.length > 0 } };
  });

  router.get('/api/executions', async (ctx) => {
    const sceneKey = ctx.query.get('sceneKey') ?? undefined;
    const limit = clampInt(ctx.query.get('limit'), 100, 1, 500);
    const items = await runtime.executions.recent({ ...(sceneKey ? { sceneKey } : {}), limit });
    return { json: { items } };
  });

  router.get('/api/graph', async (ctx) => {
    const nodeId = ctx.query.get('node');
    if (nodeId) return { json: runtime.graphAbout(nodeId) };
    return { json: runtime.graphSnapshot() };
  });

  router.post('/api/graph/merge', async (ctx) => {
    const body = (ctx.body ?? {}) as { from?: string; to?: string };
    if (!body.from || !body.to) return { status: 400, json: { error: '需要 from 与 to' } };
    const r = await runtime.mergeGraphNodes(body.from, body.to);
    return { json: r };
  });

  router.post('/api/graph/rebuild', async () => {
    try {
      return { json: { ok: true, ...(await runtime.rebuildGraph()) } };
    } catch (err) {
      return { status: 400, json: { error: err instanceof Error ? err.message : String(err) } };
    }
  });

  router.post('/api/memory/reflect', async () => {
    try {
      return { json: { ok: true, ...(await runtime.reflectMemories()) } };
    } catch (err) {
      return { status: 400, json: { error: err instanceof Error ? err.message : String(err) } };
    }
  });

  router.get('/api/audits', async (ctx) => {
    const limit = clampInt(ctx.query.get('limit'), 100, 1, 500);
    return { json: { items: await runtime.recentAudits(limit) } };
  });

  router.get('/api/scenes', async () => ({ json: { items: runtime.sceneSummaries() } }));

  // ---------------- 人格 ----------------
  router.get('/api/personas', async () => {
    const store = runtime.stores.personas;
    return { json: { activeId: store.activeId, items: store.list() } };
  });

  router.post('/api/personas/:id/distill', async (ctx) => {
    const id = ctx.params?.id ?? '';
    if (!id) return { status: 400, json: { error: '缺少人格 id' } };
    const r = await runtime.distillPersonaById(id);
    if (!r.ok) return { status: 400, json: { error: r.error } };
    const persona = runtime.stores.personas.get(id);
    return { json: { ok: true, pairs: r.pairs ?? 0, persona } };
  });

  router.post('/api/personas', async (ctx) => {
    const body = (ctx.body ?? {}) as {
      id?: string;
      name?: string;
      description?: string;
      content?: string;
      distill?: {
        sceneKey?: string;
        senderId?: string;
        senderName?: string;
        auto?: boolean;
      } | null;
    };
    if (!body.name || !body.name.trim()) return { status: 400, json: { error: 'name 不能为空' } };
    const store = runtime.stores.personas;
    const previous = body.id ? store.get(body.id)?.distill : undefined;
    const distill = body.distill === null
      ? undefined
      : body.distill && body.distill.senderId
        ? {
            ...(body.distill.sceneKey ? { sceneKey: body.distill.sceneKey } : {}),
            senderId: body.distill.senderId,
            ...(body.distill.senderName ? { senderName: body.distill.senderName } : {}),
            auto: Boolean(body.distill.auto),
            ...(previous?.lastRunAt ? { lastRunAt: previous.lastRunAt } : {}),
            ...(previous?.lastMessageCount !== undefined ? { lastMessageCount: previous.lastMessageCount } : {}),
          }
        : previous;
    const persona = store.upsert({
      ...(body.id ? { id: body.id } : {}),
      name: body.name.trim(),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(distill ? { distill } : {}),
    });
    await store.flush();
    await runtime.autoSyncPersona(persona.id);
    return { json: { ok: true, persona } };
  });

  router.delete('/api/personas/:id', async (ctx) => {
    const store = runtime.stores.personas;
    const ok = store.remove(ctx.params.id ?? '');
    if (ok) await store.flush();
    return { status: ok ? 200 : 404, json: { ok } };
  });

  router.post('/api/personas/:id/activate', async (ctx) => {
    const store = runtime.stores.personas;
    const ok = store.setActive(ctx.params.id ?? '');
    if (ok) await store.flush();
    return { status: ok ? 200 : 404, json: { ok, activeId: store.activeId } };
  });

  router.post('/api/personas/:id/export', async (ctx) => {
    const body = (ctx.body ?? {}) as { path?: string };
    try {
      const result = await runtime.exportPersona(ctx.params.id, body.path);
      return { json: { ok: true, ...result } };
    } catch (err) {
      return { status: 400, json: { error: err instanceof Error ? err.message : String(err) } };
    }
  });

  // ---------------- 模型探测 ----------------
  router.get('/api/models/probe', async (ctx) => {
    const extra = ctx.query.get('extra');
    try {
      const result = await runtime.probeModels(extra ? [extra] : []);
      return { json: result };
    } catch (err) {
      return { status: 500, json: { error: err instanceof Error ? err.message : String(err) } };
    }
  });

  router.post('/api/models/apply', async (ctx) => {
    const body = (ctx.body ?? {}) as { target?: string; baseURL?: string; model?: string };
    if (body.target !== 'judge' && body.target !== 'distill') {
      return { status: 400, json: { error: "target 只能是 'judge' 或 'distill'" } };
    }
    if (!body.baseURL?.trim() || !body.model?.trim()) {
      return { status: 400, json: { error: 'baseURL 与 model 都不能为空' } };
    }
    try {
      await runtime.applyModel(body.target, body.baseURL.trim(), body.model.trim());
      return { json: { ok: true, target: body.target } };
    } catch (err) {
      return { status: 400, json: { error: err instanceof Error ? err.message : String(err) } };
    }
  });

  // ---------------- 样本 ----------------
  router.get('/api/samples', async (ctx) => {
    const limit = clampInt(ctx.query.get('limit'), 100, 1, 1000);
    const personaId = ctx.query.get('personaId') ?? undefined;
    return { json: { items: runtime.stores.samples.list(limit, personaId) } };
  });

  router.post('/api/samples', async (ctx) => {
    const body = (ctx.body ?? {}) as {
      personaId?: string; question?: string; answer?: string; tags?: string[]; source?: string };
    if (!body.question?.trim() || !body.answer?.trim()) {
      return { status: 400, json: { error: 'question 与 answer 都不能为空' } };
    }
    const sample = runtime.stores.samples.add({
      question: body.question,
      answer: body.answer,
      ...(body.tags ? { tags: body.tags } : {}),
      ...(body.source ? { source: body.source } : {}),
      ...(body.personaId ? { personaId: body.personaId } : {}),
    });
    return { json: { ok: true, sample } };
  });

  router.delete('/api/samples/:id', async (ctx) => {
    const ok = await runtime.stores.samples.remove(ctx.params.id ?? '');
    return { status: ok ? 200 : 404, json: { ok } };
  });

  // ---------------- 记忆 ----------------
  router.get('/api/memories', async (ctx) => {
    const limit = clampInt(ctx.query.get('limit'), 200, 1, 2000);
    const status = ctx.query.get('status');
    const items = runtime.stores.memories.list({
      limit,
      ...(status === 'active' || status === 'archived' || status === 'forgotten' ? { status } : {}),
    });
    return { json: { items } };
  });

  router.post('/api/memories', async (ctx) => {
    const body = (ctx.body ?? {}) as {
      text?: string;
      type?: string;
      importance?: number;
      tags?: string[];
      subjects?: string[];
      sceneKey?: string;
    };
    if (!body.text?.trim()) return { status: 400, json: { error: 'text 不能为空' } };
    const result = await runtime.stores.memories.add({
      text: body.text,
      ...(body.type ? { type: body.type as never } : {}),
      ...(body.importance !== undefined ? { importance: body.importance } : {}),
      ...(body.tags ? { tags: body.tags } : {}),
      ...(body.subjects ? { subjects: body.subjects } : {}),
      ...(body.sceneKey ? { sceneKey: body.sceneKey } : {}),
    });
    await runtime.stores.memories.flush();
    return { json: { ok: true, memory: result.record, merged: result.merged } };
  });

  router.delete('/api/memories/:id', async (ctx) => {
    const id = ctx.params.id ?? '';
    const ok = runtime.stores.memories.forget(id);
    await runtime.stores.memories.flush();
    return { status: ok ? 200 : 404, json: { ok } };
  });

  router.post('/api/memories/:id/restore', async (ctx) => {
    const ok = runtime.stores.memories.restore(ctx.params.id ?? '');
    await runtime.stores.memories.flush();
    return { status: ok ? 200 : 404, json: { ok } };
  });

  router.get('/api/memory/stats', async () => ({
    json: { ...runtime.stores.memories.stats(), health: runtime.stores.memories.embeddingHealth() },
  }));

  router.get('/api/memory/search', async (ctx) => {
    const q = ctx.query.get('q') ?? '';
    if (!q.trim()) return { status: 400, json: { error: '需要 q' } };
    const topK = clampInt(ctx.query.get('topK'), 8, 1, 50);
    const hits = await runtime.memoryHits(q, topK);
    return { json: { query: q, hits } };
  });

  router.post('/api/memory/extract', async (ctx) => {
    const body = (ctx.body ?? {}) as { sceneKey?: string };
    try {
      const result = await runtime.runMemoryExtraction(body.sceneKey);
      return { json: { ok: true, ...result } };
    } catch (err) {
      return { status: 400, json: { error: err instanceof Error ? err.message : String(err) } };
    }
  });

  router.get('/api/embedding/health', async () => ({
    json: {
      quality: runtime.embeddingQuality,
      health: runtime.stores.memories.embeddingHealth(),
    },
  }));

  router.post('/api/embedding/selftest', async () => {
    runtime.embeddingQuality = { checked: false, ok: false };
    runtime.embeddingCheckPromise = undefined; // 强制重跑
    await runtime.ensureEmbeddingQuality();
    return { json: { ...runtime.embeddingQuality, health: runtime.stores.memories.embeddingHealth() } };
  });

  router.post('/api/memory/backfill', async (ctx) => {
    const body = (ctx.body ?? {}) as { force?: boolean; limit?: number };
    const result = await runtime.stores.memories.backfill({
      ...(body.force ? { force: true } : {}),
      ...(body.limit ? { limit: Number(body.limit) } : {}),
    });
    if (result.updated > 0) await runtime.stores.memories.flush();
    return { json: { ok: true, ...result, health: runtime.stores.memories.embeddingHealth() } };
  });

  router.post('/api/memory/decay', async () => ({ json: { ok: true, ...runtime.stores.memories.decay() } }));

  // ---------------- 调试: 判断 / Prompt / Agent / 模拟 ----------------
  router.post('/api/judge/test', async (ctx) => {
    const msg = buildProbeMessage(ctx.body, runtime);
    if ('error' in msg) return { status: 400, json: { error: msg.error } };
    const decision = await runtime.pipelineRef.judgeOnly(msg.value);
    return { json: { decision } };
  });

  router.post('/api/prompt/preview', async (ctx) => {
    const msg = buildProbeMessage(ctx.body, runtime);
    if ('error' in msg) return { status: 400, json: { error: msg.error } };
    const reason = ((ctx.body as { reason?: string })?.reason ?? 'manual') as
      | 'mention'
      | 'keyword'
      | 'judge'
      | 'manual';
    const bundle = await runtime.pipelineRef.previewPrompt(msg.value, reason);
    return { json: { prompt: bundle } };
  });

  // 通用对话通道：给外部脚本（如 QQ 自动回复）用，不经过消息池/判断
  router.post('/api/agent/chat', async (ctx) => {
    const body = (ctx.body ?? {}) as { text?: string; system?: string; history?: Array<{ role: string; content: string }> };
    if (!body.text || !body.text.trim()) return { status: 400, json: { error: 'text 不能为空' } };
    const historyText = (body.history ?? [])
      .slice(-12)
      .map((m) => `${m.role === 'user' ? '对方' : '你'}: ${m.content}`)
      .join('\n');
    const user = [historyText ? `【之前的对话】\n${historyText}` : '', `【最新一条】\n${body.text}`]
      .filter(Boolean)
      .join('\n\n');
    const started = Date.now();
    try {
      const res = await runtime.getAgent().send({
        system: body.system ?? '你是一个正常人，在 QQ 上和对方私聊。回复简短口语化，一到两句话，不要用列表或 markdown。',
        user,
        meta: { sceneKey: 'dsh:private', sceneLabel: 'QQ 私聊', triggerId: '', reason: 'manual' },
      });
      // agent（尤其 pasc-qq）会按 QQ 协议回 JSON，这里取出 message 字段
      let text = res.text.trim();
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === 'string') text = parsed.message.trim();
      } catch {
        /* 不是 JSON 就用原文 */
      }
      return { json: { ok: true, text, latencyMs: Date.now() - started } };
    } catch (err) {
      return { status: 502, json: { ok: false, error: err instanceof Error ? err.message : String(err) } };
    }
  });

  router.post('/api/agent/probe', async () => ({ json: await runtime.probeAgent() }));

  router.post('/api/simulate', async (ctx) => {
    const body = (ctx.body ?? {}) as {
      text?: string;
      senderId?: string;
      senderName?: string;
      groupId?: string;
      scene?: 'group' | 'private';
      force?: boolean;
    };
    if (!body.text?.trim()) return { status: 400, json: { error: 'text 不能为空' } };
    const result = await runtime.simulate({
      text: body.text,
      ...(body.senderId ? { senderId: body.senderId } : {}),
      ...(body.senderName ? { senderName: body.senderName } : {}),
      ...(body.groupId ? { groupId: body.groupId } : {}),
      ...(body.scene ? { scene: body.scene } : {}),
      force: body.force ?? true,
    });
    return { json: { ok: true, messageId: result.message.id } };
  });

  router.get('/api/napcat/status', async () => ({
    json: {
      status: runtime.client.status,
      selfId: runtime.client.selfId,
      protocol: runtime.client.protocol,
      ...(await runtime.client.health()),
    },
  }));

  // ---------------- 聊天记录存档 / QCE 导入 ----------------
  router.get('/api/archive/stats', async () => ({ json: runtime.archiveStats() ?? {} }));

  router.post('/api/import/qce', async (ctx) => {
    const body = (ctx.body ?? {}) as {
      filePath?: string;
      groupId?: string;
      sceneKey?: string;
      selfId?: string;
      includeSystem?: boolean;
      dryRun?: boolean;
    };
    if (!body.filePath?.trim()) return { status: 400, json: { error: '需要 filePath(服务器本地路径)' } };
    try {
      const result = await runtime.importQce({
        filePath: body.filePath.trim(),
        ...(body.groupId ? { groupId: body.groupId } : {}),
        ...(body.sceneKey ? { sceneKey: body.sceneKey } : {}),
        ...(body.selfId ? { selfId: body.selfId } : {}),
        ...(body.includeSystem !== undefined ? { includeSystem: body.includeSystem } : {}),
        ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
      });
      return { json: { ok: true, ...result, dryRun: body.dryRun ?? false } };
    } catch (err) {
      return { status: 400, json: { error: err instanceof Error ? err.message : String(err) } };
    }
  });

  // ---------------- 人格提纯 / Q&A 截取(模块三) ----------------
  router.get('/api/users', async (ctx) => {
    const sceneKey = ctx.query.get('sceneKey') ?? '';
    if (!sceneKey) return { status: 400, json: { error: '需要 sceneKey' } };
    return { json: { items: runtime.participants(sceneKey) } };
  });

  router.get('/api/extract/qas', async (ctx) => {
    const senderId = ctx.query.get('senderId') ?? '';
    if (!senderId) return { status: 400, json: { error: '需要 senderId' } };
    const sceneKey = ctx.query.get('sceneKey') ?? undefined;
    const result = buildPairs(runtime, {
      senderId,
      ...(sceneKey ? { sceneKey } : {}),
      includeAsks: ctx.query.get('includeAsks') === '1',
      limit: clampInt(ctx.query.get('limit'), 60, 1, 200),
    });
    return { json: result };
  });

  router.post('/api/extract/distill', async (ctx) => {
    const body = (ctx.body ?? {}) as {
      senderId?: string;
      sceneKey?: string;
      save?: boolean;
      activate?: boolean;
      name?: string;
    };
    if (!body.senderId) return { status: 400, json: { error: '需要 senderId' } };

    const sceneKey = body.sceneKey ?? undefined;
    const extracted = buildPairs(runtime, {
      senderId: body.senderId,
      ...(sceneKey ? { sceneKey } : {}),
      limit: 200,
    });
    if (extracted.pairs.length === 0 && extracted.targetMessages === 0) {
      return { status: 400, json: { error: '这个用户在当前会话里没有可用发言' } };
    }

    const messages = runtime.sceneMessages(sceneKey);
    const target = collectUserMessages(messages, body.senderId);
    const targetName = target[0]?.senderName ?? extracted.pairs[0]?.target.name ?? body.senderId;

    const draft = await distillPersona(
      { target: { id: body.senderId, name: body.name ?? targetName }, sceneKey: sceneKey ?? 'all', pairs: extracted.pairs, messages: target },
      {
        getConfig: () => runtime.config.distill,
        getClient: () => runtime.distillClient(),
      },
    );

    let personaId: string | undefined;
    if (body.save) {
      const store = runtime.stores.personas;
      const persona = store.upsert({
        name: body.name ?? draft.name,
        description: draft.description,
        content: draft.content,
      });
      personaId = persona.id;
      if (body.activate) store.setActive(persona.id);
      await store.flush();
    }

    return { json: { ok: true, draft, personaId } };
  });

  router.post('/api/extract/filter', async (ctx) => {
    const body = (ctx.body ?? {}) as {
      senderId?: string;
      sceneKey?: string;
      limit?: number;
      maxKeep?: number;
      hint?: string;
    };
    if (!body.senderId) return { status: 400, json: { error: '需要 senderId' } };

    const extracted = buildPairs(runtime, {
      senderId: body.senderId,
      ...(body.sceneKey ? { sceneKey: body.sceneKey } : {}),
      limit: clampInt(String(body.limit ?? 60), 60, 1, 200),
    });
    if (extracted.pairs.length === 0) {
      return { json: { ok: true, pairs: [], total: 0, kept: 0, batches: 0, failedBatches: 0, note: '没有可筛选的候选配对' } };
    }

    const client = runtime.distillClient();
    if (!client?.configured) {
      return { status: 400, json: { error: '提纯模型未配置，无法做 AI 筛选' } };
    }

    const targetName = extracted.pairs[0]?.target.name ?? body.senderId;
    const result = await filterPairsWithAI(extracted.pairs, client, {
      maxKeep: clampInt(String(body.maxKeep ?? 20), 20, 1, 100),
      targetName,
      ...(body.hint ? { hint: body.hint } : {}),
    });

    const byId = new Map(result.kept.map((v) => [v.id, v]));
    const pairs = extracted.pairs
      .filter((p) => byId.has(p.id))
      .map((p) => ({ ...p, aiScore: byId.get(p.id)!.score, aiReason: byId.get(p.id)!.reason }))
      .sort((a, b) => b.aiScore - a.aiScore);

    return {
      json: {
        ok: true,
        pairs,
        total: extracted.pairs.length,
        kept: pairs.length,
        batches: result.batches,
        failedBatches: result.failedBatches,
        deduped: result.deduped,
      },
    };
  });

  router.post('/api/extract/import', async (ctx) => {
    const body = (ctx.body ?? {}) as {
      senderId?: string;
      sceneKey?: string;
      limit?: number;
      tags?: string[];
      pairIds?: string[];
      /** 归属人格；不填则写进全局样本池 */
      personaId?: string;
    };
    if (!body.senderId) return { status: 400, json: { error: '需要 senderId' } };

    const extracted = buildPairs(runtime, {
      senderId: body.senderId,
      ...(body.sceneKey ? { sceneKey: body.sceneKey } : {}),
      limit: clampInt(String(body.limit ?? 20), 20, 1, 200),
    });
    const selected = body.pairIds?.length
      ? extracted.pairs.filter((p) => body.pairIds!.includes(p.id))
      : extracted.pairs;

    const store = runtime.stores.samples;
    const added = selected.map((p) =>
      store.add({
        question: p.question,
        answer: p.answer,
        tags: body.tags ?? ['auto-extract'],
        source: `extract:${p.sceneKey}`,
        ...(body.personaId ? { personaId: body.personaId } : {}),
      }),
    );
    return { json: { ok: true, imported: added.length, total: store.size } };
  });

  router.get('/api/extract/export', async (ctx) => {
    const senderId = ctx.query.get('senderId') ?? '';
    if (!senderId) return { status: 400, json: { error: '需要 senderId' } };
    const sceneKey = ctx.query.get('sceneKey') ?? undefined;
    const format = ctx.query.get('format') === 'json' ? 'json' : 'txt';

    const extracted = buildPairs(runtime, {
      senderId,
      ...(sceneKey ? { sceneKey } : {}),
      includeAsks: ctx.query.get('includeAsks') === '1',
      limit: clampInt(ctx.query.get('limit'), 60, 1, 200),
    });
    const name = extracted.pairs[0]?.target.name ?? senderId;
    const filename = buildExportFilename(name, format);
    const content =
      format === 'json'
        ? pairsToJson(extracted.pairs)
        : pairsToFewShotText(extracted.pairs, { targetName: name, ...(sceneKey ? { sceneKey } : {}) });

    // HTTP 头只能是 latin-1, 中文文件名要走 RFC 5987 的 filename*
    const asciiName = filename.replace(/[^\x20-\x7E]/g, '_');
    return {
      text: content,
      contentType: format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      headers: {
        'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    };
  });

  // ---------------- NapCat HTTP 事件上报 ----------------
  router.post('/napcat/event', async (ctx) => {
    const events = Array.isArray(ctx.body) ? ctx.body : [ctx.body];
    let count = 0;
    for (const event of events) {
      if (event && typeof event === 'object') {
        runtime.client.handleRawEvent(event as never);
        count += 1;
      }
    }
    return { json: { ok: true, count } };
  });

  // ---------------- 控制台 ----------------
  router.get('/', async (ctx) => {
    dashboardCache ??= await readFile(DASHBOARD_URL, 'utf8');
    ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    ctx.res.end(dashboardCache);
    return { handled: true };
  });

  // 旧版控制台（人格/记忆/提纯/设置还在那边）
  router.get('/legacy', async (ctx) => {
    legacyCache ??= await readFile(LEGACY_URL, 'utf8');
    ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    ctx.res.end(legacyCache);
    return { handled: true };
  });

  router.get('/favicon.ico', async (ctx) => {
    ctx.res.writeHead(204).end();
    return { handled: true };
  });

  return router;
}

function buildProbeMessage(
  body: unknown,
  runtime: Runtime,
): { value: ChatMessage } | { error: string } {
  const b = (body ?? {}) as {
    text?: string;
    senderId?: string;
    senderName?: string;
    groupId?: string;
    scene?: 'group' | 'private';
  };
  if (!b.text?.trim()) return { error: 'text 不能为空' };
  const senderId = b.senderId ?? '10001';
  const scene =
    b.scene === 'private'
      ? ({ kind: 'private', userId: senderId } as const)
      : ({ kind: 'group', groupId: b.groupId ?? '123456' } as const);

  const sceneKey = sceneKeyOf(scene);
  void runtime;

  return {
    value: {
      id: `probe-${Date.now()}`,
      seq: 0,
      scene,
      sceneKey,
      senderId,
      senderName: b.senderName ?? '测试用户',
      segments: [{ type: 'text', text: b.text }],
      text: b.text,
      atTargets: [],
      mentionsSelf: false,
      timestamp: Date.now(),
      isSelf: false,
    },
  };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

interface ExtractArgs {
  senderId: string;
  sceneKey?: string;
  includeAsks?: boolean;
  limit?: number;
}

/** 统一走一遍: 取消息 → 跑提取 → 返回 pairs 与目标用户发言数 */
function buildPairs(
  runtime: Runtime,
  args: ExtractArgs,
): { pairs: QaPair[]; targetMessages: number; stats: Record<string, number> } {
  const messages = runtime.sceneMessages(args.sceneKey);
  const opts = extractionOptionsFrom(runtime.config.extraction, args.senderId, args.sceneKey);
  const result = extractQaPairs(messages, {
    ...opts,
    ...(args.includeAsks !== undefined ? { includeTargetAsks: args.includeAsks } : {}),
    ...(args.limit ? { maxPairs: args.limit } : {}),
  });
  const targetMessages = collectUserMessages(messages, args.senderId).length;
  return {
    pairs: result.pairs,
    targetMessages,
    stats: {
      scanned: result.stats.scanned,
      targetUtterances: result.stats.targetUtterances,
      rejected: result.stats.rejected,
    },
  };
}
