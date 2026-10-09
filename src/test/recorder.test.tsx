import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { listen } from '@tauri-apps/api/event';
import { LoginRecorder } from '../features/login-recorder/LoginRecorder';
import { draftToConfig, initialRules } from '../features/login-recorder/model';
import { ConfirmProvider } from '../components/confirm';
import { recorder } from '../services/recorder';
import { webLogin } from '../services/web-login';
import type { Account } from '../types/accounts';
import type { Recording, LocatorSet } from '../types/web-login';
vi.mock('../services/recorder', () => ({
  recorder: { start: vi.fn(), snapshot: vi.fn(), command: vi.fn(), close: vi.fn() },
}));
vi.mock('../services/web-login', () => ({
  webLogin: { snapshot: vi.fn(), save: vi.fn(), start: vi.fn(), close: vi.fn() },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
const account: Account = {
  id: 'account',
  name: '工作邮箱',
  username: 'work@example.test',
  kind: 'web',
  target: 'https://example.test',
  credential_ref: 'opaque',
  created_at: 'now',
  updated_at: 'now',
  revision: 1,
  credential_state: 'saved',
};
const rules = Object.fromEntries(
  ['username', 'password', 'submit', 'success', 'identity', 'challenge', 'failure'].map((f) => [
    f,
    { kind: 'css', value: '#' + f },
  ]),
) as LocatorSet;
const base: Recording = {
  id: 'record',
  account_id: account.id,
  credential_ref: account.credential_ref,
  origin: account.target,
  login_url: account.target + '/login',
  status: 'ready',
  message: '请点选控件',
  active: true,
  rules: {},
  form_action_url: account.target + '/submit',
  results: {},
  verified_login: false,
  verified_success: false,
};
const callbacks = new Map<string, (e: { payload: unknown }) => void>();
beforeEach(() => {
  vi.clearAllMocks();
  callbacks.clear();
  vi.mocked(listen).mockImplementation(async (event, fn) => {
    const handler = fn as (e: { payload: unknown }) => void;
    callbacks.set(event, handler);
    return () => {
      if (callbacks.get(event) === handler) callbacks.delete(event);
    };
  });
  vi.mocked(recorder.close).mockResolvedValue();
  vi.mocked(recorder.command).mockResolvedValue();
  vi.mocked(webLogin.save).mockResolvedValue();
  vi.mocked(recorder.snapshot).mockResolvedValue(null);
  vi.mocked(recorder.start).mockResolvedValue(base);
  vi.mocked(webLogin.snapshot).mockResolvedValue({
    configs: [],
    runs: [],
    active_runs: [],
    runtime_ready: true,
    browser: { status: 'ready', source: 'edge', message: '准备完成', version: 'test' },
  });
  vi.mocked(webLogin.start).mockResolvedValue({
    id: 'run',
    config_id: 'config',
    account_id: account.id,
    status: 'logging_in',
    message: '真实测试',
    submitted: false,
    started_at: 'now',
    updated_at: 'now',
  });
});
afterEach(cleanup);
function show() {
  return render(
    <StrictMode>
      <ConfirmProvider>
        <LoginRecorder account={account} onClose={() => {}} />
      </ConfirmProvider>
    </StrictMode>,
  );
}
async function open() {
  show();
  const button = screen.getByText('打开录制浏览器');
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await screen.findByText('请点选控件');
}
async function emit(value: Recording) {
  await act(async () => callbacks.get('web-login-recording')?.({ payload: value }));
}
it('录制不自动读取凭据；后端定位通过前禁止保存与授权测试', async () => {
  await open();
  expect(recorder.start).toHaveBeenCalledWith(account.id, account.target + '/');
  expect(screen.getByText('保存登录配置')).toBeDisabled();
  expect(screen.getByText('授权测试登录')).toBeDisabled();
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(webLogin.start).not.toHaveBeenCalled();
  expect(webLogin.save).not.toHaveBeenCalled();
});
it('StrictMode 保留实际点选规则，状态事件不覆盖用户编辑', async () => {
  await open();
  await emit({ ...base, rules: { username: rules.username } });
  const input = screen.getByLabelText('账号输入框定位内容');
  expect(input).toHaveValue('#username');
  fireEvent.change(input, { target: { value: '#changed' } });
  await emit({ ...base, status: 'picking', rules: { username: rules.username } });
  expect(input).toHaveValue('#changed');
});
it('验证后保存类型化配置且重复保存保持 ID；真实测试必须另行确认', async () => {
  await open();
  await emit({ ...base, rules, verified_login: true, verified_success: true });
  fireEvent.click(screen.getByText('保存登录配置'));
  await waitFor(() => expect(webLogin.save).toHaveBeenCalledTimes(1));
  const config = vi.mocked(webLogin.save).mock.calls[0][0];
  expect(config).toMatchObject({
    schema_version: 2,
    credential_ref: account.credential_ref,
    locators: rules,
  });
  expect(JSON.stringify(config)).not.toContain('"password": "');
  await waitFor(() => expect(screen.getByText('授权测试登录')).toBeEnabled());
  fireEvent.click(screen.getByText('保存登录配置'));
  await waitFor(() => expect(webLogin.save).toHaveBeenCalledTimes(2));
  expect(vi.mocked(webLogin.save).mock.calls[1][0].id).toBe(config.id);
  fireEvent.click(screen.getByText('授权测试登录'));
  expect(webLogin.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('取消'));
  expect(webLogin.start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('授权测试登录'));
  fireEvent.click(screen.getByText('确认继续'));
  await waitFor(() => expect(webLogin.start).toHaveBeenCalledWith(config.id, true));
  expect(recorder.close).toHaveBeenCalledWith(base.id);
});
it('未重新验证的编辑、缺失控件和变更凭据绑定不能保存', () => {
  const proved = { ...base, rules, verified_login: true, verified_success: true };
  expect(() =>
    draftToConfig(
      account,
      proved,
      { ...rules, password: { kind: 'css', value: '#new' } },
      '登录',
      30,
    ),
  ).toThrow();
  expect(() =>
    draftToConfig({ ...account, credential_ref: 'new' }, proved, rules, '登录', 30),
  ).toThrow();
  expect(() =>
    draftToConfig(
      account,
      proved,
      { ...rules, failure: { kind: 'css', value: '#changed' } },
      '登录',
      30,
    ),
  ).toThrow();
});
it('旧 CSS 配置可用定位表单编辑，不需要改写旧数据库', () => {
  const config = draftToConfig(
    account,
    { ...base, rules, verified_login: true, verified_success: true },
    rules,
    '登录',
    30,
  );
  delete config.locators;
  delete config.schema_version;
  delete config.credential_ref;
  expect(initialRules(config).username).toEqual({ kind: 'css', value: '#sf-username' });
});
