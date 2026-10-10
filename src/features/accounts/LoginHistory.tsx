import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { errorMessage } from '../../services/api';
import { datetime } from '../../utils/format';
export const loginStatus: Record<string, string> = {
  success: '登录已验证',
  authenticated: '登录已验证',
  session_reused: '有效会话已复用',
  session_expired: '会话已过期',
  checking_session: '正在检查会话',
  logging_in: '正在尝试一次登录',
  running: '正在登录',
  waiting_manual: '等待人工验证',
  manual_required: '需要人工登录',
  authorization_required: '需要授权',
  cooldown: '尝试次数受限',
  timeout: '登录超时',
  failed: '登录失败',
  blocked: '目标验证未通过',
  locator_invalid: '定位已失效',
  wrong_account: '当前会话属于其他账号',
  closed: '专用浏览器已关闭',
  interrupted: '登录已中断',
  cancelled: '登录已取消',
  login_timeout: '登录等待超时',
};
interface Entry {
  id: string;
  name: string;
  target: string;
  status: string;
  timestamp: string;
  submitted: boolean;
}
export function LoginHistory({ compact = false }: { compact?: boolean }) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    let visible = true;
    const releases: (() => void)[] = [];
    const load = () => {
      if (!visible || document.visibilityState === 'hidden') return Promise.resolve();
      return invoke<Entry[]>('login_history')
        .then((r) => {
          if (live) {
            setRows(r);
            setError('');
            setLoading(false);
          }
        })
        .catch((e) => {
          if (live) {
            setError(errorMessage(e));
            setLoading(false);
          }
        });
    };
    void listen<boolean>('main-visible', (e) => {
      visible = e.payload;
      if (visible) void load();
    })
      .then((f) => {
        if (live) releases.push(f);
        else f();
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    void load();
    for (const event of ['web-login-status', 'desktop-login-changed'])
      void listen(event, () => void load())
        .then((f) => {
          if (live) releases.push(f);
          else f();
        })
        .catch((e) => {
          if (live) setError(errorMessage(e));
        });
    return () => {
      live = false;
      releases.forEach((f) => f());
    };
  }, []);
  return (
    <section className="panel login-history">
      <h3>最近登录记录</h3>
      <p className="muted">仅展示状态摘要，不包含密码或会话内容。</p>
      {loading && <p>正在读取…</p>}
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
      {!loading && !error && !rows.length && <p className="muted">还没有登录记录。</p>}
      {rows.slice(0, compact ? 4 : 30).map((r) => (
        <div className="log-detail" key={r.id}>
          <div className="grow">
            <strong>{r.name}</strong>
            <p>
              {loginStatus[r.status] ?? '登录未确认成功'} ·{' '}
              {r.target === 'web' ? '网页' : '桌面应用'}
            </p>
            <small>
              {datetime(r.timestamp)} · {r.submitted ? '已提交一次登录请求' : '未自动提交'}
            </small>
          </div>
        </div>
      ))}
    </section>
  );
}
