use super::{
    evaluator::{self, Clock},
    models::*,
};
use crate::context::Snapshot;
use std::collections::HashSet;
pub fn plan(
    c: &Config,
    s: &Snapshot,
    event: &Event,
    input: &Inputs,
    clock: &dyn Clock,
) -> Vec<Decision> {
    let mut rules: Vec<_> = c
        .rules
        .iter()
        .filter(|r| {
            r.enabled
                && (event.kind == EventKind::Refresh || r.triggers.contains(&event.kind))
                && (event.kind != EventKind::Schedule
                    || event.schedule_id.as_deref() == Some(r.id.as_str())
                    || r.schedule.is_none())
        })
        .collect();
    rules.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| {
                let priority = |r: &Rule| {
                    r.mode_id
                        .as_ref()
                        .and_then(|id| c.modes.iter().find(|m| m.id == *id))
                        .map(|m| m.priority)
                        .unwrap_or(0)
                };
                priority(b).cmp(&priority(a))
            })
            .then(a.created_at.cmp(&b.created_at))
            .then(a.id.cmp(&b.id))
    });
    let mut groups = HashSet::new();
    let mut scenes = HashSet::new();
    let now = clock.now();
    rules
        .into_iter()
        .map(|r| {
            let trace = evaluator::evaluate(&r.condition, s, clock);
            let mode = r
                .mode_id
                .as_ref()
                .and_then(|id| c.modes.iter().find(|m| m.id == *id));
            let targets = mode
                .map(|m| m.targets.clone())
                .unwrap_or_else(|| vec![r.target.clone()]);
            let mut d = Decision {
                id: crate::models::id(),
                rule_id: r.id.clone(),
                rule_name: r.name.clone(),
                rule_version: r.version,
                snapshot_id: s.id.clone(),
                event_id: event.id.clone(),
                evaluated_at: now.to_rfc3339(),
                match_result: trace.result,
                decision: "skipped".into(),
                reasons: vec![],
                trace,
                targets: targets.clone(),
                execution_run_ids: vec![],
                next_eligible_at: None,
            };
            let confirmed = input.confirmed_rule.as_deref() == Some(r.id.as_str());
            let mut reason = if !c.enabled {
                "智能规则总开关已关闭。"
            } else if input.paused {
                "所有自动化已暂停，手动启动仍可用。"
            } else if !r.condition.enabled {
                "根条件已停用。"
            } else if r.schedule.is_some()
                && (event.kind == EventKind::Schedule
                    || (event.kind == EventKind::Refresh
                        && r.triggers.iter().all(|kind| *kind == EventKind::Schedule)))
                && crate::automation::service::due(r, &now).is_none()
            {
                "计划时间尚未到达或已超过补执行窗口。"
            } else if d.match_result != Match::True {
                match d.match_result {
                    Match::Error => "条件检测错误，不执行。",
                    Match::Unknown => "必要环境无法确定，不执行。",
                    _ => "条件未满足。",
                }
            } else if mode.is_some_and(|m| !m.enabled || m.strategy == "manual") {
                "工作模式停用或只允许手动切换。"
            } else if input.override_mode.as_ref().is_some_and(|o| {
                o.expires_at
                    .as_ref()
                    .is_none_or(|v| chrono::DateTime::parse_from_rfc3339(v).is_ok_and(|t| t > now))
            }) {
                "处于手动模式覆盖，环境规则不能改变当前选择。"
            } else if input.stable_seconds < u64::from(r.stability_seconds) {
                "环境尚未达到最短稳定时间。"
            } else if targets.iter().any(|t| {
                input.disabled_scenes.contains(&t.scene_id)
                    || t.workflow_id
                        .as_ref()
                        .or_else(|| input.scene_workflows.get(&t.scene_id))
                        .is_some_and(|id| input.disabled_workflows.contains(id))
            }) {
                "目标场景或工作流已停用。"
            } else if targets
                .iter()
                .any(|t| input.active_scenes.contains(&t.scene_id))
            {
                "同一场景正在执行。"
            } else {
                ""
            };
            if reason.is_empty() && !confirmed {
                if let Some(last) = input
                    .last_actions
                    .get(&r.id)
                    .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                {
                    let next = last + chrono::Duration::seconds(i64::from(r.cooldown_seconds));
                    if now < next {
                        reason = "规则仍处于冷却时间。";
                        d.next_eligible_at = Some(next.to_rfc3339());
                    }
                }
            }
            let group = mode.map(|m| m.exclusive_group.as_str()).unwrap_or("");
            if reason.is_empty()
                && !group.is_empty()
                && c.modes.iter().any(|m| {
                    m.exclusive_group == group
                        && m.targets
                            .iter()
                            .any(|t| input.active_scenes.contains(&t.scene_id))
                })
            {
                reason = "同一互斥组的工作模式正在执行。";
            }
            if reason.is_empty() && (!group.is_empty() && groups.contains(group)) {
                reason = "更高优先级的互斥工作模式已获选。";
            }
            if reason.is_empty() && targets.iter().any(|t| scenes.contains(&t.scene_id)) {
                reason = "更高优先级规则已选择相同场景，避免重复提交。";
            }
            if reason.is_empty() {
                if !group.is_empty() {
                    groups.insert(group.to_owned());
                }
                for t in &targets {
                    scenes.insert(t.scene_id.clone());
                }
                let policy = if mode.is_some_and(|m| m.strategy == "suggest") && r.policy == "auto"
                {
                    "confirm"
                } else {
                    r.policy.as_str()
                };
                d.decision = if confirmed || policy == "auto" {
                    "execute"
                } else if policy == "confirm" {
                    "waiting_confirmation"
                } else {
                    "notify"
                }
                .into();
                d.reasons
                    .push("条件满足、环境稳定、冷却结束且无当前冲突。".into());
            } else {
                d.reasons.push(reason.into());
            }
            d
        })
        .collect()
}
