import { z } from 'zod';
import type { NodeConfig, Workflow, WorkflowNode } from '../../types/v2';
export const nodeLabels: Record<NodeConfig['type'], string> = {
  start: '开始',
  web: '打开网页',
  app: '启动应用',
  folder: '打开文件夹',
  delay: '延迟等待',
  condition: '条件判断',
  network: '等待网络',
  layout: '恢复窗口布局',
  notification: '系统通知',
  end: '结束',
  scene: '启动简单场景',
};
export const workflowSchema = z.object({
  id: z.uuid(),
  scene_id: z.uuid(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000),
  schema_version: z.literal(1),
  enabled: z.boolean(),
  max_seconds: z.number().int().min(1).max(3600),
  nodes: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string().trim().min(1),
        x: z.number().finite(),
        y: z.number().finite(),
        on_error: z.enum(['stop', 'continue']),
        config: z
          .object({
            type: z.enum([
              'start',
              'end',
              'web',
              'app',
              'folder',
              'delay',
              'condition',
              'network',
              'layout',
              'notification',
              'scene',
            ]),
          })
          .passthrough(),
      }),
    )
    .min(2)
    .max(200),
  edges: z.array(
    z.object({
      id: z.uuid(),
      source: z.uuid(),
      target: z.uuid(),
      handle: z.enum(['next', 'true', 'false']),
    }),
  ),
  created_at: z.string(),
  updated_at: z.string(),
});
export function newNode(type: NodeConfig['type'], x = 0, y = 0): WorkflowNode {
  let config: NodeConfig;
  switch (type) {
    case 'start':
    case 'end':
      config = { type };
      break;
    case 'web':
    case 'app':
    case 'folder':
      config = { type, task_id: '' };
      break;
    case 'delay':
      config = { type, milliseconds: 3000 };
      break;
    case 'condition':
      config = { type, mode: 'and', conditions: [{ type: 'weekdays', days: [1, 2, 3, 4, 5] }] };
      break;
    case 'network':
      config = { type, mode: 'local', url: '', timeout_seconds: 30 };
      break;
    case 'layout':
      config = { type, layout_id: '', timeout_seconds: 15 };
      break;
    case 'notification':
      config = { type, title: 'StartFlow', body: '流程已到达通知节点。', level: 'info' };
      break;
    case 'scene':
      config = { type, scene_id: '' };
      break;
  }
  return { id: crypto.randomUUID(), name: nodeLabels[type], x, y, config, on_error: 'stop' };
}
export function blankWorkflow(sceneId: string, name = '新的工作流'): Workflow {
  const a = newNode('start'),
    b = newNode('end', 300, 0);
  const stamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    scene_id: sceneId,
    name,
    description: '',
    schema_version: 1,
    enabled: true,
    max_seconds: 3600,
    nodes: [a, b],
    edges: [{ id: crypto.randomUUID(), source: a.id, target: b.id, handle: 'next' }],
    created_at: stamp,
    updated_at: stamp,
  };
}
export function fromPreset(sceneId: string, preset: string): Workflow {
  const w = blankWorkflow(sceneId);
  let types: NodeConfig['type'][];
  switch (preset) {
    case 'office':
      w.name = '日常办公';
      types = ['start', 'network', 'web', 'app', 'end'];
      break;
    case 'editing':
      w.name = '视频剪辑';
      types = ['start', 'folder', 'app', 'delay', 'layout', 'end'];
      break;
    case 'weekday': {
      w.name = '工作日启动';
      const start = newNode('start');
      const condition = newNode('condition', 260, 0);
      const scene = newNode('scene', 520, -90);
      const yes = newNode('end', 780, -90);
      const no = newNode('end', 520, 140);
      w.nodes = [start, condition, scene, yes, no];
      w.edges = [
        { id: crypto.randomUUID(), source: start.id, target: condition.id, handle: 'next' },
        { id: crypto.randomUUID(), source: condition.id, target: scene.id, handle: 'true' },
        { id: crypto.randomUUID(), source: condition.id, target: no.id, handle: 'false' },
        { id: crypto.randomUUID(), source: scene.id, target: yes.id, handle: 'next' },
      ];
      return w;
    }
    default:
      return w;
  }
  w.nodes = types.map((t, i) => newNode(t, i * 260, 0));
  w.edges = w.nodes.slice(1).map((n, i) => ({
    id: crypto.randomUUID(),
    source: w.nodes[i].id,
    target: n.id,
    handle: 'next',
  }));
  return w;
}
