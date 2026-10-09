export type Availability =
  'available' | 'unavailable' | 'permission_denied' | 'unsupported' | 'error';
export interface Field<T> {
  status: Availability;
  value: T | null;
  reason: string;
}
export interface Display {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
  scale: number;
}
export interface Context {
  id: string;
  schema_version: number;
  captured_at: string;
  network_connected: Field<boolean>;
  network_type: Field<string>;
  wifi_ssid: Field<string>;
  wifi_network_id: Field<string>;
  displays: Field<Display[]>;
  power_source: Field<string>;
  battery_percentage: Field<number>;
  session: Field<string>;
  processes: Record<string, { running: Field<boolean>; window: Field<boolean> }>;
  services: Record<string, Field<boolean>>;
  capabilities: Record<string, Field<boolean>>;
}
export type EventKind =
  | 'login'
  | 'unlock'
  | 'resume'
  | 'network'
  | 'displays'
  | 'power'
  | 'processes'
  | 'schedule'
  | 'refresh';
export type Expression =
  | { type: 'group'; operator: 'and' | 'or' | 'not'; children: Condition[] }
  | { type: 'network'; connected: boolean }
  | { type: 'wifi'; network_id: string }
  | { type: 'monitors'; minimum: number; maximum: number }
  | { type: 'power'; source: 'ac' | 'battery' }
  | { type: 'session'; state: string }
  | { type: 'weekdays'; days: number[] }
  | { type: 'time'; start: string; end: string }
  | { type: 'process'; task_id: string; state: string }
  | { type: 'service'; url: string };
export interface Condition {
  id: string;
  enabled: boolean;
  expression: Expression;
}
export interface Target {
  scene_id: string;
  workflow_id: string | null;
}
export interface Rule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  version: number;
  priority: number;
  triggers: EventKind[];
  condition: Condition;
  target: Target;
  mode_id: string | null;
  policy: 'notify' | 'confirm' | 'auto';
  cooldown_seconds: number;
  stability_seconds: number;
  schedule: { time: string; days: number[]; catch_up_minutes: number } | null;
  created_at: string;
  updated_at: string;
}
export interface Mode {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  enabled: boolean;
  priority: number;
  exclusive_group: string;
  strategy: 'manual' | 'suggest' | 'auto';
  targets: Target[];
  created_at: string;
  updated_at: string;
}
export interface Permissions {
  wifi: boolean;
  displays: boolean;
  power: boolean;
  session: boolean;
  processes: boolean;
  services: boolean;
  ai: boolean;
}
export interface TrustedNetwork {
  id: string;
  name: string;
  sealed_ssid: string;
}
export interface AutomationConfig {
  schema_version: number;
  enabled: boolean;
  retention_days: number;
  permissions: Permissions;
  networks: TrustedNetwork[];
  rules: Rule[];
  modes: Mode[];
}
export type Match = 'true' | 'false' | 'unknown' | 'error';
export interface Trace {
  condition_id: string;
  result: Match;
  explanation: string;
  children: Trace[];
}
export interface Decision {
  id: string;
  rule_id: string;
  rule_name: string;
  rule_version: number;
  snapshot_id: string;
  event_id: string;
  evaluated_at: string;
  match_result: Match;
  decision: string;
  reasons: string[];
  trace: Trace;
  targets: Target[];
  execution_run_ids: string[];
  next_eligible_at: string | null;
}
export interface Override {
  id: string;
  mode_id: string;
  kind: string;
  expires_at: string | null;
  created_at: string;
}
export interface AutomationStatus {
  config: AutomationConfig;
  context: Context;
  decisions: Decision[];
  manual_override: Override | null;
  current_mode: string | null;
  stable_seconds: number;
  subscription_error: string | null;
  paused: boolean;
}
export const eventLabels: Record<EventKind, string> = {
  login: 'Windows 登录',
  unlock: '系统解锁',
  resume: '睡眠恢复',
  network: '网络变化',
  displays: '显示器变化',
  power: '电源变化',
  processes: '指定应用变化',
  schedule: '定时到达',
  refresh: '主动重新评估',
};
export const decisionLabels: Record<string, string> = {
  execute: '将执行',
  notify: '仅提示',
  waiting_confirmation: '等待确认',
  running: '正在执行',
  completed: '已完成',
  skipped: '已跳过',
  failed: '执行失败',
  cancelled: '已取消',
  interrupted: '已中断',
  timed_out: '执行超时',
};
export const matchLabels: Record<Match, string> = {
  true: '条件满足',
  false: '条件不满足',
  unknown: '环境未知',
  error: '检测错误',
};
export function condition(expression: Expression): Condition {
  return { id: crypto.randomUUID(), enabled: true, expression };
}
export function newRule(sceneId = ''): Rule {
  return {
    id: crypto.randomUUID(),
    name: '新的智能规则',
    description: '',
    enabled: false,
    version: 1,
    priority: 50,
    triggers: ['unlock'],
    condition: condition({
      type: 'group',
      operator: 'and',
      children: [condition({ type: 'network', connected: true })],
    }),
    target: { scene_id: sceneId, workflow_id: null },
    mode_id: null,
    policy: 'confirm',
    cooldown_seconds: 300,
    stability_seconds: 5,
    schedule: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}
