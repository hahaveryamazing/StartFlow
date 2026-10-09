export interface LoginConfig {
  id: string;
  account_id: string;
  name: string;
  origin: string;
  login_url: string;
  form_action_url: string;
  username_selector: string;
  password_selector: string;
  submit_selector: string;
  success_selector: string;
  identity_selector: string;
  challenge_selector: string;
  failure_selector: string;
  timeout_seconds: number;
}
export type LoginStatus =
  | 'checking_session'
  | 'logging_in'
  | 'authenticated'
  | 'session_reused'
  | 'session_expired'
  | 'waiting_manual'
  | 'failed'
  | 'timeout'
  | 'blocked'
  | 'authorization_required'
  | 'cooldown'
  | 'closed'
  | 'interrupted';
export interface LoginRun {
  id: string;
  config_id: string;
  account_id: string;
  status: LoginStatus;
  submitted: boolean;
  started_at: string;
  updated_at: string;
  message: string;
}
export interface LoginSnapshot {
  configs: LoginConfig[];
  runs: LoginRun[];
  active_runs: string[];
  runtime_ready: boolean;
}
