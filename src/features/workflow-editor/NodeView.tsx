import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import {
  CirclePlay,
  Globe,
  AppWindow,
  Folder,
  Timer,
  GitBranch,
  Wifi,
  PanelsTopLeft,
  Bell,
  Flag,
  Layers,
} from 'lucide-react';
import type { WorkflowNode } from '../../types/v2';
import { nodeLabels } from '../workflows/schema';
import { StatusBadge } from '../../components/common';
export type CanvasNode = Node<{ node: WorkflowNode; status?: string }, 'workflow'>;
const icons = {
  start: CirclePlay,
  web: Globe,
  app: AppWindow,
  folder: Folder,
  delay: Timer,
  condition: GitBranch,
  network: Wifi,
  layout: PanelsTopLeft,
  notification: Bell,
  end: Flag,
  scene: Layers,
};
export function NodeView({ data, selected }: NodeProps<CanvasNode>) {
  const n = data.node;
  const Icon = icons[n.config.type];
  return (
    <div
      className={`flow-node ${selected ? 'selected' : ''} node-${n.config.type} execution-${data.status ?? 'pending'}`}
    >
      {n.config.type !== 'start' && <Handle type="target" position={Position.Left} id="in" />}
      <div className="flow-node-top">
        <span className="flow-node-icon">
          <Icon size={18} />
        </span>
        <span>
          <small>{nodeLabels[n.config.type]}</small>
          <strong>{n.name}</strong>
        </span>
      </div>
      {data.status && <StatusBadge status={data.status} />}
      {n.config.type === 'condition' ? (
        <>
          <span className="branch-label branch-true">True · 是</span>
          <Handle type="source" position={Position.Right} id="true" style={{ top: '36%' }} />
          <span className="branch-label branch-false">False · 否</span>
          <Handle type="source" position={Position.Right} id="false" style={{ top: '76%' }} />
        </>
      ) : (
        n.config.type !== 'end' && <Handle type="source" position={Position.Right} id="next" />
      )}
    </div>
  );
}
