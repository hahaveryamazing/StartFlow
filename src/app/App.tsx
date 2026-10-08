import { useEffect, useState, lazy, Suspense } from 'react';
import {
  LayoutDashboard,
  Layers,
  ListChecks,
  CalendarClock,
  History,
  Settings2,
  Sun,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  LoaderCircle,
  RotateCw,
  AlertCircle,
  GitBranch,
  PanelsTopLeft,
  Command,
} from 'lucide-react';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import { Toaster } from 'sonner';
import { useApp, perform } from '../stores/app';
import { api } from '../services/api';
import { useBridge } from '../hooks/bridge';
import { useTheme } from '../features/themes/useTheme';
import { v2 } from '../services/v2';
import { Button } from '../components/ui/button';
import { ConfirmProvider } from '../components/confirm';
import type { Page } from '../types';
const nav = [
  { key: 'dashboard', label: '工作台', Icon: LayoutDashboard },
  { key: 'scenes', label: '启动场景', Icon: Layers },
  { key: 'workflows', label: '工作流', Icon: GitBranch },
  { key: 'tasks', label: '任务管理', Icon: ListChecks },
  { key: 'schedules', label: '计划调度', Icon: CalendarClock },
  { key: 'layouts', label: '窗口布局', Icon: PanelsTopLeft },
  { key: 'logs', label: '运行日志', Icon: History },
  { key: 'settings', label: '系统设置', Icon: Settings2 },
] as const;
const pages = {
  dashboard: lazy(() =>
    import('../features/dashboard/Dashboard').then((m) => ({ default: m.Dashboard })),
  ),
  scenes: lazy(() => import('../features/scenes/Scenes').then((m) => ({ default: m.Scenes }))),
  workflows: lazy(() =>
    import('../features/workflows/Workflows').then((m) => ({ default: m.Workflows })),
  ),
  layouts: lazy(() =>
    import('../features/window-layouts/WindowLayouts').then((m) => ({ default: m.WindowLayouts })),
  ),
  tasks: lazy(() => import('../features/tasks/Tasks').then((m) => ({ default: m.Tasks }))),
  schedules: lazy(() =>
    import('../features/schedules/Schedules').then((m) => ({ default: m.Schedules })),
  ),
  logs: lazy(() => import('../features/logs/Logs').then((m) => ({ default: m.Logs }))),
  settings: lazy(() =>
    import('../features/settings/Settings').then((m) => ({ default: m.Settings })),
  ),
};
const Onboarding = lazy(() =>
  import('../features/settings/Onboarding').then((m) => ({ default: m.Onboarding })),
);
export function App() {
  useBridge();
  const { data, loading, error, page, setPage, refresh } = useApp();
  const [collapsed, setCollapsed] = useState(false);
  const [themeBusy, setThemeBusy] = useState(false);
  const settings = data?.config.settings;
  const { dark, background } = useTheme(settings, data?.v2?.extension.theme);
  const Content = pages[page];
  return (
    <MotionConfig reducedMotion={settings?.animations === false ? 'always' : 'user'}>
      <ConfirmProvider>
        <div className="app-background" style={background} />
        <div className={`app-shell ${collapsed ? 'collapsed' : ''}`}>
          <aside className="sidebar">
            <a
              className="brand"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setPage('dashboard');
              }}
            >
              <img src="/startflow.svg" alt="" />
              <span>
                StartFlow<small>智能工作启动中心</small>
              </span>
            </a>
            <div className="nav-caption">工作空间</div>
            <nav aria-label="主导航">
              {nav.map(({ key, label, Icon }) => (
                <button
                  key={key}
                  className={`nav-item ${page === key ? 'active' : ''}`}
                  aria-current={page === key ? 'page' : undefined}
                  aria-label={label}
                  title={collapsed ? label : undefined}
                  onClick={() => setPage(key)}
                >
                  <Icon size={19} />
                  <span>{label}</span>
                  {key === 'scenes' && data && <small>{data.config.scenes.length}</small>}
                </button>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="local-info">
                <span className={`pulse-dot ${data?.config.settings.paused ? 'paused' : ''}`} />
                <span>
                  {data ? '本地服务已连接' : '正在连接服务'}
                  <small>StartFlow v2.0.0</small>
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={collapsed ? '展开导航' : '收起导航'}
                onClick={() => setCollapsed(!collapsed)}
              >
                {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
              </Button>
            </div>
          </aside>
          <div className="workspace">
            <header className="topbar">
              <div className="breadcrumbs">
                工作空间<span>/</span>
                <strong>{nav.find((n) => n.key === page)?.label}</strong>
              </div>
              <div className="topbar-right">
                <span className="top-date">
                  {new Date().toLocaleDateString('zh-CN', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                    weekday: 'long',
                  })}
                </span>
                <span className={`system-status ${settings?.paused ? 'paused' : ''}`}>
                  <span className="pulse-dot" />
                  {loading
                    ? '正在连接'
                    : settings?.paused
                      ? '自动任务已暂停'
                      : error
                        ? '服务不可用'
                        : '后台调度已就绪'}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="快速命令面板"
                  onClick={() => void perform(v2.palette)}
                >
                  <Command size={18} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  loading={themeBusy}
                  aria-label="切换主题"
                  disabled={!settings}
                  onClick={() =>
                    void (async () => {
                      if (settings) {
                        setThemeBusy(true);
                        await perform(
                          () => api.saveSettings({ ...settings, theme: dark ? 'light' : 'dark' }),
                          '主题已保存',
                        );
                        setThemeBusy(false);
                      }
                    })()
                  }
                >
                  {dark ? <Sun size={18} /> : <Moon size={18} />}
                </Button>
              </div>
            </header>
            <main className="main-content">
              {loading ? (
                <div className="full-state">
                  <LoaderCircle className="spin" size={32} />
                  <h2>正在准备你的工作空间</h2>
                  <p>读取本地配置与运行记录…</p>
                </div>
              ) : error ? (
                <div className="full-state">
                  <AlertCircle size={36} />
                  <h2>暂时无法连接本地服务</h2>
                  <p>{error}</p>
                  <Button onClick={() => void refresh()}>
                    <RotateCw size={16} />
                    重试连接
                  </Button>
                </div>
              ) : (
                data && (
                  <AnimatePresence mode="wait">
                    <motion.div
                      key={page}
                      initial={settings?.animations ? { opacity: 0, y: 8 } : false}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: settings?.animations ? 0.16 : 0 }}
                    >
                      <Suspense
                        fallback={
                          <div className="small-empty">
                            <LoaderCircle className="spin" size={24} />
                            正在准备页面…
                          </div>
                        }
                      >
                        <Content />
                      </Suspense>
                    </motion.div>
                  </AnimatePresence>
                )
              )}
            </main>
          </div>
        </div>
        {data && !data.config.settings.onboarding_done && (
          <Suspense fallback={null}>
            <Onboarding />
          </Suspense>
        )}
        <Toaster theme={dark ? 'dark' : 'light'} richColors position="bottom-right" closeButton />
      </ConfirmProvider>
    </MotionConfig>
  );
}
