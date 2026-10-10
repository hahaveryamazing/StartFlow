use super::{models::*, worker};
use crate::{
    accounts::{models::AccountKind, repository as accounts, Accounts},
    database::Db,
    error::{AppError, Result},
    models::{now, validate_id},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{collections::HashSet, sync::Mutex};
use tauri::{Emitter, Manager};
#[derive(Default)]
pub struct Active(Mutex<HashSet<String>>);
struct Lease<'a>(&'a Active, String);
impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Ok(mut ids) = self.0 .0.lock() {
            ids.remove(&self.1);
        }
    }
}
fn reserve<'a>(active: &'a Active, path: &str) -> Result<Lease<'a>> {
    let key = path.trim_start_matches("\\\\?\\").to_lowercase();
    let mut ids = active
        .0
        .lock()
        .map_err(|_| AppError::new("busy", "登录服务暂时不可用。"))?;
    if !ids.insert(key.clone()) {
        return Err(AppError::new("busy", "此应用正在执行登录，请等待完成。"));
    }
    Ok(Lease(active, key))
}
pub fn claim(c: &Connection, account: &str, time: i64) -> Result<()> {
    validate_id(account)?;
    let changed=c.execute("INSERT INTO desktop_login_attempts(account_id,last_requested_at) VALUES(?1,?2) ON CONFLICT(account_id) DO UPDATE SET last_requested_at=excluded.last_requested_at WHERE desktop_login_attempts.last_requested_at<=?2-300",params![account,time])?;
    if changed == 0 {
        return Err(AppError::new(
            "cooldown",
            "此账号五分钟内已有登录尝试。请人工检查后再试，避免频繁提交。",
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_executable_is_mutually_exclusive_and_lease_releases() {
        let active = Active::default();
        let lease = reserve(&active, "C:\\APP.exe").unwrap();
        assert!(reserve(&active, "c:\\app.EXE").is_err());
        drop(lease);
        assert!(reserve(&active, "c:\\app.exe").is_ok());
    }
}
fn get(c: &Connection, id: &str) -> Result<Config> {
    validate_id(id)?;
    let text: Option<String> = c
        .query_row(
            "SELECT payload FROM desktop_login_configs WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    serde_json::from_str(
        &text.ok_or_else(|| AppError::new("desktop_config", "登录配置已不存在。"))?,
    )
    .map_err(Into::into)
}
fn check_window(a: &crate::accounts::models::Account, w: &Window) -> Result<()> {
    if a.kind != AccountKind::App
        || !same_path(&a.target, &w.executable_path)
        || w.pid == 0
        || w.creation_time.is_empty()
    {
        return Err(AppError::new(
            "wrong_target",
            "请选择此应用账号绑定的真实 EXE 窗口。",
        ));
    }
    Ok(())
}
fn store_run(c: &Connection, r: &Run) -> Result<()> {
    c.execute("INSERT INTO desktop_login_runs VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload",params![r.id,r.account_id,r.result.status,serde_json::to_string(r)?])?;
    c.execute("DELETE FROM desktop_login_runs WHERE rowid NOT IN (SELECT rowid FROM desktop_login_runs ORDER BY rowid DESC LIMIT 200)",[])?;
    Ok(())
}
#[derive(Serialize)]
pub struct Snapshot {
    configs: Vec<Config>,
    runs: Vec<Run>,
}
#[tauri::command]
pub async fn desktop_login_snapshot(window: tauri::WebviewWindow) -> Result<Snapshot> {
    crate::accounts::commands::authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let g = db.lock()?;
        let mut s = g
            .conn
            .prepare("SELECT payload FROM desktop_login_configs ORDER BY rowid DESC")?;
        let configs = s
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect::<Result<_>>()?;
        let mut s = g
            .conn
            .prepare("SELECT payload FROM desktop_login_runs ORDER BY rowid DESC LIMIT 30")?;
        let runs = s
            .query_map([], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect::<Result<_>>()?;
        Ok(Snapshot { configs, runs })
    })
    .await
    .map_err(|_| AppError::new("desktop_login", "无法读取应用登录配置。"))?
}
#[tauri::command]
pub async fn desktop_login_windows(
    window: tauri::WebviewWindow,
    account_id: String,
) -> Result<Response> {
    crate::accounts::commands::authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let a = accounts::find(&db.lock()?.conn, &account_id)?;
        if a.kind != AccountKind::App || !a.target.to_ascii_lowercase().ends_with(".exe") {
            return Err(AppError::new(
                "desktop_config",
                "请绑定实际 EXE 路径；快捷方式不用于识别应用身份。",
            ));
        }
        worker::call(
            Request::Windows {
                executable_path: a.target,
            },
            15,
        )
    })
    .await
    .map_err(|_| AppError::new("desktop_login", "窗口查询失败。"))?
}
#[tauri::command]
pub async fn desktop_login_inspect(
    window: tauri::WebviewWindow,
    account_id: String,
    target: Window,
) -> Result<Response> {
    crate::accounts::commands::authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let a = accounts::find(&db.lock()?.conn, &account_id)?;
        check_window(&a, &target)?;
        worker::call(Request::Inspect { window: target }, 15)
    })
    .await
    .map_err(|_| AppError::new("desktop_login", "控件查询失败。"))?
}
#[tauri::command]
pub async fn desktop_login_test(
    window: tauri::WebviewWindow,
    config: Config,
    target: Window,
) -> Result<Response> {
    crate::accounts::commands::authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let a = accounts::find(&db.lock()?.conn, &config.account_id)?;
        config.validate(&a)?;
        check_window(&a, &target)?;
        worker::call(
            Request::Test {
                window: target,
                config: Box::new(config),
            },
            15,
        )
    })
    .await
    .map_err(|_| AppError::new("desktop_login", "定位测试未完成。"))?
}
#[tauri::command]
pub async fn desktop_login_save(window: tauri::WebviewWindow, config: Config) -> Result<()> {
    crate::accounts::commands::authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move||{let db=app.state::<Db>();let g=db.lock()?;let a=accounts::find(&g.conn,&config.account_id)?;config.validate(&a)?;
        let count:i64=g.conn.query_row("SELECT COUNT(*) FROM desktop_login_configs",[],|r|r.get(0))?;
        if count>=500{return Err(AppError::new("desktop_config","登录配置数量已达上限。"));}
        let existing:Option<String>=g.conn.query_row("SELECT account_id FROM desktop_login_configs WHERE id=?1",[&config.id],|r|r.get(0)).optional()?;
        if existing.is_some_and(|id|id!=config.account_id){return Err(AppError::new("desktop_config","配置 ID 已属于其他账号。"));}
        g.conn.execute("INSERT INTO desktop_login_configs VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",params![config.id,config.account_id,serde_json::to_string(&config)?])?;Ok(())
    }).await.map_err(|_|AppError::new("desktop_login","保存未完成。"))?
}
#[tauri::command]
pub async fn desktop_login_delete(window: tauri::WebviewWindow, id: String) -> Result<()> {
    crate::accounts::commands::authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        validate_id(&id)?;
        let db = app.state::<Db>();
        db.lock()?
            .conn
            .execute("DELETE FROM desktop_login_configs WHERE id=?1", [id])?;
        Ok(())
    })
    .await
    .map_err(|_| AppError::new("desktop_login", "删除未完成。"))?
}
#[tauri::command]
pub async fn desktop_login_run(
    window: tauri::WebviewWindow,
    id: String,
    authorized: bool,
) -> Result<Run> {
    crate::accounts::commands::authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || execute(&app, &id, authorized, None))
        .await
        .map_err(|_| {
            AppError::new(
                "desktop_login",
                "登录操作中断，请检查应用状态；不会自动重试。",
            )
        })?
}

