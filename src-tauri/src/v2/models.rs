use crate::{
    models::Config,
    workflow::models::{NodeLog, Workflow, WorkflowRun},
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub scene_id: String,
    pub workflow_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Shortcut {
    pub id: String,
    pub action: String,
    pub target_id: String,
    pub accelerator: String,
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Theme {
    pub preset: String,
    pub radius: u32,
    pub density: String,
    pub background_style: String,
    pub background_id: Option<String>,
    pub background_opacity: f64,
    pub background_blur: u32,
    pub background_fit: String,
    pub backup_frequency: String,
    pub backup_retention: u32,
}
impl Default for Theme {
    fn default() -> Self {
        Self {
            preset: "ocean".into(),
            radius: 14,
            density: "comfortable".into(),
            background_style: "solid".into(),
            background_id: None,
            background_opacity: 0.2,
            background_blur: 4,
            background_fit: "cover".into(),
            backup_frequency: "daily".into(),
            backup_retention: 7,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub workflow: Workflow,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Extension {
    pub workflows: Vec<Workflow>,
    pub bindings: Vec<Binding>,
    pub layouts: Vec<crate::window_manager::Layout>,
    pub shortcuts: Vec<Shortcut>,
    pub theme: Theme,
    pub templates: Vec<Template>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bundle {
    pub application: String,
    pub schema_version: u32,
    pub exported_at: String,
    pub config: Config,
    pub extension: Extension,
    #[serde(default)]
    pub assets: Vec<BackgroundAsset>,
    #[serde(default)]
    pub automation: Option<crate::rules::models::Config>,
    #[serde(default)]
    pub ai: Option<crate::ai::Settings>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackgroundAsset {
    pub id: String,
    pub data: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupRecord {
    pub id: String,
    pub filename: String,
    pub backup_type: String,
    pub created_at: String,
    pub size: u64,
    pub status: String,
}
#[derive(Serialize)]
pub struct V2Snapshot {
    pub extension: Extension,
    pub node_logs: Vec<NodeLog>,
    pub workflow_runs: Vec<WorkflowRun>,
    pub backups: Vec<BackupRecord>,
    pub shortcut_errors: Vec<(String, String)>,
}
