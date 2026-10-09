export type AccountKind = 'web' | 'app';
export interface Account {
  id: string;
  name: string;
  username: string;
  kind: AccountKind;
  target: string;
  credential_ref: string;
  created_at: string;
  updated_at: string;
  revision: number;
  credential_state: 'saved' | 'missing' | 'unavailable';
}
export interface AccountList {
  accounts: Account[];
  pending_cleanup: number;
}
// Write-only request. Never add this type to Snapshot, Zustand, logs or export models.
export interface AccountWrite {
  id: string | null;
  name: string;
  username: string;
  kind: AccountKind;
  target: string;
  password: string | null;
  expected_revision: number | null;
}
export interface AccountMutation {
  account: Account | null;
  pending_cleanup: number;
}
