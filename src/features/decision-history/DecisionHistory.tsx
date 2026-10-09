import { useState } from 'react';
import { useApp, perform } from '../../stores/app';
import { v3 } from '../../services/v3';
import { PageHeader, Empty } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Modal } from '../../components/ui/dialog';
import { useConfirm } from '../../components/confirm';
import { decisionLabels, matchLabels, type Decision, type Trace } from '../../types/v3';
import { toast } from 'sonner';
import { errorMessage } from '../../services/api';
export function TraceView({ trace }: { trace: Trace }) {
  return (
    <div className={`decision-trace trace-${trace.result}`}>
      <span>{trace.explanation}</span>
      {trace.children.map((c) => (
        <TraceView key={c.condition_id} trace={c} />
      ))}
    </div>
  );
}
export function DecisionRows({ decisions }: { decisions: Decision[] }) {
  const [selected, setSelected] = useState<Decision | null>(null);
  const [replay, setReplay] = useState<Decision[] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="decision-list">
        {decisions.map((d) => (
          <button
            className="decision-row"
            key={d.id}
            onClick={() => {
              setSelected(d);
              setReplay(null);
            }}
          >
            <span className={`decision-dot result-${d.match_result}`} />
            <div>
              <strong>{d.rule_name}</strong>
              <small>
                {d.reasons.join(' ')} · {new Date(d.evaluated_at).toLocaleString('zh-CN')}
              </small>
            </div>
            <span className="soft-badge">{decisionLabels[d.decision] ?? d.decision}</span>
          </button>
        ))}
      </div>
      {selected && (
        <Modal
          open
          title="本地决策路径"
          onClose={() => setSelected(null)}
          description={`规则版本 ${selected.rule_version} · ${matchLabels[selected.match_result]} · ${selected.id}`}
        >
          <TraceView trace={selected.trace} />
          {selected.reasons.map((r, i) => (
            <p className="hint" key={i}>
              {r}
            </p>
          ))}
          {selected.next_eligible_at && (
            <p>冷却结束：{new Date(selected.next_eligible_at).toLocaleString('zh-CN')}</p>
          )}
          {selected.execution_run_ids.map((id) => (
            <p className="hint" key={id}>
              执行记录：{id}
            </p>
          ))}
          <div className="data-buttons">
            {selected.decision === 'waiting_confirmation' && (
              <>
                <Button
                  loading={busy}
                  onClick={() =>
                    void (async () => {
                      setBusy(true);
                      if (
                        await perform(
                          () => v3.confirm(selected.id, true),
                          '已重新检测环境，请查看最新决策',
                        )
                      )
                        setSelected(null);
                      setBusy(false);
                    })()
                  }
                >
                  确认启动
                </Button>
                <Button
                  disabled={busy}
                  variant="secondary"
                  onClick={() =>
                    void perform(() => v3.confirm(selected.id, false), '本次建议已拒绝').then(
                      (ok) => {
                        if (ok) setSelected(null);
                      },
                    )
                  }
                >
                  拒绝本次建议
                </Button>
              </>
            )}
            <Button
              disabled={busy}
              variant="secondary"
              onClick={() =>
                void (async () => {
                  try {
                    setBusy(true);
                    setReplay(await v3.replay(selected.id));
                  } catch (e) {
                    toast.error(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              历史回放（无系统操作）
            </Button>
          </div>
          {replay && (
            <div className="simulation-results">
              {replay.map((d) => (
                <div className="panel" key={d.id}>
                  <strong>{decisionLabels[d.decision]}</strong>
                  <TraceView trace={d.trace} />
                  {d.reasons.map((r, i) => (
                    <p className="hint" key={i}>
                      {r}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
export function DecisionHistory() {
  const a = useApp((s) => s.data?.v3);
  const [query, setQuery] = useState('');
  const confirm = useConfirm();
  return (
    <>
      <PageHeader
        eyebrow="决策 / 原因 / 回放"
        title="决策历史"
        description="由本地规则引擎记录执行与跳过原因；环境摘要默认保留 30 天。"
        action={
          <Button
            variant="secondary"
            onClick={() =>
              void (async () => {
                if (
                  await confirm(
                    '清空环境决策历史？',
                    '只删除环境摘要和决策，不删除规则、场景或工作流；冷却与执行去重保留。',
                  )
                )
                  await perform(v3.clearHistory, '环境决策历史已清空');
              })()
            }
          >
            清空环境历史
          </Button>
        }
      />
      <input
        aria-label="搜索决策"
        className="decision-search"
        placeholder="搜索规则名称或原因…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {a?.decisions.length ? (
        <DecisionRows
          decisions={a.decisions.filter((d) => (d.rule_name + d.reasons.join('')).includes(query))}
        />
      ) : (
        <Empty
          title="还没有环境决策"
          description="启用智能规则后，真实判断路径会记录在这里。模拟结果不会写入实际历史。"
        />
      )}
    </>
  );
}
