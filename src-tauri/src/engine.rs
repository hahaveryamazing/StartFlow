use crate::{
    database::{self, Db},
    error::{AppError, Result},
    models::*,
};
use rusqlite::params;
use tauri::{Emitter, Manager};

pub fn changed(app: &tauri::AppHandle) {
    if let Err(e) = app.emit("data-changed", ()) {
        eprintln!("StartFlow event: {e}");
    }
}
pub fn report_error(app: &tauri::AppHandle, e: &AppError) {
    eprintln!("StartFlow {}: {}", e.code, e.message);
    let _ = app.emit("service-error", e);
}
pub fn submit_scene(
    app: &tauri::AppHandle,
    scene_id: &str,
    trigger: &str,
    automatic: Option<(&str, &str)>,
) -> Result<String> {
    submit_scene_with_workflow(app, scene_id, trigger, automatic, None)
}
pub fn submit_scene_with_workflow(
    app: &tauri::AppHandle,
    scene_id: &str,
    trigger: &str,
    automatic: Option<(&str, &str)>,
    workflow_override: Option<&str>,
) -> Result<String> {
    let db = app.state::<Db>();
    let mut g = db.lock()?;
    let c = database::config(&g.conn)?;
    let extension = crate::v2::repository::load(&g.conn)?;
    let workflow_id = workflow_override.or_else(|| {
        extension
            .bindings
            .iter()
            .find(|b| b.scene_id == scene_id)
            .map(|b| b.workflow_id.as_str())
    });
    let workflow = if let Some(key) = workflow_id {
        let w = extension
            .workflows
            .iter()
            .find(|w| w.id == key && w.scene_id == scene_id)
            .cloned()
            .ok_or_else(|| AppError::new("workflow", "场景绑定的工作流不存在。"))?;
        if !w.enabled {
            return Err(AppError::new(
                "disabled",
                "工作流已停用，不会自动改为执行简单列表。",
            ));
        }
        crate::workflow::validator::validate(&w, &c, &extension)?;
        Some(w)
    } else {
        None
    };
    if g.active.len() >= 4 {
        return Err(AppError::new(
            "busy",
            "同时执行上限为 4 个，请等待当前任务完成。",
        ));
    }
    let scene = c
        .scenes
        .iter()
        .find(|s| s.id == scene_id)
        .ok_or_else(|| AppError::new("not_found", "场景已被删除。"))?;
    if !scene.enabled {
        return Err(AppError::new("disabled", "该场景已停用，请启用后再启动。"));
    }
    if g.active.contains(scene_id) {
        return Err(AppError::new("busy", "该场景正在执行，请等待完成。"));
    }
    if automatic.is_some() && c.settings.paused {
        return Err(AppError::new("disabled", "自动任务已暂停。"));
    }
    let mut links: Vec<_> = c
        .scene_tasks
        .iter()
        .filter(|a| a.scene_id == scene_id)
        .collect();
    links.sort_by_key(|a| a.sort_order);
    let tasks: Vec<Task> = links
        .iter()
        .filter_map(|a| c.tasks.iter().find(|t| t.id == a.task_id).cloned())
        .collect();
    if tasks.is_empty() && workflow.is_none() {
        return Err(AppError::new("empty", "请先为场景添加任务。"));
    }
    let run_id = id();
    let started = chrono::Utc::now();
    let date = started
        .with_timezone(&chrono::Local)
        .date_naive()
        .to_string();
    let stamp = started.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let tx = g.conn.transaction()?;
    if let Some((rule, occurrence_date)) = automatic {
        if !database::reserve_automatic(&tx, scene_id, &date, occurrence_date, rule)? {
            return Err(AppError::new(
                "dedup",
                "该场景的本日或对应计划已经自动执行。",
            ));
        }
    }
    tx.execute(
        "INSERT INTO execution_runs VALUES(?1,?2,?3,?4,?5,?6,NULL,'running',?7)",
        params![
            run_id,
            scene_id,
            scene.name,
            trigger,
            automatic.map(|a| a.0),
            stamp,
            date
        ],
    )?;
    let mut work = Vec::new();
    for task in if workflow.is_none() {
        tasks
    } else {
        Vec::new()
    } {
        let log_id = id();
        tx.execute(
            "INSERT INTO execution_logs VALUES(?1,?2,?3,?4,NULL,NULL,'pending','等待执行。')",
            params![log_id, run_id, task.id, task.name],
        )?;
        work.push((log_id, task));
    }
    if let Some(w) = &workflow {
        crate::workflow::executor::prepare(&tx, &run_id, w)?;
    }
    tx.commit()?;
    let control = match app.state::<crate::runtime::Runtime>().register(&run_id) {
        Ok(c) => c,
        Err(e) => {
            g.conn.execute(
                "UPDATE execution_runs SET status='failed',finished_at=?1 WHERE id=?2",
                params![now(), run_id],
            )?;
            return Err(e);
        }
    };
    g.active.insert(scene_id.into());
    drop(g);
    changed(app);
    let app = app.clone();
    let scene_id = scene_id.to_owned();
    let result = run_id.clone();
    let name = scene.name.clone();
    tauri::async_runtime::spawn(async move {
        let seconds = workflow.as_ref().map(|w| w.max_seconds).unwrap_or(3600);
        let future = async {
            if let Some(w) = &workflow {
                crate::workflow::executor::execute(&app, &run_id, w, &c, &extension, &control).await
            } else {
                let status = execute(&app, &run_id, work, &control).await?;
                if status != "failed" {
                    if let Some(layout) = extension
                        .layouts
                        .iter()
                        .find(|l| l.scene_id.as_deref() == Some(scene_id.as_str()))
                    {
                        return restore_simple_layout(
                            &app, &run_id, layout, &extension, &control, status,
                        )
                        .await;
                    }
                }
                Ok(status)
            }
        };
        let outcome = match tokio::time::timeout(
            std::time::Duration::from_secs(seconds as u64),
            future,
        )
        .await
        {
            Ok(r) => r,
            Err(_) => Err(AppError::new("timed_out", "流程已达到最长执行时间。")),
        };
        let status = match &outcome {
            Ok(s) => *s,
            Err(e) if e.code == "cancelled" => "cancelled",
            Err(e) if e.code == "timed_out" => "timed_out",
            Err(_) => "failed",
        };
        if let Err(e) = crate::workflow::executor::settle(&app, &run_id, status) {
            report_error(&app, &e);
        }
        {
            let db = app.state::<Db>();
            match db.lock() {
                Ok(mut g) => {
                    g.active.remove(&scene_id);
                    if let Err(e)=g.conn.execute("UPDATE execution_logs SET status='skipped',finished_at=?1,message='流程已停止，任务未继续提交。' WHERE run_id=?2 AND status IN ('pending','running')",params![now(),run_id]){report_error(&app,&e.into());}
                    if let Err(e) = g.conn.execute(
                        "UPDATE execution_runs SET status=?1,finished_at=?2 WHERE id=?3",
                        params![status, now(), run_id],
                    ) {
                        report_error(&app, &e.into());
                    }
                }
                Err(e) => report_error(&app, &e),
            };
        }
        app.state::<crate::runtime::Runtime>().remove(&run_id);
        if let Err(e) = crate::automation::coordinator::complete_run(&app, &run_id, status) {
            report_error(&app, &e);
        }
        if let Err(e) = outcome {
            report_error(&app, &e);
        }
        changed(&app);
        let _ = crate::tray::refresh(&app);
        notify(&app, &name, status);
    });
    Ok(result)
}
pub fn submit_task(app: &tauri::AppHandle, task_id: &str) -> Result<String> {
    let db = app.state::<Db>();
    let mut g = db.lock()?;
    let c = database::config(&g.conn)?;
    if g.active.len() >= 4 {
        return Err(AppError::new("busy", "同时执行上限为 4 个，请稍后重试。"));
    }
    let task = c
        .tasks
        .iter()
        .find(|t| t.id == task_id)
        .cloned()
        .ok_or_else(|| AppError::new("not_found", "任务已被删除。"))?;
    let key = format!("task:{task_id}");
    if g.active.contains(&key) {
        return Err(AppError::new("busy", "该任务正在测试运行。"));
    }
    let run_id = id();
    let log_id = id();
    let tx = g.conn.transaction()?;
    tx.execute(
        "INSERT INTO execution_runs VALUES(?1,NULL,'单独测试','manual',NULL,?2,NULL,'running',?3)",
        params![run_id, now(), chrono::Local::now().date_naive().to_string()],
    )?;
    tx.execute(
        "INSERT INTO execution_logs VALUES(?1,?2,?3,?4,NULL,NULL,'pending','等待执行。')",
        params![log_id, run_id, task.id, task.name],
    )?;
    tx.commit()?;
    let control = match app.state::<crate::runtime::Runtime>().register(&run_id) {
        Ok(c) => c,
        Err(e) => {
            g.conn.execute(
                "UPDATE execution_runs SET status='failed',finished_at=?1 WHERE id=?2",
                params![now(), run_id],
            )?;
            return Err(e);
        }
    };
    g.active.insert(key.clone());
    drop(g);
    changed(app);
    let result = run_id.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = execute(&app, &run_id, vec![(log_id, task)], &control).await;
        let status = match &outcome {
            Ok(s) => *s,
            Err(e) if e.code == "cancelled" => "cancelled",
            _ => "failed",
        };
        {
            let db = app.state::<Db>();
            if let Ok(mut g) = db.lock() {
                g.active.remove(&key);
                if let Err(e)=g.conn.execute("UPDATE execution_logs SET status='skipped',finished_at=?1,message='任务已取消。' WHERE run_id=?2 AND status IN ('pending','running')",params![now(),run_id]){report_error(&app,&e.into());}
                if let Err(e) = g.conn.execute(
                    "UPDATE execution_runs SET status=?1,finished_at=?2 WHERE id=?3",
                    params![status, now(), run_id],
                ) {
                    report_error(&app, &e.into());
                }
            };
        }
        app.state::<crate::runtime::Runtime>().remove(&run_id);
        if let Err(e) = outcome {
            report_error(&app, &e);
        }
        changed(&app);
        notify(&app, "任务测试", status);
    });
    Ok(result)
}
fn update(
    app: &tauri::AppHandle,
    log: &str,
    status: &str,
    message: &str,
    finish: bool,
) -> Result<()> {
    let db = app.state::<Db>();
    let g = db.lock()?;
    if finish {
        g.conn.execute(
            "UPDATE execution_logs SET status=?1,message=?2,finished_at=?3 WHERE id=?4",
            params![status, message, now(), log],
        )?;
    } else {
        g.conn.execute(
            "UPDATE execution_logs SET status=?1,message=?2,started_at=?3 WHERE id=?4",
            params![status, message, now(), log],
        )?;
    }
    drop(g);
    changed(app);
    Ok(())
}
async fn execute(
    app: &tauri::AppHandle,
    _run: &str,
    work: Vec<(String, Task)>,
    control: &crate::runtime::Control,
) -> Result<&'static str> {
    let mut failures = 0;
    let mut launches = 0;
    for (log, t) in work {
        control.check()?;
        update(app, &log, "running", "正在等待并提交启动请求。", false)?;
        if !t.enabled {
            update(app, &log, "skipped", "该任务已停用。", true)?;
            continue;
        }
        let outcome = crate::runtime::task(&t, control).await;
        match outcome {
            Ok(result) => {
                if result.status == "launch_requested" {
                    launches += 1;
                }
                update(app, &log, result.status, result.message, true)?;
            }
            Err(e) if e.code == "cancelled" => return Err(e),
            Err(e) => {
                failures += 1;
                update(app, &log, "failed", &e.message, true)?;
            }
        }
    }
    Ok(if failures > 0 {
        if launches > 0 {
            "partial"
        } else {
            "failed"
        }
    } else if launches == 0 {
        "skipped"
    } else {
        "launch_requested"
    })
}
struct NestedGuard {
    app: tauri::AppHandle,
    key: String,
}
impl Drop for NestedGuard {
    fn drop(&mut self) {
        let db = self.app.state::<Db>();
        if let Ok(mut g) = db.lock() {
            g.active.remove(&self.key);
        };
        changed(&self.app);
    }
}
pub async fn execute_nested_simple(
    app: &tauri::AppHandle,
    run: &str,
    scene: &str,
    c: &Config,
    control: &crate::runtime::Control,
) -> Result<&'static str> {
    let work = {
        let db = app.state::<Db>();
        let mut g = db.lock()?;
        if g.active.contains(scene) || g.active.len() >= 4 {
            return Err(AppError::new("busy", "关联场景正在运行或达到并发上限。"));
        }
        if !c.scenes.iter().any(|s| s.id == scene && s.enabled) {
            return Err(AppError::new("disabled", "关联简单场景已停用。"));
        }
        let mut links: Vec<_> = c
            .scene_tasks
            .iter()
            .filter(|a| a.scene_id == scene)
            .collect();
        links.sort_by_key(|a| a.sort_order);
        let mut work = vec![];
        for a in links {
            if let Some(t) = c.tasks.iter().find(|t| t.id == a.task_id) {
                let log = id();
                g.conn.execute("INSERT INTO execution_logs VALUES(?1,?2,?3,?4,NULL,NULL,'pending','等待执行。')",params![log,run,t.id,t.name])?;
                work.push((log, t.clone()));
            }
        }
        if work.is_empty() {
            return Err(AppError::new("empty", "关联场景尚无任务。"));
        }
        g.active.insert(scene.into());
        work
    };
    let _guard = NestedGuard {
        app: app.clone(),
        key: scene.into(),
    };
    execute(app, run, work, control).await
}
async fn restore_simple_layout(
    app: &tauri::AppHandle,
    run: &str,
    layout: &crate::window_manager::Layout,
    e: &crate::v2::models::Extension,
    control: &crate::runtime::Control,
    prior: &'static str,
) -> Result<&'static str> {
    {
        let db = app.state::<Db>();
        let g = db.lock()?;
        g.conn.execute(
            "INSERT INTO workflow_runs VALUES(?1,?2,?3)",
            params![run, layout.id, layout.name],
        )?;
        g.conn.execute("INSERT INTO workflow_execution_logs VALUES(?1,?2,?3,?4,'layout',?5,NULL,'running','null','')",params![id(),run,layout.id,layout.name,now()])?;
    }
    changed(app);
    let result = crate::window_manager::restore(
        layout,
        &e.layouts,
        15,
        &std::collections::HashMap::new(),
        control,
    )
    .await?;
    let failed = result.iter().any(|r| r.status == "failed");
    {
        let db = app.state::<Db>();
        let g = db.lock()?;
        g.conn.execute("UPDATE workflow_execution_logs SET status=?1,finished_at=?2,result_json=?3,error_message=?4 WHERE run_id=?5",params![if failed{"failed"}else{"completed"},now(),serde_json::to_string(&result)?,if failed{"部分窗口恢复失败。"}else{""},run])?;
    }
    Ok(if failed {
        if prior == "launch_requested" {
            "partial"
        } else {
            "failed"
        }
    } else {
        prior
    })
}
fn notify(app: &tauri::AppHandle, name: &str, status: &str) {
    use tauri_plugin_notification::NotificationExt;
    let enabled = {
        let db = app.state::<Db>();
        db.lock()
            .and_then(|g| database::config(&g.conn))
            .is_ok_and(|c| c.settings.notifications)
    };
    if enabled {
        let body = format!(
            "{name}：{}",
            match status {
                "failed" => "执行失败，请查看运行日志。",
                "partial" => "部分任务失败，请查看运行日志。",
                "skipped" => "任务已跳过。",
                _ => "启动请求已提交。",
            }
        );
        if let Err(e) = app
            .notification()
            .builder()
            .title("StartFlow")
            .body(body)
            .show()
        {
            eprintln!("StartFlow notification: {e}");
        }
    }
}
