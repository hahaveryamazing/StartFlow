import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, X, Plus } from 'lucide-react';
import { Modal } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { iconMap, iconNames, SceneIcon } from '../../components/common';
import { api } from '../../services/api';
import { useApp, perform } from '../../stores/app';
import { orderedTasks, kindLabel } from '../../utils/format';
import type { Scene, Task } from '../../types';
const schema = z.object({
  name: z.string().trim().min(1, '请填写场景名称').max(40, '名称最多 40 个字符'),
  description: z.string().max(600, '描述最多 600 个字符'),
  icon: z.string(),
  color: z.string().regex(/^#[\da-f]{6}$/i),
  enabled: z.boolean(),
});
function SortableTask({
  task,
  onRemove,
  index,
}: {
  task: Task;
  onRemove: () => void;
  index: number;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      className="sortable-task"
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label={`调整 ${task.name} 顺序`}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={17} />
      </Button>
      <span className="order">{String(index + 1).padStart(2, '0')}</span>
      <span className="grow">
        <strong>{task.name}</strong>
        <small>
          {kindLabel[task.kind]} · 延迟 {task.delay_ms / 1000} 秒{!task.enabled ? ' · 已停用' : ''}
        </small>
      </span>
      <Button variant="ghost" size="icon" aria-label={`移除 ${task.name}`} onClick={onRemove}>
        <X size={15} />
      </Button>
    </div>
  );
}
export function SceneEditor({
  scene,
  onClose,
  onSaved,
}: {
  scene: Scene;
  onClose: () => void;
  onSaved?: (s: Scene) => void;
}) {
  const data = useApp((s) => s.data)!;
  const [ids, setIds] = useState(orderedTasks(data.config, scene.id));
  const [addId, setAddId] = useState('');
  const [busy, setBusy] = useState(false);
  const {
    register,
    watch,
    setValue,
    handleSubmit,
    formState: { errors },
  } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: scene });
  const color = watch('color');
  const icon = watch('icon');
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const submit = handleSubmit(async (fields) => {
    setBusy(true);
    const saved = { ...scene, ...fields };
    if (await perform(() => api.saveScene(saved, ids), '场景已保存')) {
      onSaved?.(saved);
      onClose();
    }
    setBusy(false);
  });
  const drag = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id)
      setIds(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  };
  return (
    <Modal
      title={scene.name ? '编辑启动场景' : '创建启动场景'}
      description="给常用工作内容一个场景，按设定顺序一键打开。"
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form onSubmit={submit}>
        <div className="form-body">
          <div className="scene-preview">
            <SceneIcon icon={icon} color={color} size={28} />
            <div>
              <strong>{watch('name') || '你的新场景'}</strong>
              <small>{ids.length} 项启动任务</small>
            </div>
          </div>
          <label className="field">
            场景名称
            <input autoFocus placeholder="例如：日常办公" {...register('name')} />
            {errors.name && <small className="error-text">{errors.name.message}</small>}
          </label>
          <label className="field">
            场景描述
            <textarea rows={2} placeholder="准备好开始一天的工作" {...register('description')} />
            {errors.description && (
              <small className="error-text">{errors.description.message}</small>
            )}
          </label>
          <div className="form-grid">
            <div className="field">
              场景图标
              <div className="icon-picker">
                {Object.entries(iconMap).map(([key, Icon]) => (
                  <Button
                    key={key}
                    aria-label={`选择图标：${iconNames[key]}`}
                    variant="secondary"
                    size="icon"
                    className={icon === key ? 'selected' : ''}
                    onClick={() => setValue('icon', key)}
                  >
                    <Icon size={19} />
                  </Button>
                ))}
              </div>
            </div>
            <label className="field">
              场景颜色
              <input type="color" {...register('color')} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" {...register('enabled')} />
            启用此场景
          </label>
          <div className="field">
            启动顺序
            <span className="hint">拖动左侧手柄排序；键盘按空格选中、方向键移动、空格确认。</span>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={drag}
              accessibility={{
                screenReaderInstructions: {
                  draggable: '按空格选择任务，用方向键调整顺序，再按空格确认；按 Escape 取消。',
                },
                announcements: {
                  onDragStart: () => '任务已选中，请用方向键调整顺序。',
                  onDragOver: () => '任务位置已调整。',
                  onDragEnd: () => '启动顺序已更新。',
                  onDragCancel: () => '已取消排序。',
                },
              }}
            >
              <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                {ids.map((id, index) => {
                  const task = data.config.tasks.find((t) => t.id === id);
                  return task ? (
                    <SortableTask
                      task={task}
                      key={id}
                      index={index}
                      onRemove={() => setIds(ids.filter((v) => v !== id))}
                    />
                  ) : null;
                })}
              </SortableContext>
            </DndContext>
            {ids.length === 0 && (
              <p className="hint-box">还没有关联任务。先在任务管理添加内容，再在这里加入。</p>
            )}
            <div className="input-action">
              <select
                aria-label="添加已有任务"
                value={addId}
                onChange={(e) => setAddId(e.target.value)}
              >
                <option value="">选择已有任务…</option>
                {data.config.tasks
                  .filter((t) => !ids.includes(t.id))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {kindLabel[t.kind]}
                    </option>
                  ))}
              </select>
              <Button
                variant="secondary"
                disabled={!addId}
                onClick={() => {
                  setIds([...ids, addId]);
                  setAddId('');
                }}
              >
                <Plus size={16} />
                加入场景
              </Button>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" loading={busy}>
            保存场景
          </Button>
        </div>
      </form>
    </Modal>
  );
}
