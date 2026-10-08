import { useState } from 'react';
import {
  PanelsTopLeft,
  Monitor,
  Save,
  RotateCcw,
  Pencil,
  Trash2,
  RefreshCw,
  Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { v2 } from '../../services/v2';
import { errorMessage } from '../../services/api';
import { useApp, perform } from '../../stores/app';
import { PageHeader, Empty, SearchBox } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Modal } from '../../components/ui/dialog';
import { useConfirm } from '../../components/confirm';
import {
  emptyExtension,
  type WindowLayout,
  type WindowInventory,
  type LayoutItem,
  type WindowInfo,
} from '../../types/v2';
import { datetime } from '../../utils/format';
function itemFromWindow(w: WindowInfo, inv: WindowInventory): LayoutItem {
  const m = inv.monitors.find((m) => m.id === w.monitor_id)!;
  const width = m.work.right - m.work.left,
    height = m.work.bottom - m.work.top;
  const x = Math.max(0, Math.min(0.95, (w.rect.left - m.work.left) / width));
  const y = Math.max(0, Math.min(0.95, (w.rect.top - m.work.top) / height));
  return {
    id: crypto.randomUUID(),
    executable_path: w.executable_path,
    title: w.title,
    title_mode:
      inv.windows.filter((x) => x.executable_path.toLowerCase() === w.executable_path.toLowerCase())
        .length > 1
        ? 'exact'
        : 'none',
    monitor_id: w.monitor_id,
    x,
    y,
    width: Math.max(0.05, Math.min(1 - x, (w.rect.right - w.rect.left) / width)),
    height: Math.max(0.05, Math.min(1 - y, (w.rect.bottom - w.rect.top) / height)),
    state: w.maximized ? 'maximized' : 'normal',
  };
}
export function WindowLayouts() {
  const data = useApp((s) => s.data)!;
  const ext = data.v2?.extension ?? emptyExtension;
  const confirm = useConfirm();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [inventory, setInventory] = useState<WindowInventory | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [capture, setCapture] = useState(false);
  const [editing, setEditing] = useState<WindowLayout | null>(null);
  const [name, setName] = useState('我的窗口布局');
  const refresh = async () => {
    setBusy(true);
    try {
      setInventory(await v2.inventory());
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const newCapture = async () => {
    setSelected([]);
    setCapture(true);
    await refresh();
  };
  const updateItem = (id: string, patch: Partial<LayoutItem>) => {
    if (editing)
      setEditing({
        ...editing,
        items: editing.items.map((i) => (i.id === id ? { ...i, ...patch } : i)),
      });
  };
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    const saved = { ...editing, updated_at: new Date().toISOString() };
    if (
      await perform(
        () =>
          v2.save({ ...ext, layouts: [...ext.layouts.filter((l) => l.id !== saved.id), saved] }),
        '布局已保存',
      )
    )
      setEditing(null);
    setBusy(false);
  };
  const rows = ext.layouts.filter((l) => l.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <PageHeader
        eyebrow="WINDOW LAYOUTS"
        title="窗口布局"
        description="保存工作区位置，让启动后的窗口回到合适的位置。"
        action={
          <Button loading={busy} onClick={() => void newCapture()}>
            <Save size={16} />
            保存当前布局
          </Button>
        }
      />
      <div className="hint-box">
        仅管理 Windows
        正常允许移动的窗口。不会绕过权限，也不控制浏览器中的单个标签页。恢复会读取实际窗口位置确认结果。
      </div>
      <div className="list-toolbar">
        <SearchBox value={query} onChange={setQuery} placeholder="搜索窗口布局" />
        <span className="muted">{rows.length} 个布局</span>
      </div>
      {!rows.length ? (
        <Empty
          title="安排好你的工作区"
          description="打开常用桌面程序，选择需要管理的窗口，再保存它们的位置。"
          action={<Button onClick={() => void newCapture()}>捕获当前窗口</Button>}
        />
      ) : (
        <div className="workflow-grid">
          {rows.map((l) => (
            <article className="panel layout-card" key={l.id}>
              <div className="card-top">
                <PanelsTopLeft size={22} />
                <span className="muted">{l.items.length} 个窗口</span>
              </div>
              <h3>{l.name}</h3>
              <LayoutPreview layout={l} />
              <p className="muted">
                {l.scene_id
                  ? `关联 ${data.config.scenes.find((s) => s.id === l.scene_id)?.name}`
                  : '可在工作流中使用'}{' '}
                · {datetime(l.updated_at)}
              </p>
              <div className="scene-actions">
                <Button
                  className="grow"
                  onClick={() =>
                    void perform(() => v2.restoreLayout(l.id), '布局恢复已提交，结果见运行日志')
                  }
                >
                  <RotateCcw size={15} />
                  恢复布局
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label={`编辑布局 ${l.name}`}
                  onClick={() => setEditing(structuredClone(l))}
                >
                  <Pencil size={15} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`删除布局 ${l.name}`}
                  onClick={() =>
                    void (async () => {
                      if (
                        await confirm(
                          '删除此布局？',
                          '引用该布局的工作流需要先修改，原应用窗口不会被关闭。',
                        )
                      )
                        await perform(
                          () =>
                            v2.save({ ...ext, layouts: ext.layouts.filter((x) => x.id !== l.id) }),
                          '布局已删除',
                        );
                    })()
                  }
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      {capture && (
        <Modal
          title="选择需要保存的窗口"
          description="枚举仅在此操作发生时执行；权限受限和系统窗口会被排除。"
          open
          onClose={() => setCapture(false)}
          wide
        >
          <div className="form-body">
            <div className="inline-fields">
              <label className="grow">
                布局名称
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
              </label>
              <Button variant="secondary" loading={busy} onClick={() => void refresh()}>
                <RefreshCw size={15} />
                刷新窗口
              </Button>
            </div>
            {inventory && (
              <>
                <p className="muted">
                  {inventory.monitors.length} 个显示器 · {inventory.windows.length} 个可识别窗口 ·{' '}
                  {inventory.excluded_count} 个受限窗口已排除
                </p>
                <div className="capture-list">
                  {inventory.windows.map((w) => (
                    <label key={w.handle} className="capture-window">
                      <input
                        type="checkbox"
                        checked={selected.includes(w.handle)}
                        onChange={() =>
                          setSelected(
                            selected.includes(w.handle)
                              ? selected.filter((h) => h !== w.handle)
                              : [...selected, w.handle],
                          )
                        }
                      />
                      <div>
                        <strong>{w.title}</strong>
                        <small>{w.executable_path}</small>
                      </div>
                      <Monitor size={17} />
                    </label>
                  ))}
                </div>
              </>
            )}
            {!busy && !inventory && <p className="muted">尚未取得窗口列表，可点击刷新重试。</p>}
          </div>
          <div className="modal-footer">
            <span className="muted">已选择 {selected.length} 个窗口</span>
            <Button
              disabled={!inventory || !selected.length || selected.length > 32 || !name.trim()}
              onClick={() => {
                if (inventory) {
                  const stamp = new Date().toISOString();
                  setEditing({
                    id: crypto.randomUUID(),
                    scene_id: null,
                    name: name.trim(),
                    monitors: inventory.monitors,
                    items: inventory.windows
                      .filter((w) => selected.includes(w.handle))
                      .map((w) => itemFromWindow(w, inventory)),
                    missing_monitor: 'primary',
                    fallback_layout_id: null,
                    created_at: stamp,
                    updated_at: stamp,
                  });
                  setCapture(false);
                }
              }}
            >
              <Check size={15} />
              配置并保存
            </Button>
          </div>
        </Modal>
      )}
      {editing && (
        <Modal
          title="编辑窗口布局"
          description="位置与尺寸以显示器工作区比例保存，适配不同分辨率。"
          open
          onClose={() => setEditing(null)}
          wide
        >
          <div className="form-body">
            <div className="form-grid">
              <label>
                布局名称
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  maxLength={40}
                />
              </label>
              <label>
                关联简单场景
                <select
                  value={editing.scene_id ?? ''}
                  onChange={(e) => setEditing({ ...editing, scene_id: e.target.value || null })}
                >
                  <option value="">仅由工作流或手动恢复</option>
                  {data.config.scenes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                显示器断开时
                <select
                  value={editing.missing_monitor}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      missing_monitor: e.target.value as WindowLayout['missing_monitor'],
                    })
                  }
                >
                  <option value="primary">移动至主显示器</option>
                  <option value="skip">跳过对应窗口</option>
                  <option value="fallback">使用备用布局</option>
                </select>
              </label>
              {editing.missing_monitor === 'fallback' && (
                <label>
                  备用布局
                  <select
                    value={editing.fallback_layout_id ?? ''}
                    onChange={(e) =>
                      setEditing({ ...editing, fallback_layout_id: e.target.value || null })
                    }
                  >
                    <option value="">请选择</option>
                    {ext.layouts
                      .filter((l) => l.id !== editing.id && l.missing_monitor !== 'fallback')
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </div>
            <p className="hint-box">
              关联简单场景后，该场景提交完任务会恢复此布局。高级模式通过显式布局节点控制位置。每个简单场景只能关联一个自动恢复布局。
            </p>
            <LayoutPreview layout={editing} />
            {editing.items.map((item, i) => (
              <div key={item.id} className="layout-item-editor">
                <div className="panel-caption">
                  <strong>
                    {i + 1}. {item.executable_path.split(/[\\/]/).pop()}
                  </strong>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="移除此窗口规则"
                    onClick={() =>
                      setEditing({
                        ...editing,
                        items: editing.items.filter((x) => x.id !== item.id),
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
                <p className="muted path-text">{item.executable_path}</p>
                <div className="form-grid">
                  <label>
                    标题匹配
                    <select
                      value={item.title_mode}
                      onChange={(e) =>
                        updateItem(item.id, {
                          title_mode: e.target.value as LayoutItem['title_mode'],
                        })
                      }
                    >
                      <option value="none">只匹配程序完整路径</option>
                      <option value="contains">标题包含</option>
                      <option value="exact">标题完全一致</option>
                    </select>
                  </label>
                  <label>
                    标题规则
                    <input
                      value={item.title}
                      disabled={item.title_mode === 'none'}
                      onChange={(e) => updateItem(item.id, { title: e.target.value })}
                    />
                  </label>
                  <label>
                    目标显示器
                    <select
                      value={item.monitor_id}
                      onChange={(e) => updateItem(item.id, { monitor_id: e.target.value })}
                    >
                      {editing.monitors.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                          {m.primary ? '（主屏）' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    窗口状态
                    <select
                      value={item.state}
                      onChange={(e) =>
                        updateItem(item.id, { state: e.target.value as LayoutItem['state'] })
                      }
                    >
                      <option value="normal">正常大小</option>
                      <option value="maximized">最大化</option>
                    </select>
                  </label>
                </div>
                <div className="relative-fields">
                  {(['x', 'y', 'width', 'height'] as const).map((key, j) => (
                    <label key={key}>
                      {['左侧', '顶部', '宽度', '高度'][j]} %
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={Math.round(item[key] * 100)}
                        onChange={(e) => updateItem(item.id, { [key]: +e.target.value / 100 })}
                      />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="modal-footer">
            <Button loading={busy} disabled={!editing.items.length} onClick={() => void save()}>
              <Save size={15} />
              保存布局
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function LayoutPreview({ layout }: { layout: WindowLayout }) {
  return (
    <div className="monitor-preview">
      {layout.monitors.map((m) => (
        <div className="monitor-tile" key={m.id}>
          <div className="monitor-screen">
            {layout.items
              .filter((i) => i.monitor_id === m.id)
              .map((i, j) => (
                <div
                  className="monitor-window"
                  key={i.id}
                  style={{
                    left: `${i.x * 100}%`,
                    top: `${i.y * 100}%`,
                    width: `${i.width * 100}%`,
                    height: `${i.height * 100}%`,
                  }}
                >
                  {j + 1}
                </div>
              ))}
          </div>
          <small>
            <Monitor size={12} />
            {m.primary ? '主显示器' : m.name}
          </small>
        </div>
      ))}
    </div>
  );
}
