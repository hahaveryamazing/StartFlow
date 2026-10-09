import type { Condition, Expression, AutomationConfig } from '../../types/v3';
import { condition } from '../../types/v3';
import { useApp } from '../../stores/app';
import { Button } from '../../components/ui/button';
const options = [
  ['network', '本地网络'],
  ['wifi', '信任 Wi-Fi'],
  ['monitors', '显示器数量'],
  ['power', '供电来源'],
  ['session', '会话状态'],
  ['weekdays', '指定星期'],
  ['time', '时间区间'],
  ['process', '指定应用'],
  ['service', 'HTTPS 服务'],
  ['group', '组合条件'],
] as const;
export function defaultExpression(type: Expression['type']): Expression {
  switch (type) {
    case 'group':
      return { type, operator: 'and', children: [condition({ type: 'network', connected: true })] };
    case 'network':
      return { type, connected: true };
    case 'wifi':
      return { type, network_id: '' };
    case 'monitors':
      return { type, minimum: 2, maximum: 16 };
    case 'power':
      return { type, source: 'ac' };
    case 'session':
      return { type, state: 'active' };
    case 'weekdays':
      return { type, days: [1, 2, 3, 4, 5] };
    case 'time':
      return { type, start: '09:00', end: '18:00' };
    case 'process':
      return { type, task_id: '', state: 'running' };
    case 'service':
      return { type, url: 'https://' };
  }
}
export function ConditionEditor({
  value,
  onChange,
  config,
  depth = 0,
  onRemove,
}: {
  value: Condition;
  onChange: (c: Condition) => void;
  config: AutomationConfig;
  depth?: number;
  onRemove?: () => void;
}) {
  const tasks = useApp((s) => s.data!.config.tasks);
  const e = value.expression;
  const replace = (expression: Expression) => onChange({ ...value, expression });
  return (
    <div className={`condition-card ${value.enabled ? '' : 'condition-disabled'}`}>
      <div className="condition-card-heading">
        <select
          aria-label="条件类型"
          value={e.type}
          onChange={(event) => replace(defaultExpression(event.target.value as Expression['type']))}
        >
          {options
            .filter(([key]) => key !== 'group' || depth < 3)
            .map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
        </select>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
          />
          启用
        </label>
        {onRemove && (
          <Button variant="ghost" size="sm" onClick={onRemove}>
            删除
          </Button>
        )}
      </div>
      {e.type === 'group' ? (
        <>
          <div className="inline-fields">
            <label>
              组合方式
              <select
                value={e.operator}
                onChange={(event) =>
                  replace({
                    ...e,
                    operator: event.target.value as typeof e.operator,
                    children: event.target.value === 'not' ? e.children.slice(0, 1) : e.children,
                  })
                }
              >
                <option value="and">全部满足 AND</option>
                <option value="or">任意满足 OR</option>
                <option value="not">取反 NOT</option>
              </select>
            </label>
          </div>
          {e.children.map((child, index) => (
            <div
              className="condition-child"
              key={child.id}
              draggable
              onDragStart={(event) => {
                event.stopPropagation();
                event.dataTransfer.setData(
                  'application/startflow-condition',
                  `${value.id}:${child.id}`,
                );
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const source = event.dataTransfer.getData('application/startflow-condition');
                const id = source.split(':');
                if (id[0] !== value.id || id[1] === child.id) return;
                const from = e.children.findIndex((c) => c.id === id[1]);
                if (from < 0) return;
                const children = [...e.children];
                const [moved] = children.splice(from, 1);
                children.splice(index, 0, moved);
                replace({ ...e, children });
              }}
            >
              <ConditionEditor
                value={child}
                config={config}
                depth={depth + 1}
                onChange={(next) =>
                  replace({ ...e, children: e.children.map((c) => (c.id === next.id ? next : c)) })
                }
                onRemove={
                  e.children.length > 1
                    ? () => replace({ ...e, children: e.children.filter((c) => c.id !== child.id) })
                    : undefined
                }
              />
              <div className="condition-order">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => {
                    const children = [...e.children];
                    [children[index - 1], children[index]] = [children[index], children[index - 1]];
                    replace({ ...e, children });
                  }}
                >
                  上移
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={index === e.children.length - 1}
                  onClick={() => {
                    const children = [...e.children];
                    [children[index + 1], children[index]] = [children[index], children[index + 1]];
                    replace({ ...e, children });
                  }}
                >
                  下移
                </Button>
              </div>
            </div>
          ))}
          {e.operator !== 'not' && e.children.length < 16 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                replace({
                  ...e,
                  children: [...e.children, condition({ type: 'network', connected: true })],
                })
              }
            >
              添加条件
            </Button>
          )}
          <small className="hint">
            排序仅整理显示；逻辑按明确的条件组计算。最多 3 层组合、64 个条件。
          </small>
        </>
      ) : null}
      {e.type === 'network' && (
        <select
          aria-label="网络状态条件"
          value={String(e.connected)}
          onChange={(event) => replace({ ...e, connected: event.target.value === 'true' })}
        >
          <option value="true">本地接口已连接</option>
          <option value="false">本地接口未连接</option>
        </select>
      )}
      {e.type === 'wifi' && (
        <label>
          信任网络
          <select
            value={e.network_id}
            onChange={(event) => replace({ ...e, network_id: event.target.value })}
          >
            <option value="">请选择；在隐私设置中添加</option>
            {config.networks.map((n) => (
              <option value={n.id} key={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {e.type === 'monitors' && (
        <div className="form-grid">
          <label>
            最少数量
            <input
              type="number"
              min={0}
              max={16}
              value={e.minimum}
              onChange={(event) => replace({ ...e, minimum: +event.target.value })}
            />
          </label>
          <label>
            最多数量
            <input
              type="number"
              min={0}
              max={16}
              value={e.maximum}
              onChange={(event) => replace({ ...e, maximum: +event.target.value })}
            />
          </label>
        </div>
      )}
      {e.type === 'power' && (
        <select
          aria-label="电源条件"
          value={e.source}
          onChange={(event) => replace({ ...e, source: event.target.value as 'ac' | 'battery' })}
        >
          <option value="ac">外接电源</option>
          <option value="battery">电池供电</option>
        </select>
      )}
      {e.type === 'session' && (
        <select
          aria-label="会话条件"
          value={e.state}
          onChange={(event) => replace({ ...e, state: event.target.value })}
        >
          <option value="active">当前活动会话</option>
          <option value="locked">系统已锁定</option>
          <option value="disconnected">会话已断开</option>
        </select>
      )}
      {e.type === 'weekdays' && (
        <div className="weekday-picker">
          {['一', '二', '三', '四', '五', '六', '日'].map((label, index) => (
            <label key={label}>
              <input
                type="checkbox"
                checked={e.days.includes(index + 1)}
                onChange={(event) =>
                  replace({
                    ...e,
                    days: event.target.checked
                      ? [...e.days, index + 1]
                      : e.days.filter((d) => d !== index + 1),
                  })
                }
              />
              周{label}
            </label>
          ))}
        </div>
      )}
      {e.type === 'time' && (
        <div className="form-grid">
          <label>
            开始时间
            <input
              type="time"
              value={e.start}
              onChange={(event) => replace({ ...e, start: event.target.value })}
            />
          </label>
          <label>
            结束时间
            <input
              type="time"
              value={e.end}
              onChange={(event) => replace({ ...e, end: event.target.value })}
            />
          </label>
        </div>
      )}
      {e.type === 'process' && (
        <div className="form-grid">
          <label>
            应用任务
            <select
              value={e.task_id}
              onChange={(event) => replace({ ...e, task_id: event.target.value })}
            >
              <option value="">请选择已配置的应用</option>
              {tasks
                .filter((t) => t.kind === 'app')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            应用状态
            <select
              value={e.state}
              onChange={(event) => replace({ ...e, state: event.target.value })}
            >
              <option value="running">正在运行</option>
              <option value="stopped">未运行</option>
              <option value="window">存在主窗口</option>
              <option value="no_window">不存在可识别主窗口</option>
            </select>
          </label>
        </div>
      )}
      {e.type === 'service' && (
        <label>
          HTTPS 服务地址
          <input
            value={e.url}
            onChange={(event) => replace({ ...e, url: event.target.value })}
            placeholder="https://你的服务地址"
          />
          <small>需开启服务探测；请求最长 3 秒、不跟随重定向。</small>
        </label>
      )}
    </div>
  );
}
