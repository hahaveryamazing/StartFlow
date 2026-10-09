import { invoke } from '@tauri-apps/api/core';
import type { Recording, RecorderCommand } from '../types/web-login';
export const recorder = {
  start: (accountId: string, loginUrl: string) =>
    invoke<Recording>('web_recorder_start', { accountId, loginUrl }),
  snapshot: () => invoke<Recording | null>('web_recorder_snapshot'),
  command: (id: string, command: RecorderCommand) =>
    invoke<void>('web_recorder_command', { id, command }),
  close: (id: string) => invoke<void>('web_recorder_close', { id }),
};
