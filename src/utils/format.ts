import type { Config, Scene, Task, Schedule } from '../types';
export const id = () => crypto.randomUUID();
export const stamp = () => new Date().toISOString();
export const datetime = (s: string | null | undefined) =>
  s
    ? new Date(s).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '尚未执行';
export const time = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';
export const orderedTasks = (c: Config, sceneId: string) =>
  c.scene_tasks
    .filter((a) => a.scene_id === sceneId)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((a) => a.task_id);
export const newScene = (): Scene => ({
  id: id(),
  name: '',
  description: '',
  icon: 'briefcase',
  color: '#3B82F6',
  enabled: true,
  sort_order: 0,
  created_at: stamp(),
  updated_at: stamp(),
});
export const newTask = (): Task => ({
  id: id(),
  name: '',
  kind: 'web',
  url: '',
  executable_path: '',
  arguments: [],
  working_directory: '',
  browser_mode: 'default',
  browser_path: '',
  delay_ms: 0,
  wait_for_network: false,
  skip_if_running: true,
  enabled: true,
  created_at: stamp(),
  updated_at: stamp(),
});
export const newSchedule = (sceneId: string): Schedule => ({
  id: id(),
  scene_id: sceneId,
  trigger_type: 'daily',
  time_of_day: '09:00',
  weekdays: [1, 2, 3, 4, 5],
  delay_seconds: 10,
  catch_up_minutes: 120,
  enabled: true,
  created_at: stamp(),
  updated_at: stamp(),
});
export const kindLabel = { web: '网页', app: '应用程序', folder: '文件夹' };
export const triggerLabel: Record<string, string> = {
  shortcut: '快捷键',
  test: '工作流测试',
  manual: '手动启动',
  login: '登录启动',
  daily: '每日计划',
  weekly: '每周计划',
  recovery: '错过后补执行',
};
export const statusLabel: Record<string, string> = {
  completed: '流程已完成',
  cancelled: '已取消',
  interrupted: '上次执行中断',
  timed_out: '执行超时',
  pending: '等待执行',
  running: '正在执行',
  launch_requested: '请求已提交',
  skipped: '已跳过',
  failed: '执行失败',
  partial: '部分失败',
};
export const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
