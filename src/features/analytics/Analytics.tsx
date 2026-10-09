import { useEffect, useState } from 'react';
import { call, errorMessage } from '../../services/api';
import { PageHeader } from '../../components/common';
import { statusLabel } from '../../utils/format';
import { toast } from 'sonner';
interface Metrics {
  daily: [string, number][];
  results: [string, number][];
  workflows: [string, number][];
  failed_rules: [string, number][];
  total_runs: number;
  automatic_runs: number;
  launch_requests: number;
  failed_tasks: number;
  skipped_tasks: number;
  average_seconds: number | null;
  conflicts: number;
}
function date(value: Date) {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function Bars({ items }: { items: [string, number][] }) {
  const maximum = Math.max(1, ...items.map(([, n]) => n));
  return (
    <div className="metric-bars">
      {items.length ? (
        items.map(([label, n]) => (
          <div className="metric-bar-row" key={label}>
            <span>{label}</span>
            <div>
              <i style={{ width: `${(n / maximum) * 100}%` }} />
            </div>
            <strong>{n}</strong>
          </div>
        ))
      ) : (
        <p className="hint">此范围没有记录。</p>
      )}
    </div>
  );
}
export function Analytics() {
  const [start, setStart] = useState(() => date(new Date(Date.now() - 6 * 86400000)));
  const [end, setEnd] = useState(() => date(new Date()));
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    void call<Metrics>('v3_analytics', { start, end })
      .then((v) => {
        if (alive) setData(v);
      })
      .catch((e) => {
        if (alive) {
          setError(errorMessage(e));
          toast.error(errorMessage(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [start, end]);
  return (
    <>
      <PageHeader
        eyebrow="SQLite / 本地汇总"
        title="执行统计"
        description="来自真实运行和决策记录，不读取屏幕、键盘或程序内操作。启动请求不表示第三方软件完全就绪。"
      />
      <div className="form-grid date-filters">
        <label>
          开始日期
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label>
          结束日期
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      {error ? (
        <div className="panel">{error}</div>
      ) : !data ? (
        <div className="panel">正在读取本地统计…</div>
      ) : (
        <>
          <div className="metric-grid">
            {[
              ['总执行次数', data.total_runs],
              ['自动执行次数', data.automatic_runs],
              ['启动请求已提交', data.launch_requests],
              ['失败任务', data.failed_tasks],
              ['跳过任务', data.skipped_tasks],
              [
                '平均执行时长',
                data.average_seconds === null ? '无数据' : `${data.average_seconds.toFixed(1)} 秒`,
              ],
              ['规则冲突次数', data.conflicts],
            ].map(([label, value]) => (
              <div className="panel" key={label}>
                <small>{label}</small>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <div className="analytics-grid">
            <section className="panel">
              <h2>每天自动执行</h2>
              <Bars items={data.daily} />
            </section>
            <section className="panel">
              <h2>执行结果分布</h2>
              <Bars items={data.results.map(([label, n]) => [statusLabel[label] ?? label, n])} />
            </section>
            <section className="panel">
              <h2>工作内容执行次数</h2>
              <Bars items={data.workflows} />
            </section>
            <section className="panel">
              <h2>高频失败规则</h2>
              <Bars items={data.failed_rules} />
            </section>
          </div>
        </>
      )}
    </>
  );
}
