use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workflow {
    pub id: String,
    pub scene_id: String,
    pub name: String,
    pub description: String,
    pub schema_version: u32,
    pub enabled: bool,
    pub max_seconds: u32,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub id: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub config: NodeConfig,
    pub on_error: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum NodeConfig {
    Start,
    End,
    Web {
        task_id: String,
    },
    App {
        task_id: String,
    },
    Folder {
        task_id: String,
    },
    Delay {
        milliseconds: u64,
    },
    Condition {
        mode: String,
        conditions: Vec<Condition>,
    },
    Network {
        mode: String,
        url: String,
        timeout_seconds: u32,
    },
    Layout {
        layout_id: String,
        timeout_seconds: u32,
    },
    Notification {
        title: String,
        body: String,
        level: String,
    },
    Scene {
        scene_id: String,
    },
}
impl NodeConfig {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::End => "end",
            Self::Web { .. } => "web",
            Self::App { .. } => "app",
            Self::Folder { .. } => "folder",
            Self::Delay { .. } => "delay",
            Self::Condition { .. } => "condition",
            Self::Network { .. } => "network",
            Self::Layout { .. } => "layout",
            Self::Notification { .. } => "notification",
            Self::Scene { .. } => "scene",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Condition {
    Time { start: String, end: String },
    Weekdays { days: Vec<u32> },
    Process { path: String },
    Network,
    Service { url: String, timeout_seconds: u32 },
    File { path: String },
    Folder { path: String },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub handle: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeLog {
    pub id: String,
    pub run_id: String,
    pub node_id: String,
    pub node_name: String,
    pub node_type: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub status: String,
    pub result: serde_json::Value,
    pub error_message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowRun {
    pub run_id: String,
    pub workflow_id: String,
    pub name: String,
}
