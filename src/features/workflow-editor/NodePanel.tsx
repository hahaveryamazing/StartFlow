import { useState } from 'react';
import { Plus, Trash2, Pencil } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { useApp } from '../../stores/app';
import { useEditor } from './store';
import { Button } from '../../components/ui/button';
import { TaskEditor } from '../tasks/TaskEditor';
import { newTask } from '../../utils/format';
import type { Condition, WorkflowNode, NodeConfig } from '../../types/v2';
import type { Task } from '../../types';
import { nodeLabels } from '../workflows/schema';
import { errorMessage } from '../../services/api';
function DelayField({
  milliseconds,
  onChange,
}: {
  milliseconds: number;
  onChange: (value: number) => void;
}) {
  const [unit, setUnit] = useState(1000);
  return (
    <div className="inline-fields">
      <input
        aria-label="等待时长"
        type="number"
        min={0}
        max={600000 / unit}
        step={1 / unit}
        value={milliseconds / unit}
        onChange={(e) => onChange(Math.round(+e.target.value * unit))}
      />
      <select aria-label="等待单位" value={unit} onChange={(e) => setUnit(+e.target.value)}>
        <option value={1}>毫秒</option>
        <option value={1000}>秒</option>
        <option value={60000}>分钟</option>
      </select>
    </div>
  );
}
const conditionNames = {
  time: '时间区间',
  weekdays: '星期 / 自定义工作日',
  process: '程序正在运行',
  network: '本地网络可用',
  service: 'HTTPS 服务可访问',
  file: '文件存在',
  folder: '文件夹存在',
};
function defaultCondition(type: Condition['type']): Condition {
  switch (type) {
    case 'time':
      return { type, start: '09:00', end: '18:00' };
    case 'weekdays':
      return { type, days: [1, 2, 3, 4, 5] };
    case 'network':
      return { type };
    case 'service':
      return { type, url: '', timeout_seconds: 5 };
    default:
      return { type, path: '' };
  }
}
function ConditionRow({
  value,
  onChange,
  onDelete,
}: {
  value: Condition;
  onChange: (v: Condition) => void;
  onDelete: () => void;
}) {
  const choose = async () => {
    try {
      const path = await open({
        directory: value.type === 'folder',
        multiple: false,
        filters: value.type === 'process' ? [{ name: '程序', extensions: ['exe'] }] : undefined,
      });
      if (typeof path === 'string' && 'path' in value) onChange({ ...value, path });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div className="condition-row">
      <div className="inline-fields">
        <select
          aria-label="条件类型"
          value={value.type}
          onChange={(e) => onChange(defaultCondition(e.target.value as Condition['type']))}
        >
          {Object.entries(conditionNames).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <Button variant="ghost" size="icon" aria-label="删除条件" onClick={onDelete}>
          <Trash2 size={14} />
        </Button>
      </div>
      {value.type === 'time' && (
        <div className="inline-fields">
          <input
            aria-label="开始时间"
            type="time"
            value={value.start}
            onChange={(e) => onChange({ ...value, start: e.target.value })}
          />
          <input
            aria-label="结束时间"
            type="time"
            value={value.end}
            onChange={(e) => onChange({ ...value, end: e.target.value })}
          />
        </div>
      )}
      {value.type === 'weekdays' && (
        <div className="weekday-grid">
          {['一', '二', '三', '四', '五', '六', '日'].map((label, i) => (
            <button
              key={i}
              className={value.days.includes(i + 1) ? 'selected' : ''}
              onClick={() =>
                onChange({
                  ...value,
                  days: value.days.includes(i + 1)
                    ? value.days.filter((d) => d !== i + 1)
                    : [...value.days, i + 1].sort(),
                })
              }
              aria-pressed={value.days.includes(i + 1)}
            >
              周{label}
            </button>
          ))}
        </div>
      )}
      {'path' in value && (
        <>
          <input
            aria-label="条件本地路径"
            value={value.path}
            placeholder="选择或输入完整本地路径"
            onChange={(e) => onChange({ ...value, path: e.target.value })}
          />
          <Button variant="secondary" size="sm" onClick={() => void choose()}>
            <FolderIcon />
            选择路径
          </Button>
        </>
      )}
      {value.type === 'service' && (
        <>
          <input
            aria-label="条件 HTTPS 服务"
            value={value.url}
            placeholder="https://…"
            onChange={(e) => onChange({ ...value, url: e.target.value })}
          />
          <label>
            探测超时（秒）
            <input
              type="number"
              min={1}
              max={90}
              value={value.timeout_seconds}
              onChange={(e) => onChange({ ...value, timeout_seconds: +e.target.value })}
            />
          </label>
        </>
      )}
      {value.type === 'network' && <p className="muted">仅判断本地接口连接，不代表互联网可达。</p>}
    </div>
  );
}
function FolderIcon() {
  return <Plus size={13} />;
}
export function NodePanel({ node }: { node: WorkflowNode | null }) {
  const data = useApp((s) => s.data)!;
  const editor = useEditor();
  const [editing, setEditing] = useState<Task | null>(null);
  if (!node)
    return (
      <aside className="node-panel">
        <span className="eyebrow">节点配置</span>
        <div className="small-empty">选择画布中的节点，配置执行内容。</div>
        <p className="hint-box">流程不支持循环和汇合。条件分支应分别连接结束节点。</p>
      </aside>
    );
  const update = (patch: Partial<WorkflowNode>) => {
    if (editor.workflow)
      editor.change({
        ...editor.workflow,
        nodes: editor.workflow.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)),
      });
  };
  const cfg = node.config;
  const setConfig = (config: NodeConfig) => update({ config });
  const task = 'task_id' in cfg ? data.config.tasks.find((t) => t.id === cfg.task_id) : undefined;
  const taskType = ['web', 'app', 'folder'].includes(cfg.type) ? (cfg.type as Task['kind']) : null;
  return (
    <aside className="node-panel">
      <div className="panel-caption">
        <span className="eyebrow">节点配置</span>
        <small>{nodeLabels[cfg.type]}</small>
      </div>
      <label>
        节点名称
        <input value={node.name} onChange={(e) => update({ name: e.target.value })} />
      </label>
      {taskType && 'task_id' in cfg && (
        <>
          <label>
            使用已配置任务
            <select
              value={cfg.task_id}
              onChange={(e) => setConfig({ ...cfg, task_id: e.target.value })}
            >
              <option value="">请选择任务</option>
              {data.config.tasks
                .filter((t) => t.kind === taskType)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="inline-fields">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setEditing({ ...newTask(), kind: taskType })}
            >
              <Plus size={14} />
              新增任务
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!task}
              onClick={() => setEditing(task ?? null)}
            >
              <Pencil size={14} />
              编辑参数
            </Button>
          </div>
          {task && (
            <p className="hint-box">
              {task.kind === 'web' ? task.url : task.executable_path}
              <br />
              延迟 {task.delay_ms / 1000} 秒 · {task.enabled ? '已启用' : '已停用'}
              <br />
              路径、独立参数、工作目录与简单模式共用同一任务配置。
            </p>
          )}
        </>
      )}
      {cfg.type === 'delay' && (
        <>
          <label>
            等待时长
            <DelayField
              milliseconds={cfg.milliseconds}
              onChange={(milliseconds) => setConfig({ ...cfg, milliseconds })}
            />
          </label>
          <div className="inline-fields">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfig({ ...cfg, milliseconds: 1000 })}
            >
              1 秒
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfig({ ...cfg, milliseconds: 3000 })}
            >
              3 秒
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setConfig({ ...cfg, milliseconds: 60000 })}
            >
              1 分钟
            </Button>
          </div>
          <p className="muted">最大 10 分钟；等待可取消。</p>
        </>
      )}
      {cfg.type === 'condition' && (
        <>
          <label>
            条件组合
            <select
              value={cfg.mode}
              onChange={(e) => setConfig({ ...cfg, mode: e.target.value as 'and' | 'or' })}
            >
              <option value="and">满足全部条件（AND）</option>
              <option value="or">满足任意条件（OR）</option>
            </select>
          </label>
          {cfg.conditions.map((c, i) => (
            <ConditionRow
              key={i}
              value={c}
              onChange={(v) =>
                setConfig({ ...cfg, conditions: cfg.conditions.map((x, j) => (j === i ? v : x)) })
              }
              onDelete={() =>
                setConfig({ ...cfg, conditions: cfg.conditions.filter((_, j) => j !== i) })
              }
            />
          ))}
          <Button
            variant="secondary"
            size="sm"
            disabled={cfg.conditions.length >= 16}
            onClick={() =>
              setConfig({ ...cfg, conditions: [...cfg.conditions, defaultCondition('weekdays')] })
            }
          >
            <Plus size={14} />
            添加条件
          </Button>
          <p className="hint-box">
            检查错误会停止流程，不会当作 False。工作日按勾选星期判断，不含法定节假日数据库。
          </p>
        </>
      )}
      {cfg.type === 'network' && (
        <>
          <label>
            等待目标
            <select
              value={cfg.mode}
              onChange={(e) => setConfig({ ...cfg, mode: e.target.value as 'local' | 'service' })}
            >
              <option value="local">本地网络接口可用</option>
              <option value="service">指定 HTTPS 服务返回成功</option>
            </select>
          </label>
          {cfg.mode === 'service' && (
            <label>
              服务地址
              <input
                value={cfg.url}
                placeholder="https://…"
                onChange={(e) => setConfig({ ...cfg, url: e.target.value })}
              />
            </label>
          )}
          <label>
            最长等待（秒）
            <input
              type="number"
              min={1}
              max={90}
              value={cfg.timeout_seconds}
              onChange={(e) => setConfig({ ...cfg, timeout_seconds: +e.target.value })}
            />
          </label>
        </>
      )}
      {cfg.type === 'layout' && (
        <>
          <label>
            窗口布局
            <select
              value={cfg.layout_id}
              onChange={(e) => setConfig({ ...cfg, layout_id: e.target.value })}
            >
              <option value="">请选择布局</option>
              {data.v2?.extension.layouts.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            窗口出现超时（秒）
            <input
              type="number"
              min={1}
              max={60}
              value={cfg.timeout_seconds}
              onChange={(e) => setConfig({ ...cfg, timeout_seconds: +e.target.value })}
            />
          </label>
          <p className="hint-box">
            先提交程序启动，再等待匹配窗口。无法移动的窗口会记录失败，不会绕过权限。
          </p>
        </>
      )}
      {cfg.type === 'scene' && (
        <label>
          其它简单场景
          <select
            value={cfg.scene_id}
            onChange={(e) => setConfig({ ...cfg, scene_id: e.target.value })}
          >
            <option value="">请选择</option>
            {data.config.scenes
              .filter(
                (s) =>
                  s.id !== editor.workflow?.scene_id &&
                  !data.v2?.extension.bindings.some((b) => b.scene_id === s.id),
              )
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {cfg.type === 'notification' && (
        <>
          <label>
            标题
            <input
              value={cfg.title}
              onChange={(e) => setConfig({ ...cfg, title: e.target.value })}
            />
          </label>
          <label>
            内容
            <textarea
              value={cfg.body}
              onChange={(e) => setConfig({ ...cfg, body: e.target.value })}
            />
          </label>
          <label>
            级别
            <select
              value={cfg.level}
              onChange={(e) => setConfig({ ...cfg, level: e.target.value as typeof cfg.level })}
            >
              {[
                ['info', '提示'],
                ['success', '成功'],
                ['warning', '注意'],
                ['error', '错误'],
              ].map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">此节点只提交配置的通知，不会改变其它节点的实际状态。</p>
        </>
      )}
      {!['start', 'end', 'condition'].includes(cfg.type) && (
        <label>
          执行失败时
          <select
            value={node.on_error}
            onChange={(e) => update({ on_error: e.target.value as 'stop' | 'continue' })}
          >
            <option value="stop">停止当前流程</option>
            <option value="continue">记录失败，继续后续节点</option>
          </select>
        </label>
      )}
      {editing && (
        <TaskEditor
          task={editing}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            if ('task_id' in cfg) setConfig({ ...cfg, task_id: t.id });
          }}
        />
      )}
    </aside>
  );
}
