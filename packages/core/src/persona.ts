import { randomUUID } from 'node:crypto';
import { readJsonFile, writeJsonFile } from './store.js';
import { truncate } from './text.js';

export interface Persona {
  id: string;
  name: string;
  /** 一句话简介, 给判断模型看 */
  description: string;
  /** 人格描述 markdown, 直接注入 Prompt */
  content: string;
  updatedAt: number;
  /** 这个人格从谁身上提纯（每个目标用户一份） */
  distill?: PersonaDistillTarget;
}

export interface PersonaDistillTarget {
  /** 只从这个会话抽；不填表示全部会话 */
  sceneKey?: string;
  /** 目标用户 QQ */
  senderId: string;
  /** 目标用户昵称（仅展示用） */
  senderName?: string;
  /** 自动提纯：目标用户攒够新发言后自动重跑 */
  auto: boolean;
  /** 上次提纯完成时间 */
  lastRunAt?: number;
  /** 上次提纯后又积累了多少条目标用户发言 */
  lastMessageCount?: number;
}

interface PersonaDb {
  activeId: string | null;
  items: Persona[];
}

const DEFAULT_PERSONA: Omit<Persona, 'id' | 'updatedAt'> = {
  name: '小明',
  description: '群里的老熟人, 说话随意但不招人烦, 偶尔嘴贫',
  content: [
    '你叫小明, 在这个群里待了两年多, 和大家都很熟。',
    '',
    '## 性格',
    '- 说话随意、松弛, 不会端着, 偶尔损人但从不恶意。',
    '- 有点懒, 长问题会先看完再答, 不确定就说"不太清楚"。',
    '- 遇到感兴趣的技术或游戏话题会多说两句, 八卦话题只围观不传谣。',
    '',
    '## 说话习惯',
    '- 短句为主, 常带"啊""吧""其实""就"。',
    '- 很少用感叹号, 不用表情包刷屏, 偶尔一个"草"或"笑死"。',
    '- 不主动说教, 不发表情包式敷衍, 不一句话回三个问题。',
    '',
    '## 禁忌',
    '- 不吵架, 不站队, 不评价群友的长相和家境。',
    '- 不装作什么都会, 不懂就承认。',
  ].join('\n'),
};

/**
 * 人格库。里程碑 1 支持多个人格条目 + 一个 active,
 * 人格正文是纯 markdown, 方便直接写进 Prompt 或 OpenClaw 的 markdown 文件。
 */
export class PersonaStore {
  private db: PersonaDb = { activeId: null, items: [] };

  private constructor(private readonly file: string) {}

  static async open(file: string, opts: { seed?: boolean } = {}): Promise<PersonaStore> {
    const store = new PersonaStore(file);
    store.db = await readJsonFile<PersonaDb>(file, { activeId: null, items: [] });
    if (!Array.isArray(store.db.items)) store.db = { activeId: null, items: [] };
    if (store.db.items.length === 0 && (opts.seed ?? true)) {
      const seeded = store.upsert(DEFAULT_PERSONA);
      store.db.activeId = seeded.id;
      await store.flush();
    }
    return store;
  }

  list(): Persona[] {
    return [...this.db.items];
  }

  get(id: string): Persona | undefined {
    return this.db.items.find((p) => p.id === id);
  }

  getActive(): Persona | undefined {
    if (!this.db.activeId) return this.db.items[0];
    return this.get(this.db.activeId) ?? this.db.items[0];
  }

  get activeId(): string | null {
    return this.db.activeId;
  }

  upsert(input: Partial<Persona> & { name: string }): Persona {
    const existing = input.id ? this.get(input.id) : undefined;
    if (existing) {
      if (input.name !== undefined) existing.name = input.name;
      if (input.description !== undefined) existing.description = input.description;
      if (input.content !== undefined) existing.content = input.content;
      if (input.distill !== undefined) existing.distill = input.distill;
      existing.updatedAt = Date.now();
      return existing;
    }
    const persona: Persona = {
      id: input.id ?? randomUUID(),
      name: input.name,
      description: input.description ?? '',
      content: input.content ?? '',
      updatedAt: Date.now(),
      ...(input.distill ? { distill: input.distill } : {}),
    };
    this.db.items.push(persona);
    return persona;
  }

  remove(id: string): boolean {
    const idx = this.db.items.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.db.items.splice(idx, 1);
    if (this.db.activeId === id) this.db.activeId = this.db.items[0]?.id ?? null;
    return true;
  }

  setActive(id: string): boolean {
    if (!this.get(id)) return false;
    this.db.activeId = id;
    return true;
  }

  /** 给判断模型用的人格摘要 */
  summary(maxLen = 120): string {
    const p = this.getActive();
    if (!p) return '';
    const desc = p.description || p.content;
    return `${p.name}: ${truncate(desc, maxLen)}`;
  }

  async flush(): Promise<void> {
    await writeJsonFile(this.file, this.db);
  }

  async save(): Promise<void> {
    await this.flush();
  }
}
