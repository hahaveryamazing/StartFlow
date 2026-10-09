import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Snapshot, Scene, Task, Schedule, Settings, Config, LogPage } from '../types';
export function errorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  )
    return error.message;
  return '操作未完成，请重试或重新启动软件。';
}
export function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri())
    return Promise.reject(new Error('请使用 StartFlow 桌面应用；浏览器页面无法访问本地启动服务。'));
  return invoke<T>(command, args);
}
export const queryLogs = (date: string, sceneId: string, status: string, offset: number) =>
  call<LogPage>('query_logs', { date, sceneId, status, offset });
export const api = {
  snapshot: async (): Promise<Snapshot> => {
    const [base, v3] = await Promise.all([
      call<Snapshot>('snapshot'),
      call<import('../types/v3').AutomationStatus>('v3_snapshot'),
    ]);
    return { ...base, v3 };
  },
  saveScene: (scene: Scene, taskIds: string[]) => call<void>('save_scene', { scene, taskIds }),
  saveTask: (task: Task) => call<void>('save_task', { task }),
  saveSchedule: (schedule: Schedule) => call<void>('save_schedule', { schedule }),
  saveSettings: (settings: Settings) => call<void>('save_settings', { settings }),
  runScene: (sceneId: string) => call<string>('run_scene', { sceneId }),
  runTask: (taskId: string) => call<string>('run_task', { taskId }),
  remove: (kind: string, entityId: string) => call<void>('delete_entity', { kind, entityId }),
  duplicate: (sceneId: string) => call<void>('duplicate_scene', { sceneId }),
  autostart: (enabled: boolean) => call<boolean>('set_autostart', { enabled }),
  readImport: (path: string) => call<Config>('read_import', { path }),
  applyImport: (config: Config) => call<void>('apply_import', { config }),
  export: (path: string) => call<void>('export_config', { path }),
  clearLogs: () => call<void>('clear_logs'),
  openDirectory: () => call<void>('open_data_directory'),
  quit: () => call<void>('quit'),
};
