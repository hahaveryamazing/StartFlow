import { useState } from 'react';
import { useApp, perform } from '../../stores/app';
import { v3 } from '../../services/v3';
import { Toggle } from '../../components/common';
import { Button } from '../../components/ui/button';
import { useConfirm } from '../../components/confirm';
import type { Permissions } from '../../types/v3';
const capabilities: { key: keyof Permissions; name: string; description: string }[] = [
  {
    key: 'wifi',
    name: 'Wi-Fi 信息检测',
    description:
      '只读取当前连接名称，Windows 可能要求定位权限；不扫描周边、不读密码或 BSSID。默认关闭。',
  },
  {
    key: 'displays',
    name: '显示器信息检测',
    description: '读取显示器数量、排列、分辨率和缩放。此开关不影响手动 V2 窗口布局功能。',
  },
  {
    key: 'power',
    name: '电源状态检测',
    description: '读取电源来源及设备支持的电池信息。无电池明确显示不适用。',
  },
  {
    key: 'session',
    name: '当前用户会话事件',
    description: '订阅当前会话锁定、解锁和恢复事件，不监控其它用户或窗口聚焦。',
  },
  {
    key: 'processes',
    name: '指定应用持续检测',
    description:
      '每 15 秒最多查询已启用规则关联的应用完整路径和窗口。默认关闭，不记录程序使用历史。',
  },
  {
    key: 'services',
    name: '指定 HTTPS 服务探测',
    description:
      '仅对启用规则明确配置的地址发出有超时请求；本地网络接口连接不等同互联网。默认关闭。',
  },
  {
    key: 'ai',
    name: 'AI 服务授权',
    description: '只允许受控配置助手请求，另需配置 Provider 并逐次查看发送预览。默认关闭。',
  },
];
export function Privacy() {
  const a = useApp((s) => s.data?.v3);
  const [name, setName] = useState('');
  const [ssid, setSsid] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  if (!a) return null;
  const c = a.config;
  return (
    <section className="settings-panel">
      <h2>隐私与环境感知</h2>
      <p className="hint">
        应用内开关与 Windows 实际权限分开显示。关闭后不会继续读取相应信息；现有手动工作流不受影响。
      </p>
      {capabilities.map(({ key, name, description }) => (
        <div className="permission-row" key={key}>
          <Toggle
            label={name}
            description={description}
            checked={c.permissions[key]}
            onChange={(enabled) =>
              void (async () => {
                if (
                  enabled &&
                  ['wifi', 'processes', 'services', 'ai'].includes(key) &&
                  !(await confirm(`允许${name}？`, description))
                )
                  return;
                await perform(
                  () => v3.save({ ...c, permissions: { ...c.permissions, [key]: enabled } }),
                  '环境授权已更新',
                );
              })()
            }
          />
          {a.context.capabilities[key] && (
            <small className="hint">
              系统状态：
              {a.context.capabilities[key].status === 'available'
                ? '可用'
                : a.context.capabilities[key].status === 'permission_denied'
                  ? 'Windows 拒绝访问'
                  : a.context.capabilities[key].reason || '未启用'}
            </small>
          )}
        </div>
      ))}
      <div className="form-grid">
        <label>
          信任网络显示名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：办公网络"
          />
        </label>
        <label>
          准确 Wi-Fi 名称（SSID）
          <input
            value={ssid}
            onChange={(e) => setSsid(e.target.value)}
            maxLength={32}
            autoComplete="off"
            placeholder="用户明确输入的当前网络名称"
          />
        </label>
      </div>
      <Button
        loading={busy}
        disabled={!name || !ssid}
        variant="secondary"
        onClick={() =>
          void (async () => {
            setBusy(true);
            if (
              await perform(
                () => v3.trustNetwork(name, ssid),
                '信任网络已由 Windows 用户作用域加密保存',
              )
            ) {
              setName('');
              setSsid('');
            }
            setBusy(false);
          })()
        }
      >
        添加受保护的信任网络
      </Button>
      <p className="hint">
        精确 SSID 使用 Windows DPAPI 保护；换设备需重新填写。历史只记录信任网络 ID。
      </p>
      {c.networks.map((n) => (
        <div className="backup-row" key={n.id}>
          <span>{n.name}</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void (async () => {
                if (await confirm('删除信任网络？', '引用它的规则需先修改，否则后端会拒绝删除。'))
                  await perform(
                    () => v3.save({ ...c, networks: c.networks.filter((x) => x.id !== n.id) }),
                    '信任网络已删除',
                  );
              })()
            }
          >
            删除
          </Button>
        </div>
      ))}
      <label>
        环境历史保留天数
        <select
          value={c.retention_days}
          onChange={(e) =>
            void perform(() => v3.save({ ...c, retention_days: +e.target.value }), '保留期限已保存')
          }
        >
          <option value={7}>7 天</option>
          <option value={30}>30 天</option>
          <option value={90}>90 天</option>
          <option value={365}>365 天</option>
        </select>
      </label>
      <Button
        variant="ghost"
        onClick={() =>
          void (async () => {
            if (
              await confirm(
                '清空环境决策历史？',
                '保留场景、规则、冷却及日期去重；只删除历史摘要。',
              )
            )
              await perform(v3.clearHistory, '环境历史已清空');
          })()
        }
      >
        清空环境历史
      </Button>
    </section>
  );
}
