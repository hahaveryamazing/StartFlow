import { useState } from 'react';
import { Palette } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Modal } from '../../components/ui/dialog';

const colors = [
  '#3b82f6',
  '#2563eb',
  '#06b6d4',
  '#14b8a6',
  '#22c55e',
  '#84cc16',
  '#eab308',
  '#f97316',
  '#ef4444',
  '#ec4899',
  '#a78bfa',
  '#8b92a5',
];
const valid = (value: string) => /^#[\da-f]{6}$/i.test(value);

export function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [lastValid, setLastValid] = useState(value);
  const select = (color: string) => {
    setDraft(color);
    if (valid(color)) {
      setLastValid(color);
      onChange(color);
    }
  };
  const close = () => {
    setOpen(false);
  };
  return (
    <>
      <Button
        variant="secondary"
        aria-label="选择主题强调色"
        onClick={() => {
          setDraft(value);
          setLastValid(value);
          setOpen(true);
        }}
      >
        <span className="color-swatch" style={{ background: value }} aria-hidden="true" />
        <Palette size={16} />
        选择颜色
      </Button>
      {open && (
        <Modal
          open
          title="选择主题强调色"
          description="选择色块或调整滑杆即可预览。完成后保存设置，重启也会保留。"
          onClose={close}
        >
          <div className="form-body">
            <div className="accent-palette" aria-label="常用颜色">
              {colors.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`颜色 ${color}`}
                  aria-pressed={lastValid.toLowerCase() === color}
                  style={{ background: color }}
                  onClick={() => select(color)}
                />
              ))}
            </div>
            <label>
              颜色代码
              <input
                aria-label="颜色代码"
                value={draft}
                maxLength={7}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={!valid(draft)}
                onChange={(e) => select(e.target.value.trim())}
              />
            </label>
            {!valid(draft) && (
              <p className="danger-text" role="alert">
                请输入 # 开头的六位颜色代码，例如 #3b82f6。
              </p>
            )}
            {(['红色', '绿色', '蓝色'] as const).map((name, index) => {
              const channels = [1, 3, 5].map((offset) =>
                parseInt(lastValid.slice(offset, offset + 2), 16),
              );
              return (
                <label key={name}>
                  {name} · {channels[index]}
                  <input
                    type="range"
                    aria-label={`${name}分量`}
                    min={0}
                    max={255}
                    value={channels[index]}
                    onChange={(e) => {
                      channels[index] = Number(e.target.value);
                      select('#' + channels.map((c) => c.toString(16).padStart(2, '0')).join(''));
                    }}
                  />
                </label>
              );
            })}
            <div
              className="accent-preview"
              style={{ background: lastValid }}
              aria-label="颜色预览"
            />
          </div>
          <footer className="modal-footer">
            <Button disabled={!valid(draft)} onClick={close}>
              完成
            </Button>
          </footer>
        </Modal>
      )}
    </>
  );
}
