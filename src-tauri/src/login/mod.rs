pub mod backup;
pub mod history;
pub mod service;
use crate::{
    accounts::repository,
    error::{AppError, Result},
    workflow::models::{NodeConfig, Workflow},
};
use rusqlite::{Connection, OptionalExtension};
use tauri::Manager;

pub fn binding(c: &Connection, target: &str, id: &str) -> Result<serde_json::Value> {
    crate::models::validate_id(id)?;
    let (config, account_id) = match target {
        "web" => {
            let cfg = crate::web_login::repository::configs(c)?
                .into_iter()
                .find(|v| v.id == id)
                .ok_or_else(|| AppError::new("login_config", "网页登录配置不存在，请重新选择。"))?;
            let a = repository::find(c, &cfg.account_id)?;
            cfg.validate(&a)?;
            (serde_json::to_value(cfg)?, a.id)
        }
        "desktop" => {
            let text: Option<String> = c
                .query_row(
                    "SELECT payload FROM desktop_login_configs WHERE id=?1",
                    [id],
                    |r| r.get(0),
                )
                .optional()?;
            let cfg: crate::desktop_login::models::Config =
                serde_json::from_str(&text.ok_or_else(|| {
                    AppError::new("login_config", "桌面登录配置不存在，请重新选择。")
                })?)?;
            let a = repository::find(c, &cfg.account_id)?;
            cfg.validate(&a)?;
            (serde_json::to_value(cfg)?, a.id)
        }
        _ => return Err(AppError::new("login_config", "登录类型无效。")),
    };
    let a = repository::find(c, &account_id)?;
    Ok(
        serde_json::json!({"config":config,"account_id":a.id,"credential_ref":a.credential_ref,"revision":a.revision}),
    )
}
pub fn references(c: &Connection, w: &Workflow) -> Result<()> {
    for n in &w.nodes {
        if let Some((target, id)) = n.config.login_reference() {
            binding(c, target, id)?;
        }
    }
    Ok(())
}
pub fn fingerprint(c: &Connection, w: &Workflow) -> Result<String> {
    let mut bindings = vec![];
    for n in &w.nodes {
        if let Some((target, id)) = n.config.login_reference() {
            bindings.push(binding(c, target, id)?);
        }
    }
    // Exact canonical typed metadata, not a bearer credential. Nothing here can reveal a password.
    let mut semantic = w.clone();
    semantic.created_at.clear();
    semantic.updated_at.clear();
    for n in &mut semantic.nodes {
        n.x = 0.;
        n.y = 0.;
    }
    Ok(serde_json::to_string(
        &serde_json::json!({"workflow":semantic,"bindings":bindings}),
    )?)
}
pub fn granted(c: &Connection, w: &Workflow) -> Result<bool> {
    let saved: Option<String> = c
        .query_row(
            "SELECT binding_json FROM workflow_login_grants WHERE workflow_id=?1",
            [&w.id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(saved.is_some_and(|v| fingerprint(c, w).is_ok_and(|current| v == current)))
}
#[tauri::command]
pub fn login_workflow_authorize(
    window: tauri::WebviewWindow,
    workflow_id: String,
    authorized: bool,
) -> Result<()> {
    crate::accounts::commands::authorize(&window)?;
    crate::models::validate_id(&workflow_id)?;
    let db = window.state::<crate::database::Db>();
    let g = db.lock()?;
    if !g.active.is_empty() {
        return Err(AppError::new("busy", "请先结束运行再修改登录授权。"));
    }
    if !authorized {
        g.conn.execute(
            "DELETE FROM workflow_login_grants WHERE workflow_id=?1",
            [workflow_id],
        )?;
        return Ok(());
    }
    let e = crate::v2::repository::load(&g.conn)?;
    let w = e
        .workflows
        .iter()
        .find(|w| w.id == workflow_id)
        .ok_or_else(|| AppError::new("login_config", "请先保存工作流。"))?;
    if !w
        .nodes
        .iter()
        .any(|n| matches!(n.config, NodeConfig::AutoLogin { .. }))
    {
        return Err(AppError::new("login_config", "此工作流没有自动登录节点。"));
    }
    let value = fingerprint(&g.conn, w)?;
    g.conn.execute("INSERT INTO workflow_login_grants VALUES(?1,?2,?3) ON CONFLICT(workflow_id) DO UPDATE SET binding_json=excluded.binding_json,authorized_at=excluded.authorized_at",rusqlite::params![w.id,value,crate::models::now()])?;
    Ok(())
}
#[tauri::command]
pub fn login_workflow_authorized(
    window: tauri::WebviewWindow,
    workflow_id: String,
) -> Result<bool> {
    crate::accounts::commands::authorize(&window)?;
    let db = window.state::<crate::database::Db>();
    let g = db.lock()?;
    let e = crate::v2::repository::load(&g.conn)?;
    match e.workflows.iter().find(|w| w.id == workflow_id) {
        Some(w) => granted(&g.conn, w),
        None => Ok(false),
    }
}
