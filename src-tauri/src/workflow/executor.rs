use super::models::*;
use crate::{
    database::Db,
    engine,
    error::{AppError, Result},
    models::{id, now, Config},
    runtime::Control,
    v2::models::Extension,
};
use rusqlite::params;
use std::collections::HashMap;
use tauri::Manager;
pub fn prepare(conn: &rusqlite::Connection, run: &str, w: &Workflow) -> Result<()> {
    conn.execute(
        "INSERT INTO workflow_runs VALUES(?1,?2,?3)",
        params![run, w.id, w.name],
    )?;
    for n in &w.nodes {
        conn.execute("INSERT INTO workflow_execution_logs VALUES(?1,?2,?3,?4,?5,NULL,NULL,'pending','null','')",params![id(),run,n.id,n.name,n.config.kind()])?;
    }
    Ok(())
}
fn update(
    app: &tauri::AppHandle,
    run: &str,
    node: &str,
    status: &str,
    result: serde_json::Value,
    message: &str,
    finished: bool,
) -> Result<()> {
    let db = app.state::<Db>();
    let g = db.lock()?;
    g.conn.execute(if finished {"UPDATE workflow_execution_logs SET status=?1,result_json=?2,error_message=?3,finished_at=?4 WHERE run_id=?5 AND node_id=?6"}else{"UPDATE workflow_execution_logs SET status=?1,result_json=?2,error_message=?3,started_at=?4 WHERE run_id=?5 AND node_id=?6"},params![status,serde_json::to_string(&result)?,message,now(),run,node])?;
    drop(g);
    engine::changed(app);
    Ok(())
}
pub fn settle(app: &tauri::AppHandle, run: &str, status: &str) -> Result<()> {
    let db = app.state::<Db>();
    let g = db.lock()?;
    g.conn.execute("UPDATE workflow_execution_logs SET status='skipped',finished_at=?1,error_message=?2 WHERE run_id=?3 AND status='pending'",params![now(),if status=="completed"{"未选择的条件分支。"}else{"流程已停止，节点未提交。"},run])?;
    g.conn.execute("UPDATE workflow_execution_logs SET status=?1,finished_at=?2,error_message=?3 WHERE run_id=?4 AND status='running'",params![status,now(),match status{"cancelled"=>"用户已取消等待。","timed_out"=>"已达到工作流最长运行时间。",_=>"流程执行已中断。"},run])?;
    Ok(())
}
pub async fn execute(
    app: &tauri::AppHandle,
    run: &str,
    w: &Workflow,
    c: &Config,
    e: &Extension,
    control: &Control,
) -> Result<&'static str> {
    let mut next = w
        .nodes
        .iter()
        .find(|n| matches!(n.config, NodeConfig::Start))
        .map(|n| n.id.clone())
        .ok_or_else(|| AppError::new("workflow", "缺少开始节点。"))?;
    let mut errors = false;
    let mut pids = HashMap::new();
    for _ in 0..w.nodes.len() {
        control.check()?;
        let n = w
            .nodes
            .iter()
            .find(|n| n.id == next)
            .ok_or_else(|| AppError::new("workflow", "节点引用无效。"))?;
        update(
            app,
            run,
            &n.id,
            "running",
            serde_json::Value::Null,
            "",
            false,
        )?;
        let mut handle = "next";
        let result: Result<(&str, serde_json::Value)> = async {
            match &n.config {
                NodeConfig::Start | NodeConfig::End => Ok(("completed", serde_json::Value::Null)),
                NodeConfig::Web { task_id }
                | NodeConfig::App { task_id }
                | NodeConfig::Folder { task_id } => {
                    let t = c
                        .tasks
                        .iter()
                        .find(|t| t.id == *task_id)
                        .ok_or_else(|| AppError::new("workflow", "关联任务不存在。"))?;
                    let outcome = crate::runtime::task(t, control).await?;
                    if let Some(pid) = outcome.pid {
                        pids.insert(
                            if t.kind == "web" {
                                t.browser_path.clone()
                            } else {
                                t.executable_path.clone()
                            },
                            pid,
                        );
                    }
                    Ok((
                        outcome.status,
                        serde_json::json!({"message":outcome.message,"pid":outcome.pid}),
                    ))
                }
                NodeConfig::Delay { milliseconds } => {
                    control
                        .wait(std::time::Duration::from_millis(*milliseconds))
                        .await?;
                    Ok(("completed", serde_json::json!({"waited_ms":milliseconds})))
                }
                NodeConfig::Condition { mode, conditions } => {
                    let result = crate::conditions::group(mode, conditions, control).await?;
                    handle = if result { "true" } else { "false" };
                    Ok((
                        "completed",
                        serde_json::json!({"condition":result,"branch":handle}),
                    ))
                }
                NodeConfig::Network {
                    mode,
                    url,
                    timeout_seconds,
                } => {
                    crate::conditions::wait_network(mode, url, *timeout_seconds, control).await?;
                    Ok((
                        "completed",
                        serde_json::json!({"mode":mode,"available":true}),
                    ))
                }
                NodeConfig::Layout {
                    layout_id,
                    timeout_seconds,
                } => {
                    let l = e
                        .layouts
                        .iter()
                        .find(|l| l.id == *layout_id)
                        .ok_or_else(|| AppError::new("layout", "窗口布局不存在。"))?;
                    let results = crate::window_manager::restore(
                        l,
                        &e.layouts,
                        *timeout_seconds,
                        &pids,
                        control,
                    )
                    .await?;
                    let failed = results.iter().any(|r| r.status == "failed");
                    if failed {
                        update(
                            app,
                            run,
                            &n.id,
                            "running",
                            serde_json::to_value(&results)?,
                            "",
                            false,
                        )?;
                        return Err(AppError::new(
                            "layout",
                            "部分窗口布局恢复失败，请查看节点结果。",
                        ));
                    }
                    Ok(("completed", serde_json::to_value(results)?))
                }
                NodeConfig::Notification { title, body, level } => {
                    use tauri_plugin_notification::NotificationExt;
                    if c.settings.notifications {
                        app.notification()
                            .builder()
                            .title(title)
                            .body(format!(
                                "{}：{}",
                                match level.as_str() {
                                    "success" => "成功",
                                    "warning" => "注意",
                                    "error" => "错误",
                                    _ => "提示",
                                },
                                body
                            ))
                            .show()
                            .map_err(|_| AppError::new("notification", "系统通知提交失败。"))?;
                        Ok((
                            "completed",
                            serde_json::json!({"notification_requested":true}),
                        ))
                    } else {
                        Ok(("skipped", serde_json::json!({"message":"执行通知已关闭。"})))
                    }
                }
                NodeConfig::Scene { scene_id } => {
                    let result =
                        engine::execute_nested_simple(app, run, scene_id, c, control).await?;
                    if ["failed", "partial"].contains(&result) {
                        return Err(AppError::new("scene", "关联简单场景中有任务执行失败。"));
                    }
                    Ok(("completed", serde_json::json!({"scene_status":result})))
                }
            }
        }
        .await;
        match result {
            Ok((status, result)) => update(app, run, &n.id, status, result, "", true)?,
            Err(error) => {
                if error.code == "cancelled" {
                    return Err(error);
                }
                errors = true;
                let previous = {
                    let db = app.state::<Db>();
                    let g = db.lock()?;
                    g.conn.query_row("SELECT result_json FROM workflow_execution_logs WHERE run_id=?1 AND node_id=?2",params![run,n.id],|r|r.get::<_,String>(0))?
                };
                update(
                    app,
                    run,
                    &n.id,
                    "failed",
                    serde_json::from_str(&previous)?,
                    &error.message,
                    true,
                )?;
                if n.on_error == "stop" {
                    return Err(error);
                }
            }
        }
        if matches!(n.config, NodeConfig::End) {
            return Ok(if errors { "partial" } else { "completed" });
        }
        next = w
            .edges
            .iter()
            .find(|a| a.source == n.id && a.handle == handle)
            .map(|a| a.target.clone())
            .ok_or_else(|| AppError::new("workflow", "后续连线缺失。"))?;
    }
    Err(AppError::new("workflow", "流程超过最大节点步数，已停止。"))
}
pub fn convert(scene_id: &str, c: &Config) -> Result<Workflow> {
    let scene = c
        .scenes
        .iter()
        .find(|s| s.id == scene_id)
        .ok_or_else(|| AppError::new("not_found", "场景不存在。"))?;
    let mut nodes = vec![Node {
        id: id(),
        name: "开始".into(),
        x: 0.,
        y: 0.,
        config: NodeConfig::Start,
        on_error: "stop".into(),
    }];
    let mut links: Vec<_> = c
        .scene_tasks
        .iter()
        .filter(|a| a.scene_id == scene_id)
        .collect();
    links.sort_by_key(|a| a.sort_order);
    for a in links {
        let t = c
            .tasks
            .iter()
            .find(|t| t.id == a.task_id)
            .ok_or_else(|| AppError::new("workflow", "关联任务不存在。"))?;
        let config = match t.kind.as_str() {
            "web" => NodeConfig::Web {
                task_id: t.id.clone(),
            },
            "app" => NodeConfig::App {
                task_id: t.id.clone(),
            },
            _ => NodeConfig::Folder {
                task_id: t.id.clone(),
            },
        };
        nodes.push(Node {
            id: id(),
            name: t.name.clone(),
            x: nodes.len() as f64 * 250.,
            y: 0.,
            config,
            on_error: "continue".into(),
        });
    }
    nodes.push(Node {
        id: id(),
        name: "结束".into(),
        x: nodes.len() as f64 * 250.,
        y: 0.,
        config: NodeConfig::End,
        on_error: "stop".into(),
    });
    let edges = nodes
        .windows(2)
        .map(|a| Edge {
            id: id(),
            source: a[0].id.clone(),
            target: a[1].id.clone(),
            handle: "next".into(),
        })
        .collect();
    Ok(Workflow {
        id: id(),
        scene_id: scene_id.into(),
        name: format!("{} · 工作流", scene.name),
        description: "从简单列表创建的独立草稿；原任务列表仍保留。".into(),
        schema_version: 1,
        enabled: true,
        max_seconds: 3600,
        nodes,
        edges,
        created_at: now(),
        updated_at: now(),
    })
}
