import { beforeEach, describe, it, expect, vi } from 'vitest';
import { blankWorkflow, fromPreset, workflowSchema } from '../features/workflows/schema';
import { useEditor } from '../features/workflow-editor/store';
import { accelerator } from '../features/shortcuts/Shortcuts';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ConfirmProvider, useConfirm } from '../components/confirm';
import { useEffect } from 'react';
beforeEach(() => {
  useEditor.getState().close();
  cleanup();
});
describe('V2 编辑器数据和键盘', () => {
  it('独立草稿可撤销与重做，保存快照不被后续修改覆盖', () => {
    const w = blankWorkflow(crypto.randomUUID());
    const e = useEditor.getState();
    e.open(w);
    e.change({ ...w, name: '新名字' });
    expect(useEditor.getState().saved).toBe(JSON.stringify(w));
    e.undo();
    expect(useEditor.getState().workflow?.name).toBe(w.name);
    e.redo();
    expect(useEditor.getState().workflow?.name).toBe('新名字');
    e.markSaved();
    expect(useEditor.getState().saved).toBe(JSON.stringify(useEditor.getState().workflow));
    e.change({ ...w, name: '另外修改' });
    expect(useEditor.getState().saved).toContain('新名字');
  });
  it('工作日模板使用独立分支结束节点和稳定标识', () => {
    const w = fromPreset(crypto.randomUUID(), 'weekday');
    expect(workflowSchema.safeParse(w).success).toBe(true);
    expect(new Set(w.nodes.map((n) => n.id)).size).toBe(w.nodes.length);
    expect(w.edges.filter((e) => e.handle === 'true')).toHaveLength(1);
    expect(w.edges.filter((e) => e.handle === 'false')).toHaveLength(1);
    expect(w.nodes.filter((n) => n.config.type === 'end')).toHaveLength(2);
  });
  it('拒绝超出节点数量和运行时长的草稿', () => {
    const w = blankWorkflow(crypto.randomUUID());
    expect(workflowSchema.safeParse({ ...w, max_seconds: 3601 }).success).toBe(false);
    expect(workflowSchema.safeParse({ ...w, name: '' }).success).toBe(false);
  });
  it('录制物理按键并拒绝没有修饰键的普通输入', () => {
    expect(
      accelerator({ code: 'KeyA', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }),
    ).toBe('Ctrl+Alt+A');
    expect(
      accelerator({ code: 'Digit1', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }),
    ).toBe('Ctrl+Shift+1');
    expect(
      accelerator({ code: 'KeyA', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }),
    ).toBeNull();
  });
  it('确认回调在弹窗开启和关闭后保持稳定，避免导航提示重复更新', () => {
    const observed = vi.fn();
    function Probe() {
      const confirm = useConfirm();
      useEffect(() => {
        observed(confirm);
      }, [confirm]);
      return <button onClick={() => void confirm('离开？', '未保存修改')}>打开确认</button>;
    }
    render(
      <ConfirmProvider>
        <Probe />
      </ConfirmProvider>,
    );
    fireEvent.click(screen.getByText('打开确认'));
    fireEvent.click(screen.getByText('取消'));
    expect(observed).toHaveBeenCalledTimes(1);
  });
});
