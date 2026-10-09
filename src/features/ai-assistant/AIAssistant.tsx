import { useEffect, useState } from 'react';
import { useApp, perform } from '../../stores/app';
import { ai } from '../../services/ai';
import { errorMessage } from '../../services/api';
import { PageHeader, Toggle } from '../../components/common';
import { Button } from '../../components/ui/button';
import { Modal } from '../../components/ui/dialog';
import { useConfirm } from '../../components/confirm';
import { toast } from 'sonner';
import type {
  AIStatus,
  AISettings,
  AIRequest,
  AIPreview,
  AIDraft,
  AIConfiguration,
} from '../../types/ai';
export function AIAssistant() {
  const d = useApp((s) => s.data)!;
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [key, setKey] = useState('');
  const [request, setRequest] = useState<AIRequest>({
    kind: 'rule',
    prompt: '',
    scene_id: d.config.scenes[0]?.id ?? '',
    task_ids: [],
    layout_ids: [],
    rule_id: null,
  });
  const [preview, setPreview] = useState<AIPreview | null>(null);
  const [selected, setSelected] = useState<AIDraft | null>(null);
  const [json, setJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirm = useConfirm();
  const setPage = useApp((s) => s.setPage);
  async function refresh() {
    const next = await ai.status();
    setStatus(next);
    setSettings(next.settings);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(errorMessage(e)));
  }, []);
  async function saveSettings() {
    if (!settings) return;
    setBusy(true);
    try {
      await ai.settings(settings);
      if (key) {
        await ai.key(key);
        setKey('');
      }
      await refresh();
      toast.success('模型设置已保存；凭据只保存在 Windows 凭据管理器。');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function openDraft(draft: AIDraft) {
    setSelected(draft);
    setJson(JSON.stringify(draft.configuration, null, 2));
  }
  return (
    <>
      <PageHeader
        eyebrow="辅助配置 / 用户确认 / 无执行权限"
        title="AI 配置助手"
        description="使用自己的云端服务或已启动的本地兼容模型。助手只创建、解释配置草稿，不能直接启动任务。"
      />
      {error && <p className="error-text">{error}</p>}
      {!settings ? (
        <div className="panel">正在读取本地助手设置…</div>
      ) : (
        <div className="ai-grid">
          <section className="panel ai-provider-form">
            <h2>模型服务</h2>
            <Toggle
              label="启用 AI 配置助手"
              description="默认关闭。关闭时环境感知、规则和调度继续工作。"
              checked={settings.enabled}
              onChange={(enabled) => setSettings({ ...settings, enabled })}
            />
            <p className="hint">
              环境权限中心授权：{d.v3?.config.permissions.ai ? '已允许' : '未允许，需主动开启'}
            </p>
            <Button variant="ghost" size="sm" onClick={() => setPage('settings')}>
              管理 AI 数据授权
            </Button>
            <label>
              Provider 类型
              <select
                value={settings.provider_type}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    provider_type: e.target.value as AISettings['provider_type'],
                  })
                }
              >
                <option value="local">本地兼容模型服务</option>
                <option value="cloud">云端兼容服务</option>
              </select>
            </label>
            <label>
              完整兼容接口地址
              <input
                value={settings.endpoint}
                placeholder="本地回环或 HTTPS 地址，以 /chat/completions 结束"
                onChange={(e) => setSettings({ ...settings, endpoint: e.target.value })}
              />
            </label>
            <label>
              模型名称
              <input
                value={settings.model}
                placeholder="填写实际可用的模型"
                onChange={(e) => setSettings({ ...settings, model: e.target.value })}
              />
            </label>
            <label>
              API Key
              <input
                type="password"
                autoComplete="off"
                value={key}
                placeholder={
                  status?.credential_present
                    ? '已有受保护凭据；留空保留'
                    : '云端需填写自己的凭据，本地服务可选'
                }
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={settings.history}
                onChange={(e) => setSettings({ ...settings, history: e.target.checked })}
              />
              发送最近两份助手草稿作为上下文（预览可见）
            </label>
            <div className="data-buttons">
              <Button loading={busy} onClick={() => void saveSettings()}>
                保存模型设置
              </Button>
              <Button
                variant="ghost"
                disabled={busy || !status?.credential_present}
                onClick={() =>
                  void (async () => {
                    if (
                      !(await confirm(
                        '删除 AI 凭据？',
                        'Windows 凭据管理器中的当前 Provider Key 将被删除，之后需重新配置。',
                      ))
                    )
                      return;
                    try {
                      await ai.deleteKey();
                      await refresh();
                      toast.success('受保护凭据已删除');
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  })()
                }
              >
                删除凭据
              </Button>
            </div>
            <p className="hint">
              Key 不返回页面、不进入 SQLite、JSON、日志或
              LocalStorage。云端没有默认免费服务；本地模型需由用户自行安装和启动。
            </p>
          </section>
          <section className="panel ai-request-form">
            <h2>描述你想配置的工作方式</h2>
            <label>
              辅助类型
              <select
                value={request.kind}
                onChange={(e) =>
                  setRequest({ ...request, kind: e.target.value as AIRequest['kind'] })
                }
              >
                <option value="rule">生成智能规则草稿</option>
                <option value="workflow">生成工作流草稿</option>
                <option value="explanation">解释已有规则</option>
              </select>
            </label>
            <label>
              明确选择的目标场景
              <select
                value={request.scene_id}
                onChange={(e) => setRequest({ ...request, scene_id: e.target.value })}
              >
                <option value="">请先创建一个场景</option>
                {d.config.scenes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {request.kind === 'explanation' && (
              <label>
                需要解释的规则
                <select
                  value={request.rule_id ?? ''}
                  onChange={(e) => setRequest({ ...request, rule_id: e.target.value || null })}
                >
                  <option value="">请选择真实规则</option>
                  {d.v3?.config.rules.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              自然语言需求
              <textarea
                value={request.prompt}
                maxLength={8000}
                rows={5}
                placeholder="例如：工作日早上九点启动已选择的办公场景。未配置应用和网络时，助手会要求补充。"
                onChange={(e) => setRequest({ ...request, prompt: e.target.value })}
              />
            </label>
            <details>
              <summary>明确允许发送的任务和布局名称 / ID</summary>
              <div className="trigger-picker">
                {d.config.tasks.map((t) => (
                  <label key={t.id}>
                    <input
                      type="checkbox"
                      checked={request.task_ids.includes(t.id)}
                      onChange={(e) =>
                        setRequest({
                          ...request,
                          task_ids: e.target.checked
                            ? [...request.task_ids, t.id]
                            : request.task_ids.filter((id) => id !== t.id),
                        })
                      }
                    />
                    {t.name}
                  </label>
                ))}
                {d.v2?.extension.layouts.map((l) => (
                  <label key={l.id}>
                    <input
                      type="checkbox"
                      checked={request.layout_ids.includes(l.id)}
                      onChange={(e) =>
                        setRequest({
                          ...request,
                          layout_ids: e.target.checked
                            ? [...request.layout_ids, l.id]
                            : request.layout_ids.filter((id) => id !== l.id),
                        })
                      }
                    />
                    {l.name}
                  </label>
                ))}
              </div>
            </details>
            <Button
              loading={busy}
              disabled={
                !request.prompt.trim() ||
                !request.scene_id ||
                !status?.settings.enabled ||
                !d.v3?.config.permissions.ai
              }
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    setPreview(await ai.preview(request));
                  } catch (e) {
                    toast.error(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              查看发送预览
            </Button>
            <p className="hint">
              预览确认后才请求实际模型。生成内容还需本地 Schema
              验证和你确认保存；没有点击运行就不会执行。
            </p>
          </section>
        </div>
      )}
      <section className="panel recent-decisions">
        <h2>已生成的本地草稿</h2>
        {status?.drafts.length ? (
          status.drafts.map((draft) => (
            <div className="backup-row" key={draft.id}>
              <span>
                {draft.configuration.type === 'rule'
                  ? '规则'
                  : draft.configuration.type === 'workflow'
                    ? '工作流'
                    : '规则解释'}{' '}
                · {new Date(draft.created_at).toLocaleString('zh-CN')}
                <small className="hint">
                  {draft.provider} · {draft.valid ? '通过静态验证' : '需要补充或修正'}
                </small>
              </span>
              <Button size="sm" variant="secondary" onClick={() => openDraft(draft)}>
                查看并编辑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void (async () => {
                    if (await confirm('删除助手草稿？', '已保存的正式规则和工作流不受影响。')) {
                      try {
                        await ai.remove(draft.id);
                        await refresh();
                        toast.success('草稿已删除');
                      } catch (e) {
                        toast.error(errorMessage(e));
                      }
                    }
                  })()
                }
              >
                删除
              </Button>
            </div>
          ))
        ) : (
          <p className="hint">没有模型调用记录。启用助手需要你自己的服务，当前不会显示模拟回复。</p>
        )}
      </section>
      {preview && (
        <Modal
          open
          wide
          title="AI 数据发送预览"
          description={`${preview.provider_type === 'cloud' ? '云端' : '本地'}服务：${preview.endpoint}`}
          onClose={() => {
            if (!busy) setPreview(null);
          }}
        >
          <p className="hint">{preview.warning}</p>
          <pre className="ai-response">{JSON.stringify(preview.payload, null, 2)}</pre>
          <div className="modal-footer">
            <Button disabled={busy} variant="secondary" onClick={() => setPreview(null)}>
              取消，不发送
            </Button>
            <Button
              loading={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  try {
                    const draft = await ai.generate(preview.token);
                    setPreview(null);
                    await refresh();
                    openDraft(draft);
                    toast.success('实际模型响应已保存为草稿，没有执行任务');
                  } catch (e) {
                    toast.error(errorMessage(e));
                    setPreview(null);
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              同意发送并生成草稿
            </Button>
          </div>
        </Modal>
      )}
      {selected && (
        <Modal
          open
          wide
          title="助手配置草稿"
          description={`${selected.provider} · 仅供配置辅助，实际决策仍由本地规则引擎产生。`}
          onClose={() => setSelected(null)}
        >
          {selected.errors.map((error, index) => (
            <p className="error-text" key={index}>
              {error}
            </p>
          ))}
          {selected.configuration.type === 'explanation' ? (
            <div className="ai-response">{selected.configuration.explanation}</div>
          ) : (
            <>
              <label>
                结构化配置（可编辑；保存时 Rust 再验证）
                <textarea
                  className="ai-response"
                  rows={14}
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                />
              </label>
              <p className="hint">
                正式保存后仍保持规则 /
                工作流停用，不自动绑定、不运行。请在编辑器补充参数，再主动启用。
              </p>
            </>
          )}
          <div className="modal-footer">
            <Button variant="secondary" onClick={() => setSelected(null)}>
              关闭
            </Button>
            {selected.configuration.type !== 'explanation' && (
              <Button
                loading={busy}
                onClick={() =>
                  void (async () => {
                    if (
                      !(await confirm(
                        '确认保存助手配置？',
                        '内容将再经过后端验证，以停用状态写入正式规则或工作流；不会执行。',
                      ))
                    )
                      return;
                    setBusy(true);
                    try {
                      const configuration = JSON.parse(json) as AIConfiguration;
                      if (
                        await perform(
                          () => ai.commit(configuration),
                          '已保存停用配置，请前往编辑器检查',
                        )
                      ) {
                        setSelected(null);
                        await refresh();
                      }
                    } catch (e) {
                      toast.error(errorMessage(e));
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                验证并确认保存
              </Button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
