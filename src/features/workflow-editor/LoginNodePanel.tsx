import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { NodeConfig } from '../../types/v2';
import { errorMessage } from '../../services/api';
type LoginConfig = Extract<NodeConfig, { config_id: string }>;
export function LoginNodePanel({
  config,
  onChange,
}: {
  config: LoginConfig;
  onChange: (c: LoginConfig) => void;
}) {
  const [choices, setChoices] = useState<{ id: string; name: string; account_id: string }[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; name: string; username: string }[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    void Promise.all([
      invoke<{ configs: typeof choices }>(
        config.target === 'web' ? 'web_login_snapshot' : 'desktop_login_snapshot',
      ),
      invoke<{ accounts: typeof accounts }>('accounts_list'),
    ])
      .then(([s, a]) => {
        if (live) {
          setChoices(s.configs);
          setAccounts(a.accounts);
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [config.target]);
  return (
    <>
      <label>
        登录类型
        <select
          value={config.target}
          onChange={(e) =>
            onChange({ ...config, target: e.target.value as 'web' | 'desktop', config_id: '' })
          }
        >
          <option value="web">网页 · 独立浏览器</option>
          <option value="desktop">Windows 应用</option>
        </select>
      </label>
      <label>
        登录配置与账号
        <select
          value={config.config_id}
          disabled={loading}
          onChange={(e) => onChange({ ...config, config_id: e.target.value })}
        >
          <option value="">{loading ? '正在读取…' : '请选择已录制的登录配置'}</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {accounts.find((a) => a.id === c.account_id)?.name ?? '账号不可用'}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
      {!loading && !choices.length && !error && (
        <p className="hint-box">先在账号与凭据中心创建账号，再录制对应登录配置。</p>
      )}
      {'timeout_seconds' in config && (
        <label>
          最长等待（秒）
          <input
            type="number"
            min={3}
            max={600}
            value={config.timeout_seconds}
            onChange={(e) => onChange({ ...config, timeout_seconds: +e.target.value })}
          />
        </label>
      )}
      {config.type === 'auto_login' && (
        <label>
          未确认登录成功时
          <select
            value={config.failure_policy}
            onChange={(e) =>
              onChange({ ...config, failure_policy: e.target.value as 'stop' | 'skip' | 'manual' })
            }
          >
            <option value="stop">停止流程</option>
            <option value="skip">记录结果，跳过此登录节点</option>
            <option value="manual">等待人工操作并重新检查</option>
          </select>
        </label>
      )}
      <p className="hint-box">
        网页检查会打开或复用此账号的独立浏览器，桌面检查等待已启动应用的唯一窗口。成功须同时核验登录状态及账号身份。自动填密需要保存后单独授权；密码不会进入工作流。
      </p>
      {config.type === 'login_branch' && (
        <p className="muted">
          True：身份验证成功。False：明确未登录。控件、权限或目标身份错误会停止流程。
        </p>
      )}
    </>
  );
}
