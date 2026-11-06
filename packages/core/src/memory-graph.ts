import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { TextCompleter } from './memory-extract.js';
import { extractJsonValue } from './json-utils.js';

/**
 * 记忆图谱。
 *
 * 记忆本身是一句句孤立的文本，"谁跟谁是什么关系"看不出来。
 * 这里从记忆里抽实体和关系，攒成一张可以画的网：
 *
 *   张三 ──同事── 李四
 *   张三 ──住在── 杭州
 *
 * 设计取舍：
 *   - 边带 weight（证据条数），同一关系被反复提到就越粗
 *   - 每个节点/边都留 memoryIds，点开能看到原话，可追溯
 *   - 不做自动消歧（"张三"和"小张"是两个人），留给人工在界面上合并
 */
export type EntityType = 'person' | 'place' | 'org' | 'topic';

export interface GraphNode {
  /** 归一化后的名字，作为唯一键 */
  id: string;
  name: string;
  type: EntityType;
  /** 被提到次数 */
  mentions: number;
  /** 支撑它的记忆 id */
  memoryIds: string[];
  /** 第一次/最近一次被提到的时间 */
  firstSeen: number;
  lastSeen: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** 关系词，如"同事""住在""喜欢" */
  relation: string;
  /** 证据条数 */
  weight: number;
  memoryIds: string[];
  firstSeen: number;
  lastSeen: number;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  updatedAt: number;
}

interface GraphFile {
  version: 2;
  updatedAt: number;
  nodes: Record<string, GraphNode>;
  edges: Record<string, GraphEdge>;
  /** 别名 → 正名。"小张" 合并进 "张三" 后，以后再抽到"小张"会自动归到"张三" */
  aliases: Record<string, string>;
}

const ENTITY_TYPES: EntityType[] = ['person', 'place', 'org', 'topic'];

/**
 * 泛称黑名单。
 * 模型很爱抽"用户""群友""大家"这种词 —— 它们在图上没有意义，
 * 而且会把所有关系都吸到一个假节点上。
 */
const GENERIC_NAMES = new Set([
  '用户', '某人', '有人', '大家', '群友', '群成员', '成员', '网友', '他', '她', '我', '你',
  '机器人', 'bot', '某', '某人说', '用户们', '其他人', '别人',
]);

