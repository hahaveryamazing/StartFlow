import { useState } from 'react';
import { GitBranch, ArrowRight, Keyboard, CalendarClock, PanelsTopLeft, Play } from 'lucide-react';
import { useApp, perform } from '../../stores/app';
import { useEditor } from '../workflow-editor/store';
import { Modal } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { useConfirm } from '../../components/confirm';
import { WorkflowPreview } from '../workflows/Preview';
import { v2 } from '../../services/v2';
import { api, errorMessage } from '../../services/api';
import { toast } from 'sonner';
import type { Scene } from '../../types';
import { orderedTasks, triggerLabel } from '../../utils/format';
export function SceneDetails({ scene, onClose }: { scene: Scene; onClose: () => void }) {
  const data = useApp((s) => s.data)!;
  const ext = data.v2?.extension;
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const binding = ext?.bindings.find((b) => b.scene_id === scene.id);
  const workflow = ext?.workflows.find((w) => w.id === binding?.workflow_id);
  const openEditor = async () => {
    setBusy(true);
    try {
      const w = workflow ?? (await v2.convert(scene.id));
      await useApp.getState().refresh();
      useEditor.getState().open(w);
      onClose();
      useApp.getState().setPage('workflows');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={scene.name} description={scene.description} open onClose={onClose} wide>
      <div className="form-body">
        <div className="scene-mode-bar">
          <span className="badge">{workflow ? '高级工作流' : '简单任务列表'}</span>
          <Button variant="secondary" loading={busy} onClick={() => void openEditor()}>
            <GitBranch size={15} />
            {workflow ? '编辑高级工作流' : '创建高级草稿'}
          </Button>
        </div>
        {workflow ? (
          <WorkflowPreview workflow={workflow} />
        ) : (
          <div className="scene-simple-preview">
            {orderedTasks(data.config, scene.id).map((id, i) => (
              <div key={id}>
                <span className="order">{i + 1}</span>
                {data.config.tasks.find((t) => t.id === id)?.name}
                <ArrowRight size={14} />
              </div>
            ))}
          </div>
        )}
        {workflow && (
          <Button
            variant="secondary"
            onClick={() =>
              void (async () => {
                if (
                  ext &&
                  (await confirm(
                    '使用原简单列表？',
                    '不会把分支工作流转换成列表。将恢复保留的原简单任务列表，工作流草稿继续保留。',
                  ))
                )
                  await perform(
                    () =>
                      v2.save({
                        ...ext,
                        bindings: ext.bindings.filter((b) => b.scene_id !== scene.id),
                      }),
                    '已恢复原简单列表',
                  );
              })()
            }
          >
            使用原简单列表
          </Button>
        )}
        <div className="scene-links">
          <h3>
            <PanelsTopLeft size={16} />
            关联布局
          </h3>
          <p>
            {ext?.layouts
              .filter((l) => l.scene_id === scene.id)
              .map((l) => l.name)
              .join('、') || '未关联；高级流程可通过布局节点恢复'}
          </p>
          <h3>
            <Keyboard size={16} />
            快捷键
          </h3>
          <p>
            {ext?.shortcuts
              .filter((s) => s.action === 'scene' && s.target_id === scene.id)
              .map((s) => s.accelerator)
              .join('、') || '尚未配置'}
          </p>
          <h3>
            <CalendarClock size={16} />
            调度规则
          </h3>
          {data.config.schedules
            .filter((s) => s.scene_id === scene.id)
            .map((s) => (
              <p key={s.id}>
                {triggerLabel[s.trigger_type]}{' '}
                {s.trigger_type === 'login' ? `${s.delay_seconds} 秒后` : s.time_of_day} ·{' '}
                {s.enabled ? '启用' : '停用'}
              </p>
            ))}
        </div>
      </div>
      <div className="modal-footer">
        <Button
          onClick={() => void perform(() => api.runScene(scene.id), '场景执行已提交')}
          disabled={data.active_scenes.includes(scene.id)}
        >
          <Play size={15} />
          运行当前模式
        </Button>
      </div>
    </Modal>
  );
}
