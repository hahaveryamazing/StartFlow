import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DesktopLogin } from '../features/desktop-login/DesktopLogin';
import { DesktopRecorder, newDesktopConfig } from '../features/desktop-login/DesktopRecorder';
import { ConfirmProvider } from '../components/confirm';
import { accounts } from '../services/accounts';
import { desktopLogin } from '../services/desktop-login';
import type { Account } from '../types/accounts';
vi.mock('../services/accounts', () => ({ accounts: { list: vi.fn() } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('../services/desktop-login', () => ({
  desktopLogin: {
    snapshot: vi.fn(),
    windows: vi.fn(),
    inspect: vi.fn(),
    test: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    run: vi.fn(),
  },
}));
const account: Account = {
  id: 'account',
  name: '测试应用',
  username: 'demo',
  kind: 'app',
  target: 'C:\\App.exe',
  credential_ref: 'ref',
  created_at: 'now',
  updated_at: 'now',
  revision: 1,
  credential_state: 'saved',
};
const config = newDesktopConfig(account);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accounts.list).mockResolvedValue({ accounts: [account], pending_cleanup: 0 });
  vi.mocked(desktopLogin.snapshot).mockResolvedValue({ configs: [config], runs: [] });
});
afterEach(cleanup);
function show() {
  render(
    <ConfirmProvider>
      <DesktopLogin />
    </ConfirmProvider>,
  );
}
it('授权前必须确认，取消不会读取凭据或运行', async () => {
  show();
  fireEvent.click(await screen.findByText('授权并测试登录'));
  expect(screen.getByRole('dialog')).toHaveTextContent('最多提交一次');
  expect(desktopLogin.run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('取消'));
  expect(desktopLogin.run).not.toHaveBeenCalled();
});
it('只检查会话明确传递不授权', async () => {
  vi.mocked(desktopLogin.run).mockResolvedValue({
    id: 'run',
    config_id: config.id,
    account_id: account.id,
    started_at: 'now',
    finished_at: 'now',
    result: {
      status: 'authorization_required',
      message: '需要授权',
      windows: [],
      controls: [],
      submitted: false,
    },
  });
  show();
  fireEvent.click(await screen.findByText('检查会话'));
  expect(desktopLogin.run).toHaveBeenCalledWith(config.id, false);
});
it('删除配置须确认且不删除账号', async () => {
  show();
  fireEvent.click(await screen.findByText('删除'));
  expect(screen.getByRole('dialog')).toHaveTextContent('账号与密码会保留');
  expect(desktopLogin.remove).not.toHaveBeenCalled();
});
it('加载错误不会伪装空列表', async () => {
  vi.mocked(desktopLogin.snapshot).mockRejectedValue({ message: '数据库不可用' });
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('数据库不可用');
});
it('录制器未选择窗口时不能验证保存，且没有密码值字段', () => {
  render(<DesktopRecorder account={account} onClose={() => {}} />);
  expect(screen.getByRole('button', { name: '验证并保存' })).toBeDisabled();
  expect(screen.getByText('测试定位（不填写）')).toBeDisabled();
  expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
  expect(config).not.toHaveProperty('password_value');
  expect(config).not.toHaveProperty('secret');
});
it('窗口提供程序报错时展示真实错误', async () => {
  vi.mocked(desktopLogin.windows).mockRejectedValue({ message: '权限不足' });
  render(<DesktopRecorder account={account} onClose={() => {}} />);
  fireEvent.click(screen.getByText('读取应用窗口'));
  expect(await screen.findByRole('alert')).toHaveTextContent('权限不足');
  expect(desktopLogin.inspect).not.toHaveBeenCalled();
});
