import { LoginHistory, loginStatus } from '../accounts/LoginHistory';
import { useState, useEffect } from 'react';
import { Trash2, ChevronRight, CheckCircle2, AlertCircle, SkipForward } from 'lucide-react';
import { useApp, perform } from '../../stores/app';
import { api } from '../../services/api';
import { queryLogs, errorMessage } from '../../services/api';
import { PageHeader, Empty, StatusBadge } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Modal } from '../../components/ui/dialog';
import { useConfirm } from '../../components/confirm';
import { datetime, triggerLabel } from '../../utils/format';
import type { Run, Log, LogPage } from '../../types';
import { v2 } from '../../services/v2';
import type { NodeLog } from '../../types/v2';
export function RunDetails({
  run,
  onClose,
  records,
}: {
  run: Run;
  onClose: () => void;
  records?: Log[];
}) {
  const data = useApp((s) => s.data)!;
  const current = data.runs.find((r) => r.id === run.id) ?? run;
  const logs = (records ?? data.logs).filter((l) => l.run_id === run.id);
  const [archived, setArchived] = useState<NodeLog[]>([]);
  const [nodeError, setNodeError] = useState('');
  useEffect(() => {
    let live = true;
    void v2
      .nodeLogs(run.id)
      .then((rows) => {
        if (live) {
          setArchived(rows);
          setNodeError('');
        }
      })
      .catch((e) => {
        if (live) setNodeError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [run.id, current.status]);
  const live = data.v2?.node_logs.filter((n) => n.run_id === run.id) ?? [];
  const nodes = live.length ? live : archived;
  const duration = current.finished_at
    ? Math.max(0, (+new Date(current.finished_at) - +new Date(current.started_at)) / 1000)
    : null;
  return (
    <Modal
      title={current.scene_name_snapshot}
      description={`${triggerLabel[current.trigger_type]} · ${datetime(current.started_at)}`}
      open
      onClose={onClose}
      wide
    >
      <div className="form-body">
        {nodeError && <p className="hint-box danger-text">节点详情读取失败：{nodeError}</p>}
        <div className="run-summary">
          <StatusBadge status={current.status} />
          <span className="muted">
            {duration === null ? '执行中' : `耗时 ${duration.toFixed(1)} 秒`}
          </span>
          {current.status === 'running' && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void perform(() => v2.cancel(current.id), '取消请求已提交')}
            >
              取消执行
            </Button>
          )}
        </div>
        {nodes.length > 0 && (
          <>
            <p className="muted">
              已执行 {nodes.filter((n) => n.started_at).length} 个节点；未选中的分支显示为跳过。
            </p>
            {nodes.map((n) => (
              <div key={n.id} className="log-detail">
                <div className="grow">
                  <strong>{n.node_name}</strong>
                  <p>{n.error_message || nodeResult(n.result)}</p>
                  <small>
                    {datetime(n.started_at)}
                    {n.finished_at ? ` → ${datetime(n.finished_at)}` : ''}
                  </small>
                  {Array.isArray(n.result) && (
                    <div className="run-node-result">
                      {n.result.map((r, i) => (
                        <p key={i}>
                          {isObject(r)
                            ? `${String(r.message ?? '')} ${isObject(r.actual) ? `位置 (${r.actual.left}, ${r.actual.top}) → (${r.actual.right}, ${r.actual.bottom})` : ''}`
                            : ''}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
                <StatusBadge status={n.status} />
              </div>
            ))}
          </>
        )}
        {logs.map((l, i) => (
          <div key={l.id} className="log-detail">
            <span className="order">{String(i + 1).padStart(2, '0')}</span>
            <div className="grow">
              <strong>{l.task_name_snapshot}</strong>
              <p>{l.message}</p>
              <small>
                {datetime(l.started_at)}
                {l.finished_at ? ` → ${datetime(l.finished_at)}` : ''}
              </small>
            </div>
            <StatusBadge status={l.status} />
          </div>
        ))}
        <p className="hint-box">
          “请求已提交”表示 Windows 接受了启动请求。StartFlow
          不确认第三方应用已经完全就绪，也不检测浏览器中已经打开的标签页。
        </p>
      </div>
      <div className="modal-footer">
        <Button variant="secondary" onClick={onClose}>
          关闭详情
        </Button>
      </div>
    </Modal>
  );
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nodeResult(value: unknown): string {
  if (!isObject(value)) return '';
  if (typeof value.login_status === 'string')
    return `${loginStatus[value.login_status] ?? '登录未确认成功'} · ${value.authenticated ? '账号身份已验证' : '未确认登录'} · ${value.submitted ? '已提交一次请求' : '未提交密码'}`;
  if (typeof value.condition === 'boolean')
    return `条件结果：${value.condition ? 'True · 是' : 'False · 否'}`;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.waited_ms === 'number') return `等待完成：${value.waited_ms / 1000} 秒`;
  if (value.notification_requested) return 'Windows 通知请求已提交';
  if (value.available)
    return value.mode === 'service' ? '指定 HTTPS 服务可访问' : '本地网络接口可用';
  return '';
}
export function RunRows({ runs, onSelect }: { runs: Run[]; onSelect: (r: Run) => void }) {
  return (
    <div className="run-list">
      {runs.map((r) => (
        <button className="run-row" key={r.id} onClick={() => onSelect(r)}>
          <span className={`run-mark status-${r.status}`}>
            {r.status === 'failed' || r.status === 'partial' ? (
              <AlertCircle size={17} />
            ) : r.status === 'skipped' ? (
              <SkipForward size={17} />
            ) : (
              <CheckCircle2 size={17} />
            )}
          </span>
          <span className="grow">
            <strong>{r.scene_name_snapshot}</strong>
            <small>
              {triggerLabel[r.trigger_type]} · {datetime(r.started_at)}
            </small>
          </span>
          <StatusBadge status={r.status} />
          <ChevronRight size={16} />
        </button>
      ))}
    </div>
  );
}
export function Logs() {
  const data = useApp((s) => s.data)!;
  const [date, setDate] = useState('');
  const [scene, setScene] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<LogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<Run | null>(null);
  const confirm = useConfirm();
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void queryLogs(date, scene, status, offset)
      .then((r) => {
        if (!cancelled) {
          setResult(r);
          setError('');
        }
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date, scene, status, offset, data]);
  return (
    <>
      <LoginHistory compact />
      <PageHeader
        eyebrow="运行记录 / 执行历史"
        title="运行日志"
        description="每一次启动，都有清晰的结果和记录。"
        action={
          <Button
            variant="secondary"
            onClick={() =>
              void (async () => {
                if (
                  await confirm(
                    '清空全部运行日志？',
                    '历史执行详情将永久删除。自动执行去重记录会保留。',
                  )
                ) {
                  if (await perform(api.clearLogs, '运行日志已清空')) setOffset(0);
                }
              })()
            }
          >
            <Trash2 size={16} />
            清空日志
          </Button>
        }
      />
      <div className="stat-strip">
        {[
          ['请求已提交', result?.requested ?? 0, 'success'],
          ['执行失败', result?.failed ?? 0, 'danger'],
          ['已跳过', result?.skipped ?? 0, 'muted'],
        ].map(([label, count, color]) => (
          <div key={label}>
            <span className={String(color)}>{count}</span>
            <small>{label}</small>
          </div>
        ))}
      </div>
      <div className="toolbar log-filters">
        <label>
          日期
          <input
            aria-label="按日期筛选"
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label>
          场景
          <select
            aria-label="按场景筛选"
            value={scene}
            onChange={(e) => {
              setScene(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">全部场景</option>
            {result?.scene_choices.map(([id, name]) => (
              <option value={id} key={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          结果
          <select
            aria-label="按结果筛选"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">全部结果</option>
            <option value="launch_requested">请求已提交</option>
            <option value="failed">执行失败</option>
            <option value="partial">部分失败</option>
            <option value="skipped">已跳过</option>
            <option value="running">正在执行</option>
            <option value="completed">流程已完成</option>
            <option value="cancelled">已取消</option>
            <option value="interrupted">上次已中断</option>
            <option value="timed_out">执行超时</option>
          </select>
        </label>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDate('');
            setScene('');
            setStatus('');
            setOffset(0);
          }}
        >
          重置
        </Button>
      </div>
      {error ? (
        <div className="hint-box error-text">{error}</div>
      ) : result?.runs.length ? (
        <div className="list-panel" aria-busy={loading}>
          <RunRows runs={result.runs} onSelect={setDetail} />
        </div>
      ) : loading ? (
        <div className="small-empty">正在读取运行历史…</div>
      ) : (
        <Empty
          title="这里会记住每一次启动"
          description={
            date || scene || status
              ? '此筛选条件下没有记录。'
              : '运行一个任务或场景后，即可查看执行详情。'
          }
        />
      )}
      <div className="toolbar" style={{ marginTop: 20 }}>
        <p className="page-note">
          共 {result?.total ?? 0} 次执行 · 每页 50 条 · 统计覆盖全部匹配记录
          {loading ? ' · 正在刷新' : ''}
        </p>
        <div className="row-actions">
          <Button
            variant="secondary"
            size="sm"
            disabled={loading || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            上一页
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={loading || offset + 50 >= (result?.total ?? 0)}
            onClick={() => setOffset(offset + 50)}
          >
            下一页
          </Button>
        </div>
      </div>
      {detail && <RunDetails run={detail} records={result?.logs} onClose={() => setDetail(null)} />}
    </>
  );
}
