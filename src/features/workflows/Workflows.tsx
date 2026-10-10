import { lazy, Suspense, useState } from 'react';
import {
  GitBranch,
  Plus,
  Copy,
  Trash2,
  BookTemplate,
  Pencil,
  Play,
  ArrowRight,
  LoaderCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useApp, perform } from '../../stores/app';
import { useEditor } from '../workflow-editor/store';
import { v2 } from '../../services/v2';
import { errorMessage } from '../../services/api';
import { PageHeader, SearchBox, Empty, StatusBadge } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Modal } from '../../components/ui/dialog';
import { useConfirm } from '../../components/confirm';
import { emptyExtension, type Workflow, type Template } from '../../types/v2';
import { fromPreset } from './schema';
import { WorkflowPreview } from './Preview';
import { datetime } from '../../utils/format';
const Editor = lazy(() => import('../workflow-editor/Editor').then((m) => ({ default: m.Editor })));
function clone(w: Workflow, scene: string): Workflow {
  const map = new Map(w.nodes.map((n) => [n.id, crypto.randomUUID()]));
  return {
    ...structuredClone(w),
    id: crypto.randomUUID(),
    scene_id: scene,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    nodes: w.nodes.map((n) => ({ ...structuredClone(n), id: map.get(n.id)! })),
    edges: w.edges.map((e) => ({
      ...e,
      id: crypto.randomUUID(),
      source: map.get(e.source)!,
      target: map.get(e.target)!,
    })),
  };
}
export function Workflows() {
  const data = useApp((s) => s.data)!;
  const ext = data.v2?.extension ?? emptyExtension;
  const editor = useEditor();
  const confirm = useConfirm();
  const [query, setQuery] = useState('');
  const [create, setCreate] = useState(false);
  const [scene, setScene] = useState(data.config.scenes[0]?.id ?? '');
  const [template, setTemplate] = useState('blank');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [personal, setPersonal] = useState<Workflow | null>(null);
  const [rename, setRename] = useState<Template | null>(null);
  const [preview, setPreview] = useState<Workflow | null>(null);
  if (editor.workflow)
    return (
      <Suspense
        fallback={
          <div className="small-empty">
            <LoaderCircle className="spin" />
            正在准备工作流编辑器…
          </div>
        }
      >
        <Editor />
      </Suspense>
    );
  const rows = ext.workflows.filter((w) =>
    `${w.name} ${w.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  const start = () => {
    if (!scene) {
      toast.error('请先创建一个场景。');
      return;
    }
    const chosen = ext.templates.find((t) => t.id === template);
    editor.open(chosen ? clone(chosen.workflow, scene) : fromPreset(scene, template), false);
    setCreate(false);
  };
  return (
    <>
      <PageHeader
        eyebrow="WORKFLOWS"
        title="工作流"
        description="把启动内容连成清晰、可验证的执行逻辑。"
        action={
          <Button onClick={() => setCreate(true)}>
            <Plus size={16} />
            创建工作流
          </Button>
        }
      />
      <div className="workflow-intro">
        <span className="intro-icon">
          <GitBranch size={24} />
        </span>
        <div>
          <strong>简单列表仍然保留</strong>
          <p>
            转换会创建独立草稿；保存不会切换运行模式。高级模式启用后，所有触发入口共用同一执行引擎。
          </p>
        </div>
        <Button variant="secondary" onClick={() => setCreate(true)}>
          <BookTemplate size={16} />
          模板库
        </Button>
      </div>
      <div className="list-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="搜索工作流" />
        <span className="muted">{rows.length} 个工作流</span>
      </div>
      {!rows.length ? (
        <Empty
          title="从一个简单流程开始"
          description="选择空白模板，或把现有场景转换为可恢复的工作流草稿。"
          action={<Button onClick={() => setCreate(true)}>创建第一个工作流</Button>}
        />
      ) : (
        <div className="workflow-grid">
          {rows.map((w) => {
            const bound = ext.bindings.some((b) => b.workflow_id === w.id);
            const record = data.runs.find((r) =>
              data.v2?.workflow_runs.some((x) => x.run_id === r.id && x.workflow_id === w.id),
            );
            return (
              <article key={w.id} data-workflow-id={w.id} className="panel workflow-card">
                <div className="card-top">
                  <GitBranch size={20} />
                  <span className={`badge ${bound ? 'status-completed' : ''}`}>
                    {bound ? '场景高级模式' : '独立草稿'}
                  </span>
                </div>
                <h3>{w.name}</h3>
                <p className="muted">
                  {data.config.scenes.find((s) => s.id === w.scene_id)?.name} · {w.nodes.length}{' '}
                  个节点
                </p>
                <WorkflowPreview workflow={w} />
                <div className="workflow-card-meta">
                  <span>{datetime(w.updated_at)}</span>
                  {record && <StatusBadge status={record.status} />}
                </div>
                <div className="scene-actions">
                  <Button className="grow" onClick={() => editor.open(w)}>
                    <Pencil size={15} />
                    编辑流程
                  </Button>
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label={`测试 ${w.name}`}
                    disabled={record?.status === 'running'}
                    onClick={() => void perform(() => v2.run(w.id), '真实测试已提交')}
                  >
                    <Play size={15} />
                  </Button>
                </div>
                <div className="card-tools">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPersonal(w);
                      setName(w.name);
                    }}
                  >
                    <Copy size={13} />
                    存为模板
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void (async () => {
                        if (
                          await confirm(
                            '删除工作流？',
                            '草稿和高级模式关联将被删除；原简单列表、共享任务和运行历史保留。',
                          )
                        )
                          await perform(
                            () =>
                              v2.save({
                                ...ext,
                                workflows: ext.workflows.filter((x) => x.id !== w.id),
                                bindings: ext.bindings.filter((x) => x.workflow_id !== w.id),
                              }),
                            '工作流已删除',
                          );
                      })()
                    }
                  >
                    <Trash2 size={13} />
                    删除
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {create && (
        <Modal
          title="创建工作流"
          description="通用模板不包含假定的软件路径，创建后请选择自己的任务和布局。"
          open
          onClose={() => setCreate(false)}
          wide
        >
          <div className="form-body">
            <label>
              关联场景
              <select value={scene} onChange={(e) => setScene(e.target.value)}>
                <option value="">选择场景</option>
                {data.config.scenes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="template-grid">
              {[
                ['blank', '自定义空白', '开始 → 结束'],
                ['office', '日常办公', '网络 → 网页 → 应用'],
                ['editing', '视频剪辑', '素材 → 应用 → 等待 → 布局'],
                ['weekday', '工作日启动', '星期条件 → 简单场景 / 结束'],
              ].map(([key, label, desc]) => (
                <button
                  key={key}
                  className={`template-choice ${template === key ? 'selected' : ''}`}
                  onClick={() => setTemplate(key)}
                >
                  <BookTemplate size={22} />
                  <strong>{label}</strong>
                  <small>{desc}</small>
                </button>
              ))}
            </div>
            {ext.templates.length > 0 && (
              <>
                <h3>个人模板</h3>
                {ext.templates.map((t) => (
                  <div className="template-personal" key={t.id}>
                    <button
                      onClick={() => setTemplate(t.id)}
                      className={template === t.id ? 'selected' : ''}
                    >
                      {t.name}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`预览 ${t.name}`}
                      onClick={() => setPreview(t.workflow)}
                    >
                      <GitBranch size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`重命名 ${t.name}`}
                      onClick={() => {
                        setRename(t);
                        setName(t.name);
                      }}
                    >
                      <Pencil size={15} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`删除模板 ${t.name}`}
                      onClick={() =>
                        void (async () => {
                          if (await confirm('删除个人模板？', '已经创建的工作流不受影响。'))
                            await perform(
                              () =>
                                v2.save({
                                  ...ext,
                                  templates: ext.templates.filter((x) => x.id !== t.id),
                                }),
                              '模板已删除',
                            );
                        })()
                      }
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                ))}
              </>
            )}
            <p className="hint-box">转换现有列表会立即保存独立草稿，不覆盖场景的原配置。</p>
          </div>
          <div className="modal-footer">
            <Button
              variant="secondary"
              loading={busy}
              disabled={!scene}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    const w = await v2.convert(scene);
                    await useApp.getState().refresh();
                    editor.open(w);
                    setCreate(false);
                  } catch (e) {
                    toast.error(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              转换简单列表
            </Button>
            <Button disabled={!scene} onClick={start}>
              从模板创建
              <ArrowRight size={15} />
            </Button>
          </div>
        </Modal>
      )}
      {(personal || rename) && (
        <Modal
          title={personal ? '保存为个人模板' : '重命名模板'}
          open
          onClose={() => {
            setPersonal(null);
            setRename(null);
          }}
        >
          <div className="form-body">
            <label>
              模板名称
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
            </label>
          </div>
          <div className="modal-footer">
            <Button
              disabled={!name.trim()}
              onClick={() =>
                void (async () => {
                  const templates = personal
                    ? [
                        ...ext.templates,
                        { id: crypto.randomUUID(), name: name.trim(), workflow: personal },
                      ]
                    : ext.templates.map((t) =>
                        t.id === rename?.id ? { ...t, name: name.trim() } : t,
                      );
                  if (await perform(() => v2.save({ ...ext, templates }), '模板已保存')) {
                    setPersonal(null);
                    setRename(null);
                  }
                })()
              }
            >
              保存模板
            </Button>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal title={preview.name} open onClose={() => setPreview(null)} wide>
          <div className="form-body">
            <WorkflowPreview workflow={preview} />
          </div>
        </Modal>
      )}
    </>
  );
}
