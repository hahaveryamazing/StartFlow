import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { accounts } from '../../services/accounts';
import { errorMessage } from '../../services/api';
import type { Account, AccountList, AccountWrite } from '../../types/accounts';
export function useAccounts() {
  const [data, setData] = useState<AccountList | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const data = await accounts.list();
      if (alive.current) {
        setData(data);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(errorMessage(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);
  const mutate = async (action: () => Promise<{ pending_cleanup: number }>, message: string) => {
    setBusy(true);
    try {
      const result = await action();
      if (result.pending_cleanup) toast.warning(`${message}。有密码清理待重试，请查看页面提示。`);
      else toast.success(message);
      await refresh();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return {
    data,
    loading,
    busy,
    error,
    refresh,
    save: (request: AccountWrite) => mutate(() => accounts.save(request), '账号已保存'),
    remove: (account: Account) =>
      mutate(() => accounts.delete(account.id, account.revision), '账号已移除'),
    retry: () =>
      mutate(async () => ({ pending_cleanup: await accounts.cleanup() }), '清理检查已完成'),
    check: async (account: Account) => {
      setBusy(true);
      try {
        const present = await accounts.exists(account.id);
        present
          ? toast.success('Windows 中已保存此账号凭据')
          : toast.warning('未找到密码，请编辑账号重新设置');
        await refresh();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        if (alive.current) setBusy(false);
      }
    },
  };
}
