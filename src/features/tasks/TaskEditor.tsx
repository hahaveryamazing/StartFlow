import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { open } from '@tauri-apps/plugin-dialog';
import { Globe, AppWindow, Folder, FolderOpen, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Modal } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { api, errorMessage } from '../../services/api';
import { perform } from '../../stores/app';
import type { Task } from '../../types';
const schema = z
  .object({
    name: z.string().trim().min(1, '请填写任务名称').max(40, '名称最多 40 个字符'),
    kind: z.enum(['web', 'app', 'folder']),
    url: z.string(),
    executable_path: z.string(),
    working_directory: z.string(),
    browser_mode: z.enum(['default', 'custom']),
    browser_path: z.string(),
    delay_seconds: z.number().min(0).max(60),
    enabled: z.boolean(),
    wait_for_network: z.boolean(),
    skip_if_running: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'web') {
      try {
        const u = new URL(v.url);
        if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password)
          throw new Error();
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['url'],
          message: '请输入不含账号密码的完整 http 或 https 网址',
        });
      }
      if (v.browser_mode === 'custom' && !v.browser_path)
        ctx.addIssue({ code: 'custom', path: ['browser_path'], message: '请选择浏览器程序' });
    } else if (!v.executable_path)
      ctx.addIssue({ code: 'custom', path: ['executable_path'], message: '请选择本地路径' });
  });
type Values = z.infer<typeof schema>;
export function TaskEditor({
  task,
  onClose,
  onSaved,
}: {
  task: Task;
  onClose: () => void;
  onSaved?: (t: Task) => Promise<void> | void;
}) {
  const [args, setArgs] = useState(task.arguments);
  const [busy, setBusy] = useState(false);
  const {
    register,
    watch,
    setValue,
    handleSubmit,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { ...task, delay_seconds: task.delay_ms / 1000 },
  });
  const kind = watch('kind');
  const browser = watch('browser_mode');
  const pick = async (
    field: 'executable_path' | 'working_directory' | 'browser_path',
    directory = false,
  ) => {
    try {
      const selected = await open({
        directory,
        multiple: false,
        title: directory ? '选择文件夹' : '选择程序',
        filters: directory
          ? undefined
          : [
              {
                name: 'Windows 程序',
                extensions: field === 'browser_path' ? ['exe'] : ['exe', 'lnk'],
              },
            ],
      });
      if (typeof selected === 'string') setValue(field, selected, { shouldValidate: true });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const submit = handleSubmit(async (values) => {
    setBusy(true);
    const { delay_seconds, ...fields } = values;
    const saved: Task = {
      ...task,
      ...fields,
      arguments: args,
      delay_ms: Math.round(delay_seconds * 1000),
    };
    if (await perform(() => api.saveTask(saved), '任务已保存')) {
      await onSaved?.(saved);
      onClose();
    }
    setBusy(false);
  });
  return (
    <Modal
      title={task.name ? '编辑任务' : '添加启动任务'}
      description="网页、应用程序或文件夹，都可以成为工作场景的一部分。"
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form onSubmit={submit}>
        <div className="form-body">
          <div className="segmented">
            {(
              [
                { value: 'web', label: '网页', Icon: Globe },
                { value: 'app', label: '应用程序', Icon: AppWindow },
                { value: 'folder', label: '文件夹', Icon: Folder },
              ] as const
            ).map(({ value, label, Icon }) => (
              <Button
                key={value}
                variant="ghost"
                className={kind === value ? 'selected' : ''}
                onClick={() => setValue('kind', value)}
              >
                <Icon size={17} />
                {label}
              </Button>
            ))}
          </div>
          <label className="field">
            任务名称
            <input autoFocus placeholder="例如：工作邮箱" {...register('name')} />
            {errors.name && <small className="error-text">{errors.name.message}</small>}
          </label>
          {kind === 'web' ? (
            <>
              <label className="field">
                目标网址
                <input placeholder="https://www.bing.com" {...register('url')} />
                {errors.url && <small className="error-text">{errors.url.message}</small>}
              </label>
              <label className="field">
                打开方式
                <select {...register('browser_mode')}>
                  <option value="default">系统默认浏览器</option>
                  <option value="custom">指定浏览器</option>
                </select>
              </label>
              {browser === 'custom' && (
                <label className="field">
                  浏览器程序
                  <div className="input-action">
                    <input placeholder="浏览器 EXE 完整路径" {...register('browser_path')} />
                    <Button variant="secondary" onClick={() => void pick('browser_path')}>
                      <FolderOpen size={16} />
                      选择
                    </Button>
                  </div>
                  {errors.browser_path && (
                    <small className="error-text">{errors.browser_path.message}</small>
                  )}
                </label>
              )}
              <label className="check">
                <input type="checkbox" {...register('wait_for_network')} />
                等待网络接口可用（最多 30 秒）
              </label>
            </>
          ) : (
            <>
              <label className="field">
                {kind === 'folder' ? '文件夹路径' : '程序或快捷方式'}
                <div className="input-action">
                  <input
                    placeholder={kind === 'folder' ? '选择本地文件夹' : '选择 EXE 或 LNK'}
                    {...register('executable_path')}
                  />
                  <Button
                    variant="secondary"
                    onClick={() => void pick('executable_path', kind === 'folder')}
                  >
                    <FolderOpen size={16} />
                    选择
                  </Button>
                </div>
                {errors.executable_path && (
                  <small className="error-text">{errors.executable_path.message}</small>
                )}
              </label>
              {kind === 'app' && (
                <>
                  <div className="field">
                    启动参数<span className="hint">每项填写一个独立参数，无需额外添加引号。</span>
                    {args.map((a, i) => (
                      <div className="input-action" key={i}>
                        <input
                          aria-label={`参数 ${i + 1}`}
                          value={a}
                          onChange={(e) =>
                            setArgs(args.map((v, j) => (j === i ? e.target.value : v)))
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`删除参数 ${i + 1}`}
                          onClick={() => setArgs(args.filter((_, j) => j !== i))}
                        >
                          <X size={16} />
                        </Button>
                      </div>
                    ))}
                    <Button variant="secondary" size="sm" onClick={() => setArgs([...args, ''])}>
                      <Plus size={14} />
                      添加参数
                    </Button>
                  </div>
                  <label className="field">
                    工作目录（可选）
                    <div className="input-action">
                      <input {...register('working_directory')} />
                      <Button
                        variant="secondary"
                        onClick={() => void pick('working_directory', true)}
                      >
                        选择
                      </Button>
                    </div>
                  </label>
                  <label className="check">
                    <input type="checkbox" {...register('skip_if_running')} />
                    同一路径的程序已运行时跳过
                  </label>
                  <p className="hint">快捷方式无法可靠匹配目标进程；权限受限的进程可能无法检测。</p>
                </>
              )}
            </>
          )}
          <div className="form-grid">
            <label className="field">
              启动前延迟（秒）
              <input
                type="number"
                min="0"
                max="60"
                step="0.1"
                {...register('delay_seconds', { valueAsNumber: true })}
              />
              {errors.delay_seconds && <small className="error-text">延迟应为 0～60 秒</small>}
            </label>
            <label className="check">
              <input type="checkbox" {...register('enabled')} />
              启用此任务
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button type="submit" loading={busy}>
            保存任务
          </Button>
        </div>
      </form>
    </Modal>
  );
}
