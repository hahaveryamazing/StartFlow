import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { condition, newRule, type AutomationConfig, type Context } from '../types/v3';
import { ConditionEditor, defaultExpression } from '../features/automation-rules/ConditionEditor';
import { RuleSimulator } from '../features/rule-simulator/RuleSimulator';
import { useApp } from '../stores/app';
import type { Snapshot } from '../types';
import { v3 } from '../services/v3';
import { modeRuleDraft } from '../features/workspace-modes/presets';
vi.mock('../services/v3', () => ({ v3: { simulate: vi.fn() } }));
it('模式模板仅生成禁用的确认草稿，不猜测本地程序和办公网络', () => {
  const mode = {
    id: crypto.randomUUID(),
    name: '办公',
    priority: 50,
    targets: [{ scene_id: crypto.randomUUID(), workflow_id: null }],
  } as Parameters<typeof modeRuleDraft>[1];
  for (let index = 0; index < 3; index++) {
    const rule = modeRuleDraft(index, mode)!;
    expect(rule.enabled).toBe(false);
    expect(rule.policy).toBe('confirm');
    expect(rule.mode_id).toBe(mode.id);
    expect(JSON.stringify(rule.condition)).not.toContain('executable_path');
  }
  expect(modeRuleDraft(3, mode)).toBeNull();
});
const field = <T,>(value: T) => ({ status: 'available' as const, value, reason: '' });
const absent = { status: 'unavailable' as const, value: null, reason: '未授权' };
const context: Context = {
  id: crypto.randomUUID(),
  schema_version: 1,
  captured_at: '2026-10-08T09:00:00+08:00',
  network_connected: field(true),
  network_type: field('ethernet'),
  wifi_ssid: absent,
  wifi_network_id: absent,
  displays: field([]),
  power_source: field('ac'),
  battery_percentage: absent,
  session: field('active'),
  processes: {},
  services: {},
  capabilities: {},
};
const config: AutomationConfig = {
  schema_version: 1,
  enabled: true,
  retention_days: 30,
  permissions: {
    wifi: false,
    displays: true,
    power: true,
    session: true,
    processes: false,
    services: false,
    ai: false,
  },
  rules: [],
  modes: [],
  networks: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  const data: Snapshot = {
    config: {
      version: 1,
      scenes: [],
      tasks: [],
      scene_tasks: [],
      schedules: [],
      settings: {
        theme: 'dark',
        accent: '#3B82F6',
        animations: false,
        close_to_tray: true,
        notifications: false,
        show_on_autostart: false,
        default_scene_id: null,
        paused: false,
        onboarding_done: true,
      },
    },
    runs: [],
    logs: [],
    active_scenes: [],
    schedules: [],
    autostart_enabled: false,
    data_directory: 'test',
    today_auto_count: 0,
    v3: {
      config,
      context,
      decisions: [],
      manual_override: null,
      current_mode: null,
      stable_seconds: 10,
      subscription_error: null,
      paused: false,
    },
  };
  useApp.setState({ data, loading: false, error: null });
  vi.mocked(v3.simulate).mockResolvedValue([]);
});
afterEach(cleanup);
it('新规则默认请求确认且停用，条件稳定 ID 独立', () => {
  const a = newRule(),
    b = newRule();
  expect(a.enabled).toBe(false);
  expect(a.policy).toBe('confirm');
  expect(a.cooldown_seconds).toBe(300);
  expect(a.id).not.toBe(b.id);
  expect(a.condition.id).not.toBe(b.condition.id);
});
it('条件表单可切换 NOT；裁剪子节点，不改变保留节点 ID', () => {
  const start = condition({
    type: 'group',
    operator: 'and',
    children: [condition(defaultExpression('network')), condition(defaultExpression('power'))],
  });
  const change = vi.fn();
  function Probe() {
    const [value, setValue] = useState(start);
    return (
      <ConditionEditor
        value={value}
        config={config}
        onChange={(v) => {
          setValue(v);
          change(v);
        }}
      />
    );
  }
  render(<Probe />);
  fireEvent.change(screen.getByLabelText('组合方式'), { target: { value: 'not' } });
  expect(change.mock.calls.at(-1)?.[0].expression.children).toHaveLength(1);
  expect(change.mock.calls.at(-1)?.[0].expression.children[0].id).toBe(
    start.expression.type === 'group' ? start.expression.children[0].id : '',
  );
});
it('模拟器调用后端并明确零系统操作，不创建前端执行状态', async () => {
  render(<RuleSimulator />);
  fireEvent.click(screen.getByText('模拟执行（无系统操作）'));
  await waitFor(() => expect(v3.simulate).toHaveBeenCalledTimes(1));
  expect(v3.simulate).toHaveBeenCalledWith(
    expect.objectContaining({ schema_version: 1 }),
    'refresh',
    false,
    10,
    null,
  );
  expect(await screen.findByText('没有已启用且匹配触发类型的规则。')).toBeVisible();
});
