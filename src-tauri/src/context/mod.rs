use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Available,
    Unavailable,
    PermissionDenied,
    Unsupported,
    Error,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Field<T> {
    pub status: Availability,
    pub value: Option<T>,
    pub reason: String,
}
impl<T> Field<T> {
    pub fn available(value: T) -> Self {
        Self {
            status: Availability::Available,
            value: Some(value),
            reason: String::new(),
        }
    }
    pub fn absent(status: Availability, reason: impl Into<String>) -> Self {
        Self {
            status,
            value: None,
            reason: reason.into(),
        }
    }
    pub fn disabled() -> Self {
        Self::absent(Availability::Unavailable, "此项环境感知未开启。")
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Display {
    pub id: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
    pub scale: f64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessState {
    pub running: Field<bool>,
    pub window: Field<bool>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub id: String,
    pub schema_version: u32,
    pub captured_at: String,
    pub network_connected: Field<bool>,
    pub network_type: Field<String>,
    pub wifi_ssid: Field<String>,
    pub wifi_network_id: Field<String>,
    pub displays: Field<Vec<Display>>,
    pub power_source: Field<String>,
    pub battery_percentage: Field<u8>,
    pub session: Field<String>,
    pub processes: BTreeMap<String, ProcessState>,
    pub services: BTreeMap<String, Field<bool>>,
    pub capabilities: BTreeMap<String, Field<bool>>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            id: crate::models::id(),
            schema_version: 1,
            captured_at: crate::models::now(),
            network_connected: Field::disabled(),
            network_type: Field::disabled(),
            wifi_ssid: Field::disabled(),
            wifi_network_id: Field::disabled(),
            displays: Field::disabled(),
            power_source: Field::disabled(),
            battery_percentage: Field::disabled(),
            session: Field::disabled(),
            processes: BTreeMap::new(),
            services: BTreeMap::new(),
            capabilities: BTreeMap::new(),
        }
    }
}
impl Snapshot {
    pub fn permitted(&self, p: &crate::rules::models::Permissions) -> Self {
        let mut s = self.clone();
        if !p.wifi {
            s.wifi_ssid = Field::disabled();
            s.wifi_network_id = Field::disabled();
        }
        if !p.displays {
            s.displays = Field::disabled();
        }
        if !p.power {
            s.power_source = Field::disabled();
            s.battery_percentage = Field::disabled();
        }
        if !p.session {
            s.session = Field::disabled();
        }
        if !p.processes {
            s.processes.clear();
        }
        if !p.services {
            s.services.clear();
        }
        s
    }
    pub fn redacted(&self) -> Self {
        let mut result = self.clone();
        result.wifi_ssid = Field::absent(
            Availability::Unavailable,
            "历史只保存信任网络标识，不保存精确 SSID。",
        );
        // Paths in summaries are stable configured task IDs, not a process activity history.
        result
    }
    pub fn fingerprint(&self) -> String {
        use std::hash::{Hash, Hasher};
        let mut state = self.redacted();
        state.id.clear();
        state.captured_at.clear();
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        // Only local event identities use this hash; never a security or credential primitive.
        if let Ok(json) = serde_json::to_string(&state) {
            json.hash(&mut hash);
        }
        format!("{:016x}", hash.finish())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn privacy_and_state_identity() {
        let a = Snapshot {
            wifi_ssid: Field::available("private-network".into()),
            ..Snapshot::default()
        };
        let mut b = a.clone();
        b.id = crate::models::id();
        b.captured_at = "later".into();
        assert_eq!(a.fingerprint(), b.fingerprint());
        assert!(!serde_json::to_string(&a.redacted())
            .unwrap()
            .contains("private-network"));
        b.power_source = Field::available("ac".into());
        assert_ne!(a.fingerprint(), b.fingerprint());
    }
}
