import { useEffect, useState, useCallback } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { AppWindow, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '../../components/common';
import { Button } from '../../components/ui/button';
import { useConfirm } from '../../components/confirm';
import { accounts } from '../../services/accounts';
import { desktopLogin } from '../../services/desktop-login';
import { errorMessage } from '../../services/api';
import type { Account } from '../../types/accounts';
import type { DesktopConfig, DesktopSnapshot } from '../../types/desktop-login';
import { DesktopRecorder } from './DesktopRecorder';
import '../../styles/desktop-login.css';
const states: Record<string, string> = {
  running: '正在登录',
  success: '已确认登录',
  session_reused: '复用会话',
  session_expired: '会话已失效',
  authorization_required: '等待授权',
  waiting_manual: '等待人工验证',
  failed: '登录失败',
  timeout: '等待超时',
  manual_required: '需要人工登录',
  invalid_controls: '控件已失效',
  ambiguous_controls: '控件不唯一',
  wrong_account: '其他账号会话',
  wrong_target: '窗口身份不符',
  permission_denied: '权限不足',
  locked: '桌面已锁定',
  interrupted: '执行已中断',
};
export function DesktopLogin() {
  const [data, setData] = useState<DesktopSnapshot | null>(null);
  const [list, setList] = useState<Account[]>([]);
  const [selected, setSelected] = useState('');
  const [edit, setEdit] = useState<{ account: Account; config?: DesktopConfig } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirm = useConfirm();
  const refresh = useCallback(async () => {
    try {
      const [snapshot, a] = await Promise.all([desktopLogin.snapshot(), accounts.list()]);
      setData(snapshot);
      setList(a.accounts.filter((a) => a.kind === 'app'));
      setError('');
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    let disposed = false;
    let stop: UnlistenFn | undefined;
    void listen('desktop-login-changed', () => {
      void refresh();
    })
      .then((fn) => {
        if (disposed) fn();
        else stop = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, [refresh]);
  async function run(c: DesktopConfig, authorized: boolean) {
    if (
      authorized &&
      !(await confirm(
        '授权一次桌面登录',
        `将向「${c.name}」绑定的 EXE 填写凭据并最多提交一次。请确认这是可信应用且无需扫码、验证码或系统验证。不会绕过 UAC 或锁屏。`,
      ))
    )
      return;
    setBusy(true);
    setError('');
    let failure = '';
    try {
      const r = await desktopLogin.run(c.id, authorized);
      if (['success', 'session_reused'].includes(r.result.status)) toast.success(r.result.message);
      else toast.info(r.result.message);
    } catch (e) {
      failure = errorMessage(e);
    } finally {
      setBusy(false);
      await refresh();
      if (failure) setError(failure);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="DESKTOP SIGN IN"
        title="桌面应用登录"
        description="按窗口身份与控件规则安全登录。只有明确授权的手动操作会提交凭据。"
        action={
          <Button variant="secondary" loading={busy} onClick={() => void refresh()}>
            <RefreshCw size={16} />
            刷新记录
          </Button>
        }
      />
      <div className="account-security-note">
        <AppWindow />
        <div>
          <strong>安全填写，无坐标点击</strong>
          <p>
            只支持普通桌面上提供 UI Automation ValuePattern / InvokePattern
            的单步登录表单。扫码、验证码、MFA、Windows Hello
            与安全桌面均需人工完成。默认每账号五分钟最多一次尝试。
          </p>
        </div>
      </div>
      <div className="filter-bar">
        <select
          aria-label="选择应用账号"
          value={selected}
          disabled={busy}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">选择已有应用账号…</option>
          {list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.username}
            </option>
          ))}
        </select>
        <Button
          disabled={busy || !selected}
          onClick={() => {
            const a = list.find((a) => a.id === selected);
            if (a) setEdit({ account: a });
          }}
        >
          <Plus size={16} />
          录制登录配置
        </Button>
      </div>
      {error && (
        <p role="alert" className="account-warning">
          {error}
        </p>
      )}
      {!data ? (
        <div className="small-empty">{error ? '请检查后重新加载' : '正在加载登录配置…'}</div>
      ) : data.configs.length ? (
        <div className="account-grid">
          {data.configs.map((c) => (
            <article key={c.id} className="account-card">
              <h3>{c.name}</h3>
              <p className="desktop-path">{c.executable_path}</p>
              <p>
                {c.window_title} · {c.timeout_seconds} 秒超时
              </p>
              <footer>
                <Button disabled={busy} onClick={() => void run(c, true)}>
                  授权并测试登录
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => void run(c, false)}>
                  检查会话
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    const a = list.find((a) => a.id === c.account_id);
                    if (a) setEdit({ account: a, config: c });
                  }}
                >
                  编辑 / 重新录制
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirm(
                        '删除桌面登录配置',
                        `删除「${c.name}」的控件配置，账号与密码会保留。`,
                      )
                    ) {
                      try {
                        await desktopLogin.remove(c.id);
                        toast.success('配置已删除');
                        await refresh();
                      } catch (e) {
                        setError(errorMessage(e));
                      }
                    }
                  }}
                >
                  删除
                </Button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <div className="small-empty">
          <AppWindow size={32} />
          <h3>为可信应用配置登录</h3>
          <p>先添加绑定完整 EXE 路径的应用账号，再选择目标窗口和控件。</p>
        </div>
      )}
      {busy && <p role="status">正在检查或登录；控件无响应时会自动超时，主窗口可继续使用。</p>}
      {!!data?.runs.length && (
        <section className="account-card">
          <h3>最近登录记录</h3>
          {data.runs.map((r) => (
            <div key={r.id} className="desktop-run">
              <time>{new Date(r.started_at).toLocaleString('zh-CN')}</time>
              <span>{r.result.message}</span>
              <span>{states[r.result.status] ?? '操作未完成'}</span>
            </div>
          ))}
        </section>
      )}
      {edit && (
        <DesktopRecorder
          account={edit.account}
          existing={edit.config}
          onClose={() => setEdit(null)}
          onSaved={() => void refresh()}
        />
      )}
    </>
  );
}
