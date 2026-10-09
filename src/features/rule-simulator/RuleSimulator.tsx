import { useState } from 'react';
import { useApp } from '../../stores/app';
import { v3 } from '../../services/v3';
import { PageHeader } from '../../components/common';
import { Button } from '../../components/ui/button';
import { TraceView } from '../decision-history/DecisionHistory';
import {
  decisionLabels,
  matchLabels,
  eventLabels,
  type Field,
  type Context,
  type Decision,
  type EventKind,
} from '../../types/v3';
import { toast } from 'sonner';
import { errorMessage } from '../../services/api';
const available = <T,>(value: T): Field<T> => ({ status: 'available', value, reason: '' });
const unknown = <T,>(): Field<T> => ({
  status: 'unavailable',
  value: null,
  reason: '用户设置的模拟未知状态',
});
export function RuleSimulator() {
  const a = useApp((s) => s.data?.v3)!;
  const tasks = useApp((s) => s.data!.config.tasks);
  const [snapshot, setSnapshot] = useState<Context>(() => structuredClone(a.context));
  const [kind, setKind] = useState<EventKind>('refresh');
  const [guards, setGuards] = useState(false);
  const [stable, setStable] = useState(10);
  const [time, setTime] = useState(() => {
    const date = new Date();
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [scheduleId, setScheduleId] = useState('');
  const [result, setResult] = useState<Decision[] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHeader
        eyebrow="同一引擎 / 无副作用"
        title="规则模拟器"
        description="模拟只运行 Rust 规则解析、条件计算和冲突解决，不打开网页、不启动应用、不移动窗口、不写真实决策历史。"
      />
      <section className="panel simulator-form">
        <div className="form-grid">
          <label>
            模拟日期和本地时间
            <input type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
          <label>
            模拟触发事件
            <select value={kind} onChange={(e) => setKind(e.target.value as EventKind)}>
              {Object.entries(eventLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {kind === 'schedule' && (
            <label>
              定时规则
              <select value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>
                <option value="">请选择规则</option>
                {a.config.rules
                  .filter((r) => r.schedule)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            本地网络
            <select
              value={
                snapshot.network_connected.value === null
                  ? 'unknown'
                  : String(snapshot.network_connected.value)
              }
              onChange={(e) =>
                setSnapshot({
                  ...snapshot,
                  network_connected:
                    e.target.value === 'unknown' ? unknown() : available(e.target.value === 'true'),
                })
              }
            >
              <option value="true">已连接</option>
              <option value="false">未连接</option>
              <option value="unknown">未知 / 未授权</option>
            </select>
          </label>
          <label>
            信任 Wi-Fi
            <select
              value={snapshot.wifi_network_id.value ?? 'unknown'}
              onChange={(e) =>
                setSnapshot({
                  ...snapshot,
                  wifi_network_id:
                    e.target.value === 'unknown' ? unknown() : available(e.target.value),
                })
              }
            >
              <option value="unknown">未知 / 权限不足</option>
              <option value="">未匹配任何信任网络</option>
              {a.config.networks.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            显示器数量
            <input
              type="number"
              min={0}
              max={16}
              value={snapshot.displays.value?.length ?? 0}
              onChange={(e) =>
                setSnapshot({
                  ...snapshot,
                  displays: available(
                    Array.from({ length: Math.max(0, Math.min(16, +e.target.value)) }, (_, i) => ({
                      id: `simulation-${i}`,
                      x: i * 1920,
                      y: 0,
                      width: 1920,
                      height: 1080,
                      primary: i === 0,
                      scale: 1,
                    })),
                  ),
                })
              }
            />
          </label>
          <label>
            电源来源
            <select
              value={snapshot.power_source.value ?? 'unknown'}
              onChange={(e) =>
                setSnapshot({
                  ...snapshot,
                  power_source:
                    e.target.value === 'unknown' ? unknown() : available(e.target.value),
                })
              }
            >
              <option value="ac">外接电源</option>
              <option value="battery">电池供电</option>
              <option value="unknown">未知</option>
            </select>
          </label>
          <label>
            会话状态
            <select
              value={snapshot.session.value ?? 'unknown'}
              onChange={(e) =>
                setSnapshot({
                  ...snapshot,
                  session: e.target.value === 'unknown' ? unknown() : available(e.target.value),
                })
              }
            >
              <option value="active">活动</option>
              <option value="locked">锁定</option>
              <option value="disconnected">断开</option>
              <option value="unknown">未知</option>
            </select>
          </label>
          <label>
            稳定时间（秒）
            <input
              type="number"
              min={0}
              max={300}
              value={stable}
              onChange={(e) => setStable(+e.target.value)}
            />
          </label>
        </div>
        <h3>已配置应用的模拟状态</h3>
        {tasks
          .filter((t) => t.kind === 'app')
          .map((t) => (
            <label className="setting-select" key={t.id}>
              <span>{t.name}</span>
              <select
                value={
                  snapshot.processes[t.id]?.running.value === null
                    ? 'unknown'
                    : String(snapshot.processes[t.id]?.running.value ?? false)
                }
                onChange={(e) =>
                  setSnapshot({
                    ...snapshot,
                    processes: {
                      ...snapshot.processes,
                      [t.id]: {
                        running:
                          e.target.value === 'unknown'
                            ? unknown()
                            : available(e.target.value === 'true'),
                        window:
                          e.target.value === 'unknown'
                            ? unknown()
                            : available(e.target.value === 'true'),
                      },
                    },
                  })
                }
              >
                <option value="false">未运行 / 无窗口</option>
                <option value="true">正在运行 / 有窗口</option>
                <option value="unknown">未知 / 无法查询</option>
              </select>
            </label>
          ))}
        {Object.keys(snapshot.services).map((url) => (
          <label key={url}>
            模拟服务：{url}
            <select
              value={
                snapshot.services[url]?.status === 'error'
                  ? 'error'
                  : snapshot.services[url]?.value === null
                    ? 'unknown'
                    : String(snapshot.services[url]?.value)
              }
              onChange={(e) =>
                setSnapshot({
                  ...snapshot,
                  services: {
                    ...snapshot.services,
                    [url]:
                      e.target.value === 'unknown'
                        ? unknown()
                        : e.target.value === 'error'
                          ? { status: 'error', value: null, reason: '用户设置的模拟探测错误' }
                          : available(e.target.value === 'true'),
                  },
                })
              }
            >
              <option value="true">服务可访问</option>
              <option value="false">服务不可访问</option>
              <option value="unknown">状态未知</option>
              <option value="error">检测错误</option>
            </select>
          </label>
        ))}
        <label className="inline-check">
          <input type="checkbox" checked={guards} onChange={(e) => setGuards(e.target.checked)} />
          纳入当前暂停、覆盖、冷却和场景运行状态
        </label>
        <p className="hint">
          模拟仍使用当前已保存、已启用的规则与智能总开关。显示器坐标和应用状态明确由本表单模拟，不是实际检测结果。
        </p>
        <div className="data-buttons">
          <Button
            loading={busy}
            onClick={() =>
              void (async () => {
                try {
                  setBusy(true);
                  const date = new Date(time);
                  const offset = -date.getTimezoneOffset();
                  const stamp = `${time}:00${offset >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
                  setResult(
                    await v3.simulate(
                      { ...snapshot, id: crypto.randomUUID(), captured_at: stamp },
                      kind,
                      guards,
                      stable,
                      scheduleId || null,
                    ),
                  );
                } catch (e) {
                  toast.error(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            模拟执行（无系统操作）
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setSnapshot(structuredClone(a.context));
              setResult(null);
            }}
          >
            填入当前真实环境
          </Button>
        </div>
      </section>
      {result && (
        <div className="simulation-results">
          {!result.length && <div className="panel">没有已启用且匹配触发类型的规则。</div>}
          {result.map((d) => (
            <article className="panel" key={d.id}>
              <div className="card-top">
                <h3>{d.rule_name}</h3>
                <span className="soft-badge">
                  {matchLabels[d.match_result]} · {decisionLabels[d.decision]}
                </span>
              </div>
              <TraceView trace={d.trace} />
              {d.reasons.map((r, i) => (
                <p key={i}>{r}</p>
              ))}
              <small className="hint">
                预期目标：
                {d.targets
                  .map(
                    (t) =>
                      useApp.getState().data!.config.scenes.find((s) => s.id === t.scene_id)
                        ?.name ?? '历史场景',
                  )
                  .join('、')}{' '}
                · 实际启动请求：0
              </small>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
