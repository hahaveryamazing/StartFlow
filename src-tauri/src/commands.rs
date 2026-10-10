use crate::{
    database::{self, Db},
    engine,
    error::{AppError, Result},
    models::*,
};
use tauri::State;
use tauri_plugin_autostart::ManagerExt;
fn idle(g: &database::Inner) -> Result<()> {
    if !g.active.is_empty() {
        return Err(AppError::new(
            "busy",
            "当前有任务正在执行，请完成后再修改配置。",
        ));
    }
    Ok(())
}
fn refresh(app: &tauri::AppHandle) {
    crate::automation::reconfigure(app);
    crate::shortcuts::synchronize_removed(app);
    engine::changed(app);
    if let Err(e) = crate::tray::refresh(app) {
        eprintln!("StartFlow tray: {e}");
    }
}
#[tauri::command]
pub fn snapshot(app: tauri::AppHandle, db: State<Db>) -> Result<Snapshot> {
    let g = db.lock()?;
    let c = database::config(&g.conn)?;
    let now = chrono::Local::now();
    let mut info = vec![];
    for s in &c.schedules {
        let last = g.conn.query_row(
            "SELECT MAX(triggered_at) FROM rule_history WHERE rule_id=?1",
            [&s.id],
            |r| r.get::<_, Option<String>>(0),
        )?;
        info.push(ScheduleInfo {
            id: s.id.clone(),
            last_triggered_at: last,
            next_trigger_at: crate::scheduler::next_time(s, &now),
        });
    }
    let today = g.conn.query_row(
        "SELECT COUNT(*) FROM automatic_claims WHERE local_date=?1",
        [now.date_naive().to_string()],
        |r| r.get(0),
    )?;
    Ok(Snapshot {
        v2: crate::v2::commands::snapshot(&app, &g.conn)?,
        config: c,
        runs: database::runs(&g.conn)?,
        logs: database::logs(&g.conn)?,
        active_scenes: g.active.iter().cloned().collect(),
        schedules: info,
        autostart_enabled: app
            .autolaunch()
            .is_enabled()
            .map_err(|_| AppError::new("autostart", "无法查询 Windows 登录自启状态。"))?,
        data_directory: db.directory.clone(),
        today_auto_count: today,
    })
}
#[tauri::command]
pub fn save_scene(
    app: tauri::AppHandle,
    db: State<Db>,
    mut scene: Scene,
    task_ids: Vec<String>,
) -> Result<()> {
    let mut g = db.lock()?;
    idle(&g)?;
    let mut c = database::config(&g.conn)?;
    scene.updated_at = now();
    if let Some(old) = c.scenes.iter_mut().find(|s| s.id == scene.id) {
        scene.created_at = old.created_at.clone();
        *old = scene.clone();
    } else {
        scene.created_at = now();
        c.scenes.push(scene.clone());
    }
    c.scene_tasks.retain(|a| a.scene_id != scene.id);
    for (i, task_id) in task_ids.into_iter().enumerate() {
        c.scene_tasks.push(SceneTask {
            id: id(),
            scene_id: scene.id.clone(),
            task_id,
            sort_order: i as i32,
        });
    }
    database::write_config(&mut g.conn, &c)?;
    drop(g);
    refresh(&app);
    Ok(())
}
#[tauri::command]
pub fn save_task(app: tauri::AppHandle, db: State<Db>, mut task: Task) -> Result<()> {
    let mut g = db.lock()?;
    idle(&g)?;
    let mut c = database::config(&g.conn)?;
    task.updated_at = now();
    if let Some(old) = c.tasks.iter_mut().find(|t| t.id == task.id) {
        task.created_at = old.created_at.clone();
        *old = task;
    } else {
        task.created_at = now();
        c.tasks.push(task);
    }
    database::write_config(&mut g.conn, &c)?;
    drop(g);
    refresh(&app);
    Ok(())
}
#[tauri::command]
pub fn save_schedule(app: tauri::AppHandle, db: State<Db>, mut schedule: Schedule) -> Result<()> {
    let mut g = db.lock()?;
    idle(&g)?;
    let mut c = database::config(&g.conn)?;
    schedule.updated_at = now();
    if let Some(old) = c.schedules.iter_mut().find(|s| s.id == schedule.id) {
        schedule.created_at = old.created_at.clone();
        *old = schedule;
    } else {
        schedule.created_at = now();
        c.schedules.push(schedule);
    }
    database::write_config(&mut g.conn, &c)?;
    drop(g);
    refresh(&app);
    Ok(())
}
#[tauri::command]
pub fn delete_entity(
    app: tauri::AppHandle,
    db: State<Db>,
    kind: String,
    entity_id: String,
) -> Result<()> {
    let mut g = db.lock()?;
    idle(&g)?;
    let mut c = database::config(&g.conn)?;
    match kind.as_str() {
        "scene" => {
            c.scenes.retain(|s| s.id != entity_id);
            c.scene_tasks.retain(|a| a.scene_id != entity_id);
            c.schedules.retain(|s| s.scene_id != entity_id);
            if c.settings.default_scene_id.as_ref() == Some(&entity_id) {
                c.settings.default_scene_id = None;
            }
        }
        "task" => {
            c.tasks.retain(|t| t.id != entity_id);
            c.scene_tasks.retain(|a| a.task_id != entity_id);
        }
        "schedule" => c.schedules.retain(|s| s.id != entity_id),
        _ => return Err(AppError::new("validation", "未知的删除类型。")),
    }
    database::write_config(&mut g.conn, &c)?;
    drop(g);
    refresh(&app);
    Ok(())
}
#[tauri::command]
pub fn duplicate_scene(app: tauri::AppHandle, db: State<Db>, scene_id: String) -> Result<()> {
    let mut g = db.lock()?;
    idle(&g)?;
    let mut c = database::config(&g.conn)?;
    let mut s = c
        .scenes
        .iter()
        .find(|s| s.id == scene_id)
        .cloned()
        .ok_or_else(|| AppError::new("not_found", "场景已被删除。"))?;
    let new_id = id();
    s.id = new_id.clone();
    s.name = format!("{}（副本）", s.name.chars().take(32).collect::<String>());
    s.created_at = now();
    s.updated_at = now();
    s.sort_order = c.scenes.len() as i32;
    let links: Vec<_> = c
        .scene_tasks
        .iter()
        .filter(|a| a.scene_id == scene_id)
        .map(|a| SceneTask {
            id: id(),
            scene_id: new_id.clone(),
            task_id: a.task_id.clone(),
            sort_order: a.sort_order,
        })
        .collect();
    c.scenes.push(s);
    c.scene_tasks.extend(links);
    let mut extension = crate::v2::repository::load(&g.conn)?;
    if let Some(binding) = extension
        .bindings
        .iter()
        .find(|b| b.scene_id == scene_id)
        .cloned()
    {
        if let Some(workflow) = extension
            .workflows
            .iter()
            .find(|w| w.id == binding.workflow_id)
        {
            let copy = crate::v2::repository::clone_workflow(workflow, &new_id);
            extension.bindings.push(crate::v2::models::Binding {
                scene_id: new_id.clone(),
                workflow_id: copy.id.clone(),
            });
            extension.workflows.push(copy);
        }
    }
    if let Some(layout) = extension
        .layouts
        .iter()
        .find(|l| l.scene_id.as_deref() == Some(scene_id.as_str()))
        .cloned()
    {
        let mut copy = layout;
        copy.id = id();
        copy.scene_id = Some(new_id);
        copy.created_at = now();
        copy.updated_at = now();
        for item in &mut copy.items {
            item.id = id();
        }
        extension.layouts.push(copy);
    }
    crate::v2::repository::validate(&extension, &c)?;
    let tx = g.conn.transaction()?;
    database::write_config_rows(&tx, &c)?;
    crate::v2::repository::write(&tx, &extension)?;
    tx.commit()?;
    drop(g);
    refresh(&app);
    Ok(())
}
#[tauri::command]
pub fn save_settings(
    app: tauri::AppHandle,
    db: State<Db>,
    settings: Settings,
    theme: Option<crate::v2::models::Theme>,
) -> Result<()> {
    let mut g = db.lock()?;
    crate::v2::repository::save_preferences(&mut g.conn, settings, theme)?;
    drop(g);
    refresh(&app);
    Ok(())
}
#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<bool> {
    let manager = app.autolaunch();
    (if enabled {
        manager.enable()
    } else {
        manager.disable()
    })
    .map_err(|_| {
        AppError::new(
            "autostart",
            "无法更改 Windows 登录自启，请检查当前用户的系统权限。",
        )
    })?;
    let actual = manager
        .is_enabled()
        .map_err(|_| AppError::new("autostart", "无法确认 Windows 登录自启状态。"))?;
    if actual != enabled {
        return Err(AppError::new(
            "autostart",
            "Windows 自启状态未更新，请稍后重试。",
        ));
    }
    engine::changed(&app);
    Ok(actual)
}
#[tauri::command]
pub fn run_scene(app: tauri::AppHandle, scene_id: String) -> Result<String> {
    engine::submit_scene(&app, &scene_id, "manual", None)
}
#[tauri::command]
pub fn run_task(app: tauri::AppHandle, task_id: String) -> Result<String> {
    engine::submit_task(&app, &task_id)
}
#[tauri::command]
pub fn clear_logs(app: tauri::AppHandle, db: State<Db>) -> Result<()> {
    let g = db.lock()?;
    idle(&g)?;
    g.conn.execute("DELETE FROM execution_runs", [])?;
    drop(g);
    engine::changed(&app);
    Ok(())
}
#[tauri::command]
pub fn query_logs(
    db: State<Db>,
    date: String,
    scene_id: String,
    status: String,
    offset: u32,
) -> Result<LogPage> {
    if !date.is_empty() && chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_err() {
        return Err(AppError::new("validation", "日志日期无效。"));
    }
    if !scene_id.is_empty() {
        validate_id(&scene_id)?;
    }
    if ![
        "",
        "running",
        "launch_requested",
        "failed",
        "partial",
        "skipped",
        "completed",
        "cancelled",
        "interrupted",
        "timed_out",
    ]
    .contains(&status.as_str())
    {
        return Err(AppError::new("validation", "日志筛选状态无效。"));
    }
    let g = db.lock()?;
    let conn = &g.conn;
    let filter="(?1='' OR date(r.started_at,'localtime')=?1) AND (?2='' OR r.scene_id=?2) AND (?3='' OR r.status=?3)";
    let total = conn.query_row(
        &format!("SELECT COUNT(*) FROM execution_runs r WHERE {filter}"),
        rusqlite::params![date, scene_id, status],
        |r| r.get(0),
    )?;
    let (requested,failed,skipped)=conn.query_row(&format!("SELECT COUNT(CASE WHEN l.status='launch_requested' THEN 1 END),COUNT(CASE WHEN l.status='failed' THEN 1 END),COUNT(CASE WHEN l.status='skipped' THEN 1 END) FROM (SELECT run_id,status FROM execution_logs UNION ALL SELECT run_id,status FROM workflow_execution_logs) l JOIN execution_runs r ON r.id=l.run_id WHERE {filter}"),rusqlite::params![date,scene_id,status],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    let mut stmt=conn.prepare(&format!("SELECT r.id,r.scene_id,r.scene_name_snapshot,r.trigger_type,r.rule_id,r.started_at,r.finished_at,r.status,r.local_run_date FROM execution_runs r WHERE {filter} ORDER BY r.started_at DESC,r.rowid DESC LIMIT 50 OFFSET ?4"))?;
    let runs = stmt
        .query_map(rusqlite::params![date, scene_id, status, offset], |r| {
            Ok(Run {
                id: r.get(0)?,
                scene_id: r.get(1)?,
                scene_name_snapshot: r.get(2)?,
                trigger_type: r.get(3)?,
                rule_id: r.get(4)?,
                started_at: r.get(5)?,
                finished_at: r.get(6)?,
                status: r.get(7)?,
                local_run_date: r.get(8)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut stmt=conn.prepare(&format!("SELECT id,run_id,task_id,task_name_snapshot,started_at,finished_at,status,message FROM execution_logs WHERE run_id IN(SELECT r.id FROM execution_runs r WHERE {filter} ORDER BY r.started_at DESC,r.rowid DESC LIMIT 50 OFFSET ?4) ORDER BY rowid"))?;
    let logs = stmt
        .query_map(rusqlite::params![date, scene_id, status, offset], |r| {
            Ok(Log {
                id: r.get(0)?,
                run_id: r.get(1)?,
                task_id: r.get(2)?,
                task_name_snapshot: r.get(3)?,
                started_at: r.get(4)?,
                finished_at: r.get(5)?,
                status: r.get(6)?,
                message: r.get(7)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut stmt=conn.prepare("SELECT scene_id,scene_name_snapshot FROM execution_runs WHERE scene_id IS NOT NULL GROUP BY scene_id ORDER BY MAX(started_at) DESC")?;
    let scene_choices = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(LogPage {
        runs,
        logs,
        total,
        requested,
        failed,
        skipped,
        scene_choices,
    })
}
fn json_path(path: &str) -> Result<std::path::PathBuf> {
    validate_path(path)?;
    let p = std::path::PathBuf::from(path);
    if p.extension()
        .and_then(|e| e.to_str())
        .is_none_or(|e| !e.eq_ignore_ascii_case("json"))
    {
        return Err(AppError::new("validation", "请选择 JSON 配置文件。"));
    }
    Ok(p)
}
#[tauri::command]
pub fn read_import(path: String) -> Result<Config> {
    let p = json_path(&path)?;
    let metadata =
        std::fs::metadata(&p).map_err(|_| AppError::new("file", "无法读取配置文件。"))?;
    if metadata.len() > 10 * 1024 * 1024 {
        return Err(AppError::new("file", "配置文件不能超过 10 MB。"));
    }
    let data = std::fs::read_to_string(p)
        .map_err(|_| AppError::new("file", "配置文件无法读取，请确认采用 UTF-8 编码。"))?;
    let c: Config = serde_json::from_str(data.trim_start_matches('\u{feff}'))?;
    c.validate()?;
    Ok(c)
}
#[tauri::command]
pub fn apply_import(app: tauri::AppHandle, db: State<Db>, mut config: Config) -> Result<()> {
    config.settings.paused = true;
    config.validate()?;
    {
        let g = db.lock()?;
        idle(&g)?;
        crate::v2::repository::validate_changes(&g.conn, &config)?;
    }
    crate::backups::create(&db, "before_restore")?;
    let mut g = db.lock()?;
    idle(&g)?;
    database::write_config(&mut g.conn, &config)?;
    drop(g);
    refresh(&app);
    Ok(())
}
#[tauri::command]
pub fn export_config(db: State<Db>, path: String) -> Result<()> {
    let p = json_path(&path)?;
    let c = database::config(&db.lock()?.conn)?;
    let data = serde_json::to_vec_pretty(&c)?;
    std::fs::write(p, data)
        .map_err(|_| AppError::new("file", "导出失败，请选择有写入权限的位置。"))?;
    Ok(())
}
#[tauri::command]
pub fn open_data_directory(app: tauri::AppHandle, db: State<Db>) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&db.directory, None::<&str>)
        .map_err(|_| AppError::new("file", "无法打开数据目录。"))
}
#[tauri::command]
pub fn quit(app: tauri::AppHandle) {
    app.exit(0);
}
