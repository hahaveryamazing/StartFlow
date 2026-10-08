use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scene {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub color: String,
    pub enabled: bool,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub url: String,
    pub executable_path: String,
    pub arguments: Vec<String>,
    pub working_directory: String,
    pub browser_mode: String,
    pub browser_path: String,
    pub delay_ms: u64,
    pub wait_for_network: bool,
    pub skip_if_running: bool,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SceneTask {
    pub id: String,
    pub scene_id: String,
    pub task_id: String,
    pub sort_order: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schedule {
    pub id: String,
    pub scene_id: String,
    pub trigger_type: String,
    pub time_of_day: String,
    pub weekdays: Vec<u32>,
    pub delay_seconds: u64,
    pub catch_up_minutes: u32,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub theme: String,
    pub accent: String,
    pub animations: bool,
    pub close_to_tray: bool,
    pub notifications: bool,
    pub show_on_autostart: bool,
    pub default_scene_id: Option<String>,
    pub paused: bool,
    pub onboarding_done: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            accent: "#3B82F6".into(),
            animations: true,
            close_to_tray: true,
            notifications: true,
            show_on_autostart: false,
            default_scene_id: None,
            paused: false,
            onboarding_done: false,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub scenes: Vec<Scene>,
    pub tasks: Vec<Task>,
    pub scene_tasks: Vec<SceneTask>,
    pub schedules: Vec<Schedule>,
    pub settings: Settings,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            scenes: vec![],
            tasks: vec![],
            scene_tasks: vec![],
            schedules: vec![],
            settings: Settings::default(),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub scene_id: Option<String>,
    pub scene_name_snapshot: String,
    pub trigger_type: String,
    pub rule_id: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub local_run_date: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Log {
    pub id: String,
    pub run_id: String,
    pub task_id: String,
    pub task_name_snapshot: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub status: String,
    pub message: String,
}
#[derive(Serialize)]
pub struct ScheduleInfo {
    pub id: String,
    pub last_triggered_at: Option<String>,
    pub next_trigger_at: Option<String>,
}
#[derive(Serialize)]
pub struct Snapshot {
    pub config: Config,
    pub runs: Vec<Run>,
    pub logs: Vec<Log>,
    pub active_scenes: Vec<String>,
    pub schedules: Vec<ScheduleInfo>,
    pub autostart_enabled: bool,
    pub data_directory: String,
    pub today_auto_count: i64,
}
#[derive(Serialize)]
pub struct LogPage {
    pub runs: Vec<Run>,
    pub logs: Vec<Log>,
    pub total: i64,
    pub requested: i64,
    pub failed: i64,
    pub skipped: i64,
    pub scene_choices: Vec<(String, String)>,
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn validate_id(s: &str) -> Result<()> {
    uuid::Uuid::parse_str(s)
        .map(|_| ())
        .map_err(|_| AppError::new("validation", "标识格式错误。"))
}
fn text(s: &str, max: usize, required: bool) -> Result<()> {
    if s.len() > max || s.contains('\0') || (required && s.trim().is_empty()) {
        return Err(AppError::new(
            "validation",
            "请填写有效内容，并遵守字段长度限制。",
        ));
    }
    Ok(())
}
fn color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}
pub fn validate_url(s: &str) -> Result<()> {
    let u = url::Url::parse(s)
        .map_err(|_| AppError::new("validation", "请输入完整的 http 或 https 网址。"))?;
    if !["http", "https"].contains(&u.scheme())
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err(AppError::new(
            "validation",
            "仅支持不含账号密码的 http 和 https 网址。",
        ));
    }
    Ok(())
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.scenes.len() > 1000
            || self.tasks.len() > 5000
            || self.scene_tasks.len() > 10000
            || self.schedules.len() > 2000
        {
            return Err(AppError::new("validation", "配置版本或数据数量不受支持。"));
        }
        let mut ids = HashSet::new();
        for s in &self.scenes {
            validate_id(&s.id)?;
            if !ids.insert(&s.id) {
                return Err(AppError::new("validation", "场景 ID 重复。"));
            }
            text(&s.name, 120, true)?;
            text(&s.description, 2000, false)?;
            if !color(&s.color)
                || ![
                    "briefcase",
                    "coffee",
                    "video",
                    "gamepad",
                    "book",
                    "sparkles",
                    "folder",
                    "globe",
                ]
                .contains(&s.icon.as_str())
            {
                return Err(AppError::new("validation", "场景图标或颜色无效。"));
            }
        }
        let scene_ids = ids.clone();
        ids.clear();
        for t in &self.tasks {
            validate_id(&t.id)?;
            if !ids.insert(&t.id) {
                return Err(AppError::new("validation", "任务 ID 重复。"));
            }
            text(&t.name, 120, true)?;
            for value in [
                &t.url,
                &t.executable_path,
                &t.working_directory,
                &t.browser_path,
            ] {
                text(value, 4096, false)?;
            }
            if t.delay_ms > 60000
                || t.arguments.len() > 128
                || t.arguments
                    .iter()
                    .any(|a| a.len() > 4096 || a.contains('\0'))
            {
                return Err(AppError::new(
                    "validation",
                    "延迟应为 0～60 秒，启动参数过长或无效。",
                ));
            }
            match t.kind.as_str() {
                "web" => {
                    validate_url(&t.url)?;
                    if !["default", "custom"].contains(&t.browser_mode.as_str()) {
                        return Err(AppError::new("validation", "浏览器选项无效。"));
                    }
                    if t.browser_mode == "custom" {
                        validate_program(&t.browser_path, false)?;
                    }
                }
                "app" => {
                    validate_program(&t.executable_path, true)?;
                    if !t.working_directory.is_empty() {
                        validate_path(&t.working_directory)?;
                    }
                }
                "folder" => {
                    validate_path(&t.executable_path)?;
                }
                _ => return Err(AppError::new("validation", "不支持的任务类型。")),
            }
        }
        let task_ids = ids.clone();
        ids.clear();
        let mut links = HashSet::new();
        for a in &self.scene_tasks {
            validate_id(&a.id)?;
            if !ids.insert(&a.id)
                || !scene_ids.contains(&a.scene_id)
                || !task_ids.contains(&a.task_id)
                || !links.insert((&a.scene_id, &a.task_id))
            {
                return Err(AppError::new("validation", "场景任务关联无效或重复。"));
            }
        }
        ids.clear();
        for s in &self.schedules {
            validate_id(&s.id)?;
            if !ids.insert(&s.id)
                || !scene_ids.contains(&s.scene_id)
                || !["login", "daily", "weekly"].contains(&s.trigger_type.as_str())
                || s.delay_seconds > 120
                || ![0, 30, 120].contains(&s.catch_up_minutes)
            {
                return Err(AppError::new("validation", "调度规则无效。"));
            }
            if s.trigger_type != "login"
                && (s.time_of_day.len() != 5
                    || chrono::NaiveTime::parse_from_str(&s.time_of_day, "%H:%M").is_err())
            {
                return Err(AppError::new("validation", "时间应采用 HH:mm 格式。"));
            }
            if s.weekdays.iter().any(|d| *d < 1 || *d > 7)
                || (s.trigger_type == "weekly" && s.weekdays.is_empty())
            {
                return Err(AppError::new("validation", "请至少选择一个有效星期。"));
            }
        }
        if !["dark", "light", "system"].contains(&self.settings.theme.as_str())
            || !color(&self.settings.accent)
            || self
                .settings
                .default_scene_id
                .as_ref()
                .is_some_and(|id| !scene_ids.contains(id))
        {
            return Err(AppError::new("validation", "设置格式或默认场景无效。"));
        }
        for stamp in self
            .scenes
            .iter()
            .flat_map(|s| [&s.created_at, &s.updated_at])
            .chain(
                self.tasks
                    .iter()
                    .flat_map(|s| [&s.created_at, &s.updated_at]),
            )
            .chain(
                self.schedules
                    .iter()
                    .flat_map(|s| [&s.created_at, &s.updated_at]),
            )
        {
            if chrono::DateTime::parse_from_rfc3339(stamp).is_err() {
                return Err(AppError::new("validation", "配置中的日期无效。"));
            }
        }
        Ok(())
    }
}
pub fn validate_path(path: &str) -> Result<()> {
    if path.contains('\0') || !std::path::Path::new(path).is_absolute() || path.starts_with("\\\\")
    {
        return Err(AppError::new(
            "validation",
            "请选择本机的完整路径，不支持网络共享或设备路径。",
        ));
    }
    Ok(())
}
pub fn validate_program(path: &str, lnk: bool) -> Result<()> {
    validate_path(path)?;
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "exe" && !(lnk && ext == "lnk") {
        return Err(AppError::new(
            "validation",
            "仅支持 EXE 程序和 LNK 快捷方式。",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn url_security() {
        for s in [
            "file:///C:/a",
            "javascript:alert(1)",
            "https://user:pass@example.com",
            "bing.com",
        ] {
            assert!(validate_url(s).is_err());
        }
        assert!(validate_url("https://www.bing.com").is_ok());
    }
    #[test]
    fn invalid_settings_rejected() {
        let mut c = Config::default();
        c.settings.accent = "red".into();
        assert!(c.validate().is_err());
    }
    #[test]
    fn unknown_import_fields_rejected() {
        assert!(serde_json::from_str::<Config>(r#"{"version":1,"script":"evil"}"#).is_err());
    }
    #[test]
    fn script_paths_rejected() {
        assert!(validate_program("C:\\x.cmd", true).is_err());
        assert!(validate_program("relative.exe", true).is_err());
    }
}
