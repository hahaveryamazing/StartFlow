import { useEffect, useState } from 'react';
import {
  Download,
  Upload,
  FolderOpen,
  Trash2,
  ShieldCheck,
  Sun,
  Moon,
  Monitor,
  LogOut,
} from 'lucide-react';
import { Shortcuts } from '../shortcuts/Shortcuts';
import { ThemeSettings } from '../themes/ThemeSettings';
import { ColorPicker } from '../themes/ColorPicker';
import { useAppearancePreview } from '../themes/preview';
import { defaultTheme } from '../../types/v2';
import { presets } from '../themes/useTheme';
import { Backups } from '../backups/Backups';
import { Privacy } from '../privacy/Privacy';
import { toast } from 'sonner';
import { useApp, perform } from '../../stores/app';
import { api, errorMessage } from '../../services/api';
import { PageHeader, Toggle } from '../../components/common';
import { Button } from '../../components/ui/button';
import { useConfirm } from '../../components/confirm';
export function Settings() {
  const data = useApp((s) => s.data)!;
  const [draft, setDraft] = useState(data.config.settings);
  const [themeDraft, setThemeDraft] = useState(data.v2?.extension.theme ?? defaultTheme);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const serialized = JSON.stringify(data.config.settings);
  const themeSerialized = JSON.stringify(data.v2?.extension.theme ?? defaultTheme);
  useEffect(() => setDraft(JSON.parse(serialized) as typeof draft), [serialized]);
  useEffect(
    () => setThemeDraft(JSON.parse(themeSerialized) as typeof themeDraft),
    [themeSerialized],
  );
  useEffect(() => {
    useAppearancePreview.getState().setPreview({ settings: draft, theme: themeDraft });
  }, [draft, themeDraft]);
  useEffect(() => () => useAppearancePreview.getState().setPreview(null), []);
  const changed =
    serialized !== JSON.stringify(draft) || themeSerialized !== JSON.stringify(themeDraft);
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft({ ...draft, [key]: value });
  const saveSettings = async () => {
    setBusy(true);
    await perform(() => api.saveSettings(draft, themeDraft), '设置已保存并生效');
    setBusy(false);
  };
  const autostart = async (enabled: boolean) => {
    setBusy(true);
    await perform(
      () => api.autostart(enabled),
      enabled ? 'Windows 登录自启已启用' : 'Windows 登录自启已关闭',
    );
    setBusy(false);
  };
  return (
    <>
      <PageHeader
        eyebrow="使用偏好 / 本地设置"
        title="系统设置"
        description="让 StartFlow 按照你的习惯工作。"
        action={
          <Button loading={busy} disabled={!changed} onClick={() => void saveSettings()}>
            保存设置
          </Button>
        }
      />
      <Privacy />
      <fieldset className="settings-layout" disabled={busy}>
        <div>
          <section className="settings-panel">
            <h2>常规设置</h2>
            <Toggle
              label="Windows 登录后自动启动"
              description="修改后立即生效，状态从 Windows 实际配置查询。首次安装默认关闭。"
              checked={data.autostart_enabled}
              onChange={(v) => void autostart(v)}
            />
            <label className="setting-select">
              <span>
                <strong>关闭主窗口时</strong>
                <small>隐藏到托盘后，后台计划仍继续运行。</small>
              </span>
              <select
                value={draft.close_to_tray ? 'tray' : 'quit'}
                onChange={(e) => set('close_to_tray', e.target.value === 'tray')}
              >
                <option value="tray">隐藏到系统托盘</option>
                <option value="quit">彻底退出程序</option>
              </select>
            </label>
            <Toggle
              label="显示执行通知"
              description="执行完成后，通过 Windows 系统通知反馈结果。"
              checked={draft.notifications}
              onChange={(v) => set('notifications', v)}
            />
            <Toggle
              label="登录自启时显示主窗口"
              description="关闭后在后台启动，不打断当前工作。"
              checked={draft.show_on_autostart}
              onChange={(v) => set('show_on_autostart', v)}
            />
            <label className="setting-select">
              <span>
                <strong>默认启动场景</strong>
                <small>用于托盘菜单中的“启动默认场景”。</small>
              </span>
              <select
                value={draft.default_scene_id ?? ''}
                onChange={(e) => set('default_scene_id', e.target.value || null)}
              >
                <option value="">未设置</option>
                {data.config.scenes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <Toggle
              label="暂停所有自动任务"
              description="手动启动仍可用；恢复后检查补执行窗口。"
              checked={draft.paused}
              onChange={(v) => set('paused', v)}
            />
          </section>
          <section className="settings-panel">
            <h2>外观</h2>
            <div className="theme-options">
              {(
                [
                  { key: 'dark', label: '深色', Icon: Moon },
                  { key: 'light', label: '浅色', Icon: Sun },
                  { key: 'system', label: '跟随系统', Icon: Monitor },
                ] as const
              ).map(({ key, label, Icon }) => (
                <Button
                  key={key}
                  variant="secondary"
                  aria-pressed={draft.theme === key}
                  className={draft.theme === key ? 'selected' : ''}
                  onClick={() => set('theme', key)}
                >
                  <Icon size={18} />
                  {label}
                </Button>
              ))}
            </div>
            <div className="setting-select">
              <span>
                <strong>主题强调色</strong>
                <small>选择后立即预览；保存设置后保留颜色。</small>
              </span>
              <ColorPicker value={draft.accent} onChange={(value) => set('accent', value)} />
            </div>
            <Toggle
              label="界面动画"
              description="控制页面切换和界面过渡效果。"
              checked={draft.animations}
              onChange={(v) => set('animations', v)}
            />
          </section>
        </div>
        <div>
          <section className="settings-panel">
            <h2>数据管理</h2>
            <p className="muted settings-description">
              配置保存在当前用户的应用数据目录，核心功能无需云服务。
            </p>
            <div className="data-buttons">
              <Button variant="secondary" onClick={() => void perform(api.openDirectory)}>
                <FolderOpen size={16} />
                打开数据目录
              </Button>
              <Button
                variant="secondary"
                className="danger-text"
                onClick={() =>
                  void (async () => {
                    if (
                      await confirm(
                        '清空全部运行日志？',
                        '执行详情将永久删除，自动执行去重记录保留。',
                      )
                    )
                      await perform(api.clearLogs, '运行日志已清空');
                  })()
                }
              >
                <Trash2 size={16} />
                清空日志
              </Button>
            </div>
            <code className="directory">{data.data_directory}</code>
          </section>
          <section className="settings-panel about">
            <img src="/startflow.svg" alt="StartFlow" />
            <h2>
              StartFlow <span>3.1.0</span>
            </h2>
            <p>Windows 智能工作流管理平台</p>
            <small>Your Workspace, Ready in Seconds.</small>
            <div className="privacy">
              <ShieldCheck size={17} />
              <span>本地存储 · 无账号 · 无遥测</span>
            </div>
            <p className="hint">
              卸载保留本地配置。彻底退出时调度暂停，重新启动后按补执行规则检查。Windows
              登录自启仅在用户登录后运行。
            </p>
            <Button variant="secondary" onClick={() => void api.quit()}>
              <LogOut size={15} />
              彻底退出 StartFlow
            </Button>
          </section>
        </div>
      </fieldset>
      <div className="v2-settings">
        <ThemeSettings
          draft={themeDraft}
          setDraft={setThemeDraft}
          saving={busy}
          changed={changed}
          onSave={() => void saveSettings()}
          onPreset={(id) => {
            const preset = presets.find((p) => p.id === id)!;
            setThemeDraft((previous) => ({ ...previous, preset: id }));
            setDraft((previous) => ({
              ...previous,
              accent: preset.accent,
              theme: id === 'white' ? 'light' : 'dark',
            }));
          }}
        />
        <Shortcuts />
        <Backups />
      </div>
    </>
  );
}