// Shared service used by commands and the workflow coordinator. No separate launcher.
pub fn execute(
    app: &tauri::AppHandle,
    id: &str,
    authorized: bool,
    control: Option<&crate::runtime::Control>,
) -> Result<Run> {
    execute_with_workflow(app, id, authorized, control, None)
}
pub fn execute_with_workflow(
    app: &tauri::AppHandle,
    id: &str,
    authorized: bool,
    control: Option<&crate::runtime::Control>,
    workflow: Option<&crate::workflow::models::Workflow>,
) -> Result<Run> {
    let state = app.state::<Active>();
    let db = app.state::<Db>();
    let cfg = get(&db.lock()?.conn, id)?;
    let authorized = if let Some(w) = workflow {
        let g = db.lock()?;
        let current = get(&g.conn, id)?;
        authorized
            && serde_json::to_string(&current)? == serde_json::to_string(&cfg)?
            && crate::login::granted(&g.conn, w)?
    } else {
        authorized
    };
    let _lease = reserve(&state, &cfg.executable_path)?;
    // Hold the credential mutation gate: account edits/deletes cannot race an authorized fill.
    let account_state = app.state::<Accounts>();
    let _gate = account_state
        .0
        .lock()
        .map_err(|_| AppError::new("busy", "账号服务暂时不可用。"))?;
    let account = accounts::find(&db.lock()?.conn, &cfg.account_id)?;
    cfg.validate(&account)?;
    let inv = worker::call_control(
        Request::Windows {
            executable_path: cfg.executable_path.clone(),
        },
        15,
        control,
    )?;
    let candidates: Vec<_> = inv
        .windows
        .into_iter()
        .filter(|w| w.class_name == cfg.window_class && w.title == cfg.window_title)
        .collect();
    if candidates.len() != 1 {
        return Err(AppError::new(
            "wrong_target",
            "没有唯一匹配的应用窗口，请启动应用或重新录制窗口规则。",
        ));
    }
    let target = candidates[0].clone();
    let binding = Binding {
        username: account.username,
        credential_ref: account.credential_ref,
    };
    let probe = worker::call_control(
        Request::Login {
            window: target.clone(),
            config: Box::new(cfg.clone()),
            binding: binding.clone(),
            authorized: false,
        },
        15,
        control,
    )?;
    let mut run = Run {
        id: uuid::Uuid::new_v4().to_string(),
        config_id: cfg.id.clone(),
        account_id: cfg.account_id.clone(),
        started_at: now(),
        finished_at: None,
        result: probe,
    };
    if !authorized && run.result.status == "authorization_required" {
        let previous:bool=db.lock()?.conn.query_row("SELECT EXISTS(SELECT 1 FROM desktop_login_runs WHERE json_extract(payload,'$.config_id')=?1 AND status IN ('success','session_reused'))",[&cfg.id],|r|r.get(0))?;
        if previous {
            run.result = Response::status(
                "session_expired",
                "先前会话已失效或退出。请授权一次登录，或自行完成验证。",
            );
        }
    }
    if run.result.status == "authorization_required" && authorized {
        claim(
            &db.lock()?.conn,
            &cfg.account_id,
            chrono::Utc::now().timestamp(),
        )?;
        run.result = Response::status("running", "已授权，正在验证控件并尝试一次登录。");
        store_run(&db.lock()?.conn, &run)?;
        let _ = app.emit("desktop-login-changed", ());
        run.result = worker::call_control(
            Request::Login {
                window: target,
                config: Box::new(cfg.clone()),
                binding,
                authorized: true,
            },
            cfg.timeout_seconds as u64 + 10,
            control,
        )
        .unwrap_or_else(|e| Response::status(&e.code, &e.message));
    }
    run.finished_at = Some(now());
    store_run(&db.lock()?.conn, &run)?;
    let _ = app.emit("desktop-login-changed", ());
    Ok(run)
}
