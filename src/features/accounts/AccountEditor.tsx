import { useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Modal } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { errorMessage } from '../../services/api';
import type { Account, AccountKind, AccountWrite } from '../../types/accounts';
export function AccountEditor({
  account,
  busy,
  onClose,
  onSave,
}: {
  account: Account | null;
  busy: boolean;
  onClose: () => void;
  onSave: (request: AccountWrite) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<AccountKind>(account?.kind ?? 'web');
  const [name, setName] = useState(account?.name ?? '');
  const [username, setUsername] = useState(account?.username ?? '');
  const [target, setTarget] = useState(account?.target ?? '');
  const [error, setError] = useState<string | null>(null);
  // Uncontrolled input: no password in React state, Zustand, form defaults or browser storage.
  const password = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const close = () => {
    if (busy || submitting.current) return;
    if (password.current) password.current.value = '';
    onClose();
  };
  return (
    <Modal
      open
      title={account ? '编辑账号' : '新增账号'}
      description="密码仅写入 Windows 凭据管理器。本阶段不会登录网站或应用。"
      onClose={close}
    >
      <form
        autoComplete="off"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || submitting.current) return;
          setError(null);
          const secret = password.current?.value ?? '';
          if (!account && !secret) {
            setError('新增账号时请填写密码。');
            return;
          }
          if (new TextEncoder().encode(secret).length > 2560) {
            setError('密码 UTF-8 长度不能超过 2560 字节。');
            return;
          }
          try {
            submitting.current = true;
            const saved = await onSave({
              id: account?.id ?? null,
              name,
              username,
              kind,
              target,
              password: secret || null,
              expected_revision: account?.revision ?? null,
            });
            if (saved) onClose();
          } catch {
            setError('账号保存未完成，请刷新检查状态。');
          } finally {
            submitting.current = false;
            if (password.current) password.current.value = '';
          }
        }}
      >
        <div className="form-grid">
          <label className="span-2">
            账号名称
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
              disabled={busy}
              placeholder="例如：工作邮箱 · 主账号"
            />
          </label>
          <label>
            账号类型
            <select
              value={kind}
              disabled={busy}
              onChange={(e) => {
                setKind(e.target.value as AccountKind);
                setTarget('');
              }}
            >
              <option value="web">网页账号</option>
              <option value="app">Windows 应用账号</option>
            </select>
          </label>
          <label>
            用户名
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              maxLength={320}
              required
              disabled={busy}
              autoComplete="off"
              placeholder="邮箱、手机号或用户名"
            />
          </label>
          <label className="span-2">
            {kind === 'web' ? '网站地址' : '应用路径'}
            <div className="input-action">
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                required
                disabled={busy}
                placeholder={kind === 'web' ? 'https://example.com' : '选择本地 EXE 或 LNK 文件'}
              />
              {kind === 'app' && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  aria-label="选择应用"
                  onClick={async () => {
                    try {
                      const path = await open({
                        multiple: false,
                        directory: false,
                        filters: [{ name: '应用程序与快捷方式', extensions: ['exe', 'lnk'] }],
                      });
                      if (typeof path === 'string') setTarget(path);
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  <FolderOpen size={16} />
                </Button>
              )}
            </div>
            <small>
              {kind === 'web'
                ? '保存为网站根地址；同一网站可以添加多个账号。'
                : '只绑定目标路径，不启动程序，也不修改 Windows 登录凭据。'}
            </small>
          </label>
          <label className="span-2">
            {account ? '新密码（留空保留原密码）' : '密码'}
            <input
              ref={password}
              aria-label={account ? '新密码（留空保留原密码）' : '密码'}
              type="password"
              autoComplete="new-password"
              required={!account}
              disabled={busy}
              placeholder={account ? '不会读取或回填原密码' : '请输入要安全保存的密码'}
            />
            <small>普通查询、配置导出和备份不会包含此密码。</small>
          </label>
        </div>
        {account?.credential_state === 'missing' && (
          <p className="account-warning">Windows 中未找到此账号密码，请填写新密码恢复。</p>
        )}
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <Button type="button" variant="secondary" disabled={busy} onClick={close}>
            取消
          </Button>
          <Button type="submit" loading={busy} disabled={busy}>
            保存账号
          </Button>
        </div>
      </form>
    </Modal>
  );
}
