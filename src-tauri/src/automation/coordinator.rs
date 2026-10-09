use super::{repository, Automation};
use crate::{
    context::Snapshot,
    database::Db,
    error::{AppError, Result},
    rules::{evaluator::FrozenClock, models::*, resolver},
};
use rusqlite::params;
use tauri::{Emitter, Manager};
fn clock(s: &Snapshot) -> Result<FrozenClock> {
    Ok(FrozenClock(
        chrono::DateTime::parse_from_rfc3339(&s.captured_at)
            .map_err(|_| AppError::new("context", "环境时间格式无效。"))?,
    ))
}
pub fn evaluate(
    app: &tauri::AppHandle,
    snapshot: &Snapshot,
    event: &Event,
    stable_seconds: u64,
    confirmed: Option<(&str, u32, &str)>,
) -> Result<Vec<Decision>> {
    let state = app.state::<Automation>();
    let _gate = state.gate.lock().map_err(AppError::internal)?;
    let db = app.state::<Db>();
    let (config, input) = {
        let g = db.lock()?;
        let config = repository::load(&g.conn)?;
        let mut input = repository::inputs(&g.conn, g.active.clone(), stable_seconds)?;
        input.confirmed_rule = confirmed.map(|v| v.0.to_owned());
        (config, input)
    };
    if let Some((id, version, _)) = confirmed {
        if !config
            .rules
            .iter()
            .any(|r| r.id == id && r.version == version && r.enabled)
        {
            return Err(AppError::new(
                "confirmation",
                "确认期间规则已修改，请重新评估。",
            ));
        }
    }
    let permitted = snapshot.permitted(&config.permissions);
    let started = std::time::Instant::now();
    let mut decisions = resolver::plan(&config, &permitted, event, &input, &clock(snapshot)?);
    if started.elapsed() > std::time::Duration::from_millis(500) {
        return Err(AppError::new("timeout", "规则评估超时，未执行。"));
    }
    if let Some((id, _, _)) = confirmed {
        decisions.retain(|d| d.rule_id == id);
    }
    let mut g = db.lock()?;
    let tx = g.conn.transaction()?;
    if let Some((_, _, id)) = confirmed {
        let (status, payload): (String, String) = tx.query_row(
            "SELECT status,payload FROM automation_decisions WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if status != "waiting_confirmation" {
            return Err(AppError::new("confirmation", "这条建议已经处理。"));
        }
        let mut original: Decision = serde_json::from_str(&payload)?;
        original.decision = "completed".into();
        original
            .reasons
            .push("用户已确认；请查看关联的重新评估记录。".into());
        tx.execute(
            "UPDATE automation_decisions SET status='completed',payload=?1 WHERE id=?2",
            params![serde_json::to_string(&original)?, id],
        )?;
    }
    if !repository::event(&tx, event)? {
        return Ok(vec![]);
    }
    repository::snapshot(&tx, snapshot)?;
    let evaluation = repository::Evaluation {
        config: config.clone(),
        event: event.clone(),
        inputs: input.clone(),
    };
    for decision in &decisions {
        repository::save_decision(&tx, decision, &evaluation)?;
        if ["execute", "notify", "waiting_confirmation"].contains(&decision.decision.as_str()) {
            tx.execute("INSERT INTO automation_rule_state VALUES(?1,?2) ON CONFLICT(rule_id) DO UPDATE SET last_action_at=excluded.last_action_at",params![decision.rule_id,decision.evaluated_at])?;
        }
    }
    tx.execute(
        "UPDATE automation_events SET status='completed' WHERE id=?1",
        [&event.id],
    )?;
    tx.commit()?;
    drop(g);
    // Claims/decisions are durable before Windows requests. A crash never replays this event.
    let mut output = vec![];
    for mut d in decisions {
        let rule = config
            .rules
            .iter()
            .find(|r| r.id == d.rule_id)
            .ok_or_else(|| AppError::new("rule", "规则已删除。"))?;
        if d.decision == "execute" {
            for target in &d.targets {
                let date = clock(snapshot)?.0.date_naive().to_string();
                match crate::engine::submit_scene_with_workflow(
                    app,
                    &target.scene_id,
                    "environment",
                    Some((&rule.id, &date)),
                    target.workflow_id.as_deref(),
                ) {
                    Ok(run) => d.execution_run_ids.push(run),
                    Err(e) => {
                        d.reasons.push(e.message);
                        d.decision =
                            if e.code == "busy" || e.code == "dedup" || e.code == "disabled" {
                                "skipped"
                            } else {
                                "failed"
                            }
                            .into();
                        break;
                    }
                }
            }
            if !d.execution_run_ids.is_empty() {
                if d.decision == "execute" {
                    d.decision = "running".into();
                }
                if let Some(mode) = &rule.mode_id {
                    state.live.lock().map_err(AppError::internal)?.current_mode =
                        Some(mode.clone());
                }
            }
        } else if d.decision == "notify" || d.decision == "waiting_confirmation" {
            let settings = crate::database::config(&db.lock()?.conn)?.settings;
            if settings.notifications {
                use tauri_plugin_notification::NotificationExt;
                if let Err(e) = app
                    .notification()
                    .builder()
                    .title("StartFlow 启动建议")
                    .body(format!(
                        "{}：条件已满足{}",
                        rule.name,
                        if d.decision == "waiting_confirmation" {
                            "，请在智能规则页面确认。"
                        } else {
                            "，仅提示，没有执行。"
                        }
                    ))
                    .show()
                {
                    d.reasons.push("系统通知未能显示，请查看决策记录。".into());
                    eprintln!("StartFlow notification: {e}");
                }
            }
        }
        {
            let g = db.lock()?;
            if d.decision == "running" {
                let mut statuses = vec![];
                for id in &d.execution_run_ids {
                    statuses.push(g.conn.query_row(
                        "SELECT status FROM execution_runs WHERE id=?1",
                        [id],
                        |r| r.get::<_, String>(0),
                    )?);
                }
                if !statuses.iter().any(|s| s == "running") {
                    d.decision = if statuses.iter().any(|s| {
                        s == "failed" || s == "interrupted" || s == "cancelled" || s == "timed_out"
                    }) {
                        statuses
                            .iter()
                            .find(|s| {
                                s.as_str() != "completed"
                                    && s.as_str() != "launch_requested"
                                    && s.as_str() != "skipped"
                            })
                            .cloned()
                            .unwrap_or("failed".into())
                    } else {
                        "completed".into()
                    };
                }
            }
            repository::save_decision(&g.conn, &d, &evaluation)?;
        }
        output.push(d);
    }
    let _ = app.emit("automation-changed", ());
    crate::engine::changed(app);
    Ok(output)
}
pub fn dry_run(
    config: &Config,
    snapshot: &Snapshot,
    event: &Event,
    input: &Inputs,
) -> Result<Vec<Decision>> {
    // Exactly the same evaluator/resolver. No provider, DB mutation or execution API is called.
    Ok(resolver::plan(
        config,
        snapshot,
        event,
        input,
        &clock(snapshot)?,
    ))
}
pub fn complete_run(app: &tauri::AppHandle, run: &str, _status: &str) -> Result<()> {
    let db = app.state::<Db>();
    let rows = repository::decisions(&db.lock()?.conn)?;
    for mut d in rows
        .into_iter()
        .filter(|d| d.execution_run_ids.iter().any(|id| id == run))
    {
        let g = db.lock()?;
        let mut statuses = vec![];
        for id in &d.execution_run_ids {
            let result: String =
                g.conn
                    .query_row("SELECT status FROM execution_runs WHERE id=?1", [id], |r| {
                        r.get(0)
                    })?;
            statuses.push(result);
        }
        if statuses.iter().any(|s| s == "running") {
            continue;
        }
        if d.decision == "failed" || d.decision == "skipped" {
            continue;
        }
        d.decision = if statuses
            .iter()
            .all(|s| s == "completed" || s == "launch_requested" || s == "skipped")
        {
            "completed"
        } else {
            statuses
                .iter()
                .find(|s| !["completed", "launch_requested", "skipped"].contains(&s.as_str()))
                .map(String::as_str)
                .unwrap_or("failed")
        }
        .into();
        g.conn.execute(
            "UPDATE automation_decisions SET status=?1,payload=?2 WHERE id=?3",
            params![d.decision, serde_json::to_string(&d)?, d.id],
        )?;
    }
    Ok(())
}
