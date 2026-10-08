import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Modal } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { api } from '../../services/api';
import { perform, useApp } from '../../stores/app';
import { weekdays } from '../../utils/format';
import type { Schedule } from '../../types';
const schema = z
  .object({
    scene_id: z.string().min(1, '请选择场景'),
    trigger_type: z.enum(['login', 'daily', 'weekly']),
    time_of_day: z.string(),
    delay_seconds: z.number().int().min(0).max(120),
    catch_up_minutes: z.number(),
    enabled: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.trigger_type !== 'login' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time_of_day))
      ctx.addIssue({ code: 'custom', path: ['time_of_day'], message: '请填写有效的 HH:mm 时间' });
  });
export function ScheduleEditor({ schedule, onClose }: { schedule: Schedule; onClose: () => void }) {
  const data = useApp((s) => s.data)!;
  const [days, setDays] = useState(schedule.weekdays);
  const [busy, setBusy] = useState(false);
  const [dayError, setDayError] = useState('');
  const {
    register,
    watch,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: schedule });
  const trigger = watch('trigger_type');
  const submit = handleSubmit(async (fields) => {
    if (fields.trigger_type === 'weekly' && !days.length) {
      setDayError('请至少选择一天');
      return;
    }
    setBusy(true);
    if (
      await perform(
        () => api.saveSchedule({ ...schedule, ...fields, weekdays: days }),
        '计划已保存',
      )
    )
      onClose();
    setBusy(false);
  });
  return (
    <Modal
      title="设置自动启动计划"
      description="后台进程运行期间，计划会持续执行；彻底退出后暂停调度。"
      open
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        <div className="form-body">
          <label className="field">
            启动场景
            <select {...register('scene_id')}>
              <option value="">请选择…</option>
              {data.config.scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {!s.enabled ? '（已停用）' : ''}
                </option>
              ))}
            </select>
            {errors.scene_id && <small className="error-text">{errors.scene_id.message}</small>}
          </label>
          <label className="field">
            执行方式
            <select {...register('trigger_type')}>
              <option value="login">登录 Windows 后</option>
              <option value="daily">每天固定时间</option>
              <option value="weekly">指定星期</option>
            </select>
          </label>
          {trigger === 'login' ? (
            <>
              <label className="field">
                登录后延迟（秒）
                <input
                  type="number"
                  min="0"
                  max="120"
                  {...register('delay_seconds', { valueAsNumber: true })}
                />
                {errors.delay_seconds && <small className="error-text">延迟应为 0～120 秒</small>}
              </label>
              <p className="hint-box">
                此规则只在 Windows 自启启动的软件进程中执行。
                {data.autostart_enabled
                  ? 'Windows 登录自启已开启。'
                  : '请在系统设置中主动开启 Windows 登录自启。'}
              </p>
            </>
          ) : (
            <>
              <label className="field">
                执行时间
                <input type="time" {...register('time_of_day')} />
                {errors.time_of_day && (
                  <small className="error-text">{errors.time_of_day.message}</small>
                )}
              </label>
              {trigger === 'weekly' && (
                <div className="field">
                  执行日期
                  <div className="day-picker">
                    {weekdays.map((d, i) => (
                      <Button
                        key={d}
                        variant="secondary"
                        className={days.includes(i + 1) ? 'selected' : ''}
                        aria-pressed={days.includes(i + 1)}
                        onClick={() => {
                          setDays(
                            days.includes(i + 1)
                              ? days.filter((v) => v !== i + 1)
                              : [...days, i + 1],
                          );
                          setDayError('');
                        }}
                      >
                        周{d}
                      </Button>
                    ))}
                  </div>
                  {dayError && <small className="error-text">{dayError}</small>}
                </div>
              )}
              <label className="field">
                错过计划后补执行
                <select {...register('catch_up_minutes', { valueAsNumber: true })}>
                  <option value={0}>关闭（仅计划所在分钟有效）</option>
                  <option value={30}>30 分钟内</option>
                  <option value={120}>120 分钟内（推荐）</option>
                </select>
              </label>
            </>
          )}
          <label className="check">
            <input type="checkbox" {...register('enabled')} />
            启用此计划
          </label>
          <p className="hint">
            同一场景最多自动执行一次 /
            本地自然日；手动执行不受此限制。新建过去时间的计划可能在补执行窗口内立即触发。
          </p>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" loading={busy}>
            保存计划
          </Button>
        </div>
      </form>
    </Modal>
  );
}
