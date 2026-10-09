import { useState } from 'react';
import { toast } from 'sonner';
import { Modal } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { errorMessage } from '../../services/api';
import { desktopLogin } from '../../services/desktop-login';
import type { Account } from '../../types/accounts';
import type {
  DesktopConfig,
  DesktopControl,
  DesktopLocator,
  DesktopWindow,
} from '../../types/desktop-login';
type Field = 'username' | 'password' | 'submit' | 'success' | 'identity' | 'failure' | 'challenge';
const fields: [Field, string][] = [
  ['username', '账号输入框'],
  ['password', '密码输入框'],
  ['submit', '登录按钮'],
  ['success', '登录成功控件'],
  ['identity', '显示用户名的文本'],
  ['failure', '失败提示（可选）'],
  ['challenge', '人工验证控件（可选）'],
];
const empty = (type: number): DesktopLocator => ({
  automation_id: '',
  control_type: type,
  name: '',
  ancestor_id: '',
});
export function newDesktopConfig(a: Account): DesktopConfig {
  return {
    id: crypto.randomUUID(),
    account_id: a.id,
    credential_ref: a.credential_ref,
    schema_version: 1,
    name: `${a.name} 应用登录`,
    executable_path: a.target,
    window_class: '',
    window_title: '',
    username: empty(50004),
    password: empty(50004),
    submit: empty(50000),
    success: empty(50020),
    identity: empty(50020),
    failure: null,
    challenge: null,
    timeout_seconds: 30,
  };
}
const stable = (c: DesktopControl): DesktopLocator => ({
  ...c.locator,
  name: c.locator.automation_id ? '' : c.locator.name,
});
export function DesktopRecorder({
  account,
  existing,
  onClose,
  onSaved,
}: {
  account: Account;
  existing?: DesktopConfig;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [config, setConfig] = useState(
    existing
      ? {
          ...existing,
          account_id: account.id,
          credential_ref: account.credential_ref,
          executable_path: account.target,
        }
      : newDesktopConfig(account),
  );
  const [windows, setWindows] = useState<DesktopWindow[]>([]);
  const [target, setTarget] = useState<DesktopWindow | null>(null);
  const [controls, setControls] = useState<DesktopControl[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('先自行打开绑定应用的登录窗口，再读取窗口列表。');
  const [error, setError] = useState('');
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function update(field: Field, locator: DesktopLocator | null) {
    setConfig((c) => ({ ...c, [field]: locator }));
  }
  return (
    <Modal
      open
      wide
      title="录制桌面应用登录"
      description="选择窗口与控件。只录制控件标识；不会读取输入值、录制键盘或模拟鼠标。"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="desktop-recorder">
        <ol className="desktop-steps">
          <li>选择绑定 EXE 的窗口</li>
          <li>选择账号、密码与按钮</li>
          <li>自行登录后刷新，选择成功及身份控件</li>
          <li>验证并保存</li>
        </ol>
        <p className="muted">
          绑定账号：{account.name} · {account.username}
        </p>
        <p className="desktop-path">{account.target}</p>
        <Button
          variant="secondary"
          loading={busy}
          onClick={() =>
            void action(async () => {
              const r = await desktopLogin.windows(account.id);
              setWindows(r.windows);
              setTarget(null);
              setControls([]);
              setMessage(r.message);
            })
          }
        >
          读取应用窗口
        </Button>
        <label>
          目标窗口
          <select
            aria-label="目标窗口"
            disabled={busy}
            value={target?.handle ?? ''}
            onChange={(e) => {
              const w = windows.find((w) => w.handle === Number(e.target.value)) ?? null;
              setTarget(w);
              setControls([]);
              if (w)
                setConfig((c) => ({ ...c, window_class: w.class_name, window_title: w.title }));
            }}
          >
            <option value="">请选择窗口</option>
            {windows.map((w) => (
              <option key={w.handle} value={w.handle}>
                {w.title} · PID {w.pid}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          disabled={!target}
          loading={busy}
          onClick={() =>
            void action(async () => {
              if (target) {
                const r = await desktopLogin.inspect(account.id, target);
                setControls(r.controls);
                setMessage(r.message);
              }
            })
          }
        >
          刷新控件列表
        </Button>
        <div className="desktop-locators">
          {fields.map(([field, title]) => {
            const l = config[field];
            const options = controls.filter((c) =>
              field === 'username'
                ? c.locator.control_type === 50004 && !c.is_password
                : field === 'password'
                  ? c.is_password && c.locator.control_type === 50004
                  : field === 'submit'
                    ? c.locator.control_type === 50000
                    : field === 'identity'
                      ? c.locator.control_type === 50020
                      : !c.is_password && c.locator.control_type !== 50004,
            );
            return (
              <fieldset key={field}>
                <legend>{title}</legend>
                <select
                  aria-label={title}
                  disabled={busy}
                  value=""
                  onChange={(e) => {
                    const c = options[Number(e.target.value)];
                    if (c) update(field, stable(c));
                  }}
                >
                  <option value="">从控件列表选择…</option>
                  {options.map((c, i) => (
                    <option key={i} value={i}>
                      {c.locator.automation_id || '无 ID'} ·{' '}
                      {c.is_password ? '密码控件' : c.locator.name || '输入框'}
                      {c.visible ? '' : '（当前隐藏）'}
                    </option>
                  ))}
                </select>
                {l ? (
                  <>
                    <label>
                      AutomationId
                      <input
                        aria-label={`${title} AutomationId`}
                        disabled={busy}
                        value={l.automation_id}
                        onChange={(e) => update(field, { ...l, automation_id: e.target.value })}
                      />
                    </label>
                    <label>
                      ControlType
                      <input
                        aria-label={`${title} ControlType`}
                        type="number"
                        disabled={busy}
                        value={l.control_type}
                        onChange={(e) =>
                          update(field, { ...l, control_type: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label>
                      父级 AutomationId
                      <input
                        disabled={busy}
                        value={l.ancestor_id}
                        onChange={(e) => update(field, { ...l, ancestor_id: e.target.value })}
                      />
                    </label>
                    {field !== 'username' && field !== 'password' && (
                      <label>
                        控件 Name（可留空）
                        <input
                          disabled={busy}
                          value={l.name}
                          onChange={(e) => update(field, { ...l, name: e.target.value })}
                        />
                      </label>
                    )}
                    {(field === 'failure' || field === 'challenge') && (
                      <Button size="sm" variant="ghost" onClick={() => update(field, null)}>
                        清除可选控件
                      </Button>
                    )}
                  </>
                ) : (
                  <p className="muted">未配置</p>
                )}
              </fieldset>
            );
          })}
        </div>
        <label>
          配置名称
          <input
            disabled={busy}
            value={config.name}
            onChange={(e) => setConfig((c) => ({ ...c, name: e.target.value }))}
          />
        </label>
        <label>
          等待结果上限（3～120 秒）
          <input
            type="number"
            min={3}
            max={120}
            disabled={busy}
            value={config.timeout_seconds}
            onChange={(e) => setConfig((c) => ({ ...c, timeout_seconds: Number(e.target.value) }))}
          />
        </label>
        <p role="status">{message}</p>
        {error && (
          <p className="account-warning" role="alert">
            {error}
          </p>
        )}
        <p className="muted">
          成功与身份控件必须可靠对应当前账号；身份文本需与「{account.username}
          」完全一致。不支持的控件、跨进程控件、复杂验证流程请使用人工登录。
        </p>
        <footer>
          <Button
            variant="secondary"
            disabled={!target}
            loading={busy}
            onClick={() =>
              void action(async () => {
                if (target) {
                  const r = await desktopLogin.test(config, target);
                  setMessage(r.message);
                  if (r.status !== 'validated') throw new Error(r.message);
                }
              })
            }
          >
            测试定位（不填写）
          </Button>
          <Button
            disabled={!target}
            loading={busy}
            onClick={() =>
              void action(async () => {
                if (!target) return;
                const r = await desktopLogin.test(config, target);
                if (r.status !== 'validated') throw new Error(r.message);
                await desktopLogin.save(config);
                toast.success('桌面登录配置已保存');
                onSaved?.();
                onClose();
              })
            }
          >
            验证并保存
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
