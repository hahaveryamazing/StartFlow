use super::{evaluator::FrozenClock, models::*, resolver};
use crate::{
    context::{Field, Snapshot},
    models::{id, now},
};
pub fn fixture() -> (Config, Snapshot, Event, FrozenClock) {
    let rule = Rule {
        id: id(),
        name: "办公规则".into(),
        description: String::new(),
        enabled: true,
        version: 1,
        priority: 50,
        triggers: vec![EventKind::Unlock],
        condition: Condition {
            id: id(),
            enabled: true,
            expression: Expression::Network { connected: true },
        },
        target: Target {
            scene_id: id(),
            workflow_id: None,
        },
        mode_id: None,
        policy: "auto".into(),
        cooldown_seconds: 300,
        stability_seconds: 5,
        schedule: None,
        created_at: now(),
        updated_at: now(),
    };
    let config = Config {
        enabled: true,
        rules: vec![rule],
        ..Config::default()
    };
    let snapshot = Snapshot {
        network_connected: Field::available(true),
        captured_at: "2026-10-08T09:00:00+08:00".into(),
        ..Snapshot::default()
    };
    let event = Event {
        id: id(),
        kind: EventKind::Unlock,
        key: "unlock-state-1".into(),
        occurred_at: snapshot.captured_at.clone(),
        schedule_id: None,
    };
    let clock = FrozenClock(chrono::DateTime::parse_from_rfc3339(&snapshot.captured_at).unwrap());
    (config, snapshot, event, clock)
}
fn input() -> Inputs {
    Inputs {
        stable_seconds: 10,
        ..Inputs::default()
    }
}
#[test]
fn cooldown_and_stability_are_deterministic() {
    let (c, s, e, clock) = fixture();
    let mut i = input();
    i.stable_seconds = 3;
    assert!(resolver::plan(&c, &s, &e, &i, &clock)[0].reasons[0].contains("稳定"));
    i.stable_seconds = 10;
    i.last_actions
        .insert(c.rules[0].id.clone(), "2026-10-08T08:59:00+08:00".into());
    let d = &resolver::plan(&c, &s, &e, &i, &clock)[0];
    assert_eq!(d.decision, "skipped");
    assert_eq!(
        d.next_eligible_at.as_deref(),
        Some("2026-10-08T09:04:00+08:00")
    );
    i.last_actions
        .insert(c.rules[0].id.clone(), "2026-10-08T08:54:00+08:00".into());
    assert_eq!(
        resolver::plan(&c, &s, &e, &i, &clock)[0].decision,
        "execute"
    );
}
#[test]
fn override_expiry_and_global_pause() {
    let (c, s, e, clock) = fixture();
    let mut i = input();
    i.override_mode = Some(Override {
        id: id(),
        mode_id: id(),
        kind: "hour".into(),
        expires_at: Some("2026-10-08T10:00:00+08:00".into()),
        created_at: now(),
    });
    assert!(resolver::plan(&c, &s, &e, &i, &clock)[0].reasons[0].contains("覆盖"));
    i.override_mode.as_mut().unwrap().expires_at = Some("2026-10-08T08:00:00+08:00".into());
    assert_eq!(
        resolver::plan(&c, &s, &e, &i, &clock)[0].decision,
        "execute"
    );
    i.paused = true;
    assert!(resolver::plan(&c, &s, &e, &i, &clock)[0].reasons[0].contains("暂停"));
}
#[test]
fn stable_priority_and_same_scene_conflict() {
    let (mut c, s, e, clock) = fixture();
    let mut lower = c.rules[0].clone();
    lower.id = id();
    lower.priority = 30;
    c.rules.push(lower);
    let d = resolver::plan(&c, &s, &e, &input(), &clock);
    assert_eq!(d[0].decision, "execute");
    assert!(d[1].reasons[0].contains("相同场景"));
    c.rules.reverse();
    let second = resolver::plan(&c, &s, &e, &input(), &clock);
    assert_eq!(d[0].rule_id, second[0].rule_id);
}
#[test]
fn exclusive_modes_choose_highest_priority() {
    let (mut c, s, e, clock) = fixture();
    for number in 0..2 {
        let m = Mode {
            id: id(),
            name: "模式".into(),
            description: String::new(),
            icon: "briefcase".into(),
            color: "#3b82f6".into(),
            enabled: true,
            priority: 50,
            exclusive_group: "work".into(),
            strategy: "auto".into(),
            targets: vec![Target {
                scene_id: id(),
                workflow_id: None,
            }],
            created_at: now(),
            updated_at: now(),
        };
        let mut r = c.rules[0].clone();
        r.id = id();
        r.mode_id = Some(m.id.clone());
        r.priority = if number == 0 { 80 } else { 30 };
        c.modes.push(m);
        c.rules.push(r);
    }
    c.rules.remove(0);
    let d = resolver::plan(&c, &s, &e, &input(), &clock);
    assert_eq!(d[0].decision, "execute");
    assert!(d[1].reasons[0].contains("互斥"));
}
#[test]
fn dry_run_cannot_dispatch_and_matches_real_plan() {
    let (c, s, e, clock) = fixture();
    let expected = resolver::plan(&c, &s, &e, &input(), &clock);
    let simulated = crate::automation::coordinator::dry_run(&c, &s, &e, &input()).unwrap();
    assert_eq!(simulated[0].decision, expected[0].decision);
    assert_eq!(simulated[0].match_result, expected[0].match_result);
    assert!(simulated[0].execution_run_ids.is_empty());
    assert_eq!(s.network_connected.value, Some(true));
}
#[test]
fn safe_default_and_unknown_never_execute() {
    let (mut c, mut s, e, clock) = fixture();
    c.rules[0].policy = "confirm".into();
    assert_eq!(
        resolver::plan(&c, &s, &e, &input(), &clock)[0].decision,
        "waiting_confirmation"
    );
    s.network_connected = Field::disabled();
    assert_eq!(
        resolver::plan(&c, &s, &e, &input(), &clock)[0].match_result,
        Match::Unknown
    );
    assert_eq!(
        resolver::plan(&c, &s, &e, &input(), &clock)[0].decision,
        "skipped"
    );
}
#[test]
fn selected_provider_is_injectable() {
    use crate::environment::EnvironmentProvider;
    let (c, s, _, _) = fixture();
    let mut provider = crate::environment::MockProvider(s.clone());
    assert_eq!(
        provider.capture(&c, &crate::models::Config::default(), "unknown"),
        s
    );
}

