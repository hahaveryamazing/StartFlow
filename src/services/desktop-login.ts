import { invoke } from '@tauri-apps/api/core';
import type {
  DesktopConfig,
  DesktopResponse,
  DesktopRun,
  DesktopSnapshot,
  DesktopWindow,
} from '../types/desktop-login';
export const desktopLogin = {
  snapshot: () => invoke<DesktopSnapshot>('desktop_login_snapshot'),
  windows: (accountId: string) => invoke<DesktopResponse>('desktop_login_windows', { accountId }),
  inspect: (accountId: string, target: DesktopWindow) =>
    invoke<DesktopResponse>('desktop_login_inspect', { accountId, target }),
  test: (config: DesktopConfig, target: DesktopWindow) =>
    invoke<DesktopResponse>('desktop_login_test', { config, target }),
  save: (config: DesktopConfig) => invoke<void>('desktop_login_save', { config }),
  remove: (id: string) => invoke<void>('desktop_login_delete', { id }),
  run: (id: string, authorized: boolean) =>
    invoke<DesktopRun>('desktop_login_run', { id, authorized }),
};
