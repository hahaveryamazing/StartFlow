import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WebLogin, defaultLoginConfig } from '../features/web-login/WebLogin';
import { ConfirmProvider } from '../components/confirm';
import { accounts } from '../services/accounts';
import { webLogin } from '../services/web-login';
import type { Account } from '../types/accounts';
vi.mock('../services/accounts', () => ({ accounts: { list: vi.fn() } }));
vi.mock('../services/web-login', () => ({
  webLogin: { snapshot: vi.fn(), save: vi.fn(), start: vi.fn(), close: vi.fn(), remove: vi.fn() },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
const account: Account = {
  id: 'test-id',
  name: '工作邮箱',
  username: 'work@example.test',
  kind: 'web',
  target: 'https://example.test',
  credential_ref: 'opaque-ref',
  created_at: 'now',
  updated_at: 'now',
  revision: 1,
  credential_state: 'saved',
};
const config = defaultLoginConfig(account);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accounts.list).mockResolvedValue({ accounts: [account], pending_cleanup: 0 });
  vi.mocked(webLogin.snapshot).mockResolvedValue({
    configs: [config],
    runs: [],
    active_runs: [],
    runtime_ready: true,
  });
});
afterEach(cleanup);
function show() {
  return render(
    <ConfirmProvider>
      <WebLogin />
    </ConfirmProvider>,
  );
}
it('只有用户确认才授权填密，取消不启动浏览器', async () => {
  show();
  fireEvent.click(await screen.findByText('授权登录'));
  expect(screen.getByRole('dialog')).toHaveTextContent('https://example.test');
  expect(screen.getByRole('dialog')).toHaveTextContent('最多自动提交一次');
  expect(webLogin.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('取消'));
  expect(webLogin.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('授权登录'));
  fireEvent.click(screen.getByText('确认继续'));
  await waitFor(() => expect(webLogin.start).toHaveBeenCalledWith(config.id, true));
});
it('检查会话不授权读取凭据，保存配置不执行', async () => {
  show();
  fireEvent.click(await screen.findByText('仅检查会话'));
  await waitFor(() => expect(webLogin.start).toHaveBeenCalledWith(config.id, false));
  fireEvent.click(screen.getByText('新建配置'));
  expect((screen.getByLabelText('登录配置 JSON') as HTMLTextAreaElement).value).not.toContain(
    'opaque-ref',
  );
  fireEvent.click(screen.getByText('验证并保存'));
  await waitFor(() => expect(webLogin.save).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(webLogin.snapshot).toHaveBeenCalledTimes(3));
  expect(webLogin.start).toHaveBeenCalledTimes(1);
});
it('后端运行状态显示并禁止重复启动，关闭只提交关闭请求', async () => {
  vi.mocked(webLogin.snapshot).mockResolvedValue({
    configs: [config],
    runs: [
      {
        id: 'run',
        config_id: config.id,
        account_id: account.id,
        status: 'waiting_manual',
        submitted: false,
        started_at: 'now',
        updated_at: 'now',
        message: '需要人工验证',
      },
    ],
    active_runs: ['run'],
    runtime_ready: true,
  });
  show();
  expect(await screen.findByText('等待人工验证')).toBeInTheDocument();
  expect(screen.getByText('授权登录')).toBeDisabled();
  fireEvent.click(screen.getByText('关闭专用浏览器'));
  await waitFor(() => expect(webLogin.close).toHaveBeenCalledWith('run'));
  expect(webLogin.start).not.toHaveBeenCalled();
});
it('运行时缺失禁用运行，真实加载错误可见', async () => {
  vi.mocked(webLogin.snapshot).mockResolvedValue({
    configs: [config],
    runs: [],
    active_runs: [],
    runtime_ready: false,
  });
  show();
  expect(await screen.findByText(/运行时未准备/)).toBeInTheDocument();
  expect(screen.getByText('授权登录')).toBeDisabled();
  cleanup();
  vi.mocked(webLogin.snapshot).mockRejectedValue({ message: '数据库不可用' });
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('数据库不可用');
});
