import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountEditor } from '../features/accounts/AccountEditor';
import { Accounts } from '../features/accounts/Accounts';
import { ConfirmProvider } from '../components/confirm';
import { accounts } from '../services/accounts';
import type { Account } from '../types/accounts';
vi.mock('../services/accounts', () => ({
  accounts: { list: vi.fn(), save: vi.fn(), delete: vi.fn(), exists: vi.fn(), cleanup: vi.fn() },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
const account: Account = {
  id: 'test-id',
  name: '工作邮箱',
  username: 'work@example.test',
  kind: 'web',
  target: 'https://example.test',
  credential_ref: 'opaque-id',
  created_at: 'now',
  updated_at: 'now',
  revision: 2,
  credential_state: 'saved',
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accounts.list).mockResolvedValue({
    accounts: [
      account,
      { ...account, id: 'second', name: '备用邮箱', username: 'other@example.test' },
    ],
    pending_cleanup: 0,
  });
});
afterEach(cleanup);
it('编辑只读取元数据，留空保留密码，使用版本令牌保存', async () => {
  const save = vi.fn().mockResolvedValue(true);
  render(<AccountEditor account={account} busy={false} onClose={vi.fn()} onSave={save} />);
  const input = screen.getByLabelText(/新密码/) as HTMLInputElement;
  expect(input.type).toBe('password');
  expect(input.value).toBe('');
  fireEvent.click(screen.getByText('保存账号'));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ password: null, expected_revision: 2, id: 'test-id' }),
    ),
  );
});
it('提交失败也清空密码，不进入浏览器存储或回填', async () => {
  const save = vi.fn().mockResolvedValue(false);
  const close = vi.fn();
  render(<AccountEditor account={account} busy={false} onClose={close} onSave={save} />);
  const input = screen.getByLabelText(/新密码/) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'synthetic-only-secret' } });
  fireEvent.click(screen.getByText('保存账号'));
  await waitFor(() => expect(input.value).toBe(''));
  expect(close).not.toHaveBeenCalled();
  expect(JSON.stringify(localStorage)).not.toContain('synthetic-only-secret');
  expect(JSON.stringify(sessionStorage)).not.toContain('synthetic-only-secret');
});
it('取消清空密码，保存期间不重复提交', async () => {
  let finish!: (value: boolean) => void;
  const save = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const close = vi.fn();
  render(<AccountEditor account={account} busy={false} onClose={close} onSave={save} />);
  const input = screen.getByLabelText(/新密码/) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'test-only' } });
  fireEvent.submit(input.closest('form')!);
  fireEvent.submit(input.closest('form')!);
  expect(save).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('取消'));
  expect(close).not.toHaveBeenCalled();
  finish(false);
  await waitFor(() => expect(input.value).toBe(''));
  fireEvent.change(input, { target: { value: 'cancel-only' } });
  fireEvent.click(screen.getByText('取消'));
  expect(input.value).toBe('');
  expect(close).toHaveBeenCalledTimes(1);
});
it('新增必须提供密码，超长 UTF-8 密码在提交前被拒绝', () => {
  const save = vi.fn();
  render(<AccountEditor account={null} busy={false} onClose={vi.fn()} onSave={save} />);
  const input = screen.getByLabelText('密码') as HTMLInputElement;
  fireEvent.submit(input.closest('form')!);
  expect(screen.getByRole('alert')).toHaveTextContent('请填写密码');
  fireEvent.change(input, { target: { value: '密'.repeat(900) } });
  fireEvent.submit(input.closest('form')!);
  expect(screen.getByRole('alert')).toHaveTextContent('2560');
  expect(save).not.toHaveBeenCalled();
});
it('同一目标的多个账号可搜索、筛选，删除需要确认', async () => {
  vi.mocked(accounts.delete).mockResolvedValue({ account: null, pending_cleanup: 0 });
  render(
    <ConfirmProvider>
      <Accounts />
    </ConfirmProvider>,
  );
  await screen.findByText('工作邮箱');
  expect(screen.getByText('备用邮箱')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('搜索账号'), { target: { value: 'other@' } });
  expect(screen.queryByText('工作邮箱')).toBeNull();
  fireEvent.click(screen.getByLabelText('删除 备用邮箱'));
  expect(accounts.delete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('取消'));
  expect(accounts.delete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('删除 备用邮箱'));
  fireEvent.click(screen.getByText('确认继续'));
  await waitFor(() => expect(accounts.delete).toHaveBeenCalledWith('second', 2));
  fireEvent.change(screen.getByLabelText('筛选账号类型'), { target: { value: 'app' } });
  expect(screen.getByText('没有匹配的账号')).toBeInTheDocument();
});
it('加载失败显示真实错误，缺失凭据显示密码未找到', async () => {
  vi.mocked(accounts.list).mockRejectedValueOnce({ message: '数据目录不可用' });
  render(
    <ConfirmProvider>
      <Accounts />
    </ConfirmProvider>,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('数据目录不可用');
  vi.mocked(accounts.list).mockResolvedValue({
    accounts: [{ ...account, credential_state: 'missing' }],
    pending_cleanup: 1,
  });
  fireEvent.click(screen.getByText('重新加载'));
  expect(await screen.findByText('密码未找到')).toBeInTheDocument();
  expect(screen.getByText('重试清理')).toBeInTheDocument();
});
