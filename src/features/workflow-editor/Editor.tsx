import { useState, useMemo, useEffect, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  ViewportPortal,
  useReactFlow,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ArrowLeft,
  Save,
  Undo2,
  Redo2,
  CheckCircle2,
  Play,
  StopCircle,
  Copy,
  Trash2,
  AlignHorizontalJustifyCenter,
  Plus,
  GitBranch,
} from 'lucide-react';
import { toast } from 'sonner';
import { NodeView, type CanvasNode } from './NodeView';
import { NodePanel } from './NodePanel';
import { useEditor } from './store';
import { useApp, perform } from '../../stores/app';
import { v2 } from '../../services/v2';
import { api, errorMessage } from '../../services/api';
import { Button } from '../../components/ui/button';
import { useConfirm } from '../../components/confirm';
import { StatusBadge } from '../../components/common';
import { nodeLabels, newNode, workflowSchema } from '../workflows/schema';
import { emptyExtension, type NodeConfig, type WorkflowEdge } from '../../types/v2';
import { datetime } from '../../utils/format';
const nodeTypes = { workflow: NodeView };
export function Editor() {
  return (
    <ReactFlowProvider>
      <EditorContent />
    </ReactFlowProvider>
  );
}
function EditorContent() {
  const editor = useEditor();
  const w = editor.workflow!;
  const data = useApp((s) => s.data)!;
  const confirm = useConfirm();
  const flow = useReactFlow<CanvasNode>();
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState('尚未验证');
  const [selection, setSelection] = useState<string[]>([]);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const [linkTarget, setLinkTarget] = useState('');
  const [linkHandle, setLinkHandle] = useState<'next' | 'true' | 'false'>('next');
  const dragging = useRef(false);
  const dirty = JSON.stringify(w) !== editor.saved;
  const ext = data.v2?.extension ?? emptyExtension;
  const bound = ext.bindings.find((b) => b.scene_id === w.scene_id)?.workflow_id === w.id;
  const history = data.v2?.workflow_runs.filter((r) => r.workflow_id === w.id) ?? [];
  const run = data.runs.find((r) => history.some((h) => h.run_id === r.id));
  const nodeLogs = data.v2?.node_logs.filter((l) => l.run_id === run?.id) ?? [];
  const statuses = useMemo(() => new Map(nodeLogs.map((l) => [l.node_id, l.status])), [nodeLogs]);
  const nodes: CanvasNode[] = w.nodes.map((n) => ({
    id: n.id,
    type: 'workflow',
    position: { x: n.x, y: n.y },
    data: { node: n, status: statuses.get(n.id) },
    selected: selection.includes(n.id),
  }));
  const edges = w.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.handle,
    targetHandle: 'in',
    label: e.handle === 'next' ? undefined : e.handle === 'true' ? '是' : '否',
    animated: statuses.get(e.source) === 'running',
    style: {
      stroke: e.handle === 'true' ? '#34d399' : e.handle === 'false' ? '#fb7185' : 'var(--accent)',
      strokeWidth: 2,
    },
  }));
  const selected = w.nodes.find((n) => n.id === editor.selected) ?? null;
  useEffect(() => {
    useApp.getState().setNavigationGuard(async () => {
      if (!dirty) return true;
      const ok = await confirm(
        '离开工作流编辑器？',
        '当前未保存的修改将被丢弃；已保存的工作流草稿仍保留。',
      );
      if (ok) useEditor.getState().close();
      return ok;
    });
    return () => useApp.getState().setNavigationGuard(null);
  }, [dirty, confirm]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
        return;
      if (e.ctrlKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) useEditor.getState().redo();
        else useEditor.getState().undo();
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        useEditor.getState().redo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const change = (patch: Partial<typeof w>, checkpoint = true) => {
    editor.change({ ...useEditor.getState().workflow!, ...patch }, checkpoint);
    setValidation('修改后待验证');
  };
  const validConnection = (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return false;
    const a = w.nodes.find((n) => n.id === c.source),
      b = w.nodes.find((n) => n.id === c.target);
    if (
      !a ||
      !b ||
      a.config.type === 'end' ||
      b.config.type === 'start' ||
      w.edges.some((e) => e.target === c.target) ||
      w.edges.some((e) => e.source === c.source && e.handle === (c.sourceHandle ?? 'next'))
    )
      return false;
    if (
      a.config.type === 'condition'
        ? !['true', 'false'].includes(c.sourceHandle ?? '')
        : c.sourceHandle !== 'next'
    )
      return false;
    const visit = [c.target];
    const seen = new Set<string>();
    while (visit.length) {
      const id = visit.pop()!;
      if (id === c.source) return false;
      if (!seen.has(id)) {
        seen.add(id);
        visit.push(...w.edges.filter((e) => e.source === id).map((e) => e.target));
      }
    }
    return true;
  };
  const connect = (c: Connection) => {
    if (!validConnection(c)) {
      toast.error('连接无效：请检查入口、重复入边、分支或循环。');
      return;
    }
    change({
      edges: [
        ...w.edges,
        {
          id: crypto.randomUUID(),
          source: c.source!,
          target: c.target!,
          handle: (c.sourceHandle ?? 'next') as WorkflowEdge['handle'],
        },
      ],
    });
  };
  const nodeChanges = (changes: NodeChange<CanvasNode>[]) => {
    let updated = w.nodes;
    let changed = false;
    let remove = false;
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        updated = updated.map((n) =>
          n.id === c.id ? { ...n, x: c.position!.x, y: c.position!.y } : n,
        );
        changed = true;
      }
      if (c.type === 'remove') {
        updated = updated.filter((n) => n.id !== c.id);
        changed = true;
        remove = true;
      }
    }
    if (changed)
      change(
        {
          nodes: updated,
          edges: remove
            ? w.edges.filter(
                (e) =>
                  updated.some((n) => n.id === e.source) && updated.some((n) => n.id === e.target),
              )
            : w.edges,
        },
        remove || !dragging.current,
      );
  };
  const edgeChanges = (changes: EdgeChange[]) => {
    const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id));
    if (removed.size) change({ edges: w.edges.filter((e) => !removed.has(e.id)) });
  };
  const save = async () => {
    const value = useEditor.getState().workflow!;
    if (!workflowSchema.safeParse(value).success) {
      toast.error('请检查名称、节点数量和运行时长。');
      return false;
    }
    try {
      await v2.validate(value);
    } catch (e) {
      setValidation(errorMessage(e));
      toast.error(errorMessage(e));
      return false;
    }
    const latest = useApp.getState().data?.v2?.extension ?? emptyExtension;
    const saved = { ...value, updated_at: new Date().toISOString() };
    const extension = {
      ...latest,
      workflows: [...latest.workflows.filter((x) => x.id !== saved.id), saved],
    };
    const ok = await perform(() => v2.save(extension), '工作流草稿已保存');
    if (ok) {
      editor.change(saved, false);
      editor.markSaved();
      setValidation('验证通过');
    }
    return ok;
  };
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const activate = async () => {
    if (!(await save())) return false;
    if (
      !bound &&
      !(await confirm(
        '将场景切换为高级模式？',
        '之后手动、登录、定时和快捷键均执行此工作流。原简单任务列表保留，可恢复简单模式。',
      ))
    )
      return false;
    const latest = useApp.getState().data!.v2!.extension;
    return perform(
      () =>
        v2.save({
          ...latest,
          bindings: [
            ...latest.bindings.filter((b) => b.scene_id !== w.scene_id),
            { scene_id: w.scene_id, workflow_id: w.id },
          ],
        }),
      '高级模式已启用',
    );
  };
  const remove = () => {
    const ids = new Set(selection.length ? selection : editor.selected ? [editor.selected] : []);
    change({
      nodes: w.nodes.filter((n) => !ids.has(n.id)),
      edges: w.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
    });
    setSelection([]);
    editor.select(null);
  };
  const copy = () => {
    const chosen = w.nodes.filter((n) => selection.includes(n.id) && n.config.type !== 'start');
    if (!chosen.length && selected && selected.config.type !== 'start') chosen.push(selected);
    if (w.nodes.length + chosen.length > 200) {
      toast.error('最多 200 个节点。');
      return;
    }
    change({
      nodes: [
        ...w.nodes,
        ...chosen.map((n) => ({
          ...structuredClone(n),
          id: crypto.randomUUID(),
          name: `${n.name} 副本`,
          x: n.x + 40,
          y: n.y + 80,
        })),
      ],
    });
  };
  const arrange = () => {
    const positions = new Map<string, { x: number; y: number }>();
    const start = w.nodes.find((n) => n.config.type === 'start');
    let row = 0;
    const walk = (id: string, depth: number) => {
      if (positions.has(id)) return;
      positions.set(id, { x: depth * 270, y: row * 160 });
      const out = w.edges.filter((e) => e.source === id);
      out.forEach((e, i) => {
        if (i > 0) row++;
        walk(e.target, depth + 1);
      });
    };
    if (start) walk(start.id, 0);
    w.nodes
      .filter((n) => !positions.has(n.id))
      .forEach((n) => {
        row++;
        positions.set(n.id, { x: 0, y: row * 160 });
      });
    change({ nodes: w.nodes.map((n) => ({ ...n, ...positions.get(n.id)! })) });
    setTimeout(() => void flow.fitView({ padding: 0.2 }), 30);
  };
  return (
    <section className="workflow-editor">
      <header className="editor-toolbar">
        <Button
          variant="ghost"
          size="icon"
          aria-label="返回工作流列表"
          onClick={() =>
            void (async () => {
              if (!dirty || (await confirm('关闭编辑器？', '未保存的修改将被丢弃。')))
                editor.close();
            })()
          }
        >
          <ArrowLeft size={18} />
        </Button>
        <div className="editor-name">
          <input
            aria-label="工作流名称"
            value={w.name}
            onChange={(e) => change({ name: e.target.value })}
          />
          <small>
            {data.config.scenes.find((s) => s.id === w.scene_id)?.name} ·{' '}
            {bound ? '高级模式' : '独立草稿'}
            {dirty ? ' · 未保存' : ''}
          </small>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="撤销"
          disabled={!editor.past.length}
          onClick={editor.undo}
        >
          <Undo2 size={17} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="重做"
          disabled={!editor.future.length}
          onClick={editor.redo}
        >
          <Redo2 size={17} />
        </Button>
        <Button
          variant="secondary"
          loading={busy}
          onClick={() =>
            void action(async () => {
              await v2.validate(w);
              setValidation('验证通过');
              toast.success('结构与参数验证通过');
            })
          }
        >
          <CheckCircle2 size={15} />
          验证
        </Button>
        <Button variant="secondary" loading={busy} onClick={() => void action(save)}>
          <Save size={15} />
          保存
        </Button>
        <Button
          variant="secondary"
          loading={busy}
          disabled={run?.status === 'running'}
          onClick={() =>
            void action(async () => {
              if (await save()) await perform(() => v2.run(w.id), '测试已提交，将真实执行配置内容');
            })
          }
        >
          <Play size={15} />
          测试运行
        </Button>
        <Button
          loading={busy}
          disabled={run?.status === 'running'}
          onClick={() =>
            void action(async () => {
              if (await activate()) await perform(() => api.runScene(w.scene_id), '正式执行已提交');
            })
          }
        >
          <Play size={15} />
          正式执行
        </Button>
      </header>
      <div className="editor-body">
        <aside className="node-toolbox">
          <span className="eyebrow">节点工具箱</span>
          <p className="muted">拖入画布，或点击添加</p>
          {Object.entries(nodeLabels).map(([type, label]) => (
            <button
              key={type}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('application/startflow-node', type)}
              onClick={() => {
                const n = newNode(
                  type as NodeConfig['type'],
                  w.nodes.length * 30,
                  w.nodes.length * 25,
                );
                if (w.nodes.length < 200) {
                  change({ nodes: [...w.nodes, n] });
                  editor.select(n.id);
                } else toast.error('最多 200 个节点。');
              }}
            >
              <Plus size={14} />
              {label}
            </button>
          ))}
          <div className="toolbox-footer">
            <Button variant="ghost" size="sm" onClick={arrange}>
              <AlignHorizontalJustifyCenter size={14} />
              自动排列
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!selection.length && !selected}
              onClick={copy}
            >
              <Copy size={14} />
              复制节点
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!selection.length && !selected}
              onClick={remove}
            >
              <Trash2 size={14} />
              删除节点
            </Button>
          </div>
        </aside>
        <div
          className="flow-canvas"
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(e) => {
            e.preventDefault();
            const type = e.dataTransfer.getData('application/startflow-node') as NodeConfig['type'];
            if (type in nodeLabels && w.nodes.length < 200) {
              const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
              const n = newNode(type, p.x, p.y);
              change({ nodes: [...w.nodes, n] });
              editor.select(n.id);
            }
          }}
        >
          <ReactFlow<CanvasNode>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={nodeChanges}
            onEdgesChange={edgeChanges}
            onConnect={connect}
            isValidConnection={(c) =>
              validConnection({
                source: c.source,
                target: c.target,
                sourceHandle: c.sourceHandle ?? null,
                targetHandle: c.targetHandle ?? null,
              })
            }
            onSelectionChange={(s) => {
              const ids = s.nodes.map((n) => n.id);
              setSelection((old) => (old.join() === ids.join() ? old : ids));
            }}
            onNodeClick={(_, n) => editor.select(n.id)}
            onPaneClick={() => editor.select(null)}
            onNodeDragStart={() => {
              dragging.current = true;
              editor.checkpoint();
            }}
            onNodeDrag={(_, n) => {
              const others = w.nodes.filter((x) => x.id !== n.id);
              const x = others.find((x) => Math.abs(x.x - n.position.x) < 8)?.x;
              const y = others.find((x) => Math.abs(x.y - n.position.y) < 8)?.y;
              setGuides({ x, y });
              if (x !== undefined || y !== undefined) {
                const current = useEditor.getState().workflow!;
                editor.change(
                  {
                    ...current,
                    nodes: current.nodes.map((v) =>
                      v.id === n.id ? { ...v, x: x ?? n.position.x, y: y ?? n.position.y } : v,
                    ),
                  },
                  false,
                );
              }
            }}
            onNodeDragStop={() => {
              dragging.current = false;
              setGuides({});
            }}
            fitView
            minZoom={0.15}
            maxZoom={2}
            snapToGrid
            snapGrid={[20, 20]}
            selectionOnDrag
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
            ariaLabelConfig={{
              'controls.zoomIn.ariaLabel': '放大画布',
              'controls.zoomOut.ariaLabel': '缩小画布',
              'controls.fitView.ariaLabel': '适应画布',
            }}
          >
            <Background gap={24} size={1} />
            <Controls />
            <MiniMap pannable zoomable nodeColor="var(--accent)" />
            <ViewportPortal>
              {guides.x !== undefined && (
                <div className="alignment-guide vertical" style={{ left: guides.x }} />
              )}
              {guides.y !== undefined && (
                <div className="alignment-guide horizontal" style={{ top: guides.y }} />
              )}
            </ViewportPortal>
          </ReactFlow>
        </div>
        <NodePanel node={selected} />
      </div>
      {selected && selected.config.type !== 'end' && (
        <div className="keyboard-connection">
          <GitBranch size={15} />
          <span>连接选中节点</span>
          <select
            aria-label="连接分支"
            value={
              selected.config.type === 'condition'
                ? linkHandle === 'next'
                  ? 'true'
                  : linkHandle
                : 'next'
            }
            onChange={(e) => setLinkHandle(e.target.value as typeof linkHandle)}
          >
            {selected.config.type === 'condition' ? (
              <>
                <option value="true">True · 是</option>
                <option value="false">False · 否</option>
              </>
            ) : (
              <option value="next">下一步</option>
            )}
          </select>
          <select
            aria-label="连接目标"
            value={linkTarget}
            onChange={(e) => setLinkTarget(e.target.value)}
          >
            <option value="">选择目标节点</option>
            {w.nodes
              .filter((n) => n.id !== selected.id && n.config.type !== 'start')
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!linkTarget}
            onClick={() =>
              connect({
                source: selected.id,
                target: linkTarget,
                sourceHandle:
                  selected.config.type === 'condition'
                    ? linkHandle === 'next'
                      ? 'true'
                      : linkHandle
                    : 'next',
                targetHandle: 'in',
              })
            }
          >
            建立连接
          </Button>
        </div>
      )}
      <footer className="editor-status">
        <span className={validation === '验证通过' ? 'success-text' : 'muted'}>{validation}</span>
        <span>
          {w.nodes.length} 个节点 · {w.edges.length} 条连线
        </span>
        <label>
          最长运行{' '}
          <input
            type="number"
            min={1}
            max={3600}
            value={w.max_seconds}
            onChange={(e) => change({ max_seconds: +e.target.value })}
          />{' '}
          秒
        </label>
        <label>
          <input
            type="checkbox"
            checked={w.enabled}
            onChange={(e) => change({ enabled: e.target.checked })}
          />
          工作流已启用
        </label>
        <span>最后保存：{editor.saved ? datetime(w.updated_at) : '尚未保存'}</span>
      </footer>
      {run && (
        <div className="execution-monitor">
          <StatusBadge status={run.status} />
          <span>
            已执行 {nodeLogs.filter((l) => l.started_at).length} 个节点 · 失败{' '}
            {nodeLogs.filter((l) => l.status === 'failed').length} 个
          </span>
          <span className="grow">
            {nodeLogs.find((l) => l.status === 'running')?.node_name ?? '执行路径已记录'}
          </span>
          {run.status === 'running' && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void perform(() => v2.cancel(run.id), '取消请求已提交')}
            >
              <StopCircle size={14} />
              取消流程
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
