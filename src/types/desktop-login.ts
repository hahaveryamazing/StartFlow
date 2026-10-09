export interface DesktopLocator {
  automation_id: string;
  control_type: number;
  name: string;
  ancestor_id: string;
}
export interface DesktopWindow {
  handle: number;
  pid: number;
  creation_time: string;
  executable_path: string;
  title: string;
  class_name: string;
}
export interface DesktopControl {
  locator: DesktopLocator;
  is_password: boolean;
  enabled: boolean;
  visible: boolean;
  value_supported: boolean;
  invoke_supported: boolean;
  read_only: boolean;
}
export interface DesktopConfig {
  id: string;
  account_id: string;
  credential_ref: string;
  schema_version: 1;
  name: string;
  executable_path: string;
  window_class: string;
  window_title: string;
  username: DesktopLocator;
  password: DesktopLocator;
  submit: DesktopLocator;
  success: DesktopLocator;
  identity: DesktopLocator;
  failure: DesktopLocator | null;
  challenge: DesktopLocator | null;
  timeout_seconds: number;
}
export interface DesktopResponse {
  status: string;
  message: string;
  windows: DesktopWindow[];
  controls: DesktopControl[];
  submitted: boolean;
}
export interface DesktopRun {
  id: string;
  config_id: string;
  account_id: string;
  started_at: string;
  finished_at: string | null;
  result: DesktopResponse;
}
export interface DesktopSnapshot {
  configs: DesktopConfig[];
  runs: DesktopRun[];
}
