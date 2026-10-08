import { useState } from 'react';
import { Sparkles, ArrowRight, Check, Globe, Clock3, LogIn, MousePointer2 } from 'lucide-react';
import { Modal } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { SceneIcon, iconMap, iconNames } from '../../components/common';
import { api } from '../../services/api';
import { useApp, perform } from '../../stores/app';
import { newScene, newTask, newSchedule, orderedTasks } from '../../utils/format';
import { TaskEditor } from '../tasks/TaskEditor';
import type { Task } from '../../types';
export function Onboarding() {
  const data = useApp((s) => s.data)!;
  const [step, setStep] = useState(0);
  const [scene, setScene] = useState(newScene);
  const [task, setTask] = useState<Task | null>(null);
  const [mode, setMode] = useState('manual');
  const [time, setTime] = useState('09:00');
  const [busy, setBusy] = useState(false);
  const [scheduleId] = useState(() => crypto.randomUUID());
  const skip = () =>
    perform(
      () => api.saveSettings({ ...useApp.getState().data!.config.settings, onboarding_done: true }),
      '可以随时在场景管理中继续设置',
    );
  const finish = async () => {
    setBusy(true);
    if (mode !== 'manual') {
      const r = {
        ...newSchedule(scene.id),
        id: scheduleId,
        trigger_type: mode as 'login' | 'daily',
        time_of_day: time,
      };
      if (!(await perform(() => api.saveSchedule(r)))) {
        setBusy(false);
        return;
      }
      if (
        mode === 'login' &&
        !(await perform(() => api.autostart(true), 'Windows 登录自启已启用'))
      ) {
        setBusy(false);
        return;
      }
    }
    setStep(4);
    setBusy(false);
  };
  const count = data.config.scene_tasks.filter((a) => a.scene_id === scene.id).length;
  return (
    <>
      <Modal
        title={
          [
            '欢迎使用 StartFlow',
            '创建第一个场景',
            '添加你的启动内容',
            '选择启动方式',
            '一切准备就绪',
          ][step]
        }
        description={`开始使用 · 第 ${step + 1} 步，共 5 步`}
        open
        onClose={() => {
          if (!busy) void skip();
        }}
        wide
      >
        <div className="form-body onboarding">
          <div className="step-dots">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className={i <= step ? 'active' : ''} />
            ))}
          </div>
          {step === 0 ? (
            <div className="welcome-guide">
              <span className="welcome-mark">
                <Sparkles size={35} />
              </span>
              <h2>把准备工作交给 StartFlow。</h2>
              <p>
                把常用网页、软件和文件夹组成一个场景。
                <br />
                一键启动，或让它在合适的时间自动打开。
              </p>
              <div className="guide-values">
                <span>
                  <Globe size={16} />
                  网页与应用
                </span>
                <span>
                  <Clock3 size={16} />
                  后台计划
                </span>
                <span>
                  <Check size={16} />
                  本地保存
                </span>
              </div>
            </div>
          ) : step === 1 ? (
            <>
              <div className="scene-preview">
                <SceneIcon icon={scene.icon} color={scene.color} />
                <strong>{scene.name || '你的工作场景'}</strong>
              </div>
              <label className="field">
                场景名称
                <input
                  autoFocus
                  maxLength={40}
                  placeholder="例如：日常办公"
                  value={scene.name}
                  onChange={(e) => setScene({ ...scene, name: e.target.value })}
                />
              </label>
              <div className="form-grid">
                <div className="field">
                  选择图标
                  <div className="icon-picker">
                    {Object.entries(iconMap).map(([key, Icon]) => (
                      <Button
                        key={key}
                        variant="secondary"
                        size="icon"
                        aria-label={`图标：${iconNames[key]}`}
                        className={scene.icon === key ? 'selected' : ''}
                        onClick={() => setScene({ ...scene, icon: key })}
                      >
                        <Icon size={18} />
                      </Button>
                    ))}
                  </div>
                </div>
                <label className="field">
                  场景颜色
                  <input
                    type="color"
                    value={scene.color}
                    onChange={(e) => setScene({ ...scene, color: e.target.value })}
                  />
                </label>
              </div>
            </>
          ) : step === 2 ? (
            <div className="welcome-guide">
              <Globe size={36} />
              <h2>{count ? `已添加 ${count} 项任务` : '添加第一项启动任务'}</h2>
              <p>
                例如工作邮箱、常用软件，或者你的工作文件夹。
                <br />
                保存后会自动加入刚创建的场景。
              </p>
              <Button variant="secondary" onClick={() => setTask(newTask())}>
                添加任务
              </Button>
            </div>
          ) : step === 3 ? (
            <>
              <div className="guide-modes">
                {[
                  {
                    key: 'manual',
                    label: '只在手动点击时启动',
                    note: '随时在工作台一键启动',
                    Icon: MousePointer2,
                  },
                  {
                    key: 'daily',
                    label: '每天指定时间启动',
                    note: '软件在后台运行时按时执行',
                    Icon: Clock3,
                  },
                  {
                    key: 'login',
                    label: 'Windows 登录后启动',
                    note: '选择并继续，将启用 Windows 登录自启',
                    Icon: LogIn,
                  },
                ].map(({ key, label, note, Icon }) => (
                  <button
                    key={key}
                    type="button"
                    className={mode === key ? 'selected' : ''}
                    aria-pressed={mode === key}
                    onClick={() => setMode(key)}
                  >
                    <Icon size={23} />
                    <span>
                      <strong>{label}</strong>
                      <small>{note}</small>
                    </span>
                    {mode === key && <Check size={17} />}
                  </button>
                ))}
              </div>
              {mode === 'daily' && (
                <label className="field">
                  每天执行时间
                  <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                </label>
              )}
              <p className="hint">首次安装默认关闭系统自启。你可以之后在设置中更改。</p>
            </>
          ) : (
            <div className="welcome-guide">
              <span className="welcome-mark">
                <Check size={35} />
              </span>
              <h2>你的工作空间，已经准备好。</h2>
              <p>
                {scene.name} · {count} 项任务
                <br />
                之后可以继续添加内容、调整顺序或设置计划。
              </p>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <Button variant="ghost" disabled={busy} onClick={() => void skip()}>
            跳过引导
          </Button>
          {step === 0 ? (
            <Button onClick={() => setStep(1)}>
              开始设置
              <ArrowRight size={16} />
            </Button>
          ) : step === 1 ? (
            <Button
              loading={busy}
              disabled={!scene.name.trim()}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  if (await perform(() => api.saveScene(scene, []), '第一个场景已创建')) setStep(2);
                  setBusy(false);
                })()
              }
            >
              创建并继续
              <ArrowRight size={16} />
            </Button>
          ) : step === 2 ? (
            <Button onClick={() => setStep(3)}>
              {count ? '继续' : '稍后添加'}
              <ArrowRight size={16} />
            </Button>
          ) : step === 3 ? (
            <Button
              loading={busy}
              disabled={mode === 'daily' && !time}
              onClick={() => void finish()}
            >
              完成设置
              <ArrowRight size={16} />
            </Button>
          ) : (
            <Button
              onClick={() =>
                void perform(
                  () =>
                    api.saveSettings({
                      ...useApp.getState().data!.config.settings,
                      onboarding_done: true,
                    }),
                  '欢迎使用 StartFlow',
                )
              }
            >
              进入工作台
              <ArrowRight size={16} />
            </Button>
          )}
        </div>
      </Modal>
      {task && (
        <TaskEditor
          task={task}
          onClose={() => setTask(null)}
          onSaved={async (t) => {
            const current = useApp.getState().data!.config;
            await perform(
              () => api.saveScene(scene, [...orderedTasks(current, scene.id), t.id]),
              '任务已加入场景',
            );
          }}
        />
      )}
    </>
  );
}
