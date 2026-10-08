use crate::{
    database::{self, Db},
    error::{AppError, Result},
    launcher,
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
    let db = app.state::<Db>();
    let mut g = db.lock()?;
    let c = database::config(&g.conn)?;
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
    if tasks.is_empty() {
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
    for task in tasks {
        let log_id = id();
        tx.execute(
            "INSERT INTO execution_logs VALUES(?1,?2,?3,?4,NULL,NULL,'pending','等待执行。')",
            params![log_id, run_id, task.id, task.name],
        )?;
        work.push((log_id, task));
    }
    tx.commit()?;
    g.active.insert(scene_id.into());
    drop(g);
    changed(app);
    let app = app.clone();
    let scene_id = scene_id.to_owned();
    let result = run_id.clone();
    let name = scene.name.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = execute(&app, &run_id, work).await;
        let status = match &outcome {
            Ok(s) => *s,
            Err(_) => "failed",
        };
        {
            let db = app.state::<Db>();
            match db.lock() {
                Ok(mut g) => {
                    g.active.remove(&scene_id);
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
    g.active.insert(key.clone());
    drop(g);
    changed(app);
    let result = run_id.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = execute(&app, &run_id, vec![(log_id, task)]).await;
        let status = outcome.as_ref().copied().unwrap_or("failed");
        {
            let db = app.state::<Db>();
            if let Ok(mut g) = db.lock() {
                g.active.remove(&key);
                if let Err(e) = g.conn.execute(
                    "UPDATE execution_runs SET status=?1,finished_at=?2 WHERE id=?3",
                    params![status, now(), run_id],
                ) {
                    report_error(&app, &e.into());
                }
            };
        }
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
) -> Result<&'static str> {
    let mut failures = 0;
    let mut launches = 0;
    for (log, t) in work {
        update(app, &log, "running", "正在等待并提交启动请求。", false)?;
        if !t.enabled {
            update(app, &log, "skipped", "该任务已停用。", true)?;
            continue;
        }
        tokio::time::sleep(std::time::Duration::from_millis(t.delay_ms)).await;
        if t.kind == "web" && t.wait_for_network {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
            while !launcher::network_available() && std::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            if !launcher::network_available() {
                failures += 1;
                update(
                    app,
                    &log,
                    "failed",
                    "等待可用网络接口超时（30 秒）。请检查网络连接。",
                    true,
                )?;
                continue;
            }
        }
        let outcome = tauri::async_runtime::spawn_blocking(move || launcher::launch(&t))
            .await
            .map_err(|e| AppError::internal(format!("launcher worker: {e}")))?;
        match outcome {
            Ok((status, msg)) => {
                if status == "launch_requested" {
                    launches += 1;
                }
                update(app, &log, status, msg, true)?;
            }
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
