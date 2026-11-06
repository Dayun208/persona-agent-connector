import { describe, expect, it } from 'vitest';
import { ActionGuard, normalizeConfig } from '@pasc/core';

const behavior = normalizeConfig({}).behavior;

describe('ActionGuard 权限', () => {
  it('允许普通发消息', () => {
    const guard = new ActionGuard(behavior);
    const r = guard.check({ action: 'send_message', params: { text: 'hi' } }, { isAdmin: false, allowUserActions: false });
    expect(r.ok).toBe(true);
  });

  it('未知动作直接拒绝', () => {
    const guard = new ActionGuard(behavior);
    const r = guard.check({ action: 'rm_rf', params: {} }, { isAdmin: true, allowUserActions: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('不支持的动作');
  });

  it('高危动作非管理员不可触发', () => {
    const guard = new ActionGuard(behavior);
    const r = guard.check(
      { action: 'group_manage', params: { op: 'ban', userId: '1' } },
      { isAdmin: false, allowUserActions: false },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('只允许管理员');
  });

  it('allowUserActions 打开后，群管理仍然只认管理员', () => {
    // 群友触发的消息可能被提示词注入，禁言/踢人不能靠 allowUserActions 放开
    const cfg = normalizeConfig({ behavior: { allowUserActions: true } });
    const guard = new ActionGuard(cfg.behavior);
    const r = guard.check(
      { action: 'group_manage', params: { op: 'ban', userId: '1' } },
      { isAdmin: false, allowUserActions: true },
    );
    expect(r.ok).toBe(false);
  });

  it('allowUserActions 打开后，普通互动动作对群友开放', () => {
    const cfg = normalizeConfig({ behavior: { allowUserActions: true, allowPoke: true } });
    const guard = new ActionGuard(cfg.behavior);
    const r = guard.check({ action: 'poke', params: { userId: '10001' } }, { isAdmin: false, allowUserActions: true });
    expect(r.ok).toBe(true);
  });

  it('配置开关关闭时不可用', () => {
    const cfg = normalizeConfig({ behavior: { allowFileSend: false } });
    const guard = new ActionGuard(cfg.behavior);
    const r = guard.check({ action: 'send_file', params: { file: '/tmp/a.pdf' } }, { isAdmin: true, allowUserActions: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('allowFileSend');
  });

  it('缺参数时拒绝', () => {
    const guard = new ActionGuard(behavior);
    const r = guard.check({ action: 'send_image', params: {} }, { isAdmin: false, allowUserActions: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('url 或 file');
  });

  it('requiredAll 参数缺失时拒绝', () => {
    const guard = new ActionGuard(behavior);
    const r = guard.check({ action: 'group_manage', params: { userId: '1' } }, { isAdmin: true, allowUserActions: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('op');
  });

  it('注入 Prompt 的说明只列出可用动作', () => {
    const cfg = normalizeConfig({ behavior: { allowFileSend: false, allowGroupManage: false } });
    const guard = new ActionGuard(cfg.behavior);
    const text = guard.describeForPrompt({ isAdmin: true, allowUserActions: false });
    expect(text).toContain('✘ send_file');
    expect(text).toContain('✘ group_manage');
    expect(text).toContain('✔ send_image');
  });
});
