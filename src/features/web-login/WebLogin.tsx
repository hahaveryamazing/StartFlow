import { useEffect, useState, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Plus, Globe, ShieldCheck, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Modal } from '../../components/ui/dialog';
import { useConfirm } from '../../components/confirm';
import { errorMessage } from '../../services/api';
import { accounts } from '../../services/accounts';
import { webLogin } from '../../services/web-login';
import type { Account } from '../../types/accounts';
import type { LoginConfig, LoginSnapshot } from '../../types/web-login';
export function defaultLoginConfig(account: Account): LoginConfig {
  return {
    id: crypto.randomUUID(),
    account_id: account.id,
    name: account.name + ' 登录',
    origin: account.target,
    login_url: account.target + '/login',
    form_action_url: account.target + '/login',
    username_selector: '#username',
    password_selector: '#password',
    submit_selector: 'button[type="submit"]',
    success_selector: '[data-login-success]',
    identity_selector: '[data-account-identity]',
    challenge_selector: '[data-human-verification]',
    failure_selector: '[data-login-error]',
    timeout_seconds: 30,
  };
}
function ConfigEditor({
  existing,
  list,
  onClose,
  onSave,
}: {
  existing: LoginConfig | null;
  list: Account[];
  onClose: () => void;
  onSave: (c: LoginConfig) => Promise<void>;
}) {
  const [selected, setSelected] = useState(existing?.account_id ?? list[0]?.id ?? '');
  const [text, setText] = useState(
    existing
      ? JSON.stringify(existing, null, 2)
      : list[0]
        ? JSON.stringify(defaultLoginConfig(list[0]), null, 2)
        : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal
      open
      wide
      title="网页登录配置"
      description="本阶段使用明确的 CSS 选择器配置，不包含录制器。成功标识和账号身份必须同时匹配。"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            const value = JSON.parse(text) as LoginConfig;
            await onSave(value);
            onClose();
          } catch {
            setError('配置未保存，请检查 HTTPS 地址、账号绑定和选择器；未知字段不允许保存。');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          绑定网页账号
          <select
            aria-label="绑定网页账号"
            disabled={busy}
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              const account = list.find((a) => a.id === e.target.value);
              if (account) {
                const value = defaultLoginConfig(account);
                if (existing) {
                  value.id = existing.id;
                  value.name = existing.name;
                }
                setText(JSON.stringify(value, null, 2));
              }
            }}
          >
            {list.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.username}
              </option>
            ))}
          </select>
        </label>
        <p className="notice">
          origin 必须与账号绑定网站相同；form_action_url 是精确 POST
          目标。身份标识的可见文字必须等于账号用户名。验证码、扫码、MFA、Passkey 可通过
          challenge_selector 补充识别。
        </p>
        <label>
          配置 JSON
          <textarea
            className="login-config-json"
            aria-label="登录配置 JSON"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={16}
            spellCheck={false}
            disabled={busy}
          />
        </label>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" loading={busy} disabled={!list.length || busy}>
            验证并保存
          </Button>
        </div>
      </form>
    </Modal>
  );
}
const statuses: Record<string, string> = {
  checking_session: '检查会话',
  logging_in: '单次登录中',
  authenticated: '登录已验证',
  session_reused: '会话已复用',
  session_expired: '会话已过期',
  waiting_manual: '等待人工验证',
  failed: '登录失败',
  timeout: '验证超时',
  blocked: '已阻止',
  authorization_required: '未授权填密',
  cooldown: '冷却中',
  closed: '浏览器已关闭',
  interrupted: '运行中断',
};
export function WebLogin() {
  const [snapshot, setSnapshot] = useState<LoginSnapshot | null>(null),
    [list, setList] = useState<Account[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<LoginConfig | null | undefined>();
  const confirm = useConfirm();
  const refresh = useCallback(async () => {
    const [data, accountData] = await Promise.all([webLogin.snapshot(), accounts.list()]);
    setSnapshot(data);
    setList(
      accountData.accounts.filter((a) => a.kind === 'web' && a.target.startsWith('https://')),
    );
    setError('');
  }, []);
  useEffect(() => {
    let live = true;
    let unlisten: undefined | (() => void);
    void refresh().catch((e) => {
      if (live) setError(errorMessage(e));
    });
    void listen('web-login-status', () => {
      if (live) void refresh().catch((e) => setError(errorMessage(e)));
    })
      .then((fn) => {
        if (live) unlisten = fn;
        else fn();
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
      unlisten?.();
    };
  }, [refresh]);
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        eyebrow="DEDICATED BROWSER"
        title="网页登录"
        description="在独立浏览器中复用会话或授权单次登录，账号之间保持隔离。"
        action={
          <Button onClick={() => setEditing(null)} disabled={!list.length || busy}>
            <Plus size={17} />
            新建配置
          </Button>
        }
      />
      <div className="account-security-note">
        <ShieldCheck />
        <div>
          <strong>每个账号一个专用 Profile，不使用日常浏览器资料</strong>
          <p>
            检测到验证码、扫码、MFA 或 Passkey 时，在专用浏览器内完成人工验证。Cookie
            和会话仅保留在专用 Profile，不导出到配置或备份。
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="account-warning">
          {error}
        </p>
      )}
      {snapshot && !snapshot.runtime_ready && (
        <p className="account-warning">
          专用 Node/Playwright/Chromium 运行时未准备，请按开发说明安装浏览器并执行 browser:prepare。
        </p>
      )}
      <Button variant="secondary" onClick={() => void action(refresh)} disabled={busy}>
        <RefreshCw size={16} />
        刷新状态
      </Button>
      {!snapshot && !error ? (
        <div className="small-empty">正在加载登录配置…</div>
      ) : snapshot?.configs.length ? (
        <div className="login-grid">
          {snapshot.configs.map((config) => {
            const account = list.find((a) => a.id === config.account_id),
              run = snapshot.runs.find((r) => r.config_id === config.id),
              active = snapshot.runs.find(
                (r) => r.config_id === config.id && snapshot.active_runs.includes(r.id),
              );
            return (
              <article className="account-card" key={config.id}>
                <div className="account-card-header">
                  <div className="account-icon">
                    <Globe />
                  </div>
                  <div>
                    <h3>{config.name}</h3>
                    <span>
                      {account?.name ?? '账号需要检查'} · {account?.username}
                    </span>
                  </div>
                  <span className="account-state">
                    {run ? (statuses[run.status] ?? run.status) : '未运行'}
                  </span>
                </div>
                <p className="login-origin">{config.origin}</p>
                {run && (
                  <small className="login-origin">
                    最近报告 · {new Date(run.updated_at).toLocaleString('zh-CN')}
                  </small>
                )}
                {run && <p role="status">{run.message}</p>}
                <div className="login-actions">
                  <Button
                    variant="secondary"
                    disabled={busy || !!active || !snapshot.runtime_ready}
                    onClick={() => void action(() => webLogin.start(config.id, false))}
                  >
                    仅检查会话
                  </Button>
                  <Button
                    disabled={busy || !!active || !snapshot.runtime_ready}
                    onClick={async () => {
                      if (
                        await confirm(
                          '授权此次网页登录',
                          `允许 StartFlow 在 ${config.origin} 为「${account?.name} / ${account?.username}」读取绑定密码，并在验证后的表单中最多自动提交一次。Cookie 将保留在此账号专用浏览器中。`,
                        )
                      )
                        await action(() => webLogin.start(config.id, true));
                    }}
                  >
                    授权登录
                  </Button>
                  {active && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void action(() => webLogin.close(active.id))}
                    >
                      关闭专用浏览器
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    disabled={busy || !!active}
                    onClick={() => setEditing(config)}
                  >
                    编辑配置
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy || !!active}
                    onClick={async () => {
                      if (
                        await confirm(
                          '删除登录配置',
                          '只删除此配置，保留账号、密码和专用浏览器会话。',
                        )
                      )
                        await action(() => webLogin.remove(config.id));
                    }}
                  >
                    删除配置
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="small-empty">
          <Globe size={32} />
          <h3>配置第一个网页登录流程</h3>
          <p>
            {list.length
              ? '选择已绑定的 HTTPS 账号，设置登录控件和明确的成功标识。'
              : '请先在「账号与凭据」添加一个 HTTPS 网页账号。'}
          </p>
        </div>
      )}
      {editing !== undefined && (
        <ConfigEditor
          existing={editing}
          list={list}
          onClose={() => setEditing(undefined)}
          onSave={async (config) => {
            await webLogin.save(config);
            await refresh();
            toast.success('登录配置已验证并保存，尚未执行。');
          }}
        />
      )}
    </>
  );
}
