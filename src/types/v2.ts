import type { Config, Scene, Task, Settings, Status } from './index';
export type Condition =
  | { type: 'time'; start: string; end: string }
  | { type: 'weekdays'; days: number[] }
  | { type: 'process' | 'file' | 'folder'; path: string }
  | { type: 'network' }
  | { type: 'service'; url: string; timeout_seconds: number };
export type NodeConfig =
  | { type: 'start' | 'end' }
  | { type: 'web' | 'app' | 'folder'; task_id: string }
  | { type: 'delay'; milliseconds: number }
  | { type: 'condition'; mode: 'and' | 'or'; conditions: Condition[] }
  | { type: 'network'; mode: 'local' | 'service'; url: string; timeout_seconds: number }
  | { type: 'layout'; layout_id: string; timeout_seconds: number }
  | {
      type: 'notification';
      title: string;
      body: string;
      level: 'info' | 'success' | 'warning' | 'error';
    }
  | { type: 'scene'; scene_id: string };
export interface WorkflowNode {
  id: string;
  name: string;
  x: number;
  y: number;
  config: NodeConfig;
  on_error: 'stop' | 'continue';
}
export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  handle: 'next' | 'true' | 'false';
}
export interface Workflow {
  id: string;
  scene_id: string;
  name: string;
  description: string;
  schema_version: number;
  enabled: boolean;
  max_seconds: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  created_at: string;
  updated_at: string;
}
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface Monitor {
  id: string;
  name: string;
  work: Rect;
  primary: boolean;
}
export interface LayoutItem {
  id: string;
  executable_path: string;
  title: string;
  title_mode: 'none' | 'exact' | 'contains';
  monitor_id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: 'normal' | 'maximized';
}
export interface WindowLayout {
  id: string;
  scene_id: string | null;
  name: string;
  monitors: Monitor[];
  items: LayoutItem[];
  missing_monitor: 'primary' | 'skip' | 'fallback';
  fallback_layout_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface WindowInfo {
  handle: number;
  pid: number;
  executable_path: string;
  title: string;
  rect: Rect;
  monitor_id: string;
  maximized: boolean;
}
export interface WindowInventory {
  windows: WindowInfo[];
  monitors: Monitor[];
  excluded_count: number;
}
export interface Shortcut {
  id: string;
  action: 'open' | 'palette' | 'scene' | 'pause' | 'resume';
  target_id: string;
  accelerator: string;
  enabled: boolean;
}
export interface Theme {
  preset: 'ocean' | 'white' | 'graphite' | 'forest' | 'twilight';
  radius: number;
  density: 'compact' | 'comfortable';
  background_style: 'solid' | 'gradient' | 'image';
  background_id: string | null;
  background_opacity: number;
  background_blur: number;
  background_fit: 'cover' | 'contain' | 'tile';
  backup_frequency: 'off' | 'daily' | 'weekly';
  backup_retention: number;
}
export interface Template {
  id: string;
  name: string;
  workflow: Workflow;
}
export interface Extension {
  workflows: Workflow[];
  bindings: { scene_id: string; workflow_id: string }[];
  layouts: WindowLayout[];
  shortcuts: Shortcut[];
  theme: Theme;
  templates: Template[];
}
export interface NodeLog {
  id: string;
  run_id: string;
  node_id: string;
  node_name: string;
  node_type: string;
  started_at: string | null;
  finished_at: string | null;
  status: Status;
  result: unknown;
  error_message: string;
}
export interface BackupRecord {
  id: string;
  filename: string;
  backup_type: string;
  created_at: string;
  size: number;
  status: string;
}
export interface V2Snapshot {
  extension: Extension;
  node_logs: NodeLog[];
  workflow_runs: { run_id: string; workflow_id: string; name: string }[];
  backups: BackupRecord[];
  shortcut_errors: [string, string][];
}
export interface Bundle {
  application: string;
  schema_version: number;
  exported_at: string;
  config: Config;
  extension: Extension;
  assets: { id: string; data: string }[];
}
export interface PaletteData {
  scenes: Scene[];
  tasks: Task[];
  settings: Settings;
  theme: Theme;
  shortcuts: Shortcut[];
}
export const defaultTheme: Theme = {
  preset: 'ocean',
  radius: 14,
  density: 'comfortable',
  background_style: 'solid',
  background_id: null,
  background_opacity: 0.2,
  background_blur: 4,
  background_fit: 'cover',
  backup_frequency: 'daily',
  backup_retention: 7,
};
export const emptyExtension: Extension = {
  workflows: [],
  bindings: [],
  layouts: [],
  shortcuts: [],
  templates: [],
  theme: defaultTheme,
};
