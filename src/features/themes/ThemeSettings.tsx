import { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useApp, perform } from '../../stores/app';
import { v2 } from '../../services/v2';
import { errorMessage } from '../../services/api';
import { toast } from 'sonner';
import { emptyExtension, type Theme } from '../../types/v2';
import { presets } from './useTheme';
import { Button } from '../../components/ui/button';
export function ThemeSettings() {
  const data = useApp((s) => s.data)!;
  const ext = data.v2?.extension ?? emptyExtension;
  const [draft, setDraft] = useState(ext.theme);
  const [busy, setBusy] = useState(false);
  const stored = JSON.stringify(ext.theme);
  useEffect(() => setDraft(JSON.parse(stored) as Theme), [stored]);
  const set = <K extends keyof Theme>(key: K, value: Theme[K]) =>
    setDraft({ ...draft, [key]: value });
  const choose = async () => {
    try {
      const path = await open({
        title: '选择背景图片（最大 8 MB）',
        multiple: false,
        filters: [{ name: '安全图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (typeof path === 'string') {
        setBusy(true);
        const id = await v2.chooseBackground(path);
        setDraft({ ...draft, background_id: id, background_style: 'image' });
        toast.success('图片已复制到本地数据目录，请保存外观设置');
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-panel">
      <h2>主题与个性化</h2>
      <p className="hint">预设统一调整背景、卡片、边框与悬停色。主色与深浅模式沿用上方外观设置。</p>
      <div className="preset-grid">
        {presets.map((p) => (
          <button
            className={`preset-choice ${draft.preset === p.id ? 'selected' : ''}`}
            key={p.id}
            onClick={() => set('preset', p.id)}
          >
            <div className="preset-swatch" style={{ background: p.dark }}>
              <span style={{ background: p.panel }} />
              <span style={{ background: p.accent }} />
            </div>
            {p.name}
          </button>
        ))}
      </div>
      <div className="form-grid">
        <label>
          圆角程度
          <input
            type="range"
            min="0"
            max="24"
            value={draft.radius}
            onChange={(e) => set('radius', +e.target.value)}
          />
          <small>{draft.radius} 像素</small>
        </label>
        <label>
          界面密度
          <select
            value={draft.density}
            onChange={(e) => set('density', e.target.value as Theme['density'])}
          >
            <option value="comfortable">舒适</option>
            <option value="compact">紧凑</option>
          </select>
        </label>
        <label>
          背景风格
          <select
            value={draft.background_style}
            onChange={(e) => set('background_style', e.target.value as Theme['background_style'])}
          >
            <option value="solid">纯色</option>
            <option value="gradient">柔和渐变</option>
            <option value="image">本地图片</option>
          </select>
        </label>
        <label>
          背景显示方式
          <select
            value={draft.background_fit}
            onChange={(e) => set('background_fit', e.target.value as Theme['background_fit'])}
          >
            <option value="cover">填满</option>
            <option value="contain">完整显示</option>
            <option value="tile">平铺</option>
          </select>
        </label>
        <label>
          背景透明度
          <input
            type="range"
            min="0"
            max="0.8"
            step="0.05"
            value={draft.background_opacity}
            onChange={(e) => set('background_opacity', +e.target.value)}
          />
        </label>
        <label>
          背景模糊
          <input
            type="range"
            min="0"
            max="30"
            value={draft.background_blur}
            onChange={(e) => set('background_blur', +e.target.value)}
          />
        </label>
      </div>
      <div className="data-buttons">
        <Button disabled={busy} variant="secondary" onClick={() => void choose()}>
          选择本地图片
        </Button>
        <Button
          disabled={busy}
          variant="ghost"
          onClick={() =>
            setDraft({
              ...draft,
              background_id: null,
              background_style: 'solid',
              background_opacity: 0.2,
              background_blur: 4,
            })
          }
        >
          恢复默认背景
        </Button>
        <Button
          loading={busy}
          onClick={() =>
            void (async () => {
              setBusy(true);
              await perform(() => v2.save({ ...ext, theme: draft }), '外观设置已保存并生效');
              setBusy(false);
            })()
          }
        >
          保存外观设置
        </Button>
      </div>
      <p className="hint">
        {draft.background_id
          ? '已保存独立图片副本，移动原文件不会影响背景。'
          : '支持 PNG、JPEG、WebP；图片最大 4096 × 4096。'}
      </p>
    </section>
  );
}
