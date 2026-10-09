import { Wifi, Monitor, Battery, LockKeyhole, ShieldCheck, Activity } from 'lucide-react';
import { useApp, perform } from '../../stores/app';
import { v3 } from '../../services/v3';
import { api } from '../../services/api';
import { Button } from '../../components/ui/button';
import type { Field } from '../../types/v3';
export function fieldText<T>(field: Field<T>, format: (value: T) => string): string {
  return field.status === 'available' && field.value !== null
    ? format(field.value)
    : ((
        {
          unavailable: '不可用',
          permission_denied: '权限受限',
          unsupported: '不适用',
          error: '检测错误',
        } as const
      )[field.status as Exclude<typeof field.status, 'available'>] ?? '未知');
}
export function EnvironmentPanel() {
  const data = useApp((s) => s.data)!;
  const setPage = useApp((s) => s.setPage);
  const a = data.v3;
  if (!a) return null;
  const c = a.context;
  const mode = a.config.modes.find((m) => m.id === a.current_mode);
  return (
    <section className="intelligence-grid">
      <div className="panel intelligence-mode">
        <div className="eyebrow">INTELLIGENT WORKSPACE</div>
        <h2>{mode?.name ?? '智能工作中心'}</h2>
        <p>
          {a.manual_override
            ? `手动覆盖 · ${a.manual_override.expires_at ? new Date(a.manual_override.expires_at).toLocaleString('zh-CN') : '保持到主动取消或指定登录'}`
            : a.config.enabled
              ? '按已授权的环境规则判断'
              : '智能规则尚未开启，原有调度继续工作'}
        </p>
        <div className="data-buttons">
          <Button variant="secondary" onClick={() => setPage('modes')}>
            切换工作模式
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              void perform(
                () => api.saveSettings({ ...data.config.settings, paused: !a.paused }),
                a.paused ? '已恢复自动化' : '已暂停所有自动化',
              )
            }
          >
            {a.paused ? '恢复自动化' : '暂停所有自动化'}
          </Button>
        </div>
        {a.manual_override && (
          <Button variant="ghost" onClick={() => void perform(v3.clearOverride, '手动覆盖已取消')}>
            取消手动覆盖
          </Button>
        )}
      </div>
      <div className="panel">
        <h2>
          <Activity size={18} /> 当前设备环境
        </h2>
        <div className="context-grid">
          {[
            {
              Icon: Wifi,
              label: '本地网络',
              value: fieldText(c.network_connected, (v) => (v ? '已连接' : '未连接')),
              reason: c.network_connected.reason,
            },
            {
              Icon: Monitor,
              label: '显示器',
              value: fieldText(c.displays, (v) => `${v.length} 台`),
              reason: c.displays.reason,
            },
            {
              Icon: Battery,
              label: '供电状态',
              value: fieldText(c.power_source, (v) => (v === 'ac' ? '外接电源' : '电池供电')),
              reason: c.power_source.reason,
            },
            {
              Icon: LockKeyhole,
              label: '用户会话',
              value: fieldText(
                c.session,
                (v) =>
                  ({ active: '活动会话', locked: '已锁定', disconnected: '已断开' })[v] ?? '未知',
              ),
              reason: c.session.reason,
            },
          ].map(({ Icon, label, value, reason }) => (
            <div className="context-cell" key={label} title={reason}>
              <Icon size={17} />
              <span>
                {label}
                <strong>{value}</strong>
              </span>
            </div>
          ))}
        </div>
        <div className="context-footer">
          <ShieldCheck size={14} />
          <span>
            {a.config.rules.filter((r) => r.enabled).length} 条已启用规则 · Wi-Fi{' '}
            {c.wifi_ssid.status === 'available'
              ? '已授权'
              : c.wifi_ssid.status === 'permission_denied'
                ? 'Windows 权限受限'
                : '未提供'}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setPage('settings')}>
            管理权限
          </Button>
        </div>
        {a.subscription_error && <p className="error-text">{a.subscription_error}</p>}
      </div>
    </section>
  );
}
