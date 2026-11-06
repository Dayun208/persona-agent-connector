import type { BehaviorConfig } from './config.js';
import type { Execution } from './protocol.js';

/**
 * 动作注册表 + 权限闸门
 *
 * Agent 只能"请求"执行动作, 真正做不做、能不能做由中间件说了算。
 * 这样即使模型被提示词注入, 也越不过 behavior.* 这几道开关。
 */

export type FlagKey = 'allowGroupManage' | 'allowFileSend' | 'allowSendImage' | 'allowRecall' | 'allowPoke';

export interface ActionSpec {
  name: string;
  /** 给模型看的说明 */
  prompt: string;
  /** 高危动作: 只有管理员(或显式允许)才能触发 */
  privileged: boolean;
  /** 对应的配置开关 */
  flag?: FlagKey;
  /** 危险动作：即使开了 allowUserActions，也只允许管理员触发 */
  adminOnly?: boolean;
  /** 参数要求 */
  requiredAny?: string[];
  requiredAll?: string[];
  /** 注入 Prompt 的示例 */
  example: Execution;
}

export const ACTION_SPECS: ActionSpec[] = [
  {
    name: 'send_message',
    prompt: '发送一条文字消息, 通常直接用 message 字段就够了, 不需要单独写这个动作',
    privileged: false,
    example: { action: 'send_message', target: '当前会话', params: {} },
  },
  {
    name: 'send_image',
    prompt: '发送一张图片, params.url 或 params.file 二选一',
    privileged: false,
    flag: 'allowSendImage',
    requiredAny: ['url', 'file'],
    example: { action: 'send_image', target: '当前会话', params: { url: 'https://example.com/cat.png' } },
  },
  {
    name: 'send_file',
    adminOnly: true,
    prompt: '向群里发送文件, params.file 为本地路径或 URL, params.name 为展示文件名',
    privileged: true,
    flag: 'allowFileSend',
    requiredAll: ['file'],
    example: { action: 'send_file', target: '当前会话', params: { file: '/tmp/report.pdf', name: 'report.pdf' } },
  },
  {
    name: 'group_manage',
    adminOnly: true,
    prompt:
      '群管理, params.op 取: ban(禁言, 附 durationSec) / kick(踢人) / set_card(改名片, 附 card) / '
      + 'whole_ban(全员禁言, 附 enable) / set_name(改群名, 附 name) / set_admin(设管理员, 附 enable) / '
      + 'special_title(设头衔, 附 title)。除 whole_ban/set_name 外都要附 params.userId',
    privileged: true,
    flag: 'allowGroupManage',
    requiredAll: ['op'],
    example: {
      action: 'group_manage',
      target: '当前会话',
      params: { op: 'ban', userId: '10001', durationSec: 600, reason: '刷屏' },
    },
  },
  {
    name: 'react',
    prompt: '给某条消息贴一个表情回应(NapCat 扩展), params.messageId 省略时回应触发消息, params.emojiId 默认 128077(👍)',
    privileged: false,
    example: { action: 'react', target: '当前会话', params: { emojiId: '128077' } },
  },
  {
    name: 'like',
    prompt: '给某个群友的名片点赞, params.userId 必填, params.times 默认 1 最多 10',
    privileged: false,
    requiredAll: ['userId'],
    example: { action: 'like', target: '当前会话', params: { userId: '10001', times: 3 } },
  },
  {
    name: 'recall',
    adminOnly: true,
    prompt: '撤回消息, params.messageId 省略时撤回机器人上一条消息',
    privileged: true,
    flag: 'allowRecall',
    example: { action: 'recall', target: '当前会话', params: {} },
  },
  {
    name: 'poke',
    prompt: '戳一戳某人, params.userId 为目标 QQ',
    privileged: false,
    flag: 'allowPoke',
    requiredAll: ['userId'],
    example: { action: 'poke', target: '当前会话', params: { userId: '10001' } },
  },
];

export interface ActionContext {
  /** 触发这次回复的用户是否为管理员 */
  isAdmin: boolean;
  /** behavior.allowUserActions 的值 */
  allowUserActions: boolean;
}

export type ActionCheck =
  | { ok: true; execution: Execution }
  | { ok: false; reason: string };

export class ActionGuard {
  private readonly specs = new Map(ACTION_SPECS.map((s) => [s.name, s]));

  constructor(private behavior: BehaviorConfig) {}

  update(behavior: BehaviorConfig): void {
    this.behavior = behavior;
  }

  getSpec(name: string): ActionSpec | undefined {
    return this.specs.get(name);
  }

  isAllowed(spec: ActionSpec, ctx: ActionContext): boolean {
    if (spec.flag && !this.behavior[spec.flag]) return false;
    if (spec.adminOnly && !ctx.isAdmin) return false;
    if (spec.privileged && !ctx.isAdmin && !ctx.allowUserActions) return false;
    return true;
  }

  check(raw: Execution, ctx: ActionContext): ActionCheck {
    const spec = this.specs.get(raw.action);
    if (!spec) {
      return { ok: false, reason: `不支持的动作: ${raw.action}` };
    }
    if (spec.flag && !this.behavior[spec.flag]) {
      return { ok: false, reason: `管理员未开启 ${spec.name} (behavior.${spec.flag}=false)` };
    }
    if (spec.adminOnly && !ctx.isAdmin) {
      return { ok: false, reason: `${spec.name} 只允许管理员触发` };
    }
    if (spec.privileged && !ctx.isAdmin && !this.behavior.allowUserActions) {
      return { ok: false, reason: `${spec.name} 是高危动作, 只有管理员可以触发` };
    }

    const params = raw.params ?? {};
    if (spec.requiredAll) {
      const missing = spec.requiredAll.filter((k) => params[k] === undefined || params[k] === '');
      if (missing.length > 0) {
        return { ok: false, reason: `${spec.name} 缺少参数: ${missing.join(', ')}` };
      }
    }
    if (spec.requiredAny) {
      const has = spec.requiredAny.some((k) => params[k] !== undefined && params[k] !== '');
      if (!has) {
        return { ok: false, reason: `${spec.name} 需要以下参数之一: ${spec.requiredAny.join(' 或 ')}` };
      }
    }

    return { ok: true, execution: { action: spec.name, target: raw.target, params } };
  }

  /** 生成注入 Prompt 的"可用动作"段落 */
  describeForPrompt(ctx: ActionContext): string {
    const lines: string[] = [];
    for (const spec of ACTION_SPECS) {
      if (spec.name === 'send_message') continue;
      const enabled = this.isAllowed(spec, ctx);
      const mark = enabled ? '✔' : '✘';
      const note = enabled ? '' : `(当前不可用${spec.flag && !this.behavior[spec.flag] ? ', 管理员已关闭' : ''})`;
      lines.push(`- ${mark} ${spec.name}: ${spec.prompt}${note}`);
      if (enabled) {
        lines.push(`  示例: ${JSON.stringify(spec.example)}`);
      }
    }
    return lines.join('\n');
  }
}
