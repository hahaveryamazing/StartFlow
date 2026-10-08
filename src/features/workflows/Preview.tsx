import type { Workflow } from '../../types/v2';
export function WorkflowPreview({ workflow }: { workflow: Workflow }) {
  const bounds = workflow.nodes.reduce(
    (b, n) => ({
      minX: Math.min(b.minX, n.x),
      maxX: Math.max(b.maxX, n.x),
      minY: Math.min(b.minY, n.y),
      maxY: Math.max(b.maxY, n.y),
    }),
    { minX: 0, maxX: 300, minY: 0, maxY: 0 },
  );
  return (
    <svg
      className="workflow-preview"
      role="img"
      aria-label={`${workflow.name} 只读流程预览`}
      viewBox={`${bounds.minX - 30} ${bounds.minY - 35} ${bounds.maxX - bounds.minX + 240} ${bounds.maxY - bounds.minY + 130}`}
    >
      {workflow.edges.map((e) => {
        const a = workflow.nodes.find((n) => n.id === e.source),
          b = workflow.nodes.find((n) => n.id === e.target);
        return a && b ? (
          <line
            key={e.id}
            x1={a.x + 180}
            y1={a.y + 30}
            x2={b.x}
            y2={b.y + 30}
            stroke={
              e.handle === 'true' ? '#34d399' : e.handle === 'false' ? '#fb7185' : 'var(--accent)'
            }
            strokeWidth={3}
          />
        ) : null;
      })}
      {workflow.nodes.map((n) => (
        <g key={n.id}>
          <rect
            x={n.x}
            y={n.y}
            width={180}
            height={60}
            rx={12}
            fill="var(--panel)"
            stroke="var(--accent)"
            strokeOpacity={0.5}
          />
          <text x={n.x + 90} y={n.y + 35} textAnchor="middle" fill="var(--text)" fontSize={14}>
            {n.name.length > 11 ? `${n.name.slice(0, 11)}…` : n.name}
          </text>
        </g>
      ))}
    </svg>
  );
}
