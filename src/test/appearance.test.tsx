import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Settings } from '../features/settings/Settings';
import { useAppearancePreview } from '../features/themes/preview';
import { useTheme } from '../features/themes/useTheme';
import { useApp } from '../stores/app';
import { api } from '../services/api';
import { emptyExtension } from '../types/v2';
import type { Snapshot } from '../types';
import { ConfirmProvider } from '../components/confirm';
import { toast } from 'sonner';

vi.mock('../services/api', () => ({
  api: { saveSettings: vi.fn(), snapshot: vi.fn() },
  errorMessage: () => '保存失败',
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../features/privacy/Privacy', () => ({ Privacy: () => null }));
vi.mock('../features/backups/Backups', () => ({ Backups: () => null }));
vi.mock('../features/shortcuts/Shortcuts', () => ({ Shortcuts: () => null }));
let data: Snapshot;
function Preview() {
  const preview = useAppearancePreview((s) => s.preview);
  useTheme(preview?.settings ?? data.config.settings, preview?.theme ?? data.v2!.extension.theme);
  return null;
}
function mount() {
  render(
    <ConfirmProvider>
      <Preview />
      <Settings />
    </ConfirmProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  useAppearancePreview.getState().setPreview(null);
  data = {
    config: {
      version: 1,
      scenes: [],
      tasks: [],
      scene_tasks: [],
      schedules: [],
      settings: {
        theme: 'dark',
        accent: '#3b82f6',
        animations: true,
        close_to_tray: true,
        notifications: true,
        show_on_autostart: false,
        default_scene_id: null,
        paused: true,
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
    v2: {
      extension: structuredClone(emptyExtension),
      node_logs: [],
      workflow_runs: [],
      backups: [],
      shortcut_errors: [],
    },
  };
  useApp.setState({ data, loading: false, error: null });
  vi.mocked(api.snapshot).mockImplementation(async () => data);
  vi.mocked(api.saveSettings).mockImplementation(async (settings, theme) => {
    data = {
      ...data,
      config: { ...data.config, settings },
      v2: {
        ...data.v2!,
        extension: { ...data.v2!.extension, theme: theme ?? data.v2!.extension.theme },
      },
    };
  });
});
afterEach(() => {
  cleanup();
  useAppearancePreview.getState().setPreview(null);
});
describe('应用内改色与统一保存', () => {
  it('点击打开应用内面板并预览色块，底部保存包含强调色与完整主题', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '选择主题强调色' }));
    expect(screen.getByRole('dialog', { name: '选择主题强调色' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '颜色 #22c55e' }));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#22c55e');
    expect(api.saveSettings).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '完成' }));
    await user.click(screen.getByRole('button', { name: '保存外观设置' }));
    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ accent: '#22c55e' }),
        expect.objectContaining({ preset: 'ocean' }),
      ),
    );
    expect(data.config.settings.accent).toBe('#22c55e');
  });
  it('预设同时改变主色和模式，顶部保存与底部保存使用同一接口', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '森林绿' }));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#22c55e');
    await user.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'dark', accent: '#22c55e' }),
        expect.objectContaining({ preset: 'forest' }),
      ),
    );
    await user.click(screen.getByRole('button', { name: '极简白' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#2563eb');
  });
  it('非法颜色代码不能提交，RGB 滑杆仍可选择合法颜色', async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '选择主题强调色' }));
    fireEvent.change(screen.getByLabelText('颜色代码'), { target: { value: '#zzzzzz' } });
    expect(screen.getByRole('alert')).toHaveTextContent('六位颜色代码');
    expect(screen.getByRole('button', { name: '完成' })).toBeDisabled();
    fireEvent.change(screen.getByRole('slider', { name: '红色分量' }), {
      target: { value: '128' },
    });
    expect(screen.getByLabelText('颜色代码')).toHaveValue('#8082f6');
    expect(screen.getByRole('button', { name: '完成' })).toBeEnabled();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });
  it('保存失败保留未保存状态，离开设置清除预览', async () => {
    vi.mocked(api.saveSettings).mockRejectedValue({ message: '存储失败' });
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: '暮光紫' }));
    await user.click(screen.getByRole('button', { name: '保存外观设置' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(data.config.settings.accent).toBe('#3b82f6');
    await waitFor(() => expect(screen.getByRole('button', { name: '保存外观设置' })).toBeEnabled());
    cleanup();
    expect(useAppearancePreview.getState().preview).toBeNull();
  });
});
