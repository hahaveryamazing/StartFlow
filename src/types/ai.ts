import type { Rule } from './v3';
import type { Workflow } from './v2';
export interface AISettings {
  id: string;
  enabled: boolean;
  provider_type: 'cloud' | 'local';
  endpoint: string;
  model: string;
  history: boolean;
}
export type AIConfiguration =
  | { type: 'rule'; rule: Rule | null; missing: string[]; notes: string[] }
  | { type: 'workflow'; workflow: Workflow | null; missing: string[]; notes: string[] }
  | { type: 'explanation'; explanation: string };
export interface AIDraft {
  schema_version: number;
  id: string;
  created_at: string;
  configuration: AIConfiguration;
  valid: boolean;
  errors: string[];
  provider: string;
}
export interface AIStatus {
  settings: AISettings;
  credential_present: boolean;
  drafts: AIDraft[];
}
export interface AIRequest {
  kind: 'rule' | 'workflow' | 'explanation';
  prompt: string;
  scene_id: string;
  task_ids: string[];
  layout_ids: string[];
  rule_id: string | null;
  login_configs?: { target: 'web' | 'desktop'; id: string }[];
}
export interface AIPreview {
  token: string;
  endpoint: string;
  provider_type: string;
  payload: unknown;
  warning: string;
}
