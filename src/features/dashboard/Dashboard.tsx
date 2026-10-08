import { useState } from 'react';
import {
  Layers,
  GitBranch,
  ArrowUpRight,
  ListChecks,
  Timer,
  Activity,
  Play,
  Pencil,
  Sparkles,
  Clock3,
  ChevronRight,
} from 'lucide-react';
import { useApp, perform } from '../../stores/app';
import { api } from '../../services/api';
import { v2 } from '../../services/v2';
import { RunRows } from '../logs/Logs';
import { SceneIcon, StatusBadge, SectionHeader, Empty } from '../../components/common';
import { Button } from '../../components/ui/button';
import { SceneEditor } from '../scenes/SceneEditor';
import { RunDetails } from '../logs/Logs';
import { scheduleLabel } from '../schedules/Schedules';
import { newScene, orderedTasks, statusLabel, time, weekdays, datetime } from '../../utils/format';
import type { Scene, Run } from '../../types';
export function Dashboard() {
  const data = useApp((s) => s.data)!;
  const setPage = useApp((s) => s.setPage);
  const c = data.config;
  const [edit, setEdit] = useState<Scene | null>(null);
  const [detail, setDetail] = useState<Run | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好';
  const today = c.schedules
    .filter(
      (s) =>
        s.trigger_type === 'daily' ||
        s.trigger_type === 'login' ||
        s.weekdays.includes(now.getDay() === 0 ? 7 : now.getDay()),
    )
    .sort((a, b) => a.time_of_day.localeCompare(b.time_of_day));
  const start = async (s: Scene) => {
    setBusy(s.id);
    await perform(() => api.runScene(s.id), '场景任务已提交，正在依次执行');
    setBusy(null);
  };
  const latest = data.runs[0];
  const recentTasks = [...data.logs]
    .filter((l) => l.started_at)
    .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''))
    .slice(0, 4);
  return (
    <>
      <div className="dashboard-heading">
        <div>
          <div className="eyebrow">YOUR WORKSPACE, READY IN SECONDS.</div>
          <h1>
            {greeting}
            <span className="greeting-dot">.</span>
            <br />
            <span className="muted-title">让工作，从容开始。</span>
          </h1>
          <p>常用内容已准备好，用一个场景开启你的工作流。</p>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <span className="art-center">
            <Sparkles size={38} />
          </span>
          <span className="art-node node-one">
            <Layers size={20} />
          </span>
          <span className="art-node node-two">
            <Play size={16} />
          </span>
          <span className="art-node node-three">
            <Clock3 size={17} />
          </span>
        </div>
      </div>
      <div className="quick-operations">
        <Button variant="secondary" onClick={() => void perform(v2.palette)}>
          快速命令面板
        </Button>
        <Button variant="secondary" onClick={() => setPage('workflows')}>
          编排工作流
        </Button>
        <Button variant="secondary" onClick={() => setPage('layouts')}>
          管理窗口布局
        </Button>
      </div>
      <div className="v2-dashboard-strip">
        <section className="panel">
          <h3>
            <Activity size={17} />
            后台执行
          </h3>
          {data.runs.filter((r) => r.status === 'running').length ? (
            data.runs
              .filter((r) => r.status === 'running')
              .map((r) => {
                const logs = data.v2?.node_logs.filter((n) => n.run_id === r.id) ?? [];
                return (
                  <div className="run-live-header" key={r.id}>
                    <div className="grow">
                      <strong>{r.scene_name_snapshot}</strong>
                      <p className="hint">
                        {logs.find((n) => n.status === 'running')?.node_name ?? '任务正在执行'} ·
                        已执行 {logs.filter((n) => n.started_at).length} 个节点
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => void perform(() => v2.cancel(r.id), '取消请求已提交')}
                    >
                      取消
                    </Button>
                  </div>
                );
              })
          ) : (
            <p className="muted">当前没有正在执行的任务。</p>
          )}
          <p className="hint">
            {c.settings.paused ? '自动调度已暂停' : '后台调度运行中'} · 下次计划：
            {data.schedules
              .filter((s) => s.next_trigger_at)
              .sort((a, b) => (a.next_trigger_at ?? '').localeCompare(b.next_trigger_at ?? ''))[0]
              ?.next_trigger_at
              ? datetime(
                  data.schedules
                    .filter((s) => s.next_trigger_at)
                    .sort((a, b) =>
                      (a.next_trigger_at ?? '').localeCompare(b.next_trigger_at ?? ''),
                    )[0].next_trigger_at,
                )
              : '暂无'}
          </p>
          {data.v2?.extension.shortcuts
            .filter((s) => s.enabled)
            .slice(0, 3)
            .map((s) => (
              <p className="hint" key={s.id}>
                <kbd>{s.accelerator}</kbd> ·{' '}
                {s.action === 'scene'
                  ? c.scenes.find((x) => x.id === s.target_id)?.name
                  : s.action === 'palette'
                    ? '命令面板'
                    : s.action === 'open'
                      ? '打开主窗口'
                      : s.action === 'pause'
                        ? '暂停自动调度'
                        : '恢复自动调度'}
              </p>
            ))}
        </section>
        <section className="panel">
          <h3>
            <GitBranch size={17} />
            最近工作流
          </h3>
          <RunRows
            runs={data.runs
              .filter((r) => data.v2?.workflow_runs.some((w) => w.run_id === r.id))
              .slice(0, 3)}
            onSelect={setDetail}
          />
          {!data.v2?.workflow_runs.length && (
            <p className="muted">创建并运行工作流后，这里会显示真实记录。</p>
          )}
          <h3 style={{ marginTop: 18 }}>最近失败</h3>
          {[...(data.v2?.node_logs ?? []), ...data.logs]
            .filter((l) => l.status === 'failed')
            .slice(-2)
            .reverse()
            .map((l) => (
              <button
                className="run-row"
                key={l.id}
                onClick={() => {
                  const r = data.runs.find((r) => r.id === l.run_id);
                  if (r) setDetail(r);
                }}
              >
                <span className="grow">
                  {'node_name' in l ? l.node_name : l.task_name_snapshot}
                  <small>{'error_message' in l ? l.error_message : l.message}</small>
                </span>
                <StatusBadge status={l.status} />
              </button>
            ))}
          {![...(data.v2?.node_logs ?? []), ...data.logs].some((l) => l.status === 'failed') && (
            <p className="muted">近期没有失败记录。</p>
          )}
        </section>
      </div>
      <div className="stats-grid">
        {[
          { label: '启动场景', value: c.scenes.length, note: '按照你的工作方式组织', Icon: Layers },
          {
            label: '启动任务',
            value: c.tasks.length,
            note: '网页、应用和文件夹',
            Icon: ListChecks,
          },
          {
            label: '今日自动执行',
            value: data.today_auto_count,
            note: '本地自然日 · 持久化去重',
            Icon: Timer,
          },
          {
            label: '最近执行结果',
            value: latest ? statusLabel[latest.status] : '尚未执行',
            note: latest
              ? `${latest.scene_name_snapshot} · ${time(latest.started_at)}`
              : '开始你的第一次启动',
            Icon: Activity,
          },
        ].map(({ label, value, note, Icon }) => (
          <div className="stat-card" key={label}>
            <div>
              <span>{label}</span>
              <Icon size={17} />
            </div>
            <strong className={typeof value === 'string' ? 'stat-text' : ''}>{value}</strong>
            <small>{note}</small>
          </div>
        ))}
      </div>
      <SectionHeader
        title="常用场景"
        meta={`${c.scenes.length} 个工作空间`}
        action={() => setPage('scenes')}
      />
      {c.scenes.length ? (
        <div className="dashboard-scenes">
          {c.scenes.slice(0, 3).map((s) => {
            const running = data.active_scenes.includes(s.id);
            const tasks = orderedTasks(c, s.id);
            return (
              <article className="quick-scene" key={s.id}>
                <div className="card-top">
                  <SceneIcon icon={s.icon} color={s.color} />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`编辑 ${s.name}`}
                    onClick={() => setEdit(s)}
                  >
                    <Pencil size={16} />
                  </Button>
                </div>
                <h3>{s.name}</h3>
                <p>{s.description || '你的专属工作空间'}</p>
                <div className="quick-bottom">
                  <span>
                    {tasks.length} 项任务{!s.enabled ? ' · 已停用' : ''}
                  </span>
                  <Button
                    size="sm"
                    loading={busy === s.id || running}
                    disabled={
                      !s.enabled ||
                      (!tasks.length &&
                        !data.v2?.extension.bindings.some((b) => b.scene_id === s.id))
                    }
                    onClick={() => void start(s)}
                  >
                    <Play size={13} />
                    {running ? '执行中' : '启动'}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="panel">
          <Empty
            title="创建一个属于你的启动场景"
            description="把邮箱、常用软件和工作文件夹放在一起，开启高效的一天。"
            action={
              <Button onClick={() => setEdit(newScene())}>
                创建第一个场景
                <ArrowUpRight size={15} />
              </Button>
            }
          />
        </div>
      )}
      <div className="dashboard-bottom">
        <section>
          <SectionHeader title="最近运行" action={() => setPage('logs')} />
          <div className="panel">
            {recentTasks.length ? (
              <div className="run-list">
                {recentTasks.map((log) => (
                  <button
                    className="run-row"
                    key={log.id}
                    onClick={() => {
                      const run = data.runs.find((r) => r.id === log.run_id);
                      if (run) setDetail(run);
                    }}
                  >
                    <span className={`run-mark status-${log.status}`}>
                      <Activity size={17} />
                    </span>
                    <span className="grow">
                      <strong>{log.task_name_snapshot}</strong>
                      <small>{datetime(log.started_at)}</small>
                    </span>
                    <StatusBadge status={log.status} />
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="small-empty">
                <Activity size={25} />
                <p>启动之后，记录会出现在这里。</p>
              </div>
            )}
          </div>
        </section>
        <section>
          <SectionHeader
            title="今日计划"
            meta={`周${weekdays[(now.getDay() + 6) % 7]}`}
            action={() => setPage('schedules')}
          />
          <div className="panel today-panel">
            {today.length ? (
              today.slice(0, 5).map((r) => {
                const scene = c.scenes.find((s) => s.id === r.scene_id)!;
                const last = data.runs.find((run) => run.rule_id === r.id);
                return (
                  <div className="today-row" key={r.id}>
                    <span className="today-time">
                      {r.trigger_type === 'login' ? '登录' : r.time_of_day}
                    </span>
                    <div className="grow">
                      <strong>{scene.name}</strong>
                      <small>
                        {scheduleLabel(r)}
                        {!r.enabled ? ' · 已停用' : !scene.enabled ? ' · 场景停用' : ''}
                      </small>
                    </div>
                    {last ? (
                      <StatusBadge status={last.status} />
                    ) : (
                      <span className="muted">
                        {r.enabled && scene.enabled ? '等待计划' : '已停用'}
                      </span>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="small-empty">
                <Clock3 size={25} />
                <p>今天没有自动启动计划。</p>
                <Button variant="ghost" size="sm" onClick={() => setPage('schedules')}>
                  添加一个计划
                  <ArrowUpRight size={14} />
                </Button>
              </div>
            )}
          </div>
        </section>
      </div>
      {edit && <SceneEditor scene={edit} onClose={() => setEdit(null)} />}{' '}
      {detail && <RunDetails run={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
