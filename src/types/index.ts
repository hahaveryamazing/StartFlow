export interface Scene {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}
export interface Task {
  id: string;
  name: string;
  kind: 'web' | 'app' | 'folder';
  url: string;
  executable_path: string;
  arguments: string[];
  working_directory: string;
  browser_mode: 'default' | 'custom';
  browser_path: string;
  delay_ms: number;
  wait_for_network: boolean;
  skip_if_running: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}
export interface SceneTask {
  id: string;
  scene_id: string;
  task_id: string;
  sort_order: number;
}
export interface Schedule {
  id: string;
  scene_id: string;
  trigger_type: 'login' | 'daily' | 'weekly';
  time_of_day: string;
  weekdays: number[];
  delay_seconds: number;
  catch_up_minutes: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}
export interface Settings {
  theme: 'dark' | 'light' | 'system';
  accent: string;
  animations: boolean;
  close_to_tray: boolean;
  notifications: boolean;
  show_on_autostart: boolean;
  default_scene_id: string | null;
  paused: boolean;
  onboarding_done: boolean;
}
export interface Config {
  version: number;
  scenes: Scene[];
  tasks: Task[];
  scene_tasks: SceneTask[];
  schedules: Schedule[];
  settings: Settings;
}
export type Status =
  | 'pending'
  | 'running'
  | 'launch_requested'
  | 'skipped'
  | 'failed'
  | 'partial'
  | 'completed'
  | 'cancelled'
  | 'interrupted'
  | 'timed_out';
export interface Run {
  id: string;
  scene_id: string | null;
  scene_name_snapshot: string;
  trigger_type: string;
  rule_id: string | null;
  started_at: string;
  finished_at: string | null;
  status: Status;
  local_run_date: string;
}
export interface Log {
  id: string;
  run_id: string;
  task_id: string;
  task_name_snapshot: string;
  started_at: string | null;
  finished_at: string | null;
  status: Status;
  message: string;
}
export interface Snapshot {
  v3?: import('./v3').AutomationStatus;
  v2?: import('./v2').V2Snapshot;
  config: Config;
  runs: Run[];
  logs: Log[];
  active_scenes: string[];
  schedules: { id: string; last_triggered_at: string | null; next_trigger_at: string | null }[];
  autostart_enabled: boolean;
  data_directory: string;
  today_auto_count: number;
}
export type Page =
  | 'accounts'
  | 'dashboard'
  | 'modes'
  | 'rules'
  | 'simulator'
  | 'decisions'
  | 'analytics'
  | 'ai'
  | 'scenes'
  | 'workflows'
  | 'tasks'
  | 'schedules'
  | 'layouts'
  | 'logs'
  | 'settings';
export interface LogPage {
  runs: Run[];
  logs: Log[];
  total: number;
  requested: number;
  failed: number;
  skipped: number;
  scene_choices: [string, string][];
}
