import { invoke } from '@tauri-apps/api/core';
import type { AccountList, AccountMutation, AccountWrite } from '../types/accounts';
export const accounts = {
  list: () => invoke<AccountList>('accounts_list'),
  save: (request: AccountWrite) => invoke<AccountMutation>('accounts_save', { request }),
  delete: (id: string, expectedRevision: number) =>
    invoke<AccountMutation>('accounts_delete', { id, expectedRevision }),
  exists: (id: string) => invoke<boolean>('accounts_exists', { id }),
  cleanup: () => invoke<number>('accounts_retry_cleanup'),
};
