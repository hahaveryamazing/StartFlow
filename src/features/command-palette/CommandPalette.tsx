import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Command,
  Search,
  Globe,
  AppWindow,
  Folder,
  Pause,
  Play,
  ArrowUpRight,
  LoaderCircle,
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { v2 } from '../../services/v2';
import { errorMessage } from '../../services/api';
import { SceneIcon } from '../../components/common';
import type { PaletteData } from '../../types/v2';
import { useTheme } from '../themes/useTheme';
export function CommandPalette() {
  const [data, setData] = useState<PaletteData | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    const off: (() => void)[] = [];
    const load = async () => {
      try {
        const result = await v2.paletteData();
        if (alive) {
          setData(result);
          setError('');
        }
      } catch (e) {
        if (alive) setError(errorMessage(e));
      }
    };
    const init = async () => {
      const listeners = await Promise.all([
        listen('palette-open', () => {
          setQuery('');
          setSelected(0);
          void load();
          setTimeout(() => input.current?.focus(), 30);
        }),
        listen('data-changed', () => {
          if (document.visibilityState !== 'hidden') void load();
        }),
      ]);
      if (alive) off.push(...listeners);
      else listeners.forEach((f) => f());
      await load();
    };
    void init().catch((e) => setError(errorMessage(e)));
    return () => {
      alive = false;
      off.forEach((f) => f());
    };
  }, []);
  useTheme(data?.settings, data?.theme);
  const rows = useMemo(() => {
    if (!data) return [];
    const scenes = data.scenes
      .filter((s) => s.enabled)
      .map((s) => ({
        id: s.id,
        action: 'scene',
        label: s.name,
        subtitle: '启动场景',
        icon: <SceneIcon icon={s.icon} color={s.color} size={17} />,
        accelerator: data.shortcuts.find(
          (k) => k.action === 'scene' && k.target_id === s.id && k.enabled,
        )?.accelerator,
      }));
    const tasks = data.tasks
      .filter((t) => t.enabled)
      .map((t) => ({
        id: t.id,
        action: 'task',
        label: t.name,
        subtitle: '单独运行任务',
        icon:
          t.kind === 'web' ? (
            <Globe size={18} />
          ) : t.kind === 'app' ? (
            <AppWindow size={18} />
          ) : (
            <Folder size={18} />
          ),
        accelerator: undefined,
      }));
    const actions = [
      {
        id: 'open',
        action: 'open',
        label: '打开 StartFlow',
        subtitle: '完整管理界面',
        icon: <ArrowUpRight size={18} />,
        accelerator: undefined,
      },
      {
        id: data.settings.paused ? 'resume' : 'pause',
        action: data.settings.paused ? 'resume' : 'pause',
        label: data.settings.paused ? '恢复自动调度' : '暂停自动调度',
        subtitle: '后台计划',
        icon: data.settings.paused ? <Play size={18} /> : <Pause size={18} />,
        accelerator: undefined,
      },
    ];
    return [...scenes, ...tasks, ...actions]
      .filter((r) => `${r.label} ${r.subtitle}`.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 40);
  }, [data, query]);
  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const execute = async (index: number) => {
    const row = rows[index];
    if (!row || busy) return;
    setBusy(true);
    try {
      await v2.paletteAction(row.action, ['scene', 'task'].includes(row.action) ? row.id : '');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="palette-shell"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          void v2.hidePalette();
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelected((i) => Math.min(rows.length - 1, i + 1));
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelected((i) => Math.max(0, i - 1));
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          void execute(selected);
        }
      }}
    >
      <div className="palette-search">
        <Search size={20} />
        <input
          ref={input}
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索场景、任务或操作…"
          aria-label="搜索快速命令"
        />
        {busy ? <LoaderCircle className="spin" size={20} /> : <Command size={18} />}
      </div>
      <div className="palette-results" ref={list} role="listbox" aria-label="快速命令结果">
        {error && <p className="hint-box danger-text">{error}</p>}
        {rows.map((r, i) => (
          <button
            role="option"
            aria-selected={selected === i}
            data-index={i}
            className={`palette-item ${selected === i ? 'selected' : ''}`}
            key={`${r.action}:${r.id}`}
            onMouseEnter={() => setSelected(i)}
            onClick={() => void execute(i)}
            disabled={busy}
          >
            {r.icon}
            <span>
              {r.label}
              <small>{r.subtitle}</small>
            </span>
            {r.accelerator && <kbd>{r.accelerator}</kbd>}
          </button>
        ))}
        {!rows.length && (
          <div className="small-empty">{data ? '没有匹配的命令' : '正在读取本地命令…'}</div>
        )}
      </div>
      <div className="palette-footer">
        <span>↑ ↓ 选择 · Enter 执行 · Esc 关闭</span>
        <span>StartFlow 2.0</span>
      </div>
    </div>
  );
}
