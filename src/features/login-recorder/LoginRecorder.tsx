import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MousePointer2, CircleCheck, Play, RotateCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Modal } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { useConfirm } from '../../components/confirm';
import { recorder } from '../../services/recorder';
import { webLogin } from '../../services/web-login';
import { errorMessage } from '../../services/api';
import type { Account } from '../../types/accounts';
import type {
  LocatorField,
  LocatorRule,
  LocatorSet,
  LoginConfig,
  LoginRun,
  Recording,
} from '../../types/web-login';
import {
  draftToConfig,
  fieldNames,
  locatorText,
  matchNames,
  requiredFields,
  initialRules,
} from './model';

export function LoginRecorder({
  account,
  list = [account],
  existing,
  onClose,
  onSaved,
}: {
  account: Account;
  list?: Account[];
  existing?: LoginConfig;
  onClose: () => void;
  onSaved?: () => Promise<void>;
}) {
  const [selected, setSelected] = useState(existing?.account_id ?? account.id);
  const selectedAccount = list.find((a) => a.id === selected) ?? account;
  const [url, setUrl] = useState(existing?.login_url ?? account.target + '/');
  const [name, setName] = useState(existing?.name ?? account.name + ' 登录');
  const [timeout, setTimeout] = useState(existing?.timeout_seconds ?? 30);
  const [record, setRecord] = useState<Recording | null>(null);
  const [rules, setRules] = useState<Partial<LocatorSet>>(initialRules(existing));
  const configId = useRef(existing?.id ?? crypto.randomUUID());
  const [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState('');
  const [saved, setSaved] = useState<string | null>(null),
    [run, setRun] = useState<LoginRun | null>(null);
  const activeId = useRef<string | null>(null),
    previousRules = useRef<Partial<LocatorSet>>({}),
    runId = useRef<string | null>(null);
  const confirm = useConfirm();
  useEffect(() => {
    let live = true;
    const cleanups: (() => void)[] = [];
    void webLogin
      .snapshot()
      .then((s) => {
        if (live) {
          setReady(s.runtime_ready);
          if (!s.runtime_ready) setError('浏览器尚未准备，请先在“网页登录”页面检测或下载浏览器。');
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    void recorder
      .snapshot()
      .then((s) => {
        if (live && s?.active && s.account_id === selected) {
          activeId.current = s.id;
          previousRules.current = s.rules;
          setRecord(s);
          setRules(s.rules);
          setUrl(s.login_url);
        }
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    const update = (s: Recording) => {
      if (!live || s.id !== activeId.current) return;
      const changed = (Object.keys(s.rules) as LocatorField[]).filter(
        (field) => JSON.stringify(previousRules.current[field]) !== JSON.stringify(s.rules[field]),
      );
      previousRules.current = s.rules;
      setRules((current) => {
        const next = { ...current };
        for (const field of changed) next[field] = s.rules[field];
        return next;
      });
      setRecord(s);
      setUrl(s.login_url);
    };
    const register = (promise: Promise<() => void>) => {
      void promise
        .then((fn) => {
          if (live) cleanups.push(fn);
          else fn();
        })
        .catch((e) => {
          if (live) setError(errorMessage(e));
        });
    };
    register(listen<Recording>('web-login-recording', (e) => update(e.payload)));
    register(
      listen<LoginRun>('web-login-status', (e) => {
        if (live && e.payload.id === runId.current) setRun(e.payload);
      }),
    );
    register(
      listen('web-login-browser', () => {
        void webLogin
          .snapshot()
          .then((s) => {
            if (live) setReady(s.runtime_ready);
          })
          .catch(() => {});
      }),
    );
    return () => {
      live = false;
      cleanups.forEach((fn) => fn());
      if (activeId.current) void recorder.close(activeId.current).catch(() => {});
    };
    // One modal lifetime. Selecting another account is disabled while a recording is active.
  }, []);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const send = (command: Parameters<typeof recorder.command>[1]) =>
    void action(async () => {
      if (!record) throw Error('请先打开录制浏览器。');
      await recorder.command(record.id, command);
    });
  const editable =
    !!record?.active && !['starting', 'blocked', 'failed', 'interrupted'].includes(record.status);
  const close = () => {
    if (activeId.current) void recorder.close(activeId.current).catch(() => {});
    onClose();
  };
  return (
    <Modal
      open
      wide
      title="配置网页登录 · 可视化录制"
      description="只选择控件，不录制输入、Cookie、验证码或令牌。录制浏览器与日常浏览器完全分离。"
      onClose={close}
    >
      <div className="recorder-content">
        <div className="recorder-guide">
          <ShieldCheck size={20} />
          <p>
            登录地址必须属于 <strong>{selectedAccount.target}</strong>
            。选择控件的点击不会提交；人工登录时，账号密码仅输入到已验证来源的浏览器页面。
          </p>
        </div>
        {error && (
          <p role="alert" className="account-warning">
            {error}
          </p>
        )}
        <div className="recorder-start">
          <label>
            绑定账号
            <select
              aria-label="录制绑定账号"
              value={selected}
              disabled={!!record?.active || busy}
              onChange={(e) => {
                setSelected(e.target.value);
                const next = list.find((a) => a.id === e.target.value);
                if (next) {
                  setUrl(next.target + '/');
                  setName(next.name + ' 登录');
                  setRecord(null);
                  activeId.current = null;
                  previousRules.current = {};
                  setRules({});
                  setSaved(null);
                }
              }}
            >
              {list
                .filter((a) => a.kind === 'web')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.username}
                  </option>
                ))}
            </select>
          </label>
          <label>
            登录页面地址
            <input
              aria-label="录制网站地址"
              type="url"
              value={url}
              disabled={!!record?.active || busy}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://网站/登录页"
            />
          </label>
          <Button
            loading={busy}
            disabled={!ready || !!record?.active}
            onClick={() =>
              void action(async () => {
                const s = await recorder.start(selected, url);
                activeId.current = s.id;
                previousRules.current = {};
                setRecord(s);
                setSaved(null);
                setRun(null);
              })
            }
          >
            <MousePointer2 size={16} />
            {record ? '重新录制' : '打开录制浏览器'}
          </Button>
          {record?.active && (
            <Button variant="secondary" disabled={busy} onClick={() => send({ type: 'reload' })}>
              <RotateCw size={16} />
              返回登录页
            </Button>
          )}
          {record?.active && (
            <Button
              variant="secondary"
              onClick={() =>
                void action(async () => {
                  await recorder.close(record.id);
                })
              }
            >
              结束录制
            </Button>
          )}
        </div>
        {record && (
          <p
            className={`account-warning ${record.status === 'blocked' ? 'failed' : ''}`}
            role="status"
          >
            {record.message}
          </p>
        )}
        <ol className="recorder-steps">
          <li>
            <b>1 · 选择登录控件</b>
            <span>依次点击下面的选择按钮，再在独立浏览器点选对应控件。</span>
          </li>
          <li>
            <b>2 · 测试登录页定位</b>
            <span>三个控件必须唯一、可见且属于同一个安全表单。</span>
          </li>
          <li>
            <b>3 · 手动登录一次</b>
            <span>通过验证码或其他验证后，选择成功标识及显示账号用户名的元素。</span>
          </li>
          <li>
            <b>4 · 验证并保存</b>
            <span>成功元素与账号身份一起验证；保存后可另外授权一次真实自动登录测试。</span>
          </li>
        </ol>
        <div className="recorder-fields">
          {([...requiredFields, 'challenge', 'failure'] as LocatorField[]).map((field) => {
            const rule = rules[field];
            const result = record?.results[field];
            return (
              <section className="recorder-field" key={field}>
                <div>
                  <strong>{fieldNames[field]}</strong>
                  <small>{locatorText(rule)}</small>
                  {result && (
                    <span className={result === 'ok' ? 'success-text' : 'muted'}>
                      {matchNames[result]}
                    </span>
                  )}
                </div>
                <div className="recorder-field-actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || !editable}
                    onClick={() => send({ type: 'arm', field })}
                  >
                    <MousePointer2 size={14} />
                    选择{fieldNames[field].replace('（可选）', '')}
                  </Button>
                  {rule && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setRules((current) => {
                          const next = { ...current };
                          delete next[field];
                          return next;
                        });
                        setSaved(null);
                      }}
                    >
                      删除定位
                    </Button>
                  )}
                </div>
                {rule && (
                  <div className="recorder-rule-edit">
                    <select
                      aria-label={`${fieldNames[field]}定位方式`}
                      value={rule.kind}
                      disabled={busy}
                      onChange={(e) => {
                        const kind = e.target.value as LocatorRule['kind'];
                        setRules((current) => ({
                          ...current,
                          [field]:
                            kind === 'role'
                              ? { kind, role: field === 'submit' ? 'button' : 'textbox', name: '' }
                              : { kind, value: '' },
                        }));
                        setSaved(null);
                      }}
                    >
                      {[
                        ['role', '角色与名称'],
                        ['label', '关联标签'],
                        ['placeholder', '输入提示'],
                        ['test_id', '测试标识'],
                        ['css', 'CSS 选择器'],
                      ].map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {rule.kind === 'role' && (
                      <select
                        aria-label={`${fieldNames[field]}角色`}
                        value={rule.role}
                        disabled={busy}
                        onChange={(e) => {
                          setRules((current) => ({
                            ...current,
                            [field]: { ...rule, role: e.target.value as typeof rule.role },
                          }));
                          setSaved(null);
                        }}
                      >
                        {['textbox', 'button', 'link', 'heading', 'status'].map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    )}
                    <input
                      aria-label={`${fieldNames[field]}定位内容`}
                      maxLength={256}
                      disabled={busy}
                      value={rule.kind === 'role' ? rule.name : rule.value}
                      onChange={(e) => {
                        setRules((current) => ({
                          ...current,
                          [field]:
                            rule.kind === 'role'
                              ? { ...rule, name: e.target.value }
                              : { ...rule, value: e.target.value },
                        }));
                        setSaved(null);
                      }}
                    />
                  </div>
                )}
              </section>
            );
          })}
        </div>
        <div className="recorder-validation">
          <Button
            disabled={!editable || busy}
            loading={busy}
            variant="secondary"
            onClick={() => send({ type: 'test', rules })}
          >
            <CircleCheck size={16} />
            测试当前页面定位
          </Button>
          <Button
            disabled={!editable || busy || !record?.verified_login}
            variant="secondary"
            onClick={() => send({ type: 'manual' })}
          >
            进入人工登录
          </Button>
          <span>
            登录页：{record?.verified_login ? '已验证' : '待验证'} · 成功与身份：
            {record?.verified_success ? '已验证' : '待验证'}
          </span>
        </div>
        <p className="notice">
          成功标识应是登录后专有的可见元素。账号身份元素的文字必须等于“{selectedAccount.username}
          ”，不能选择密码、验证码输入框或含令牌的内容。当前阶段支持同网站的 HTTPS
          表单登录，跨域单点登录、iframe 和复杂多页登录尚不支持。
        </p>
        <div className="form-grid">
          <label>
            配置名称
            <input
              aria-label="录制配置名称"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(null);
              }}
            />
          </label>
          <label>
            验证超时（秒）
            <input
              aria-label="录制验证超时"
              type="number"
              min={3}
              max={120}
              value={timeout}
              onChange={(e) => {
                setTimeout(Number(e.target.value));
                setSaved(null);
              }}
            />
          </label>
        </div>
        {saved && (
          <p className="success-text">
            配置已保存。测试登录需要单独确认，不会因录制或保存而自动执行。
          </p>
        )}
        {run && (
          <p role="status" className="account-warning">
            测试登录：{run.message}
          </p>
        )}
        <div className="modal-footer">
          <Button variant="secondary" onClick={close}>
            关闭
          </Button>
          <Button
            loading={busy}
            disabled={!record?.verified_login || !record?.verified_success}
            onClick={() =>
              void action(async () => {
                if (!record) return;
                if (
                  existing &&
                  !(await confirm(
                    '替换已有登录配置？',
                    '只替换当前配置的定位与账号绑定，不修改账号密码、场景或工作流。',
                  ))
                )
                  return;
                const config = draftToConfig(
                  selectedAccount,
                  record,
                  rules,
                  name,
                  timeout,
                  existing,
                );
                config.id = configId.current;
                await webLogin.save(config);
                setSaved(config.id);
                toast.success('登录配置已保存');
                await onSaved?.();
              })
            }
          >
            保存登录配置
          </Button>
          <Button
            disabled={!saved || busy}
            onClick={async () => {
              if (
                !saved ||
                !(await confirm(
                  '授权一次真实测试登录？',
                  `将向 ${selectedAccount.target} 使用账号 ${selectedAccount.username} 提交最多一次密码。验证码、扫码、MFA 需人工完成；浏览器会保留该账号的独立会话。`,
                ))
              )
                return;
              void action(async () => {
                if (record?.active) await recorder.close(record.id);
                const result = await webLogin.start(saved, true);
                runId.current = result.id;
                setRun(result);
              });
            }}
          >
            <Play size={16} />
            授权测试登录
          </Button>
          {run && (
            <Button
              variant="secondary"
              onClick={() =>
                void action(async () => {
                  await webLogin.close(run.id);
                })
              }
            >
              关闭测试浏览器
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
