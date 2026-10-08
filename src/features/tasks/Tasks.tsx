import { useState } from 'react';
import { Globe, AppWindow, Folder, Play, Pencil, Trash2, Power } from 'lucide-react';
import { useApp, perform } from '../../stores/app';
import { api } from '../../services/api';
import { PageHeader, SearchBox, Empty, AddButton, StatusBadge } from '../../components/common';
import { Button } from '../../components/ui/button';
import { useConfirm } from '../../components/confirm';
import { newTask, kindLabel } from '../../utils/format';
import type { Task } from '../../types';
import { TaskEditor } from './TaskEditor';
export function Tasks() {
  const data = useApp((s) => s.data)!;
  const [edit, setEdit] = useState<Task | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [running, setRunning] = useState<string | null>(null);
  const confirm = useConfirm();
  const tasks = data.config.tasks.filter(
    (t) =>
      (kind === 'all' || t.kind === kind) &&
      (t.name + t.url + t.executable_path).toLowerCase().includes(query.toLowerCase()),
  );
  const run = async (t: Task) => {
    setRunning(t.id);
    await perform(() => api.runTask(t.id), '任务已提交，执行状态请查看运行日志');
    setRunning(null);
  };
  return (
    <>
      <PageHeader
        eyebrow="工作空间 / 启动内容"
        title="任务管理"
        description="管理启动内容，让同一个任务在多个场景中复用。"
        action={<AddButton label="添加任务" onClick={() => setEdit(newTask())} />}
      />
      <div className="toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="搜索任务、网址或路径…" />
        <div className="filter-tabs">
          {[
            ['all', '全部'],
            ['web', '网页'],
            ['app', '应用程序'],
            ['folder', '文件夹'],
          ].map(([key, label]) => (
            <Button
              key={key}
              variant="ghost"
              size="sm"
              className={kind === key ? 'selected' : ''}
              onClick={() => setKind(key)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      {tasks.length ? (
        <div className="list-panel">
          {tasks.map((t) => {
            const Icon = t.kind === 'web' ? Globe : t.kind === 'app' ? AppWindow : Folder;
            const scenes = data.config.scene_tasks
              .filter((a) => a.task_id === t.id)
              .map((a) => data.config.scenes.find((s) => s.id === a.scene_id)?.name)
              .filter(Boolean);
            const last = data.logs.findLast((l) => l.task_id === t.id);
            return (
              <div className="task-row" key={t.id}>
                <span className="task-icon">
                  <Icon size={20} />
                </span>
                <div className="grow task-info">
                  <strong>
                    {t.name}
                    {!t.enabled && <span className="badge">已停用</span>}
                  </strong>
                  <p title={t.kind === 'web' ? t.url : t.executable_path}>
                    {t.kind === 'web' ? t.url : t.executable_path}
                  </p>
                  <small>
                    {kindLabel[t.kind]} · 延迟 {t.delay_ms / 1000} 秒 ·{' '}
                    {scenes.length ? scenes.join('、') : '未关联场景'}
                  </small>
                </div>
                {last && <StatusBadge status={last.status} />}
                <div className="row-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!t.enabled}
                    loading={running === t.id || data.active_scenes.includes(`task:${t.id}`)}
                    onClick={() => void run(t)}
                  >
                    <Play size={14} />
                    测试运行
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`编辑 ${t.name}`}
                    onClick={() => setEdit(t)}
                  >
                    <Pencil size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${t.enabled ? '停用' : '启用'} ${t.name}`}
                    onClick={() =>
                      void perform(
                        () => api.saveTask({ ...t, enabled: !t.enabled }),
                        '任务状态已保存',
                      )
                    }
                  >
                    <Power size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`删除 ${t.name}`}
                    className="danger-text"
                    onClick={() =>
                      void (async () => {
                        if (
                          await confirm(
                            '删除此任务？',
                            '任务将从所有关联场景中移除，运行历史会保留。',
                          )
                        )
                          await perform(() => api.remove('task', t.id), '任务已删除');
                      })()
                    }
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty
          title={query || kind !== 'all' ? '没有匹配的任务' : '让常用内容随时就绪'}
          description="添加网址、选择本地程序，或打开你的工作文件夹。"
          action={<AddButton label="添加任务" onClick={() => setEdit(newTask())} />}
        />
      )}{' '}
      {edit && <TaskEditor task={edit} onClose={() => setEdit(null)} />}
    </>
  );
}