#[test]
fn durable_dedup_history_clear_and_replay_use_original_rules() {
    use crate::automation::repository;
    let dir = tempfile::tempdir().unwrap();
    let db = crate::database::Db::open(dir.path()).unwrap();
    let (c, s, event, clock) = fixture();
    let mut legacy = crate::models::Config::default();
    legacy.scenes.push(crate::models::Scene {
        id: c.rules[0].target.scene_id.clone(),
        name: "保留场景".into(),
        description: "".into(),
        icon: "briefcase".into(),
        color: "#3B82F6".into(),
        enabled: true,
        sort_order: 0,
        created_at: now(),
        updated_at: now(),
    });
    let mut g = db.lock().unwrap();
    crate::database::write_config(&mut g.conn, &legacy).unwrap();
    let tx = g.conn.transaction().unwrap();
    repository::write(&tx, &c).unwrap();
    assert!(repository::event(&tx, &event).unwrap());
    repository::snapshot(&tx, &s).unwrap();
    let d = resolver::plan(&c, &s, &event, &input(), &clock).remove(0);
    repository::save_decision(
        &tx,
        &d,
        &repository::Evaluation {
            config: c.clone(),
            event: event.clone(),
            inputs: input(),
        },
    )
    .unwrap();
    tx.commit().unwrap();
    let (_, saved, context) = repository::history(&g.conn, &d.id).unwrap();
    assert_eq!(saved.config.rules[0].version, 1);
    assert_eq!(
        crate::automation::coordinator::dry_run(
            &saved.config,
            &context,
            &saved.event,
            &saved.inputs
        )
        .unwrap()[0]
            .decision,
        d.decision
    );
    g.conn.execute("DELETE FROM automation_events", []).unwrap();
    assert!(!repository::event(&g.conn, &event).unwrap());
    drop(g);
    drop(db);
    let reopened = crate::database::Db::open(dir.path()).unwrap();
    assert!(!repository::event(&reopened.lock().unwrap().conn, &event).unwrap());
}

