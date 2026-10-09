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
  schema_version?: 1 | 2;
  credential_ref?: string;
  locators?: LocatorSet;
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
  | 'interrupted'
  | 'locator_invalid';
// Typed locators are data, never executable code or regular expressions.
export type LocatorRule =
  | { kind: 'css' | 'label' | 'placeholder' | 'test_id'; value: string }
  | { kind: 'role'; role: 'textbox' | 'button' | 'link' | 'heading' | 'status'; name: string };
export type LocatorField =
  'username' | 'password' | 'submit' | 'success' | 'identity' | 'challenge' | 'failure';
export type LocatorSet = Record<LocatorField, LocatorRule>;
export interface Recording {
  id: string;
  account_id: string;
  credential_ref: string;
  origin: string;
  login_url: string;
  status:
    | 'starting'
    | 'ready'
    | 'picking'
    | 'manual'
    | 'invalid'
    | 'blocked'
    | 'failed'
    | 'closed'
    | 'interrupted';
  message: string;
  active: boolean;
  rules: Partial<LocatorSet>;
  form_action_url: string | null;
  results: Partial<
    Record<
      LocatorField,
      'ok' | 'absent' | 'ambiguous' | 'invalid' | 'form_mismatch' | 'identity_mismatch'
    >
  >;
  verified_login: boolean;
  verified_success: boolean;
}
export type RecorderCommand =
  | { type: 'arm'; field: LocatorField }
  | { type: 'test'; rules: Partial<LocatorSet> }
  | { type: 'manual' | 'reload' };
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
  browser: BrowserAvailability;
}
export interface BrowserAvailability {
  status: 'checking' | 'downloading' | 'ready' | 'missing' | 'failed' | 'cancelled' | '';
  source: 'edge' | 'chrome' | 'managed' | null;
  version: string | null;
  message: string;
}
