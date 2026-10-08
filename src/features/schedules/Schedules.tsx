import { useState } from 'react';
import { Clock3, LogIn, CalendarDays, Pencil, Trash2, Power } from 'lucide-react';
import { useApp, perform } from '../../stores/app';
import { api } from '../../services/api';
import {
  PageHeader,
  SearchBox,
  Empty,
  AddButton,
  SceneIcon,
  StatusBadge,
} from '../../components/common';
import { Button } from '../../components/ui/button';
import { useConfirm } from '../../components/confirm';
import { newSchedule, datetime, weekdays } from '../../utils/format';
import type { Schedule } from '../../types';
import { ScheduleEditor } from './ScheduleEditor';
export function scheduleLabel(s: Schedule) {
  return s.trigger_type === 'login'
    ? `登录后 ${s.delay_seconds} 秒`
    : s.trigger_type === 'daily'
      ? `每天 ${s.time_of_day}`
      : `周${[...s.weekdays]
          .sort()
          .map((d) => weekdays[d - 1])
          .join('、')} · ${s.time_of_day}`;
}
export function Schedules() {
  const data = useApp((s) => s.data)!;
  const [edit, setEdit] = useState<Schedule | null>(null);
  const [query, setQuery] = useState('');
  const confirm = useConfirm();
  const rules = data.config.schedules.filter((r) =>
    (data.config.scenes.find((s) => s.id === r.scene_id)?.name ?? '').includes(query),
  );
  return (
    <>
      <PageHeader
        eyebrow="自动执行 / 时间安排"
        title="计划调度"
        description="到点开始工作，把准备的时间留给自己。"
        action={
          <AddButton
            label="创建计划"
            onClick={() => setEdit(newSchedule(data.config.scenes[0]?.id ?? ''))}
          />
        }
      />
      <div className={`notice ${data.config.settings.paused ? 'notice-warning' : ''}`}>
        <Clock3 size={18} />
        <span>
          {data.config.settings.paused
            ? '自动任务已暂停。恢复后会根据补执行窗口检查计划。'
            : '后台调度正在运行。窗口隐藏到托盘后，计划仍会继续执行。'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void perform(
              () =>
                api.saveSettings({ ...data.config.settings, paused: !data.config.settings.paused }),
              data.config.settings.paused ? '自动任务已恢复' : '自动任务已暂停',
            )
          }
        >
          {data.config.settings.paused ? '恢复任务' : '暂停任务'}
        </Button>
      </div>
      <div className="toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="搜索关联场景…" />
        <span className="muted">本地时间 · 每场景每日最多自动执行一次</span>
      </div>
      {rules.length ? (
        <div className="schedule-grid">
          {rules.map((r) => {
            const scene = data.config.scenes.find((s) => s.id === r.scene_id)!;
            const info = data.schedules.find((i) => i.id === r.id);
            const run = data.runs.find((run) => run.rule_id === r.id);
            const Icon =
              r.trigger_type === 'login'
                ? LogIn
                : r.trigger_type === 'daily'
                  ? Clock3
                  : CalendarDays;
            return (
              <article className={`schedule-card ${!r.enabled ? 'dim' : ''}`} key={r.id}>
                <div className="card-top">
                  <span className="schedule-type">
                    <Icon size={17} />
                    {r.trigger_type === 'login'
                      ? '登录启动'
                      : r.trigger_type === 'daily'
                        ? '每日计划'
                        : '每周计划'}
                  </span>
                  <span className={`enabled-dot ${r.enabled ? '' : 'off'}`}>
                    {r.enabled ? '已启用' : '已停用'}
                  </span>
                </div>
                <h3>{scheduleLabel(r)}</h3>
                <div className="schedule-scene">
                  <SceneIcon icon={scene.icon} color={scene.color} size={17} />
                  {scene.name}
                </div>
                <dl>
                  <div>
                    <dt>下次计划</dt>
                    <dd>
                      {r.trigger_type === 'login'
                        ? '下次 Windows 登录'
                        : info?.next_trigger_at
                          ? datetime(info.next_trigger_at)
                          : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>上次执行</dt>
                    <dd>{datetime(info?.last_triggered_at)}</dd>
                  </div>
                  <div>
                    <dt>补执行</dt>
                    <dd>
                      {r.trigger_type === 'login'
                        ? '仅登录触发'
                        : r.catch_up_minutes
                          ? `${r.catch_up_minutes} 分钟内`
                          : '已关闭'}
                    </dd>
                  </div>
                </dl>
                {run && <StatusBadge status={run.status} />}
                <div className="card-tools">
                  <Button variant="ghost" size="sm" onClick={() => setEdit(r)}>
                    <Pencil size={14} />
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void perform(
                        () => api.saveSchedule({ ...r, enabled: !r.enabled }),
                        '计划状态已保存',
                      )
                    }
                  >
                    <Power size={14} />
                    {r.enabled ? '停用' : '启用'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="danger-text"
                    onClick={() =>
                      void (async () => {
                        if (await confirm('删除此计划？', '此规则不再自动执行，场景和任务会保留。'))
                          await perform(() => api.remove('schedule', r.id), '计划已删除');
                      })()
                    }
                  >
                    <Trash2 size={14} />
                    删除
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty
          title="为工作安排一个开始时间"
          description="登录自动执行、每天固定时间，或只在选定的星期启动。"
          action={
            <AddButton
              label="创建计划"
              onClick={() => setEdit(newSchedule(data.config.scenes[0]?.id ?? ''))}
            />
          }
        />
      )}
      <p className="page-note">
        如果彻底退出 StartFlow，定时任务暂时停止。重启后，仅在你设置的时间窗口内补执行。
      </p>
      {edit && <ScheduleEditor schedule={edit} onClose={() => setEdit(null)} />}
    </>
  );
}
