import { useState, useEffect } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { toast } from 'sonner';
import { v2 } from '../../services/v2';
import { errorMessage } from '../../services/api';
import { useApp, perform } from '../../stores/app';
import { emptyExtension, type Bundle } from '../../types/v2';
import { Button } from '../../components/ui/button';
import { Modal } from '../../components/ui/dialog';
import { useConfirm } from '../../components/confirm';
import { datetime } from '../../utils/format';
const labels: Record<string, string> = {
  upgrade: '升级前数据库',
  manual: '手动配置备份',
  automatic: '自动配置备份',
  before_restore: '恢复前配置备份',
};
export function Backups() {
  const data = useApp((s) => s.data)!;
  const ext = data.v2?.extension ?? emptyExtension;
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [frequency, setFrequency] = useState(ext.theme.backup_frequency);
  const [retention, setRetention] = useState(ext.theme.backup_retention);
  useEffect(() => {
    setFrequency(ext.theme.backup_frequency);
    setRetention(ext.theme.backup_retention);
  }, [ext.theme.backup_frequency, ext.theme.backup_retention]);
  const action = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true);
    await perform(fn, message);
    setBusy(false);
  };
  const importFile = async () => {
    try {
      const path = await open({
        title: '选择 V1 或 V2 配置',
        multiple: false,
        filters: [{ name: 'JSON 配置', extensions: ['json'] }],
      });
      if (typeof path === 'string') {
        setBusy(true);
        setBundle(await v2.readImport(path));
        setMode('merge');
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const exportFile = async () => {
    try {
      const path = await save({
        title: '导出完整 V2 配置',
        defaultPath: 'StartFlow-v2.json',
        filters: [{ name: 'JSON 配置', extensions: ['json'] }],
      });
      if (path) await action(() => v2.export(path), '工作流、布局、快捷键、模板和背景已导出');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const conflicts = bundle
    ? [...bundle.config.scenes.map((x) => x.id), ...bundle.config.tasks.map((x) => x.id)].filter(
        (id) => [...data.config.scenes, ...data.config.tasks].some((x) => x.id === id),
      ).length
    : 0;
  return (
    <section className="settings-panel">
      <h2>配置备份与恢复</h2>
      <p className="hint">
        备份为版本化本地配置。执行历史保留在数据库；升级前 SQLite
        副本包含历史。恢复不会自动执行导入内容。
      </p>
      <div className="inline-fields">
        <select
          aria-label="自动备份频率"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as typeof frequency)}
        >
          <option value="daily">每天备份</option>
          <option value="weekly">每周备份</option>
          <option value="off">关闭自动备份</option>
        </select>
        <input
          aria-label="自动备份保留数量"
          type="number"
          min="1"
          max="30"
          value={retention}
          onChange={(e) => setRetention(+e.target.value)}
        />
        <Button
          disabled={busy}
          onClick={() =>
            void action(
              () =>
                v2.save({
                  ...ext,
                  theme: { ...ext.theme, backup_frequency: frequency, backup_retention: retention },
                }),
              '备份策略已保存',
            )
          }
        >
          保存策略
        </Button>
      </div>
      <div className="data-buttons">
        <Button disabled={busy} onClick={() => void action(v2.backup, '本地备份已创建')}>
          立即备份
        </Button>
        <Button disabled={busy} variant="secondary" onClick={() => void exportFile()}>
          导出完整配置
        </Button>
        <Button disabled={busy} variant="secondary" onClick={() => void importFile()}>
          导入并预览
        </Button>
      </div>
      <div className="backup-list">
        {data.v2?.backups.map((b) => (
          <div className="backup-row" key={b.id}>
            <div className="grow">
              <strong>{labels[b.backup_type] ?? b.backup_type}</strong>
              <small>
                {datetime(b.created_at)} · {(b.size / 1024).toFixed(1)} KB ·{' '}
                {b.status === 'ready' ? '已保存' : '需检查'}
              </small>
            </div>
            <Button
              disabled={busy || b.status !== 'ready'}
              variant="secondary"
              size="sm"
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    setBundle(await v2.readBackup(b.id));
                    setMode('merge');
                  } catch (e) {
                    toast.error(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              恢复预览
            </Button>
            <Button
              disabled={busy}
              variant="ghost"
              size="sm"
              onClick={() =>
                void (async () => {
                  if (await confirm('删除此备份？', '此文件将永久删除，当前配置不受影响。'))
                    await action(() => v2.deleteBackup(b.id), '备份已删除');
                })()
              }
            >
              删除
            </Button>
          </div>
        ))}
      </div>
      {!data.v2?.backups.length && (
        <p className="hint">
          尚无备份。后台会按已保存的策略创建，升级和恢复前的备份不参与自动清理。
        </p>
      )}
      {bundle && (
        <Modal
          title="恢复预览"
          description="格式、版本和引用关系已通过后端验证。请确认导入方式。"
          open
          onClose={() => setBundle(null)}
        >
          <div className="import-stats">
            {[
              ['场景', bundle.config.scenes.length],
              ['任务', bundle.config.tasks.length],
              ['工作流', bundle.extension.workflows.length],
              ['计划', bundle.config.schedules.length],
              ['窗口布局', bundle.extension.layouts.length],
              ['个人模板', bundle.extension.templates.length],
            ].map(([name, count]) => (
              <div key={name}>
                <strong>{count}</strong>
                <span>{name}</span>
              </div>
            ))}
          </div>
          <p className="hint">
            发现 {conflicts}{' '}
            个场景或任务标识冲突。合并会为导入实体分配新标识并重建引用，保留现有主题和快捷键。完整替换会替换配置，运行历史保留。
          </p>
          <label className="setting-select">
            <strong>恢复方式</strong>
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="merge">合并导入</option>
              <option value="replace">完整替换</option>
            </select>
          </label>
          <p className="hint-box">
            恢复前将创建本地备份。恢复后自动调度暂停；导入的快捷键关闭。请检查此电脑上的程序、文件夹和背景路径，然后主动启用自动执行。
          </p>
          <div className="modal-footer">
            <Button variant="secondary" onClick={() => setBundle(null)}>
              取消
            </Button>
            <Button
              loading={busy}
              onClick={() =>
                void (async () => {
                  if (
                    !(await confirm(
                      mode === 'replace' ? '确认完整替换？' : '确认合并导入？',
                      mode === 'replace'
                        ? '当前全部配置将替换为预览内容。请确认已有恢复前备份。'
                        : '导入内容将作为独立实体添加。现有配置保留，自动任务将暂停。',
                    ))
                  )
                    return;
                  if (
                    mode === 'replace' &&
                    !(await confirm(
                      '再次确认替换全部配置',
                      '此操作会删除不在导入文件中的场景、任务和工作流。运行历史保留，可通过备份恢复。',
                    ))
                  )
                    return;
                  setBusy(true);
                  if (
                    await perform(
                      () => v2.apply(bundle, mode),
                      '配置已恢复，请检查路径并主动恢复自动任务',
                    )
                  )
                    setBundle(null);
                  setBusy(false);
                })()
              }
            >
              确认恢复
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
