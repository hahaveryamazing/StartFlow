import { useState } from 'react';
import { Play, Pencil, Copy, Trash2, Power } from 'lucide-react';
import { useApp, perform } from '../../stores/app';
import { api } from '../../services/api';
import {
  SceneIcon,
  StatusBadge,
  PageHeader,
  SearchBox,
  Empty,
  AddButton,
} from '../../components/common';
import { Button } from '../../components/ui/button';
import { useConfirm } from '../../components/confirm';
import { newScene, orderedTasks, datetime } from '../../utils/format';
import type { Scene } from '../../types';
import { SceneEditor } from './SceneEditor';
import { SceneDetails } from './SceneDetails';
export function SceneCard({ scene, onEdit }: { scene: Scene; onEdit: (s: Scene) => void }) {
  const data = useApp((s) => s.data)!;
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(false);
  const binding = data.v2?.extension.bindings.find((b) => b.scene_id === scene.id);
  const confirm = useConfirm();
  const count = orderedTasks(data.config, scene.id).length;
  const run = data.runs.find((r) => r.scene_id === scene.id);
  const running = data.active_scenes.includes(scene.id);
  const start = async () => {
    setBusy(true);
    await perform(() => api.runScene(scene.id), '场景任务已提交，结果请查看运行日志');
    setBusy(false);
  };
  return (
    <article className={`scene-card ${!scene.enabled ? 'dim' : ''}`}>
      <div className="card-top">
        <SceneIcon icon={scene.icon} color={scene.color} />
        <span className={`enabled-dot ${scene.enabled ? '' : 'off'}`}>
          {scene.enabled ? '已启用' : '已停用'}
        </span>
      </div>
      <h3>{scene.name}</h3>
      <p className="scene-desc">{scene.description || '为你的工作准备好一切。'}</p>
      <div className="scene-meta">
        <span>{binding ? '高级工作流' : `${String(count).padStart(2, '0')} 项任务`}</span>
        <span>{run ? datetime(run.started_at) : '尚未启动'}</span>
      </div>
      {run && <StatusBadge status={run.status} />}
      <div className="scene-actions">
        <Button
          className="grow"
          loading={busy || running}
          disabled={!scene.enabled || (!count && !binding)}
          onClick={() => void start()}
        >
          <Play size={15} />
          {running ? '正在执行' : '启动场景'}
        </Button>
        <Button
          variant="secondary"
          size="icon"
          aria-label={`编辑 ${scene.name}`}
          onClick={() => onEdit(scene)}
        >
          <Pencil size={15} />
        </Button>
      </div>
      <div className="card-tools">
        <Button variant="ghost" size="sm" onClick={() => setDetails(true)}>
          场景详情
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void perform(() => api.duplicate(scene.id), '场景已复制')}
        >
          <Copy size={13} />
          复制
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void perform(
              () =>
                api.saveScene(
                  { ...scene, enabled: !scene.enabled },
                  orderedTasks(data.config, scene.id),
                ),
              scene.enabled ? '场景已停用' : '场景已启用',
            )
          }
        >
          <Power size={13} />
          {scene.enabled ? '停用' : '启用'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="danger-text"
          onClick={() =>
            void (async () => {
              if (
                await confirm(
                  '删除此场景？',
                  '场景的任务关联和计划将被删除，任务本身与运行历史会保留。',
                )
              )
                await perform(() => api.remove('scene', scene.id), '场景已删除');
            })()
          }
        >
          <Trash2 size={13} />
          删除
        </Button>
      </div>
      {details && <SceneDetails scene={scene} onClose={() => setDetails(false)} />}
    </article>
  );
}
export function Scenes() {
  const data = useApp((s) => s.data)!;
  const [query, setQuery] = useState('');
  const [edit, setEdit] = useState<Scene | null>(null);
  const scenes = data.config.scenes.filter((s) =>
    (s.name + s.description).toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="工作空间 / 场景管理"
        title="启动场景"
        description="把重复的准备工作，变成一次轻松的启动。"
        action={
          <AddButton
            label="创建场景"
            onClick={() => setEdit({ ...newScene(), sort_order: data.config.scenes.length })}
          />
        }
      />
      <div className="toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="搜索场景…" />
        <span className="muted">共 {data.config.scenes.length} 个场景</span>
      </div>
      {scenes.length ? (
        <div className="scene-grid">
          {scenes.map((s) => (
            <SceneCard key={s.id} scene={s} onEdit={setEdit} />
          ))}
        </div>
      ) : (
        <Empty
          title={query ? '没有找到匹配场景' : '从你的第一个工作场景开始'}
          description="创建一个场景，加入每天需要打开的网页、软件和文件夹。"
          action={<AddButton label="创建场景" onClick={() => setEdit(newScene())} />}
        />
      )}{' '}
      {edit && <SceneEditor scene={edit} onClose={() => setEdit(null)} />}
    </>
  );
}
