import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useApp, perform } from '../../stores/app';
import { v3 } from '../../services/v3';
import { Button } from '../../components/ui/button';
import { Modal } from '../../components/ui/dialog';
import { PageHeader, Empty, SceneIcon } from '../../components/common';
import { TargetFields } from '../automation-rules/AutomationRules';
import { useConfirm } from '../../components/confirm';
import type { Mode } from '../../types/v3';
import { toast } from 'sonner';
import { errorMessage } from '../../services/api';
import { modeRuleDraft } from './presets';
const presets = [
  {
    name: '日常办公',
    icon: 'briefcase',
    color: '#3b82f6',
    description: '在信任网络和工作时间中使用；条件由智能规则配置。',
  },
  {
    name: '视频创作',
    icon: 'video',
    color: '#a78bfa',
    description: '结合外接显示器和已配置的剪辑应用，使用创作场景。',
  },
  {
    name: '便携办公',
    icon: 'coffee',
    color: '#22c55e',
    description: '结合电池与单屏条件选择轻量工作内容。',
  },
  {
    name: '个人娱乐',
    icon: 'gamepad',
    color: '#f59e0b',
    description: '由你手动启动，不关闭其它模式已启动的应用。',
  },
];
export function WorkspaceModes() {
  const d = useApp((s) => s.data)!;
  const a = d.v3!;
  const [edit, setEdit] = useState<Mode | null>(null);
  const [presetIndex, setPresetIndex] = useState<number | null>(null);
  const [hold, setHold] = useState('hour');
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const setPage = useApp((s) => s.setPage);
  const create = (index: number) => {
    setPresetIndex(index);
    setEdit({
      id: crypto.randomUUID(),
      ...presets[index],
      enabled: true,
      priority: index === 1 ? 80 : index === 2 ? 30 : 50,
      exclusive_group: 'workspace',
      strategy: index === 3 ? 'manual' : 'suggest',
      targets: [{ scene_id: d.config.scenes[0]?.id ?? '', workflow_id: null }],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  };
  async function save() {
    if (!edit) return;
    setBusy(true);
    try {
      if (
        edit.strategy === 'auto' &&
        !(await confirm(
          '允许自动切换此工作模式？',
          '只有已授权规则匹配时才启动关联场景；不会关闭原模式的程序。',
        ))
      )
        return;
      if (
        await perform(() => {
          const draft = presetIndex === null ? null : modeRuleDraft(presetIndex, edit);
          return v3.save({
            ...a.config,
            rules: draft ? [...a.config.rules, draft] : a.config.rules,
            modes: [...a.config.modes.filter((m) => m.id !== edit.id), edit],
          });
        }, '工作模式已保存')
      )
        setEdit(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="工作内容 / 适用环境 / 手动覆盖"
        title="工作模式"
        description="场景定义内容，工作流定义顺序，工作模式定义何时适合使用。"
        action={
          <Button onClick={() => create(0)}>
            <Plus size={16} />
            新增模式
          </Button>
        }
      />
      <div className="panel mode-override-bar">
        <span>
          {a.manual_override
            ? '当前处于手动覆盖，环境规则不会改变你的选择。'
            : '尚无手动覆盖，自动规则按你设置的策略决策。'}
        </span>
        <label>
          切换后保持
          <select value={hold} onChange={(e) => setHold(e.target.value)}>
            <option value="hour">1 小时</option>
            <option value="day">到今天结束</option>
            <option value="login">到下次 Windows 登录启动</option>
            <option value="manual">到手动取消</option>
          </select>
        </label>
        {a.manual_override && (
          <Button
            variant="ghost"
            onClick={() => void perform(v3.clearOverride, '覆盖已取消，按最新状态重新评估')}
          >
            取消覆盖
          </Button>
        )}
      </div>
      <div className="mode-presets">
        {presets.map((p, index) => (
          <Button variant="secondary" key={p.name} onClick={() => create(index)}>
            从「{p.name}」创建
          </Button>
        ))}
      </div>
      {a.config.modes.length ? (
        <div className="automation-rule-grid">
          {a.config.modes.map((m) => (
            <article
              className={`panel mode-card ${a.current_mode === m.id ? 'selected' : ''}`}
              key={m.id}
            >
              <SceneIcon icon={m.icon} color={m.color} />
              <h3>{m.name}</h3>
              <p>{m.description}</p>
              <small className="hint">
                {m.targets.length} 个场景 ·{' '}
                {{ manual: '完全手动', suggest: '建议切换', auto: '授权自动切换' }[m.strategy]} ·{' '}
                {m.exclusive_group || '允许共存'}
              </small>
              <div className="data-buttons">
                <Button
                  size="sm"
                  disabled={busy || !m.enabled}
                  onClick={() =>
                    void (async () => {
                      if (
                        !(await confirm(
                          `启动「${m.name}」并手动覆盖？`,
                          '关联工作流会执行，包括其中的启动请求和布局操作；原模式应用保留。',
                        ))
                      )
                        return;
                      setBusy(true);
                      try {
                        const result = await v3.switchMode(m.id, hold);
                        await useApp.getState().refresh();
                        if (result.errors.length) toast.error(result.errors.join(' '));
                        else toast.success('模式已选择，关联执行请求已提交');
                      } catch (e) {
                        toast.error(errorMessage(e));
                      } finally {
                        setBusy(false);
                      }
                    })()
                  }
                >
                  选择并启动
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setPresetIndex(null);
                    setEdit(structuredClone(m));
                  }}
                >
                  编辑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void (async () => {
                      if (
                        await confirm(
                          '删除工作模式？',
                          '需先修改引用它的智能规则；场景和工作流保留。',
                        )
                      )
                        await perform(
                          () =>
                            v3.save({
                              ...a.config,
                              modes: a.config.modes.filter((x) => x.id !== m.id),
                            }),
                          '工作模式已删除',
                        );
                    })()
                  }
                >
                  删除
                </Button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title="创建适合你的工作模式"
          description="模板提供基础环境规则草稿；由你关联已有场景、补充条件并主动启用。"
        />
      )}
      <p className="hint">
        规则优先级相同时，再比较模式优先级；同一互斥组只能选择一个候选模式。手动启动保留同场景互斥。
      </p>
      {edit && (
        <Modal open wide title="编辑工作模式" onClose={() => setEdit(null)}>
          {presetIndex !== null && presetIndex !== 3 && (
            <p className="hint">
              保存时同时创建停用的环境规则草稿。办公 Wi-Fi
              和具体应用需在智能规则中由你补充；不会自动执行。
            </p>
          )}
          <fieldset disabled={busy}>
            <div className="form-grid">
              <label>
                模式名称
                <input
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                />
              </label>
              <label>
                颜色
                <input
                  type="color"
                  value={edit.color}
                  onChange={(e) => setEdit({ ...edit, color: e.target.value })}
                />
              </label>
              <label>
                优先级
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={edit.priority}
                  onChange={(e) => setEdit({ ...edit, priority: +e.target.value })}
                />
              </label>
              <label>
                互斥组
                <input
                  value={edit.exclusive_group}
                  onChange={(e) => setEdit({ ...edit, exclusive_group: e.target.value })}
                  placeholder="留空允许共存"
                />
              </label>
              <label>
                切换策略
                <select
                  value={edit.strategy}
                  onChange={(e) =>
                    setEdit({ ...edit, strategy: e.target.value as Mode['strategy'] })
                  }
                >
                  <option value="manual">完全手动</option>
                  <option value="suggest">仅建议切换</option>
                  <option value="auto">授权自动切换</option>
                </select>
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={edit.enabled}
                  onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })}
                />
                启用模式
              </label>
            </div>
            <label>
              说明
              <input
                value={edit.description}
                onChange={(e) => setEdit({ ...edit, description: e.target.value })}
              />
            </label>
            <h3>关联场景与工作流</h3>
            {edit.targets.map((t, index) => (
              <div className="condition-card" key={index}>
                <TargetFields
                  value={t}
                  onChange={(target) =>
                    setEdit({
                      ...edit,
                      targets: edit.targets.map((x, i) => (i === index ? target : x)),
                    })
                  }
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={edit.targets.length === 1}
                  onClick={() =>
                    setEdit({ ...edit, targets: edit.targets.filter((_, i) => i !== index) })
                  }
                >
                  移除此关联
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="secondary"
              disabled={edit.targets.length >= 4}
              onClick={() =>
                setEdit({
                  ...edit,
                  targets: [...edit.targets, { scene_id: '', workflow_id: null }],
                })
              }
            >
              添加关联
            </Button>
            <p className="hint">
              先保存模式，再到智能规则页面配置匹配条件。切换只启动新工作内容，不终止第三方应用。
            </p>
            <div className="modal-footer">
              <Button variant="secondary" onClick={() => setEdit(null)}>
                取消
              </Button>
              <Button loading={busy} onClick={() => void save()}>
                保存模式
              </Button>
            </div>
          </fieldset>
        </Modal>
      )}
      <div className="data-buttons">
        <Button variant="secondary" onClick={() => setPage('rules')}>
          为模式配置智能规则
        </Button>
      </div>
    </>
  );
}
