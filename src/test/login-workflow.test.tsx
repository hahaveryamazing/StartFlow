import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { LoginNodePanel } from '../features/workflow-editor/LoginNodePanel';
import { LoginHistory } from '../features/accounts/LoginHistory';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
it('用稳定配置 ID 关联多个账号，并可选择等待人工策略', async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === 'accounts_list'
      ? {
          accounts: [
            { id: 'a', name: '工作账号' },
            { id: 'b', name: '备用账号' },
          ],
        }
      : {
          configs: [
            { id: 'config-a', account_id: 'a', name: '同一网站' },
            { id: 'config-b', account_id: 'b', name: '同一网站' },
          ],
        },
  );
  const change = vi.fn();
  render(
    <LoginNodePanel
      config={{
        type: 'auto_login',
        target: 'web',
        config_id: 'config-a',
        timeout_seconds: 30,
        failure_policy: 'stop',
      }}
      onChange={change}
    />,
  );
  await screen.findByRole('option', { name: '同一网站 · 备用账号' });
  fireEvent.change(screen.getByLabelText('登录配置与账号'), { target: { value: 'config-b' } });
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ config_id: 'config-b' }));
  fireEvent.change(screen.getByLabelText('未确认登录成功时'), { target: { value: 'manual' } });
  expect(change).toHaveBeenCalledWith(expect.objectContaining({ failure_policy: 'manual' }));
  expect(invoke).not.toHaveBeenCalledWith(expect.stringMatching(/password|credential_read/));
});
it('真实读取失败显示原因，不显示成功选项', async () => {
  vi.mocked(invoke).mockRejectedValue({ message: '登录配置数据库不可用' });
  render(
    <LoginNodePanel
      config={{ type: 'login_branch', target: 'desktop', config_id: '' }}
      onChange={vi.fn()}
    />,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('登录配置数据库不可用');
  expect(screen.queryByRole('option', { name: /同一网站/ })).toBeNull();
});
it('登录历史只展示后端摘要，并在卸载时释放监听器', async () => {
  const release = vi.fn();
  vi.mocked(listen).mockResolvedValue(release);
  vi.mocked(invoke).mockResolvedValue([
    {
      id: 'run',
      name: '工作邮箱',
      target: 'web',
      status: 'waiting_manual',
      timestamp: '2026-10-09T10:00:00Z',
      submitted: false,
    },
  ]);
  const view = render(<LoginHistory />);
  expect(await screen.findByText(/等待人工验证/)).toBeInTheDocument();
  expect(screen.getByText(/未自动提交/)).toBeInTheDocument();
  await waitFor(() => expect(listen).toHaveBeenCalledTimes(3));
  view.unmount();
  expect(release).toHaveBeenCalledTimes(3);
  expect(invoke).toHaveBeenCalledWith('login_history');
});

it('主窗口隐藏时暂停登录历史刷新，重新显示只读取最新摘要', async () => {
  const handlers = new Map<string, (event: { payload: boolean }) => void>();
  vi.mocked(listen).mockImplementation(async (name, handler) => {
    handlers.set(name, handler as (event: { payload: boolean }) => void);
    return () => {};
  });
  vi.mocked(invoke).mockResolvedValue([]);
  render(<LoginHistory />);
  await screen.findByText('还没有登录记录。');
  expect(invoke).toHaveBeenCalledTimes(1);
  handlers.get('main-visible')!({ payload: false });
  handlers.get('web-login-status')!({ payload: true });
  expect(invoke).toHaveBeenCalledTimes(1);
  handlers.get('main-visible')!({ payload: true });
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
});
