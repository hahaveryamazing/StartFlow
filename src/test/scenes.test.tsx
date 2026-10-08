import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { SceneEditor } from '../features/scenes/SceneEditor';
import { SceneCard } from '../features/scenes/Scenes';
import { TaskEditor } from '../features/tasks/TaskEditor';
import { ConfirmProvider } from '../components/confirm';
import { useApp } from '../stores/app';
import { api } from '../services/api';
import { newScene, newTask, stamp } from '../utils/format';
import type { Snapshot } from '../types';
vi.mock('../services/api', () => ({
  api: { snapshot: vi.fn(), saveScene: vi.fn(), saveTask: vi.fn(), runScene: vi.fn() },
  errorMessage: () => '运行失败',
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
const scene = { ...newScene(), name: '办公' };
const task = { ...newTask(), name: '必应', url: 'https://www.bing.com' };
const data: Snapshot = {
  config: {
    version: 1,
    scenes: [scene],
    tasks: [task],
    scene_tasks: [{ id: crypto.randomUUID(), scene_id: scene.id, task_id: task.id, sort_order: 0 }],
    schedules: [],
    settings: {
      theme: 'dark',
      accent: '#3B82F6',
      animations: false,
      close_to_tray: true,
      notifications: false,
      show_on_autostart: false,
      default_scene_id: null,
      paused: false,
      onboarding_done: true,
    },
  },
  runs: [],
  logs: [],
  active_scenes: [],
  schedules: [],
  autostart_enabled: false,
  data_directory: 'test',
  today_auto_count: 0,
};
beforeEach(() => {
  vi.clearAllMocks();
  useApp.setState({ data, loading: false, error: null });
  vi.mocked(api.snapshot).mockResolvedValue(data);
  vi.mocked(api.saveScene).mockResolvedValue();
  vi.mocked(api.saveTask).mockResolvedValue();
  vi.mocked(api.runScene).mockResolvedValue('run-id');
});
afterEach(cleanup);
describe('场景实际交互', () => {
  it('创建场景传递稳定 ID 和真实表单值', async () => {
    const user = userEvent.setup();
    const draft = newScene();
    const close = vi.fn();
    render(<SceneEditor scene={draft} onClose={close} />);
    await user.type(screen.getByLabelText('场景名称'), '创作工作');
    await user.click(screen.getByRole('button', { name: '保存场景' }));
    await waitFor(() =>
      expect(api.saveScene).toHaveBeenCalledWith(
        expect.objectContaining({ id: draft.id, name: '创作工作', created_at: expect.any(String) }),
        [],
      ),
    );
    expect(close).toHaveBeenCalled();
  });
  it('编辑场景保留稳定关联与任务顺序', async () => {
    const user = userEvent.setup();
    render(<SceneEditor scene={scene} onClose={() => {}} />);
    const name = screen.getByLabelText('场景名称');
    await user.clear(name);
    await user.type(name, '新办公');
    await user.click(screen.getByRole('button', { name: '保存场景' }));
    await waitFor(() =>
      expect(api.saveScene).toHaveBeenCalledWith(
        expect.objectContaining({ id: scene.id, name: '新办公' }),
        [task.id],
      ),
    );
  });
  it('场景启动调用后端命令', async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <SceneCard scene={scene} onEdit={() => {}} />
      </ConfirmProvider>,
    );
    await user.click(screen.getByRole('button', { name: '启动场景' }));
    await waitFor(() => expect(api.runScene).toHaveBeenCalledWith(scene.id));
  });
  it('正在执行时禁止同场景再次点击', () => {
    useApp.setState({ data: { ...data, active_scenes: [scene.id] } });
    render(
      <ConfirmProvider>
        <SceneCard scene={scene} onEdit={() => {}} />
      </ConfirmProvider>,
    );
    expect(screen.getByRole('button', { name: '正在执行' })).toBeDisabled();
  });
  it('空名称不提交', async () => {
    const user = userEvent.setup();
    render(<SceneEditor scene={newScene()} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: '保存场景' }));
    expect(await screen.findByText('请填写场景名称')).toBeVisible();
    expect(api.saveScene).not.toHaveBeenCalled();
  });
  it('后端拒绝保存时保留编辑弹窗', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    vi.mocked(api.saveScene).mockRejectedValue({ message: '失败' });
    render(<SceneEditor scene={scene} onClose={close} />);
    await user.click(screen.getByRole('button', { name: '保存场景' }));
    await waitFor(() => expect(api.saveScene).toHaveBeenCalled());
    expect(close).not.toHaveBeenCalled();
  });
  it('任务网址拒绝任意脚本协议', async () => {
    const user = userEvent.setup();
    render(<TaskEditor task={{ ...task, url: 'javascript:alert(1)' }} onClose={() => {}} />);
    await user.click(screen.getByRole('button', { name: '保存任务' }));
    expect(await screen.findByText('请输入不含账号密码的完整 http 或 https 网址')).toBeVisible();
    expect(api.saveTask).not.toHaveBeenCalled();
  });
  it('任务参数作为独立数组保存', async () => {
    const user = userEvent.setup();
    render(
      <TaskEditor
        task={{
          ...task,
          kind: 'app',
          executable_path: 'C:\\应用 空格\\app.exe',
          arguments: ['--name', '中文 内容'],
          created_at: stamp(),
        }}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: '保存任务' }));
    await waitFor(() =>
      expect(api.saveTask).toHaveBeenCalledWith(
        expect.objectContaining({
          executable_path: 'C:\\应用 空格\\app.exe',
          arguments: ['--name', '中文 内容'],
        }),
      ),
    );
  });
});
