import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useApp } from '../stores/app';
import type { Page } from '../types';
export function useBridge() {
  useEffect(() => {
    let alive = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanups: (() => void)[] = [];
    const sync = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => void useApp.getState().refresh(), 80);
    };
    const init = async () => {
      if (isTauri()) {
        const listeners = await Promise.all([
          listen('data-changed', sync),
          listen<{ message: string }>('service-error', (e) => toast.error(e.payload.message)),
          listen<Page>('navigate', (e) => useApp.getState().setPage(e.payload)),
        ]);
        if (alive) cleanups.push(...listeners);
        else listeners.forEach((f) => f());
      }
      if (alive) await useApp.getState().refresh();
    };
    void init().catch(() => void useApp.getState().refresh());
    const timer = setInterval(sync, 60000);
    return () => {
      alive = false;
      clearTimeout(timeout);
      clearInterval(timer);
      cleanups.forEach((f) => f());
    };
  }, []);
}
