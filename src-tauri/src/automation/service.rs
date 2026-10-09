use super::{coordinator, repository, Automation};
use crate::{
    database::Db,
    environment::{events::Debouncer, EnvironmentProvider, SystemProvider},
    error::{AppError, Result},
    rules::models::*,
};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
pub fn start(app: tauri::AppHandle, login: bool) -> Result<()> {
    let owner = app.clone();
    let worker = std::thread::Builder::new()
        .name("StartFlow environment coordinator".into())
        .spawn(move || {
            if let Err(error) = run(&app, login) {
                if let Ok(mut live) = app.state::<Automation>().live.lock() {
                    live.subscription_error = Some(error.message.clone());
                }
                crate::engine::report_error(&app, &error);
            }
        })
        .map_err(AppError::internal)?;
    *owner
        .state::<Automation>()
        .worker
        .lock()
        .map_err(AppError::internal)? = Some(worker);
    Ok(())
}
pub fn stop(app: &tauri::AppHandle) {
    let state = app.state::<Automation>();
    state.stop.store(true, Ordering::Release);
    if let Ok(mut worker) = state.worker.lock() {
        if let Some(worker) = worker.take() {
            let _ = worker.join();
        }
    };
}
fn run(app: &tauri::AppHandle, login: bool) -> Result<()> {
    let state = app.state::<Automation>();
    let db = app.state::<Db>();
    let mut config = repository::load(&db.lock()?.conn)?;
    let mut legacy = crate::database::config(&db.lock()?.conn)?;
    if login {
        db.lock()?.conn.execute(
            "DELETE FROM automation_overrides WHERE json_extract(payload,'$.kind')='login'",
            [],
        )?;
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(16);
    #[cfg(windows)]
    let subscriptions = crate::environment::subscriptions::Subscriptions::start(
        sender.clone(),
        &config.permissions,
    );
    let mut provider = SystemProvider;
    let started = Instant::now();
    let mut last_capture = Instant::now() - Duration::from_secs(120);
    let mut last_minute = String::new();
    let mut last_prune = Instant::now() - Duration::from_secs(7200);
    let mut revision = state.revision.load(Ordering::Acquire);
    let mut paused = legacy.settings.paused;
    let mut debounce = Debouncer::default();
    let mut pending_login = login;
    let mut state_version: u64 = 0;
    let mut fingerprint = String::new();
    let identity: Option<String> = db
        .lock()?
        .conn
        .query_row(
            "SELECT value_json FROM settings WHERE key='environment_identity'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(json) = identity {
        if let Ok((hash, version)) = serde_json::from_str::<(String, u64)>(&json) {
            fingerprint = hash;
            state_version = version;
        }
    }
    loop {
        if state.stop.load(Ordering::Acquire) {
            break;
        }
        let native_event = match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(kind) => Some(kind),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
            Err(_) => break,
        };
        let changed = revision != state.revision.load(Ordering::Acquire);
        let explicit = state.refresh.swap(false, Ordering::AcqRel);
        if changed {
            revision = state.revision.load(Ordering::Acquire);
            config = repository::load(&db.lock()?.conn)?;
            legacy = crate::database::config(&db.lock()?.conn)?;
            #[cfg(windows)]
            if let Ok(subscription) = &subscriptions {
                subscription.configure(&config.permissions)?;
            }
            // Only latest state is considered on resume, never an old event backlog.
            if paused && !legacy.settings.paused && config.enabled {
                debounce.observe(
                    EventKind::Refresh,
                    started.elapsed().as_millis() as u64,
                    5000,
                );
            }
            paused = legacy.settings.paused;
        }
        let process_interval = if config.permissions.processes
            && !crate::environment::providers::selected(&config)
                .0
                .is_empty()
        {
            15
        } else {
            60
        };
        let capture = native_event.is_some()
            || changed
            || explicit
            || last_capture.elapsed() >= Duration::from_secs(process_interval);
        if capture {
            #[cfg(windows)]
            let session = subscriptions
                .as_ref()
                .map(|s| s.session_state())
                .unwrap_or("unknown");
            #[cfg(not(windows))]
            let session = "unknown";
            let mut fresh = provider.capture(&config, &legacy, session);
            let _ = tauri::async_runtime::block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(8),
                    crate::environment::providers::probe_services(&mut fresh, &config),
                )
                .await
            });
            let hash = fresh.fingerprint();
            let previous = state
                .live
                .lock()
                .map_err(AppError::internal)?
                .snapshot
                .clone();
            if hash != fingerprint {
                state_version = state_version.saturating_add(1);
                fingerprint = hash;
                db.lock()?.conn.execute("INSERT INTO settings VALUES('environment_identity',?1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",[serde_json::to_string(&(fingerprint.clone(),state_version))?])?;
                if last_capture.elapsed() < Duration::from_secs(3600)
                    && previous.network_connected.status
                        != crate::context::Availability::Unavailable
                {
                    for (different, kind) in [
                        (
                            previous.network_connected != fresh.network_connected
                                || previous.network_type != fresh.network_type
                                || previous.wifi_network_id != fresh.wifi_network_id,
                            EventKind::Network,
                        ),
                        (previous.displays != fresh.displays, EventKind::Displays),
                        (
                            previous.power_source != fresh.power_source
                                || previous.battery_percentage != fresh.battery_percentage,
                            EventKind::Power,
                        ),
                        (previous.processes != fresh.processes, EventKind::Processes),
                    ] {
                        if different {
                            debounce.observe(
                                kind,
                                started.elapsed().as_millis() as u64,
                                stable_window(&config),
                            );
                        }
                    }
                }
                state.live.lock().map_err(AppError::internal)?.stable_since = Instant::now();
            }
            {
                let mut live = state.live.lock().map_err(AppError::internal)?;
                live.snapshot = fresh;
                live.config = config.clone();
                #[cfg(windows)]
                if let Err(error) = &subscriptions {
                    live.subscription_error = Some(error.message.clone());
                }
            }
            last_capture = Instant::now();
            let _ = app.emit("automation-changed", ());
        }
        if let Some(kind) = native_event {
            debounce.observe(
                kind,
                started.elapsed().as_millis() as u64,
                stable_window(&config),
            );
        }
        if explicit {
            debounce.observe(
                EventKind::Refresh,
                started.elapsed().as_millis() as u64,
                stable_window(&config),
            );
        }
        if pending_login {
            debounce.observe(
                EventKind::Login,
                started.elapsed().as_millis() as u64,
                stable_window(&config),
            );
            pending_login = false;
        }
        for kind in debounce.due(started.elapsed().as_millis() as u64) {
            let (mut snapshot, stable) = {
                let live = state.live.lock().map_err(AppError::internal)?;
                (live.snapshot.clone(), live.stable_since.elapsed().as_secs())
            };
            snapshot.id = crate::models::id();
            snapshot.captured_at = chrono::Local::now().to_rfc3339();
            let key = if kind == EventKind::Refresh {
                format!("refresh:{}", crate::models::id())
            } else if kind == EventKind::Login {
                format!("login:{}", chrono::Local::now().date_naive())
            } else {
                format!("environment:{kind:?}:{state_version}")
            };
            let event = Event {
                id: crate::models::id(),
                kind,
                key,
                occurred_at: chrono::Local::now().to_rfc3339(),
                schedule_id: None,
            };
            let _ = coordinator::evaluate(app, &snapshot, &event, stable, None)
                .map_err(|e| crate::engine::report_error(app, &e));
        }
        let now = chrono::Local::now();
        let minute = now.format("%Y-%m-%d %H:%M").to_string();
        let stable = state
            .live
            .lock()
            .map_err(AppError::internal)?
            .stable_since
            .elapsed()
            .as_secs();
        // Do not consume a scheduled occurrence before initialization/stability or while
        // paused. Retrying this minute once ready preserves a zero catch-up window.
        if minute != last_minute && scheduled_ready(&config, paused, stable) {
            last_minute = minute;
            for rule in config
                .rules
                .iter()
                .filter(|r| r.enabled && r.triggers.contains(&EventKind::Schedule))
            {
                if let Some(date) = due(rule, &now) {
                    let event = Event {
                        id: crate::models::id(),
                        kind: EventKind::Schedule,
                        key: format!("schedule:{}:{date}", rule.id),
                        occurred_at: now.to_rfc3339(),
                        schedule_id: Some(rule.id.clone()),
                    };
                    let (mut snapshot, stable) = {
                        let live = state.live.lock().map_err(AppError::internal)?;
                        (live.snapshot.clone(), live.stable_since.elapsed().as_secs())
                    };
                    snapshot.id = crate::models::id();
                    snapshot.captured_at = now.to_rfc3339();
                    let _ = coordinator::evaluate(app, &snapshot, &event, stable, None)
                        .map_err(|e| crate::engine::report_error(app, &e));
                }
            }
        }
        if last_prune.elapsed() >= Duration::from_secs(3600) {
            repository::prune(&db.lock()?.conn, config.retention_days)?;
            last_prune = Instant::now();
        }
    }
    drop(sender);
    Ok(())
}
fn stable_window(config: &Config) -> u64 {
    u64::from(
        config
            .rules
            .iter()
            .filter(|r| r.enabled)
            .map(|r| r.stability_seconds)
            .max()
            .unwrap_or(5)
            .max(5),
    ) * 1000
}
pub fn scheduled_ready(config: &Config, paused: bool, stable_seconds: u64) -> bool {
    config.enabled && !paused && stable_seconds.saturating_mul(1000) >= stable_window(config)
}
pub fn due<T: chrono::TimeZone>(rule: &Rule, now: &chrono::DateTime<T>) -> Option<String> {
    let s = rule.schedule.as_ref()?;
    let plan = crate::models::Schedule {
        id: rule.id.clone(),
        scene_id: rule.target.scene_id.clone(),
        trigger_type: "weekly".into(),
        time_of_day: s.time.clone(),
        weekdays: s.days.clone(),
        delay_seconds: 0,
        catch_up_minutes: s.catch_up_minutes,
        enabled: rule.enabled,
        created_at: String::new(),
        updated_at: String::new(),
    };
    crate::scheduler::due_date(&plan, now)
}
use rusqlite::OptionalExtension;
