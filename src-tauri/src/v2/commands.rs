use crate::{
    database::{self, Db},
    error::{AppError, Result},
    models::now,
    v2::{models::*, repository},
    workflow::models::Workflow,
};
use std::{collections::HashMap, path::Path, sync::Mutex};
use tauri::Manager;
#[derive(Default)]
pub struct Mutations(pub Mutex<()>);
fn idle(db: &Db) -> Result<()> {
    if !db.lock()?.active.is_empty() {
        return Err(AppError::new(
            "busy",
            "请先等待或取消当前执行，再修改工作流配置。",
        ));
    }
    Ok(())
}
pub fn snapshot(app: &tauri::AppHandle, conn: &rusqlite::Connection) -> Result<V2Snapshot> {
    Ok(V2Snapshot {
        extension: repository::load(conn)?,
        node_logs: repository::node_logs(conn)?,
        workflow_runs: repository::workflow_runs(conn)?,
        backups: crate::backups::records(conn)?,
        shortcut_errors: app
            .state::<crate::shortcuts::Shortcuts>()
            .errors
            .lock()
            .map_err(AppError::internal)?
            .clone(),
    })
}
pub fn save_extension(app: &tauri::AppHandle, extension: Extension) -> Result<()> {
    let gate = app.state::<Mutations>();
    let _gate = gate.0.lock().map_err(AppError::internal)?;
    let db = app.state::<Db>();
    idle(&db)?;
    let previous = {
        let g = db.lock()?;
        let config = database::config(&g.conn)?;
        repository::validate(&extension, &config)?;
        for w in &extension.workflows {
            crate::login::references(&g.conn, w)?;
        }
        crate::automation::repository::validate_references(&g.conn, &config, &extension)?;
        repository::load(&g.conn)?
    };
    let changed =
        serde_json::to_string(&previous.shortcuts)? != serde_json::to_string(&extension.shortcuts)?;
    if changed {
        crate::shortcuts::apply(app, &extension.shortcuts)?;
    }
    let outcome: Result<()> = (|| {
        let mut g = db.lock()?;
        if !g.active.is_empty() {
            return Err(AppError::new("busy", "有新执行正在运行，请稍后保存。"));
        }
        let config = database::config(&g.conn)?;
        repository::validate(&extension, &config)?;
        for w in &extension.workflows {
            crate::login::references(&g.conn, w)?;
        }
        crate::automation::repository::validate_references(&g.conn, &config, &extension)?;
        let tx = g.conn.transaction()?;
        repository::write(&tx, &extension)?;
        tx.commit()?;
        Ok(())
    })();
    if outcome.is_err() && changed {
        if let Err(e) = crate::shortcuts::apply(app, &previous.shortcuts) {
            crate::engine::report_error(app, &e);
        }
    }
    outcome?;
    crate::engine::changed(app);
    Ok(())
}
#[tauri::command]
pub async fn v2_save_extension(app: tauri::AppHandle, extension: Extension) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || save_extension(&app, extension))
        .await
        .map_err(AppError::internal)?
}
#[tauri::command]
pub fn v2_validate_workflow(app: tauri::AppHandle, workflow: Workflow) -> Result<()> {
    let db = app.state::<Db>();
    let g = db.lock()?;
    let config = database::config(&g.conn)?;
    crate::workflow::validator::validate(&workflow, &config, &repository::load(&g.conn)?)?;
    crate::login::references(&g.conn, &workflow)?;
    crate::workflow::validator::environment(&workflow, &config)
}
#[tauri::command]
pub fn v2_convert_scene(app: tauri::AppHandle, scene_id: String) -> Result<Workflow> {
    let db = app.state::<Db>();
    let mut g = db.lock()?;
    if !g.active.is_empty() {
        return Err(AppError::new("busy", "请在当前执行结束后创建草稿。"));
    }
    let c = database::config(&g.conn)?;
    let mut e = repository::load(&g.conn)?;
    let w = crate::workflow::executor::convert(&scene_id, &c)?;
    e.workflows.push(w.clone());
    repository::validate(&e, &c)?;
    let tx = g.conn.transaction()?;
    repository::write(&tx, &e)?;
    tx.commit()?;
    drop(g);
    crate::engine::changed(&app);
    Ok(w)
}
#[tauri::command]
pub fn v2_run_workflow(app: tauri::AppHandle, workflow_id: String) -> Result<String> {
    let db = app.state::<Db>();
    let e = repository::load(&db.lock()?.conn)?;
    let w = e
        .workflows
        .iter()
        .find(|w| w.id == workflow_id)
        .ok_or_else(|| AppError::new("workflow", "请先保存工作流。"))?;
    crate::engine::submit_scene_with_workflow(&app, &w.scene_id, "test", None, Some(&workflow_id))
}
#[tauri::command]
pub fn v2_cancel_run(app: tauri::AppHandle, run_id: String) -> Result<()> {
    app.state::<crate::runtime::Runtime>().cancel(&run_id)
}
#[tauri::command]
pub fn v2_query_node_logs(
    app: tauri::AppHandle,
    run_id: String,
) -> Result<Vec<crate::workflow::models::NodeLog>> {
    crate::models::validate_id(&run_id)?;
    let db = app.state::<Db>();
    let result = repository::node_logs_for(&db.lock()?.conn, Some(&run_id))?;
    Ok(result)
}
#[tauri::command]
pub async fn v2_window_inventory() -> Result<crate::window_manager::Inventory> {
    tauri::async_runtime::spawn_blocking(crate::window_manager::inventory)
        .await
        .map_err(AppError::internal)?
}
#[tauri::command]
pub async fn v2_restore_layout(app: tauri::AppHandle, layout_id: String) -> Result<String> {
    let db = app.state::<Db>();
    let mut g = db.lock()?;
    let extension = repository::load(&g.conn)?;
    let layout = extension
        .layouts
        .iter()
        .find(|l| l.id == layout_id)
        .cloned()
        .ok_or_else(|| AppError::new("layout", "布局不存在。"))?;
    let key = format!("layout:{layout_id}");
    if g.active.contains(&key) || g.active.len() >= 4 {
        return Err(AppError::new("busy", "布局正在恢复或达到执行上限。"));
    }
    let run = crate::models::id();
    let node = crate::models::id();
    let tx = g.conn.transaction()?;
    tx.execute(
        "INSERT INTO execution_runs VALUES(?1,NULL,?2,'manual',NULL,?3,NULL,'running',?4)",
        rusqlite::params![
            run,
            format!("窗口布局 · {}", layout.name),
            now(),
            chrono::Local::now().date_naive().to_string()
        ],
    )?;
    tx.execute(
        "INSERT INTO workflow_runs VALUES(?1,?2,?3)",
        rusqlite::params![run, layout.id, layout.name],
    )?;
    tx.execute("INSERT INTO workflow_execution_logs VALUES(?1,?2,?3,?4,'layout',?5,NULL,'running','null','')",rusqlite::params![crate::models::id(),run,node,layout.name,now()])?;
    tx.commit()?;
    let control = app.state::<crate::runtime::Runtime>().register(&run)?;
    g.active.insert(key.clone());
    drop(g);
    crate::engine::changed(&app);
    let result = run.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = crate::window_manager::restore(
            &layout,
            &extension.layouts,
            15,
            &HashMap::new(),
            &control,
        )
        .await;
        let (status, value, message) = match outcome {
            Ok(results) => {
                let status = if results.iter().any(|r| r.status == "failed") {
                    "partial"
                } else {
                    "completed"
                };
                (
                    status,
                    serde_json::to_string(&results).unwrap_or_else(|_| "null".into()),
                    String::new(),
                )
            }
            Err(e) => (
                if e.code == "cancelled" {
                    "cancelled"
                } else {
                    "failed"
                },
                "null".into(),
                e.message,
            ),
        };
        let db = app.state::<Db>();
        if let Ok(mut g) = db.lock() {
            g.active.remove(&key);
            if let Err(e) = g.conn.execute(
                "UPDATE execution_runs SET status=?1,finished_at=?2 WHERE id=?3",
                rusqlite::params![status, now(), run],
            ) {
                crate::engine::report_error(&app, &e.into());
            }
            if let Err(e)=g.conn.execute("UPDATE workflow_execution_logs SET status=?1,finished_at=?2,result_json=?3,error_message=?4 WHERE run_id=?5",rusqlite::params![status,now(),value,message,run]){crate::engine::report_error(&app,&e.into());}
        };
        app.state::<crate::runtime::Runtime>().remove(&run);
        crate::engine::changed(&app);
    });
    Ok(result)
}
#[tauri::command]
pub async fn v2_create_backup(app: tauri::AppHandle) -> Result<BackupRecord> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = crate::backups::create(&app.state::<Db>(), "manual")?;
        crate::engine::changed(&app);
        Ok(r)
    })
    .await
    .map_err(AppError::internal)?
}
#[tauri::command]
pub async fn v2_delete_backup(app: tauri::AppHandle, backup_id: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let g = db.lock()?;
        let r = crate::backups::records(&g.conn)?
            .into_iter()
            .find(|r| r.id == backup_id)
            .ok_or_else(|| AppError::new("backup", "备份不存在。"))?;
        let file = crate::backups::managed_path(&db.directory, &r)?;
        if file.exists() {
            std::fs::remove_file(file).map_err(AppError::internal)?;
        }
        g.conn
            .execute("DELETE FROM backup_records WHERE id=?1", [backup_id])?;
        drop(g);
        crate::engine::changed(&app);
        Ok(())
    })
    .await
    .map_err(AppError::internal)?
}
#[tauri::command]
pub async fn v2_read_backup(app: tauri::AppHandle, backup_id: String) -> Result<Bundle> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::backups::read_record(&app.state::<Db>(), &backup_id)
    })
    .await
    .map_err(AppError::internal)?
}
#[tauri::command]
pub async fn v2_read_import(app: tauri::AppHandle, path: String) -> Result<Bundle> {
    tauri::async_runtime::spawn_blocking(move || {
        let b = crate::backups::read_json(&path)?;
        crate::backups::create(&app.state::<Db>(), "before_restore")?;
        crate::engine::changed(&app);
        Ok(b)
    })
    .await
    .map_err(AppError::internal)?
}
#[tauri::command]
pub async fn v2_export(app: tauri::AppHandle, path: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::models::validate_path(&path)?;
        if !path.to_lowercase().ends_with(".json") {
            return Err(AppError::new("format", "导出文件应使用 .json 扩展名。"));
        }
        let db = app.state::<Db>();
        let b = crate::backups::make_bundle(&db.lock()?.conn, Path::new(&db.directory))?;
        std::fs::write(path, serde_json::to_vec_pretty(&b)?).map_err(AppError::internal)?;
        Ok(())
    })
    .await
    .map_err(AppError::internal)?
}
fn restore(app: &tauri::AppHandle, mut bundle: Bundle, mode: &str) -> Result<()> {
    crate::backups::validate_bundle(&bundle)?;
    let gate = app.state::<Mutations>();
    let _gate = gate.0.lock().map_err(AppError::internal)?;
    let automation = app.state::<crate::automation::Automation>();
    let _automation_gate = automation.gate.lock().map_err(AppError::internal)?;
    let db = app.state::<Db>();
    idle(&db)?;
    if !crate::web_login::runtime::active(app)?.is_empty() {
        return Err(AppError::new("busy", "请关闭专用浏览器后再恢复配置。"));
    }
    let accounts = app.state::<crate::accounts::Accounts>();
    let _accounts_gate = accounts.0.lock().map_err(AppError::internal)?;
    let current = crate::backups::make_bundle(&db.lock()?.conn, Path::new(&db.directory))?;
    bundle = match mode {
        "merge" => crate::backups::merge(&current, &bundle)?,
        "replace" => {
            crate::login::backup::remap(&mut bundle)?;
            bundle
        }
        _ => return Err(AppError::new("format", "请选择合并或完整替换。")),
    };
    crate::backups::create(&db, "before_restore")?;
    bundle.config.settings.paused = true;
    if mode == "replace" {
        if let Some(a) = &mut bundle.automation {
            a.enabled = false;
            a.permissions = Default::default();
            for r in &mut a.rules {
                r.enabled = false;
                r.policy = "confirm".into();
            }
            for m in &mut a.modes {
                m.strategy = "suggest".into();
            }
        }
        if let Some(ai) = &mut bundle.ai {
            ai.enabled = false;
            ai.history = false;
            ai.id = crate::models::id();
        }
        for s in &mut bundle.extension.shortcuts {
            s.enabled = false;
        }
    }
    // Imported machine-local background names must never overwrite an existing asset.
    if mode == "replace" {
        if let Some(old) = bundle.extension.theme.background_id.clone() {
            if let Some(asset) = bundle.assets.iter().find(|a| a.id == old) {
                let bytes =
                    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &asset.data)
                        .map_err(AppError::internal)?;
                let ext = crate::backups::validate_image(&bytes)?;
                let new = format!("{}.{}", crate::models::id(), ext);
                let folder = Path::new(&db.directory).join("backgrounds");
                std::fs::create_dir_all(&folder).map_err(AppError::internal)?;
                std::fs::write(folder.join(&new), bytes).map_err(AppError::internal)?;
                bundle.extension.theme.background_id = Some(new);
            } else {
                bundle.extension.theme.background_id = None;
                bundle.extension.theme.background_style = "solid".into();
            }
        }
    }
    crate::backups::validate_bundle(&bundle)?;
    crate::shortcuts::apply(app, &bundle.extension.shortcuts)?;
    let outcome: Result<()> = (|| {
        let mut g = db.lock()?;
        if !g.active.is_empty() {
            return Err(AppError::new("busy", "恢复前有新执行，请结束后重试。"));
        }
        let tx = g.conn.transaction()?;
        if mode == "replace" {
            crate::automation::repository::write(&tx, &Default::default())?;
        }
        database::write_config_rows(&tx, &bundle.config)?;
        tx.execute("DELETE FROM workflow_login_grants", [])?;
        repository::write(&tx, &bundle.extension)?;
        if let Some(login) = &bundle.login {
            crate::login::backup::write(&tx, login)?;
        }
        crate::automation::repository::write(&tx, &bundle.automation.clone().unwrap_or_default())?;
        if mode == "replace" {
            tx.execute("INSERT INTO settings VALUES('ai_provider',?1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",[serde_json::to_string(&bundle.ai.clone().unwrap_or_default())?])?;
        }
        let count: i64 =
            tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })?;
        if count != 0 {
            return Err(AppError::new("storage", "恢复引用校验失败，已回滚。"));
        }
        tx.commit()?;
        Ok(())
    })();
    if outcome.is_err() {
        if let Err(e) = crate::shortcuts::apply(app, &current.extension.shortcuts) {
            crate::engine::report_error(app, &e);
        }
    }
    outcome?;
    crate::automation::reconfigure(app);
    crate::engine::changed(app);
    crate::tray::refresh(app)?;
    Ok(())
}
#[tauri::command]
pub async fn v2_apply_import(app: tauri::AppHandle, bundle: Bundle, mode: String) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || restore(&app, bundle, &mode))
        .await
        .map_err(AppError::internal)?
}
#[tauri::command]
pub async fn v2_choose_background(app: tauri::AppHandle, path: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::models::validate_path(&path)?;
        let p = Path::new(&path);
        if std::fs::metadata(p).map_err(AppError::internal)?.len() > 8 * 1024 * 1024 {
            return Err(AppError::new("image", "背景图片最大 8 MB。"));
        }
        let bytes = std::fs::read(p).map_err(AppError::internal)?;
        let ext = crate::backups::validate_image(&bytes)?;
        let db = app.state::<Db>();
        let folder = Path::new(&db.directory).join("backgrounds");
        std::fs::create_dir_all(&folder).map_err(AppError::internal)?;
        let name = format!("{}.{}", crate::models::id(), ext);
        std::fs::write(folder.join(&name), bytes).map_err(AppError::internal)?;
        Ok(name)
    })
    .await
    .map_err(AppError::internal)?
}
#[tauri::command]
pub async fn v2_read_background(app: tauri::AppHandle, name: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        crate::backups::background_name(&name)?;
        let db = app.state::<Db>();
        let bytes = std::fs::read(Path::new(&db.directory).join("backgrounds").join(&name))
            .map_err(|_| AppError::new("image", "背景图片无法读取，已回退默认背景。"))?;
        let ext = crate::backups::validate_image(&bytes)?;
        Ok(format!(
            "data:image/{};base64,{}",
            if ext == "jpg" { "jpeg" } else { ext },
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
    .map_err(AppError::internal)?
}
#[tauri::command]
pub fn v2_show_palette(app: tauri::AppHandle) -> Result<()> {
    crate::shortcuts::show_palette(&app)
}
#[tauri::command]
pub fn v2_hide_palette(app: tauri::AppHandle) -> Result<()> {
    if let Some(w) = app.get_webview_window("palette") {
        w.hide().map_err(AppError::internal)?;
    }
    Ok(())
}
#[tauri::command]
pub fn v2_palette_data(app: tauri::AppHandle) -> Result<serde_json::Value> {
    let db = app.state::<Db>();
    let g = db.lock()?;
    let c = database::config(&g.conn)?;
    let (theme, shortcuts) = repository::palette_preferences(&g.conn)?;
    Ok(
        serde_json::json!({"scenes":c.scenes,"tasks":c.tasks,"settings":c.settings,"theme":theme,"shortcuts":shortcuts}),
    )
}
#[tauri::command]
pub async fn v2_palette_action(
    app: tauri::AppHandle,
    action: String,
    target: String,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::shortcuts::action_execute(&app, &action, &target)?;
        if let Some(w) = app.get_webview_window("palette") {
            w.hide().map_err(AppError::internal)?;
        }
        Ok(())
    })
    .await
    .map_err(AppError::internal)?
}
