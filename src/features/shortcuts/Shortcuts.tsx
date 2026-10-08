import { useState } from 'react';
import { Keyboard, Plus, Pencil, Trash2 } from 'lucide-react';
import { useApp, perform } from '../../stores/app';
import { v2 } from '../../services/v2';
import { emptyExtension, type Shortcut } from '../../types/v2';
import { Button } from '../../components/ui/button';
import { Modal } from '../../components/ui/dialog';
import { useConfirm } from '../../components/confirm';
import { Toggle } from '../../components/common';
export const actions = {
  open: '打开主窗口',
  palette: '快速命令面板',
  scene: '启动场景',
  pause: '暂停自动任务',
  resume: '恢复自动任务',
};
export function accelerator(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
) {
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null;
  const key = /^Key[A-Z]$/.test(e.code)
    ? e.code.slice(3)
    : /^Digit[0-9]$/.test(e.code)
      ? e.code.slice(5)
      : /^(F[1-9]|F1[0-9]|F2[0-4]|Space|Enter|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Insert|Delete)$/.test(
            e.code,
          )
        ? e.code
        : null;
  if (!key) return null;
  return [
    ...(e.ctrlKey ? ['Ctrl'] : []),
    ...(e.altKey ? ['Alt'] : []),
    ...(e.shiftKey ? ['Shift'] : []),
    ...(e.metaKey ? ['Super'] : []),
    key,
  ].join('+');
}
export function Shortcuts() {
  const data = useApp((s) => s.data)!;
  const ext = data.v2?.extension ?? emptyExtension;
  const confirm = useConfirm();
  const [edit, setEdit] = useState<Shortcut | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (list: Shortcut[]) => {
    setBusy(true);
    const ok = await perform(
      () => v2.save({ ...ext, shortcuts: list }),
      '快捷键配置已保存，启用的组合键已实际注册',
    );
    setBusy(false);
    return ok;
  };
  return (
    <section className="settings-panel">
      <h2>
        <Keyboard size={18} /> 全局快捷键
      </h2>
      <p className="hint">按组合键可在主窗口隐藏后执行操作。首次安装没有预注册快捷键。</p>
      <div className="shortcut-list">
        {ext.shortcuts.map((s) => (
          <div className="shortcut-row" key={s.id}>
            <kbd>{s.accelerator.replace('Super', 'Win')}</kbd>
            <div className="grow">
              <strong>
                {actions[s.action]}
                {s.action === 'scene'
                  ? ` · ${data.config.scenes.find((x) => x.id === s.target_id)?.name ?? '未找到场景'}`
                  : ''}
              </strong>
              <small>
                {data.v2?.shortcut_errors.find((x) => x[0] === s.id)?.[1] ??
                  (s.enabled ? '已注册' : '已停用')}
              </small>
            </div>
            <Toggle
              label="启用"
              checked={s.enabled}
              onChange={(enabled) =>
                void save(ext.shortcuts.map((x) => (x.id === s.id ? { ...x, enabled } : x)))
              }
            />
            <Button
              disabled={busy}
              variant="ghost"
              size="icon"
              aria-label="编辑快捷键"
              onClick={() => setEdit({ ...s })}
            >
              <Pencil size={15} />
            </Button>
            <Button
              disabled={busy}
              variant="ghost"
              size="icon"
              aria-label="删除快捷键"
              onClick={() =>
                void (async () => {
                  if (await confirm('删除快捷键？', '删除后会注销当前组合键。'))
                    await save(ext.shortcuts.filter((x) => x.id !== s.id));
                })()
              }
            >
              <Trash2 size={15} />
            </Button>
          </div>
        ))}
      </div>
      <div className="data-buttons">
        <Button
          disabled={busy}
          variant="secondary"
          onClick={() =>
            setEdit({
              id: crypto.randomUUID(),
              action: 'palette',
              target_id: '',
              accelerator: '',
              enabled: true,
            })
          }
        >
          <Plus size={15} />
          添加快捷键
        </Button>
        <Button
          disabled={busy || !ext.shortcuts.length}
          variant="ghost"
          onClick={() =>
            void (async () => {
              if (
                await confirm(
                  '恢复默认快捷键？',
                  '默认不注册任何组合键；现有快捷键将全部注销并删除。',
                )
              )
                await save([]);
            })()
          }
        >
          恢复默认
        </Button>
        <Button variant="ghost" onClick={() => void perform(v2.palette)}>
          打开命令面板
        </Button>
      </div>
      {edit && (
        <Modal
          title="设置快捷键"
          description="请使用 Ctrl、Alt 或 Windows 键与一个普通按键组合。占用或重复配置会被拒绝。"
          open
          onClose={() => {
            setEdit(null);
            setRecording(false);
          }}
        >
          <div className="form-grid">
            <label>
              操作
              <select
                value={edit.action}
                onChange={(e) =>
                  setEdit({ ...edit, action: e.target.value as Shortcut['action'], target_id: '' })
                }
              >
                {Object.entries(actions).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {edit.action === 'scene' && (
              <label>
                场景
                <select
                  value={edit.target_id}
                  onChange={(e) => setEdit({ ...edit, target_id: e.target.value })}
                >
                  <option value="">请选择场景</option>
                  {data.config.scenes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="shortcut-recorder">
            <Button
              variant="secondary"
              aria-label="录制快捷键"
              onClick={() => setRecording(true)}
              onKeyDown={(e) => {
                if (!recording) return;
                e.preventDefault();
                e.stopPropagation();
                if (e.code === 'Escape') {
                  setRecording(false);
                  return;
                }
                const value = accelerator(e.nativeEvent);
                if (value) {
                  setEdit({ ...edit, accelerator: value });
                  setRecording(false);
                }
              }}
            >
              {recording
                ? '请按下组合键…'
                : edit.accelerator.replace('Super', 'Win') || '点击录制快捷键'}
            </Button>
            <small className="muted">录制时 Esc 取消；使用物理按键位置识别字母与数字。</small>
          </div>
          <div className="modal-footer">
            <Button variant="secondary" onClick={() => setEdit(null)}>
              取消
            </Button>
            <Button
              loading={busy}
              disabled={!edit.accelerator || (edit.action === 'scene' && !edit.target_id)}
              onClick={() =>
                void (async () => {
                  if (await save([...ext.shortcuts.filter((x) => x.id !== edit.id), edit]))
                    setEdit(null);
                })()
              }
            >
              保存并注册
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
