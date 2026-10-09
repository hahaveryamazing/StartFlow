use super::{models::*, repository, runtime};
use crate::{
    accounts,
    database::Db,
    error::{AppError, Result},
};
use tauri::Manager;
#[derive(serde::Serialize)]
pub struct Snapshot {
    configs: Vec<LoginConfig>,
    runs: Vec<LoginRun>,
    active_runs: Vec<String>,
    runtime_ready: bool,
}
#[tauri::command]
pub async fn web_login_snapshot(window: tauri::WebviewWindow) -> Result<Snapshot> {
    accounts::commands::authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let active_runs = runtime::active(&app)?;
        let db = app.state::<Db>();
        let g = db.lock()?;
        Ok(Snapshot {
            configs: repository::configs(&g.conn)?,
            runs: repository::runs_with_active(&g.conn, &active_runs)?,
            active_runs,
            runtime_ready: runtime::runtime(&app).is_ok(),
        })
    })
    .await
    .map_err(|_| AppError::new("login", "网页登录服务暂不可用。"))?
}
#[tauri::command]
pub async fn web_login_save(window: tauri::WebviewWindow, config: LoginConfig) -> Result<()> {
    accounts::commands::authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let g = db.lock()?;
        let account = accounts::repository::find(&g.conn, &config.account_id)?;
        config.validate(&account)?;
        repository::save(&g.conn, &config)
    })
    .await
    .map_err(|_| AppError::new("login", "网页登录配置未保存。"))?
}
#[tauri::command]
pub async fn web_login_delete(window: tauri::WebviewWindow, id: String) -> Result<()> {
    accounts::commands::authorize(&window)?;
    crate::models::validate_id(&id)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let active_runs = runtime::active(&app)?;
        let db = app.state::<Db>();
        let g = db.lock()?;
        if repository::runs_with_active(&g.conn, &active_runs)?
            .iter()
            .any(|r| r.config_id == id && active_runs.contains(&r.id))
        {
            return Err(AppError::new("login", "请先关闭此配置的专用浏览器。"));
        }
        g.conn
            .execute("DELETE FROM web_login_configs WHERE id=?1", [id])?;
        Ok(())
    })
    .await
    .map_err(|_| AppError::new("login", "删除配置未完成。"))?
}
#[tauri::command]
pub async fn web_login_start(
    window: tauri::WebviewWindow,
    id: String,
    authorized: bool,
) -> Result<LoginRun> {
    accounts::commands::authorize(&window)?;
    crate::models::validate_id(&id)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (config, account) = {
            let db = app.state::<Db>();
            let g = db.lock()?;
            let config = repository::configs(&g.conn)?
                .into_iter()
                .find(|c| c.id == id)
                .ok_or_else(|| AppError::new("login", "登录配置不存在。"))?;
            let account = accounts::repository::find(&g.conn, &config.account_id)?;
            config.validate(&account)?;
            (config, account)
        };
        runtime::start(&app, config, account, authorized)
    })
    .await
    .map_err(|_| AppError::new("login", "专用浏览器启动未完成。"))?
}
#[tauri::command]
pub fn web_login_close(window: tauri::WebviewWindow, id: String) -> Result<()> {
    accounts::commands::authorize(&window)?;
    runtime::close(window.app_handle(), &id)
}
