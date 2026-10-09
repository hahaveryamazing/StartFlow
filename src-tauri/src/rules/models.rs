use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Match {
    True,
    False,
    Unknown,
    Error,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Login,
    Unlock,
    Resume,
    Network,
    Displays,
    Power,
    Processes,
    Schedule,
    Refresh,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub id: String,
    pub kind: EventKind,
    pub key: String,
    pub occurred_at: String,
    pub schedule_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Condition {
    pub id: String,
    pub enabled: bool,
    pub expression: Expression,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Expression {
    Group {
        operator: String,
        children: Vec<Condition>,
    },
    Network {
        connected: bool,
    },
    Wifi {
        network_id: String,
    },
    Monitors {
        minimum: u32,
        maximum: u32,
    },
    Power {
        source: String,
    },
    Session {
        state: String,
    },
    Weekdays {
        days: Vec<u32>,
    },
    Time {
        start: String,
        end: String,
    },
    Process {
        task_id: String,
        state: String,
    },
    Service {
        url: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub scene_id: String,
    pub workflow_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schedule {
    pub time: String,
    pub days: Vec<u32>,
    pub catch_up_minutes: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub version: u32,
    pub priority: i32,
    pub triggers: Vec<EventKind>,
    pub condition: Condition,
    pub target: Target,
    pub mode_id: Option<String>,
    pub policy: String,
    pub cooldown_seconds: u32,
    pub stability_seconds: u32,
    pub schedule: Option<Schedule>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mode {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub color: String,
    pub enabled: bool,
    pub priority: i32,
    pub exclusive_group: String,
    pub strategy: String,
    pub targets: Vec<Target>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Permissions {
    pub wifi: bool,
    pub displays: bool,
    pub power: bool,
    pub session: bool,
    pub processes: bool,
    pub services: bool,
    pub ai: bool,
}
impl Default for Permissions {
    fn default() -> Self {
        Self {
            wifi: false,
            displays: true,
            power: true,
            session: true,
            processes: false,
            services: false,
            ai: false,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustedNetwork {
    pub id: String,
    pub name: String,
    pub sealed_ssid: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub schema_version: u32,
    pub enabled: bool,
    pub retention_days: u32,
    pub permissions: Permissions,
    pub networks: Vec<TrustedNetwork>,
    pub rules: Vec<Rule>,
    pub modes: Vec<Mode>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            schema_version: 1,
            enabled: false,
            retention_days: 30,
            permissions: Permissions::default(),
            networks: vec![],
            rules: vec![],
            modes: vec![],
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trace {
    pub condition_id: String,
    pub result: Match,
    pub explanation: String,
    pub children: Vec<Trace>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Decision {
    pub id: String,
    pub rule_id: String,
    pub rule_name: String,
    pub rule_version: u32,
    pub snapshot_id: String,
    pub event_id: String,
    pub evaluated_at: String,
    pub match_result: Match,
    pub decision: String,
    pub reasons: Vec<String>,
    pub trace: Trace,
    pub targets: Vec<Target>,
    pub execution_run_ids: Vec<String>,
    pub next_eligible_at: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Override {
    pub id: String,
    pub mode_id: String,
    pub kind: String,
    pub expires_at: Option<String>,
    pub created_at: String,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Inputs {
    pub paused: bool,
    pub active_scenes: std::collections::HashSet<String>,
    pub last_actions: std::collections::HashMap<String, String>,
    pub override_mode: Option<Override>,
    pub stable_seconds: u64,
    pub confirmed_rule: Option<String>,
    pub disabled_scenes: std::collections::HashSet<String>,
    pub disabled_workflows: std::collections::HashSet<String>,
    pub scene_workflows: std::collections::HashMap<String, String>,
}