export function isGenericName(name: string): boolean {
  return GENERIC_NAMES.has(normalizeName(name));
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

function edgeId(from: string, relation: string, to: string): string {
  return `${from}|${relation}|${to}`;
}

export class MemoryGraph {
  private data: GraphFile = { version: 2, updatedAt: 0, nodes: {}, edges: {}, aliases: {} };

  private constructor(private readonly file: string) {}

  static async open(file: string): Promise<MemoryGraph> {
    const graph = new MemoryGraph(file);
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as { version?: number; updatedAt?: number; nodes?: Record<string, GraphNode>; edges?: Record<string, GraphEdge>; aliases?: Record<string, string> };
      if (parsed && (parsed.version === 1 || parsed.version === 2)) {
        const nodes: Record<string, GraphNode> = {};
        for (const [id, raw] of Object.entries(parsed.nodes ?? {})) {
          // v1 没有时间字段，用 0 表示"时间未知"
          const node = raw as Partial<GraphNode>;
          nodes[id] = {
            id: node.id ?? id,
            name: node.name ?? id,
            type: node.type ?? 'topic',
            mentions: node.mentions ?? 1,
            memoryIds: node.memoryIds ?? [],
            firstSeen: node.firstSeen ?? 0,
            lastSeen: node.lastSeen ?? 0,
          };
        }
        const edges: Record<string, GraphEdge> = {};
        for (const [id, raw] of Object.entries(parsed.edges ?? {})) {
          const edge = raw as Partial<GraphEdge>;
          edges[id] = {
            id: edge.id ?? id,
            from: edge.from ?? '',
            to: edge.to ?? '',
            relation: edge.relation ?? '',
            weight: edge.weight ?? 1,
            memoryIds: edge.memoryIds ?? [],
            firstSeen: edge.firstSeen ?? 0,
            lastSeen: edge.lastSeen ?? 0,
          };
        }
        for (const [id, e] of Object.entries(edges)) {
          if (!e.from || !e.to) delete edges[id];
        }
        graph.data = {
          version: 2,
          updatedAt: parsed.updatedAt ?? 0,
          nodes,
          edges,
          aliases: parsed.aliases ?? {},
        };
      }
    } catch {
      /* 文件不存在或损坏：从空图开始 */
    }
    return graph;
  }

  get nodeCount(): number {
    return Object.keys(this.data.nodes).length;
  }

  get edgeCount(): number {
    return Object.keys(this.data.edges).length;
  }

  /**
   * 把一次抽取结果并进图里。
   * 同一实体/关系重复出现只增加 weight 和证据，不会产生重复节点。
   */
  merge(
    entities: Array<{ name: string; type: string }>,
    relations: Array<{ from: string; to: string; relation: string }>,
    memoryId: string,
    rename?: (name: string) => string,
    now: number = Date.now(),
  ): void {
    for (const entity of entities) {
      const raw = entity.name?.trim();
      if (!raw) continue;
      if (isGenericName(raw)) continue;
      // 把 QQ 号换成昵称：记忆里常写"2959515696"，图上显示成号码没法看
      const name = rename ? rename(raw) : raw;
      if (!name || isGenericName(name)) continue;
      // 之前合并过的别名，直接归到正名
      const id = this.resolveAlias(normalizeName(name));
      const existing = this.data.nodes[id];
      const type = ENTITY_TYPES.includes(entity.type as EntityType) ? (entity.type as EntityType) : 'topic';
      if (existing) {
        existing.mentions += 1;
        // 记忆不一定按时间顺序处理，首末时间都要取极值
        if (existing.firstSeen === 0 || now < existing.firstSeen) existing.firstSeen = now;
        existing.lastSeen = Math.max(existing.lastSeen, now);
        if (!existing.memoryIds.includes(memoryId)) existing.memoryIds.push(memoryId);
        // 人 > 地点/组织 > 话题：先认出来的更强类型保留下来
        if (existing.type === 'topic' && type !== 'topic') existing.type = type;
      } else {
        this.data.nodes[id] = { id, name, type, mentions: 1, memoryIds: [memoryId], firstSeen: now, lastSeen: now };
      }
    }

    for (const rel of relations) {
      const from = this.resolveAlias(normalizeName(rel.from ?? ''));
      const to = this.resolveAlias(normalizeName(rel.to ?? ''));
      const relation = (rel.relation ?? '').trim();
      if (!from || !to || !relation || from === to) continue;
      // 关系两端的实体必须已知，否则图会断成孤岛
      if (!this.data.nodes[from] || !this.data.nodes[to]) continue;

      const id = edgeId(from, relation, to);
      const existing = this.data.edges[id];
      if (existing) {
        existing.weight += 1;
        if (existing.firstSeen === 0 || now < existing.firstSeen) existing.firstSeen = now;
        existing.lastSeen = Math.max(existing.lastSeen, now);
        if (!existing.memoryIds.includes(memoryId)) existing.memoryIds.push(memoryId);
      } else {
        this.data.edges[id] = { id, from, to, relation, weight: 1, memoryIds: [memoryId], firstSeen: now, lastSeen: now };
      }
    }
  }

  /** 别名链解析（A→B→C 也能一路追到 C） */
  private resolveAlias(id: string): string {
    let cur = id;
    for (let i = 0; i < 8; i += 1) {
      const next = this.data.aliases[cur];
      if (!next || next === cur) break;
      cur = next;
    }
    return cur;
  }

  /**
   * 把 fromId 合并进 toId。
   * 名称/提及次数/记忆证据并入，边改指向，并记下别名 —— 以后抽到旧名字会自动归到新名字。
   * 返回合并后的节点 id；两端有一个不存在时返回 undefined。
   */
  mergeNodes(fromId: string, toId: string): string | undefined {
    const from = normalizeName(fromId);
    const to = normalizeName(toId);
    if (!from || !to || from === to) return undefined;
    const src = this.data.nodes[from];
    const dst = this.data.nodes[to];
    if (!src || !dst) return undefined;

    dst.mentions += src.mentions;
    dst.firstSeen = dst.firstSeen === 0 ? src.firstSeen : (src.firstSeen === 0 ? dst.firstSeen : Math.min(dst.firstSeen, src.firstSeen));
    dst.lastSeen = Math.max(dst.lastSeen, src.lastSeen);
    for (const id of src.memoryIds) {
      if (!dst.memoryIds.includes(id)) dst.memoryIds.push(id);
    }
    if (dst.type === 'topic' && src.type !== 'topic') dst.type = src.type;

    // 边：改指向后可能和已有边重名，重名的合并权重
    const rebuilt: Record<string, GraphEdge> = {};
    for (const edge of Object.values(this.data.edges)) {
      if (edge.from === from && edge.to === from) continue;
      const nextFrom = edge.from === from ? to : edge.from;
      const nextTo = edge.to === from ? to : edge.to;
      if (nextFrom === nextTo) continue;
      const id = edgeId(nextFrom, edge.relation, nextTo);
      const existing = rebuilt[id];
      if (existing) {
        existing.weight += edge.weight;
        existing.firstSeen = Math.min(existing.firstSeen || edge.firstSeen, edge.firstSeen || existing.firstSeen);
        existing.lastSeen = Math.max(existing.lastSeen, edge.lastSeen);
        for (const mid of edge.memoryIds) {
          if (!existing.memoryIds.includes(mid)) existing.memoryIds.push(mid);
        }
      } else {
        rebuilt[id] = { ...edge, id, from: nextFrom, to: nextTo };
      }
    }
    this.data.edges = rebuilt;

    delete this.data.nodes[from];
    this.data.aliases[from] = to;
    return to;
  }

  /** 已知别名数量，便于前端提示 */
  get aliasCount(): number {
    return Object.keys(this.data.aliases).length;
  }

  snapshot(): GraphSnapshot {
    return {
      nodes: Object.values(this.data.nodes).sort((a, b) => b.mentions - a.mentions),
      edges: Object.values(this.data.edges).sort((a, b) => b.weight - a.weight),
      updatedAt: this.data.updatedAt,
    };
  }

  /** 取某个实体关联的一切，用于点击节点后的详情 */
  about(nodeId: string): { node?: GraphNode; edges: GraphEdge[]; neighborIds: string[] } {
    const node = this.data.nodes[nodeId];
    const edges = Object.values(this.data.edges).filter((e) => e.from === nodeId || e.to === nodeId);
    const neighborIds = [...new Set(edges.map((e) => (e.from === nodeId ? e.to : e.from)))];
    return { ...(node ? { node } : {}), edges, neighborIds };
  }

  async save(): Promise<void> {
    this.data.updatedAt = Date.now();
    await mkdir(dirname(this.file), { recursive: true }).catch(() => undefined);
    await writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  async clear(): Promise<void> {
    this.data = { version: 2, updatedAt: Date.now(), nodes: {}, edges: {}, aliases: {} };
    await this.save();
  }
}

export const GRAPH_EXTRACT_PROMPT = `你从记忆文本里抽取实体和关系，输出 JSON，不要输出别的内容。

实体类型只有四种：person（人）、place（地点）、org（组织）、topic（话题/事物）。
关系只能连两个已抽出的实体，用简短动词或名词，比如"同事""住在""喜欢""去过""负责"。

要求：
- 名字用文本里出现的原文，不要改写、不要翻译
- 只抽文本里明确写了的内容，不要推断
- 没把握就少抽，空数组完全可以

输出格式：
{"entities":[{"name":"张三","type":"person"}],"relations":[{"from":"张三","to":"杭州","relation":"住在"}]}`;

export interface GraphExtraction {
  entities: Array<{ name: string; type: string }>;
  relations: Array<{ from: string; to: string; relation: string }>;
}

/** 从若干条记忆里抽实体与关系；失败返回空结果，不抛错 */
export async function extractGraph(
  client: TextCompleter,
  texts: string[],
): Promise<{ data?: GraphExtraction; warning?: string }> {
  const block = texts.filter((t) => t.trim()).map((t, i) => `${i + 1}. ${t}`).join('\n');
  if (!block.trim()) return { warning: '没有可抽取的记忆' };

  let raw = '';
  try {
    const res = await client.complete(
      [
        { role: 'system', content: GRAPH_EXTRACT_PROMPT },
        { role: 'user', content: `记忆：\n${block}` },
      ],
      { temperature: 0.1, maxTokens: 800, json: true },
    );
    raw = res.text;
  } catch (err) {
    return { warning: `抽取失败: ${err instanceof Error ? err.message : String(err)}` };
  }

  const parsed = extractJsonValue(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { warning: '模型输出不是 JSON 对象' };
  }
  const obj = parsed as Record<string, unknown>;
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  const entities = asArray(obj.entities)
    .map((item) => {
      const o = item as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      const type = typeof o.type === 'string' ? o.type : 'topic';
      return name ? { name, type } : undefined;
    })
    .filter((x): x is { name: string; type: string } => x !== undefined)
    .slice(0, 30);

  const relations = asArray(obj.relations)
    .map((item) => {
      const o = item as Record<string, unknown>;
      const from = typeof o.from === 'string' ? o.from.trim() : '';
      const to = typeof o.to === 'string' ? o.to.trim() : '';
      const relation = typeof o.relation === 'string' ? o.relation.trim() : '';
      return from && to && relation ? { from, to, relation } : undefined;
    })
    .filter((x): x is { from: string; to: string; relation: string } => x !== undefined)
    .slice(0, 40);

  return { data: { entities, relations } };
}
