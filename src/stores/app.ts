import { create } from 'zustand';
import { toast } from 'sonner';
import { api, errorMessage } from '../services/api';
import type { Snapshot, Page } from '../types';
interface State {
  data: Snapshot | null;
  loading: boolean;
  error: string | null;
  page: Page;
  setPage: (p: Page) => void;
  refresh: () => Promise<void>;
  navigationGuard: (() => Promise<boolean>) | null;
  setNavigationGuard: (guard: (() => Promise<boolean>) | null) => void;
}
let refreshing: Promise<void> | null = null;
let requestedAgain = false;
export const useApp = create<State>((set, get) => ({
  data: null,
  loading: true,
  error: null,
  page: 'dashboard',
  navigationGuard: null,
  setNavigationGuard: (navigationGuard) => set({ navigationGuard }),
  setPage: (page) => {
    const guard = get().navigationGuard;
    if (guard && page !== get().page) {
      void guard().then((ok) => {
        if (ok) set({ page });
      });
    } else {
      set({ page });
    }
  },
  refresh: () => {
    if (refreshing) {
      requestedAgain = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        requestedAgain = false;
        try {
          const data = await api.snapshot();
          set({ data, loading: false, error: null });
        } catch (e) {
          set({ loading: false, error: errorMessage(e) });
        }
      } while (requestedAgain);
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  },
}));
export async function perform(action: () => Promise<unknown>, message?: string): Promise<boolean> {
  try {
    await action();
    await useApp.getState().refresh();
    if (message) toast.success(message);
    return true;
  } catch (e) {
    toast.error(errorMessage(e));
    return false;
  }
}
