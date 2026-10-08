import {
  BriefcaseBusiness,
  Coffee,
  Video,
  Gamepad2,
  BookOpen,
  Sparkles,
  Folder,
  Globe,
  Search,
  Plus,
  ArrowUpRight,
  Check,
  AlertCircle,
  Clock3,
  LoaderCircle,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { statusLabel } from '../utils/format';
import { Button } from './ui/button';
export const iconMap = {
  briefcase: BriefcaseBusiness,
  coffee: Coffee,
  video: Video,
  gamepad: Gamepad2,
  book: BookOpen,
  sparkles: Sparkles,
  folder: Folder,
  globe: Globe,
};
export const iconNames: Record<string, string> = {
  briefcase: '公文包',
  coffee: '咖啡',
  video: '视频',
  gamepad: '游戏',
  book: '阅读',
  sparkles: '灵感',
  folder: '文件夹',
  globe: '网页',
};
export function SceneIcon({
  icon,
  color,
  size = 24,
}: {
  icon: string;
  color: string;
  size?: number;
}) {
  const Icon = iconMap[icon as keyof typeof iconMap] ?? BriefcaseBusiness;
  return (
    <span className="scene-icon" style={{ color, background: `${color}19` }}>
      <Icon size={size} />
    </span>
  );
}
export function StatusBadge({ status }: { status: string }) {
  const Icon =
    status === 'running'
      ? LoaderCircle
      : status === 'failed' || status === 'partial'
        ? AlertCircle
        : status === 'launch_requested'
          ? Check
          : Clock3;
  return (
    <span className={`badge status-${status}`}>
      <Icon size={12} className={status === 'running' ? 'spin' : ''} />
      {statusLabel[status] ?? status}
    </span>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-orbit">
        <Sparkles size={27} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function SearchBox({
  value,
  onChange,
  placeholder = '搜索名称…',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="search">
      <Search size={16} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function AddButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button onClick={onClick}>
      <Plus size={17} />
      {label}
    </Button>
  );
}
export function SectionHeader({
  title,
  meta,
  action,
}: {
  title: string;
  meta?: string;
  action?: () => void;
}) {
  return (
    <div className="section-heading">
      <h2>
        {title}
        {meta && <span>{meta}</span>}
      </h2>
      {action && (
        <Button variant="ghost" size="sm" onClick={action}>
          查看全部
          <ArrowUpRight size={15} />
        </Button>
      )}
    </div>
  );
}
export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle-row ${disabled ? 'dim' : ''}`}>
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
