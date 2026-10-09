use crate::{
    context::{Availability, Field, ProcessState, Snapshot},
    rules::models::{Condition, Config, Expression},
};
use std::collections::{BTreeMap, BTreeSet};
pub fn selected(config: &Config) -> (BTreeSet<String>, BTreeSet<String>) {
    fn walk(n: &Condition, processes: &mut BTreeSet<String>, services: &mut BTreeSet<String>) {
        if !n.enabled {
            return;
        }
        match &n.expression {
            Expression::Group { children, .. } => {
                for c in children {
                    walk(c, processes, services)
                }
            }
            Expression::Process { task_id, .. } => {
                processes.insert(task_id.clone());
            }
            Expression::Service { url } => {
                services.insert(url.clone());
            }
            _ => {}
        }
    }
    let mut processes = BTreeSet::new();
    let mut services = BTreeSet::new();
    for r in config.rules.iter().filter(|r| r.enabled) {
        walk(&r.condition, &mut processes, &mut services);
    }
    (processes, services)
}
pub fn capture(c: &Config, legacy: &crate::models::Config, session: &str) -> Snapshot {
    let mut snapshot = Snapshot {
        captured_at: chrono::Local::now().to_rfc3339(),
        ..Snapshot::default()
    };
    #[cfg(windows)]
    {
        let (connected, kind) = super::windows::network();
        snapshot.network_connected = connected;
        snapshot.network_type = kind;
        if c.permissions.displays {
            snapshot.displays = super::windows::displays();
        }
        if c.permissions.power {
            let (source, battery) = super::windows::power();
            snapshot.power_source = source;
            snapshot.battery_percentage = battery;
        }
        if c.permissions.session {
            snapshot.session = if session == "unknown" {
                Field::absent(Availability::Unavailable, "会话事件订阅状态无法确定。")
            } else {
                Field::available(session.to_owned())
            };
        }
        if c.permissions.wifi {
            snapshot.wifi_ssid = super::windows::wifi();
            snapshot.wifi_network_id = match &snapshot.wifi_ssid.value {
                Some(ssid) => {
                    let mut found = None;
                    let mut denied = false;
                    for net in &c.networks {
                        match super::windows::unseal(&net.sealed_ssid) {
                            Ok(value) if value == *ssid => found = Some(net.id.clone()),
                            Err(_) => denied = true,
                            _ => {}
                        }
                    }
                    if let Some(id) = found {
                        Field::available(id)
                    } else if denied {
                        Field::absent(
                            Availability::Error,
                            "信任网络无法解密，请在此设备重新配置。",
                        )
                    } else {
                        Field::available(String::new())
                    }
                }
                None => Field::absent(snapshot.wifi_ssid.status, snapshot.wifi_ssid.reason.clone()),
            };
        }
        let (tasks, services) = selected(c);
        if c.permissions.processes && !tasks.is_empty() {
            let selected: Vec<_> = legacy
                .tasks
                .iter()
                .filter(|t| tasks.contains(&t.id) && t.kind == "app")
                .map(|t| (t.id.clone(), t.executable_path.clone()))
                .collect();
            snapshot.processes = super::windows::processes(&selected);
        }
        if c.permissions.services {
            for url in services {
                snapshot.services.insert(
                    url,
                    Field::absent(Availability::Unavailable, "服务探测尚未完成。"),
                );
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (c, legacy, session);
        snapshot.network_connected =
            Field::absent(Availability::Unsupported, "环境检测仅支持 Windows。");
    }
    for (name, enabled, status, reason) in [
        (
            "wifi",
            c.permissions.wifi,
            snapshot.wifi_ssid.status,
            snapshot.wifi_ssid.reason.clone(),
        ),
        (
            "displays",
            c.permissions.displays,
            snapshot.displays.status,
            snapshot.displays.reason.clone(),
        ),
        (
            "power",
            c.permissions.power,
            snapshot.power_source.status,
            snapshot.power_source.reason.clone(),
        ),
        (
            "session",
            c.permissions.session,
            snapshot.session.status,
            snapshot.session.reason.clone(),
        ),
    ] {
        snapshot.capabilities.insert(
            name.into(),
            if enabled {
                if status == Availability::Available {
                    Field::available(true)
                } else {
                    Field::absent(status, reason)
                }
            } else {
                Field::disabled()
            },
        );
    }
    snapshot
}
pub async fn probe_services(snapshot: &mut Snapshot, config: &Config) {
    if !config.permissions.services {
        return;
    }
    // At most eight probes per capture, each bounded; an outer evaluation deadline remains enforced.
    let urls: Vec<_> = snapshot.services.keys().take(8).cloned().collect();
    for url in urls {
        let field = match crate::conditions::service(&url, 3).await {
            Ok(value) => Field::available(value),
            Err(e) => Field::absent(Availability::Error, e.message),
        };
        snapshot.services.insert(url, field);
    }
}
#[allow(dead_code)]
fn _types(_: BTreeMap<String, ProcessState>) {}
