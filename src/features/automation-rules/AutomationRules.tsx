import { useState, useEffect } from 'react';
import { Plus, Search, ShieldCheck } from 'lucide-react';
import { useApp, perform } from '../../stores/app';
import { v3 } from '../../services/v3';
import { call, errorMessage } from '../../services/api';
import { Button } from '../../components/ui/button';
import { Modal } from '../../components/ui/dialog';
import { PageHeader, Empty, Toggle } from '../../components/common';
import { useConfirm } from '../../components/confirm';
import { eventLabels, newRule, type Rule, type Target } from '../../types/v3';
import { ConditionEditor } from './ConditionEditor';
import { DecisionRows } from '../decision-history/DecisionHistory';
export function TargetFields({
  value,
  onChange,
}: {
  value: Target;
  onChange: (t: Target) => void;
}) {
  const d = useApp((s) => s.data)!;
  return (
    <div className="form-grid">
      <label>
        启动场景
        <select
          value={value.scene_id}
          onChange={(e) => onChange({ scene_id: e.target.value, workflow_id: null })}
        >
          <option value="">请选择场景</option>
          {d.config.scenes.map((s) => (
            <option value={s.id} key={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        执行工作流
        <select
          value={value.workflow_id ?? ''}
          onChange={(e) => onChange({ ...value, workflow_id: e.target.value || null })}
        >
          <option value="">沿用场景当前运行模式</option>
          {d.v2?.extension.workflows
            .filter((w) => w.scene_id === value.scene_id)
            .map((w) => (
              <option value={w.id} key={w.id}>
                {w.name}
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}
export function AutomationRules() {
  const d = useApp((s) => s.data)!;
  const a = d.v3!;
  const c = a.config;
  const [warnings, setWarnings] = useState<{ rule_ids: string[]; description: string }[]>([]);
  const [diagnosticError, setDiagnosticError] = useState('');
  useEffect(() => {
    let alive = true;
    void call<{ rule_ids: string[]; description: string }[]>('v3_conflicts')
      .then((rows) => {
        if (alive) {
          setWarnings(rows);
          setDiagnosticError('');
        }
      })
      .catch((e) => {
        if (alive) setDiagnosticError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [c]);
  const [query, setQuery] = useState('');
  const [edit, setEdit] = useState<Rule | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const page = useApp((s) => s.setPage);
  async function save() {
    if (!edit) return;
    setBusy(true);
    try {
      if (
        edit.policy === 'auto' &&
        !(await confirm(
          '授权此规则自动执行？',
          '条件满足后将提交所选场景或模式工作流，可能启动程序或移动已配置窗口。你可随时暂停。',
        ))
      )
        return;
      const config = { ...c, rules: [...c.rules.filter((r) => r.id !== edit.id), edit] };
      if (await perform(() => v3.save(config), '规则已验证并保存')) setEdit(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="环境 / 决策 / 执行"
        title="智能规则"
        description="用条件选择工作内容；每次执行与跳过都有可查看的本地原因。"
        action={
          <Button onClick={() => setEdit(newRule(d.config.scenes[0]?.id))}>
            <Plus size={16} />
            新增规则
          </Button>
        }
      />
      {(warnings.length > 0 || diagnosticError) && (
        <details className="panel conflict-diagnostics">
          <summary>本地冲突检查 · {warnings.length} 项潜在重叠</summary>
          <p className="hint">
            以下为配置引用的确定性交集，是否同时匹配取决于环境；不是 AI 推测的执行结果。
          </p>
          {diagnosticError && <p className="error-text">{diagnosticError}</p>}
          {warnings.map((w, i) => (
            <p className="hint" key={i}>
              {w.description}
            </p>
          ))}
        </details>
      )}
      <div className="panel automation-toolbar">
        <Toggle
          label="启用智能规则"
          description="只控制 V3 新规则；暂停所有自动化会同时暂停原有调度。"
          checked={c.enabled}
          onChange={(enabled) =>
            void (async () => {
              if (
                enabled &&
                !(await confirm(
                  '开启智能规则？',
                  '已明确设置为自动执行的规则会在环境事件到达时提交工作流。新建规则默认请求确认。',
                ))
              )
                return;
              await perform(
                () => v3.save({ ...c, enabled }),
                enabled ? '智能规则已启用' : '智能规则已关闭',
              );
            })()
          }
        />
        <div className="data-buttons">
          <Button
            variant="secondary"
            onClick={() => void perform(v3.refresh, '已提交当前环境重新评估，等待稳定后查看决策')}
          >
            重新评估当前环境
          </Button>
          <Button variant="secondary" onClick={() => page('simulator')}>
            规则模拟器
          </Button>
          <Button variant="ghost" onClick={() => page('decisions')}>
            完整决策记录
          </Button>
        </div>
      </div>
      <div className="search-field">
        <Search size={16} />
        <input
          aria-label="搜索智能规则"
          placeholder="搜索规则…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {c.rules.length ? (
        <div className="automation-rule-grid">
          {c.rules
            .filter((r) => (r.name + r.description).includes(query))
            .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
            .map((r) => (
              <div className="panel automation-rule-card" key={r.id}>
                <div className="card-top">
                  <ShieldCheck size={20} />
                  <span className="soft-badge">
                    优先级 {r.priority} · v{r.version}
                  </span>
                </div>
                <h3>{r.name}</h3>
                <p>{r.description || r.triggers.map((t) => eventLabels[t]).join(' / ')}</p>
                <small className="hint">
                  {r.enabled ? '已启用' : '已停用'} ·{' '}
                  {{ notify: '仅提示', confirm: '请求确认', auto: '自动执行' }[r.policy]} · 冷却{' '}
                  {r.cooldown_seconds} 秒
                </small>
                <div className="data-buttons">
                  <Button size="sm" variant="secondary" onClick={() => setEdit(structuredClone(r))}>
                    编辑规则
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void perform(
                        () =>
                          v3.save({
                            ...c,
                            rules: c.rules.map((x) =>
                              x.id === r.id ? { ...x, enabled: !x.enabled } : x,
                            ),
                          }),
                        '规则状态已更新',
                      )
                    }
                  >
                    {r.enabled ? '停用' : '启用'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void (async () => {
                        if (
                          await confirm(
                            '删除智能规则？',
                            '原有场景、工作流和历史决策保留，规则不再触发。',
                          )
                        )
                          await perform(
                            () => v3.save({ ...c, rules: c.rules.filter((x) => x.id !== r.id) }),
                            '规则已删除',
                          );
                      })()
                    }
                  >
                    删除
                  </Button>
                </div>
              </div>
            ))}
        </div>
      ) : (
        <Empty
          title="让设备环境为你选择工作内容"
          description="创建规则，先通过模拟器检查条件和冲突，再决定仅提示、确认或自动执行。"
          action={
            <Button onClick={() => setEdit(newRule(d.config.scenes[0]?.id))}>创建第一条规则</Button>
          }
        />
      )}
      <section className="panel recent-decisions">
        <h2>最近判断与待确认建议</h2>
        <DecisionRows decisions={a.decisions.slice(0, 8)} />
      </section>
      {edit && (
        <Modal
          open
          wide
          title="配置智能规则"
          description="所有参数由 Rust 保存前验证。未知权限不会被当作 False。"
          onClose={() => {
            if (!busy)
              void (async () => {
                if (await confirm('关闭规则编辑？', '未保存的修改将丢失。')) setEdit(null);
              })();
          }}
        >
          <fieldset disabled={busy} className="rule-form">
            <div className="form-grid">
              <label>
                规则名称
                <input
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
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
            </div>
            <label>
              规则描述
              <input
                value={edit.description}
                onChange={(e) => setEdit({ ...edit, description: e.target.value })}
              />
            </label>
            <h3>什么时候触发</h3>
            <div className="trigger-picker">
              {Object.entries(eventLabels)
                .filter(([key]) => key !== 'refresh')
                .map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={edit.triggers.includes(key as (typeof edit.triggers)[number])}
                      onChange={(e) => {
                        const triggers = e.target.checked
                          ? [...edit.triggers, key as (typeof edit.triggers)[number]]
                          : edit.triggers.filter((t) => t !== key);
                        setEdit({
                          ...edit,
                          triggers,
                          schedule: triggers.includes('schedule')
                            ? (edit.schedule ?? {
                                time: '09:00',
                                days: [1, 2, 3, 4, 5],
                                catch_up_minutes: 120,
                              })
                            : null,
                        });
                      }}
                    />
                    {label}
                  </label>
                ))}
            </div>
            {edit.schedule && (
              <div className="form-grid">
                <label>
                  计划时间
                  <input
                    type="time"
                    value={edit.schedule.time}
                    onChange={(e) =>
                      setEdit({ ...edit, schedule: { ...edit.schedule!, time: e.target.value } })
                    }
                  />
                </label>
                <label>
                  补执行窗口
                  <select
                    value={edit.schedule.catch_up_minutes}
                    onChange={(e) =>
                      setEdit({
                        ...edit,
                        schedule: { ...edit.schedule!, catch_up_minutes: +e.target.value },
                      })
                    }
                  >
                    <option value={0}>关闭（当分钟）</option>
                    <option value={30}>30 分钟</option>
                    <option value={120}>120 分钟</option>
                  </select>
                </label>
                <div className="weekday-picker">
                  {['一', '二', '三', '四', '五', '六', '日'].map((day, index) => (
                    <label key={day}>
                      <input
                        type="checkbox"
                        checked={edit.schedule!.days.includes(index + 1)}
                        onChange={(e) =>
                          setEdit({
                            ...edit,
                            schedule: {
                              ...edit.schedule!,
                              days: e.target.checked
                                ? [...edit.schedule!.days, index + 1]
                                : edit.schedule!.days.filter((d) => d !== index + 1),
                            },
                          })
                        }
                      />
                      周{day}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <h3>满足什么条件</h3>
            <ConditionEditor
              value={edit.condition}
              onChange={(condition) => setEdit({ ...edit, condition })}
              config={c}
            />
            <h3>执行什么工作内容</h3>
            <label>
              关联工作模式
              <select
                value={edit.mode_id ?? ''}
                onChange={(e) => setEdit({ ...edit, mode_id: e.target.value || null })}
              >
                <option value="">直接启动场景</option>
                {c.modes.map((m) => (
                  <option value={m.id} key={m.id}>
                    {m.name} · {m.exclusive_group || '可共存'}
                  </option>
                ))}
              </select>
            </label>
            {!edit.mode_id && (
              <TargetFields
                value={edit.target}
                onChange={(target) => setEdit({ ...edit, target })}
              />
            )}
            <div className="form-grid">
              <label>
                执行策略
                <select
                  value={edit.policy}
                  onChange={(e) => setEdit({ ...edit, policy: e.target.value as Rule['policy'] })}
                >
                  <option value="notify">仅提示，不启动</option>
                  <option value="confirm">用户确认后启动</option>
                  <option value="auto">授权自动执行</option>
                </select>
              </label>
              <label>
                冷却时间（秒）
                <input
                  type="number"
                  min={0}
                  max={86400}
                  value={edit.cooldown_seconds}
                  onChange={(e) => setEdit({ ...edit, cooldown_seconds: +e.target.value })}
                />
              </label>
              <label>
                最短稳定时间（秒）
                <input
                  type="number"
                  min={0}
                  max={300}
                  value={edit.stability_seconds}
                  onChange={(e) => setEdit({ ...edit, stability_seconds: +e.target.value })}
                />
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={edit.enabled}
                  onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })}
                />
                保存后启用规则
              </label>
            </div>
            <p className="hint">
              同场景互斥、自动自然日去重与最多 4 个执行继续生效；调整条件顺序不改变 AND / OR 语义。
            </p>
            <div className="modal-footer">
              <Button variant="secondary" disabled={busy} onClick={() => setEdit(null)}>
                取消
              </Button>
              <Button loading={busy} onClick={() => void save()}>
                验证并保存规则
              </Button>
            </div>
          </fieldset>
        </Modal>
      )}
    </>
  );
}
