use super::{coordinator, repository, Automation};
use crate::{
    context::Snapshot,
    database::Db,
    error::{AppError, Result},
    models::{id, now},
    rules::models::*,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;
#[derive(Serialize)]
pub struct Status {
    pub config: Config,
    pub context: Snapshot,
    pub decisions: Vec<Decision>,
    pub manual_override: Option<Override>,
    pub current_mode: Option<String>,
    pub stable_seconds: u64,
    pub subscription_error: Option<String>,
    pub paused: bool,
}
#[tauri::command]
pub fn v3_snapshot(app: tauri::AppHandle) -> Result<Status> {
    let state = app.state::<Automation>();
    let live = state.live.lock().map_err(AppError::internal)?;
    let context = live.snapshot.clone();
    let stable_seconds = live.stable_since.elapsed().as_secs();
    let current_mode = live.current_mode.clone();
    let subscription_error = live.subscription_error.clone();
    drop(live);
    let db = app.state::<Db>();
    let g = db.lock()?;
    let config = repository::load(&g.conn)?;
    let context = context.permitted(&config.permissions);
    let mut manual_override = repository::current_override(&g.conn)?;
    if manual_override.as_ref().is_some_and(|o| {
        o.expires_at.as_ref().is_some_and(|t| {
            chrono::DateTime::parse_from_rfc3339(t).is_ok_and(|v| v <= chrono::Utc::now())
        })
    }) {
        manual_override = None;
    }
    let current_mode = manual_override
        .as_ref()
        .map(|o| o.mode_id.clone())
        .or(current_mode);
    Ok(Status {
        config,
        context,
        decisions: repository::decisions(&g.conn)?,
        manual_override,
        current_mode,
        stable_seconds,
        subscription_error,
        paused: crate::database::config(&g.conn)?.settings.paused,
    })
}
#[tauri::command]
pub async fn v3_save(app: tauri::AppHandle, mut config: Config) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Automation>();
        let _gate = state.gate.lock().map_err(AppError::internal)?;
        let db = app.state::<Db>();
        let mut g = db.lock()?;
        let old = repository::load(&g.conn)?;
        for rule in &mut config.rules {
            if let Some(previous) = old.rules.iter().find(|r| r.id == rule.id) {
                rule.created_at = previous.created_at.clone();
                let mut comparable = rule.clone();
                comparable.version = previous.version;
                comparable.updated_at = previous.updated_at.clone();
                rule.version =
                    if serde_json::to_string(&comparable)? == serde_json::to_string(previous)? {
                        previous.version
                    } else {
                        previous
                            .version
                            .checked_add(1)
                            .ok_or_else(|| AppError::new("rule", "规则版本超出限制。"))?
                    };
            } else {
                rule.version = 1;
                rule.created_at = now();
            }
            rule.updated_at = now();
        }
        let tx = g.conn.transaction()?;
        repository::write(&tx, &config)?;
        tx.commit()?;
        drop(g);
        super::reconfigure(&app);
        crate::engine::changed(&app);
        Ok(())
    })
    .await
    .map_err(AppError::internal)?
}
#[tauri::command]
pub fn v3_refresh(app: tauri::AppHandle) -> Result<()> {
    app.state::<Automation>()
        .refresh
        .store(true, std::sync::atomic::Ordering::Release);
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Simulation {
    pub snapshot: Snapshot,
    pub kind: EventKind,
    pub schedule_id: Option<String>,
    pub include_runtime_guards: bool,
    pub stable_seconds: u64,
}
pub fn validate_snapshot(snapshot: &Snapshot) -> Result<()> {
    if snapshot.schema_version != 1
        || snapshot.processes.len() > 128
        || snapshot.services.len() > 8
        || snapshot.displays.value.as_ref().is_some_and(|d| {
            d.len() > 16
                || d.iter().any(|v| {
                    v.width <= 0 || v.height <= 0 || !v.scale.is_finite() || v.scale <= 0.0
                })
        })
        || snapshot.battery_percentage.value.is_some_and(|p| p > 100)
        || snapshot
            .wifi_ssid
            .value
            .as_ref()
            .is_some_and(|v| v.len() > 32)
    {
        return Err(AppError::new("context", "模拟环境字段不合法或超出限制。"));
    }
    chrono::DateTime::parse_from_rfc3339(&snapshot.captured_at)
        .map_err(|_| AppError::new("context", "模拟时间应包含日期、时间和时区。"))?;
    Ok(())
}
#[tauri::command]
pub async fn v3_simulate(app: tauri::AppHandle, simulation: Simulation) -> Result<Vec<Decision>> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_snapshot(&simulation.snapshot)?;
        let db = app.state::<Db>();
        let g = db.lock()?;
        let c = repository::load(&g.conn)?;
        crate::rules::validator::validate(
            &c,
            &crate::database::config(&g.conn)?,
            &crate::v2::repository::load(&g.conn)?,
        )?;
        let mut input = repository::inputs(&g.conn, g.active.clone(), simulation.stable_seconds)?;
        if !simulation.include_runtime_guards {
            input.paused = false;
            input.active_scenes.clear();
            input.last_actions.clear();
            input.override_mode = None;
        }
        let event = Event {
            id: id(),
            key: "dry_run".into(),
            kind: simulation.kind,
            occurred_at: simulation.snapshot.captured_at.clone(),
            schedule_id: simulation.schedule_id,
        };
        coordinator::dry_run(&c, &simulation.snapshot, &event, &input)
    })
    .await
    .map_err(AppError::internal)?
}
#[tauri::command]
pub async fn v3_confirm(
    app: tauri::AppHandle,
    decision_id: String,
    accept: bool,
) -> Result<Vec<Decision>> {
    let (decision, evaluation) = {
        let db = app.state::<Db>();
        let g = db.lock()?;
        let (d, r, _) = repository::history(&g.conn, &decision_id)?;
        (d, r)
    };
    if decision.decision != "waiting_confirmation" {
        return Err(AppError::new(
            "confirmation",
            "这条建议已处理或不是待确认状态。",
        ));
    }
    if !accept {
        let state = app.state::<Automation>();
        let _gate = state.gate.lock().map_err(AppError::internal)?;
        let db = app.state::<Db>();
        let g = db.lock()?;
        let status: String = g.conn.query_row(
            "SELECT status FROM automation_decisions WHERE id=?1",
            [&decision_id],
            |r| r.get(0),
        )?;
        if status != "waiting_confirmation" {
            return Err(AppError::new("confirmation", "这条建议已经处理。"));
        }
        let mut d = decision;
        d.decision = "cancelled".into();
        d.reasons.push("用户拒绝了此次建议。".into());
        repository::save_decision(&g.conn, &d, &evaluation)?;
        drop(g);
        crate::engine::changed(&app);
        return Ok(vec![d]);
    }
    if chrono::DateTime::parse_from_rfc3339(&decision.evaluated_at)
        .is_ok_and(|t| chrono::Utc::now().signed_duration_since(t).num_minutes() > 10)
    {
        return Err(AppError::new(
            "confirmation",
            "建议已超过 10 分钟，请重新评估当前环境。",
        ));
    }
    let (config, legacy, session, stable) = {
        let state = app.state::<Automation>();
        let live = state.live.lock().map_err(AppError::internal)?;
        let db = app.state::<Db>();
        let g = db.lock()?;
        (
            repository::load(&g.conn)?,
            crate::database::config(&g.conn)?,
            live.snapshot
                .session
                .value
                .clone()
                .unwrap_or("unknown".into()),
            live.stable_since.elapsed().as_secs(),
        )
    };
    if !config
        .rules
        .iter()
        .any(|r| r.id == decision.rule_id && r.version == decision.rule_version && r.enabled)
    {
        return Err(AppError::new(
            "confirmation",
            "规则已修改或停用，请重新评估。",
        ));
    }
    let mut snapshot = tauri::async_runtime::spawn_blocking(move || {
        crate::environment::providers::capture(&config, &legacy, &session)
    })
    .await
    .map_err(AppError::internal)?;
    let config = {
        let db = app.state::<Db>();
        let result = repository::load(&db.lock()?.conn)?;
        result
    };
    tokio::time::timeout(
        std::time::Duration::from_secs(8),
        crate::environment::providers::probe_services(&mut snapshot, &config),
    )
    .await
    .map_err(|_| AppError::new("timeout", "重新检测环境超时，未执行。"))?;
    let event = Event {
        id: id(),
        key: format!("confirmation:{}", decision.id),
        kind: EventKind::Refresh,
        occurred_at: now(),
        schedule_id: None,
    };
    let stable = if snapshot.fingerprint()
        == app
            .state::<Automation>()
            .live
            .lock()
            .map_err(AppError::internal)?
            .snapshot
            .fingerprint()
    {
        stable
    } else {
        0
    };
    tauri::async_runtime::spawn_blocking(move || {
        coordinator::evaluate(
            &app,
            &snapshot,
            &event,
            stable,
            Some((&decision.rule_id, decision.rule_version, &decision.id)),
        )
    })
    .await
    .map_err(AppError::internal)?
}
#[derive(Serialize)]
pub struct ModeResult {
    pub execution_run_ids: Vec<String>,
    pub errors: Vec<String>,
}
#[tauri::command]
pub async fn v3_switch_mode(
    app: tauri::AppHandle,
    mode_id: String,
    hold: String,
) -> Result<ModeResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Automation>();
        let _gate = state.gate.lock().map_err(AppError::internal)?;
        let db = app.state::<Db>();
        let mode = repository::load(&db.lock()?.conn)?
            .modes
            .into_iter()
            .find(|m| m.id == mode_id && m.enabled)
            .ok_or_else(|| AppError::new("mode", "工作模式不存在或已停用。"))?;
        let current = chrono::Local::now();
        let expires_at = match hold.as_str() {
            "hour" => Some((current + chrono::Duration::hours(1)).to_rfc3339()),
            "day" => {
                use chrono::TimeZone;
                let tomorrow = current
                    .date_naive()
                    .succ_opt()
                    .ok_or_else(|| AppError::new("time", "日期超出范围。"))?;
                Some(
                    chrono::Local
                        .from_local_datetime(&tomorrow.and_time(chrono::NaiveTime::MIN))
                        .latest()
                        .ok_or_else(|| AppError::new("time", "无法确定本地日期结束。"))?
                        .to_rfc3339(),
                )
            }
            "login" | "manual" => None,
            _ => return Err(AppError::new("mode", "请选择有效的覆盖期限。")),
        };
        let value = Override {
            id: id(),
            mode_id: mode.id.clone(),
            kind: hold,
            expires_at,
            created_at: now(),
        };
        {
            let mut g = db.lock()?;
            let tx = g.conn.transaction()?;
            tx.execute("DELETE FROM automation_overrides", [])?;
            tx.execute(
                "INSERT INTO automation_overrides VALUES(?1,?2,?3)",
                rusqlite::params![value.id, value.mode_id, serde_json::to_string(&value)?],
            )?;
            tx.commit()?;
        }
        state.live.lock().map_err(AppError::internal)?.current_mode = Some(mode.id);
        let mut result = ModeResult {
            execution_run_ids: vec![],
            errors: vec![],
        };
        for target in mode.targets {
            match crate::engine::submit_scene_with_workflow(
                &app,
                &target.scene_id,
                "manual",
                None,
                target.workflow_id.as_deref(),
            ) {
                Ok(run) => result.execution_run_ids.push(run),
                Err(e) => result.errors.push(e.message),
            }
        }
        crate::engine::changed(&app);
        Ok(result)
    })
    .await
    .map_err(AppError::internal)?
}
#[tauri::command]
pub fn v3_clear_override(app: tauri::AppHandle) -> Result<()> {
    app.state::<Db>()
        .lock()?
        .conn
        .execute("DELETE FROM automation_overrides", [])?;
    app.state::<Automation>()
        .refresh
        .store(true, std::sync::atomic::Ordering::Release);
    crate::engine::changed(&app);
    Ok(())
}
#[tauri::command]
pub async fn v3_trust_network(
    app: tauri::AppHandle,
    name: String,
    ssid: String,
) -> Result<TrustedNetwork> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::workflow::validator::label(&name, 80)?;
        if ssid.is_empty() || ssid.len() > 32 || ssid.contains('\0') {
            return Err(AppError::new("wifi", "SSID 应为 1～32 个 UTF-8 字节。"));
        }
        #[cfg(windows)]
        let sealed_ssid = crate::environment::windows::seal(&ssid)?;
        #[cfg(not(windows))]
        let sealed_ssid = {
            let _ = ssid;
            return Err(AppError::new(
                "platform",
                "受保护的网络配置仅支持 Windows。",
            ));
        };
        let network = TrustedNetwork {
            id: id(),
            name,
            sealed_ssid,
        };
        let state = app.state::<Automation>();
        let _gate = state.gate.lock().map_err(AppError::internal)?;
        let db = app.state::<Db>();
        let mut g = db.lock()?;
        let mut config = repository::load(&g.conn)?;
        config.networks.push(network.clone());
        let tx = g.conn.transaction()?;
        repository::write(&tx, &config)?;
        tx.commit()?;
        drop(g);
        super::reconfigure(&app);
        crate::engine::changed(&app);
        Ok(network)
    })
    .await
    .map_err(AppError::internal)?
}
#[tauri::command]
pub fn v3_clear_history(app: tauri::AppHandle) -> Result<()> {
    let db = app.state::<Db>();
    let mut g = db.lock()?;
    let tx = g.conn.transaction()?;
    tx.execute("DELETE FROM automation_decisions", [])?;
    tx.execute("DELETE FROM automation_events", [])?;
    tx.execute("DELETE FROM environment_snapshots", [])?;
    tx.execute("DELETE FROM automation_config_versions", [])?;
    tx.commit()?;
    drop(g);
    crate::engine::changed(&app);
    Ok(())
}
#[tauri::command]
pub fn v3_replay(app: tauri::AppHandle, decision_id: String) -> Result<Vec<Decision>> {
    let db = app.state::<Db>();
    let g = db.lock()?;
    let (decision, evaluation, snapshot) = repository::history(&g.conn, &decision_id)?;
    let mut result = coordinator::dry_run(
        &evaluation.config,
        &snapshot,
        &evaluation.event,
        &evaluation.inputs,
    )?;
    for d in &mut result {
        d.reasons.push(format!(
            "历史回放，规则版本 {} / 快照版本 {}；无系统操作。",
            decision.rule_version, snapshot.schema_version
        ));
    }
    Ok(result)
}
