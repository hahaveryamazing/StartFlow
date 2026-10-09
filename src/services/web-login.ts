import { invoke } from '@tauri-apps/api/core';
import type { LoginConfig, LoginSnapshot, LoginRun, BrowserAvailability } from '../types/web-login';
export const webLogin = {
  snapshot: () => invoke<LoginSnapshot>('web_login_snapshot'),
  save: (config: LoginConfig) => invoke<void>('web_login_save', { config }),
  remove: (id: string) => invoke<void>('web_login_delete', { id }),
  start: (id: string, authorized: boolean) =>
    invoke<LoginRun>('web_login_start', { id, authorized }),
  close: (id: string) => invoke<void>('web_login_close', { id }),
  prepareBrowser: (download: boolean) =>
    invoke<BrowserAvailability>('web_login_prepare_browser', { download }),
  cancelBrowser: () => invoke<void>('web_login_cancel_browser'),
};
