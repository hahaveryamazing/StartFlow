import { useMemo, useState } from 'react';
import {
  KeyRound,
  Plus,
  Search,
  Globe,
  AppWindow,
  Pencil,
  Trash2,
  ShieldCheck,
  RotateCw,
  LoaderCircle,
} from 'lucide-react';
import { PageHeader } from '../../components/common';
import { Button } from '../../components/ui/button';
import { useConfirm } from '../../components/confirm';
import type { Account } from '../../types/accounts';
import { AccountEditor } from './AccountEditor';
import { useAccounts } from './useAccounts';
const states = { saved: '密码已保存', missing: '密码未找到', unavailable: '无法查询' };
export function Accounts() {
  const manager = useAccounts();
  const confirm = useConfirm();
  const [edit, setEdit] = useState<Account | null | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('all');
  const filtered = useMemo(
    () =>
      manager.data?.accounts.filter(
        (a) =>
          (kind === 'all' || a.kind === kind) &&
          `${a.name} ${a.username} ${a.target}`
            .toLocaleLowerCase()
            .includes(search.toLocaleLowerCase()),
      ) ?? [],
    [manager.data, search, kind],
  );
  return (
    <>
      <PageHeader
        eyebrow="SECURE ACCOUNTS"
        title="账号与凭据"
        description="集中管理不同网站与应用的账号，密码由 Windows 安全保存。"
        action={
          <Button disabled={manager.loading || manager.busy} onClick={() => setEdit(null)}>
            <Plus size={17} />
            新增账号
          </Button>
        }
      />
      <div className="account-security-note">
        <ShieldCheck size={22} />
        <div>
          <strong>密码保存在当前用户的 Windows 凭据管理器</strong>
          <p>
            StartFlow
            只保存账号信息与凭据引用，不提供密码查看、复制或自动登录。网页与应用均可绑定多个账号。
          </p>
        </div>
      </div>
      {manager.data?.pending_cleanup ? (
        <div className="account-warning" role="status">
          有 {manager.data.pending_cleanup} 条旧密码清理待重试，账号更新已保存。
          <Button variant="secondary" loading={manager.busy} onClick={() => void manager.retry()}>
            重试清理
          </Button>
        </div>
      ) : null}
      <div className="filter-bar">
        <div className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索账号"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索名称、用户名或目标"
          />
        </div>
        <select aria-label="筛选账号类型" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="all">全部类型</option>
          <option value="web">网页账号</option>
          <option value="app">应用账号</option>
        </select>
        <Button variant="secondary" disabled={manager.busy} onClick={() => void manager.refresh()}>
          <RotateCw size={16} />
          刷新状态
        </Button>
      </div>
      {manager.error && (
        <div className="account-warning" role="alert">
          {manager.error}
          <Button variant="secondary" onClick={() => void manager.refresh()}>
            重新加载
          </Button>
        </div>
      )}
      {manager.loading ? (
        <div className="small-empty">
          <LoaderCircle className="spin" />
          正在检查账号与凭据…
        </div>
      ) : filtered.length ? (
        <div className="account-grid">
          {filtered.map((account) => (
            <article className="account-card" key={account.id}>
              <div className="account-card-header">
                <div className="account-icon">
                  {account.kind === 'web' ? <Globe /> : <AppWindow />}
                </div>
                <div>
                  <h3>{account.name}</h3>
                  <span>{account.kind === 'web' ? '网页账号' : 'Windows 应用账号'}</span>
                </div>
                <span className={`account-state ${account.credential_state}`}>
                  {states[account.credential_state]}
                </span>
              </div>
              <dl>
                <dt>用户名</dt>
                <dd>{account.username}</dd>
                <dt>关联目标</dt>
                <dd title={account.target}>{account.target}</dd>
              </dl>
              <footer>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={manager.busy}
                  onClick={() => void manager.check(account)}
                >
                  <ShieldCheck size={15} />
                  检查凭据
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`编辑 ${account.name}`}
                  disabled={manager.busy}
                  onClick={() => setEdit(account)}
                >
                  <Pencil size={16} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`删除 ${account.name}`}
                  disabled={manager.busy}
                  onClick={async () => {
                    if (
                      await confirm(
                        '删除账号与密码',
                        `删除「${account.name}」及其专用 Windows 密码凭据，不影响同一目标的其他账号。无法撤销。`,
                      )
                    )
                      await manager.remove(account);
                  }}
                >
                  <Trash2 size={16} />
                </Button>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        !manager.error && (
          <div className="small-empty">
            <KeyRound size={36} />
            <h3>{manager.data?.accounts.length ? '没有匹配的账号' : '安全整理你的账号'}</h3>
            <p>
              {manager.data?.accounts.length
                ? '尝试其他关键词或类型。'
                : '添加第一个网页或应用账号，密码不会进入配置文件。'}
            </p>
          </div>
        )
      )}
      {edit !== undefined && (
        <AccountEditor
          account={edit}
          busy={manager.busy}
          onClose={() => setEdit(undefined)}
          onSave={manager.save}
        />
      )}
    </>
  );
}
