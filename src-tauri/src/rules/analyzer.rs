use super::models::*;
use std::collections::HashSet;
#[derive(serde::Serialize)]
pub struct Warning {
    pub rule_ids: Vec<String>,
    pub description: String,
}
pub fn analyze(c: &Config, legacy: &crate::models::Config) -> Vec<Warning> {
    let targets = |r: &Rule| {
        r.mode_id
            .as_ref()
            .and_then(|id| c.modes.iter().find(|m| m.id == *id))
            .map(|m| m.targets.clone())
            .unwrap_or_else(|| vec![r.target.clone()])
    };
    let mut out = vec![];
    for (index, a) in c.rules.iter().enumerate() {
        let at: HashSet<_> = targets(a).into_iter().map(|t| t.scene_id).collect();
        for b in c.rules.iter().skip(index + 1) {
            let bt: HashSet<_> = targets(b).into_iter().map(|t| t.scene_id).collect();
            let shared = !at.is_disjoint(&bt);
            let tasks = |scenes: &HashSet<String>| {
                legacy
                    .scene_tasks
                    .iter()
                    .filter(|x| scenes.contains(&x.scene_id))
                    .map(|x| x.task_id.clone())
                    .collect::<HashSet<_>>()
            };
            if shared || !tasks(&at).is_disjoint(&tasks(&bt)) {
                out.push(Warning{rule_ids:vec![a.id.clone(),b.id.clone()],description:format!("「{}」与「{}」{}；若条件同时满足，可能重复打开同一工作内容。相同场景由协调器去重，共享任务跨场景仍需调整规则。",a.name,b.name,if shared{"关联相同场景"}else{"简单任务列表包含共享任务"})});
            }
            if out.len() >= 100 {
                return out;
            }
        }
        for s in legacy
            .schedules
            .iter()
            .filter(|s| s.enabled && at.contains(&s.scene_id))
        {
            out.push(Warning {
                rule_ids: vec![a.id.clone()],
                description: format!(
                    "「{}」和原有计划关联同一场景（{}）；自动执行继续遵循每个本地自然日一次限制。",
                    a.name,
                    if s.trigger_type == "login" {
                        "登录"
                    } else {
                        "定时"
                    }
                ),
            });
            if out.len() >= 100 {
                return out;
            }
        }
    }
    out
}
#[tauri::command]
pub fn v3_conflicts(app: tauri::AppHandle) -> crate::error::Result<Vec<Warning>> {
    use tauri::Manager;
    let db = app.state::<crate::database::Db>();
    let g = db.lock()?;
    Ok(analyze(
        &crate::automation::repository::load(&g.conn)?,
        &crate::database::config(&g.conn)?,
    ))
}