#[test]
fn active_exclusive_mode_blocks_another_scene() {
    let (mut c, s, e, clock) = fixture();
    let active = id();
    let m = Mode {
        id: id(),
        name: "互斥".into(),
        description: "".into(),
        icon: "briefcase".into(),
        color: "#3b82f6".into(),
        enabled: true,
        priority: 50,
        exclusive_group: "work".into(),
        strategy: "auto".into(),
        targets: vec![c.rules[0].target.clone()],
        created_at: now(),
        updated_at: now(),
    };
    c.rules[0].mode_id = Some(m.id.clone());
    let mut other = m.clone();
    other.id = id();
    other.targets[0].scene_id = active.clone();
    c.modes = vec![m, other];
    let mut i = input();
    i.active_scenes.insert(active);
    let result = resolver::plan(&c, &s, &e, &i, &clock);
    assert_eq!(result[0].decision, "skipped");
    assert!(result[0].reasons[0].contains("互斥组"));
}
#[test]
fn disabled_scene_or_default_workflow_never_predicted_to_execute() {
    let (c, s, e, clock) = fixture();
    let mut i = input();
    i.disabled_scenes.insert(c.rules[0].target.scene_id.clone());
    assert_eq!(
        resolver::plan(&c, &s, &e, &i, &clock)[0].decision,
        "skipped"
    );
    i.disabled_scenes.clear();
    let workflow = id();
    i.scene_workflows
        .insert(c.rules[0].target.scene_id.clone(), workflow.clone());
    i.disabled_workflows.insert(workflow);
    assert!(resolver::plan(&c, &s, &e, &i, &clock)[0].reasons[0].contains("停用"));
}
#[test]
fn scheduled_rule_uses_injected_local_date_and_bounded_catchup() {
    use chrono::TimeZone;
    let (mut c, _, _, _) = fixture();
    c.rules[0].schedule = Some(Schedule {
        time: "09:00".into(),
        days: vec![4],
        catch_up_minutes: 30,
    });
    let r = &c.rules[0];
    let local = |hour, minute| {
        chrono::Local
            .with_ymd_and_hms(2026, 10, 8, hour, minute, 0)
            .single()
            .unwrap()
    };
    assert!(crate::automation::service::due(r, &local(8, 59)).is_none());
    assert_eq!(
        crate::automation::service::due(r, &local(9, 0)),
        Some("2026-10-08".into())
    );
    assert!(crate::automation::service::due(r, &local(9, 31)).is_none());
}

#[test]
fn refresh_never_bypasses_schedule_time_and_stability_defers_claim() {
    let (mut c, s, mut event, clock) = fixture();
    c.rules[0].triggers = vec![EventKind::Schedule];
    c.rules[0].schedule = Some(Schedule {
        time: "09:00".into(),
        days: vec![4],
        catch_up_minutes: 0,
    });
    event.kind = EventKind::Refresh;
    let before =
        FrozenClock(chrono::DateTime::parse_from_rfc3339("2026-10-08T08:59:59+08:00").unwrap());
    let after =
        FrozenClock(chrono::DateTime::parse_from_rfc3339("2026-10-08T09:01:00+08:00").unwrap());
    assert!(resolver::plan(&c, &s, &event, &input(), &before)[0].reasons[0].contains("计划时间"));
    assert_eq!(
        resolver::plan(&c, &s, &event, &input(), &after)[0].decision,
        "skipped"
    );
    assert_eq!(
        resolver::plan(&c, &s, &event, &input(), &clock)[0].decision,
        "execute"
    );
    assert!(!crate::automation::service::scheduled_ready(&c, false, 4));
    assert!(crate::automation::service::scheduled_ready(&c, false, 5));
    assert!(!crate::automation::service::scheduled_ready(&c, true, 10));
    c.enabled = false;
    assert!(!crate::automation::service::scheduled_ready(&c, false, 10));
}
