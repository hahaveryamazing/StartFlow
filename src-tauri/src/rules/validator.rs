use super::models::*;
use crate::{
    error::{AppError, Result},
    models::validate_id,
};
use std::collections::HashSet;
pub fn fail(message: &str) -> AppError {
    AppError::new("rule", message)
}
pub fn time(value: &str) -> Result<chrono::NaiveTime> {
    if value.len() != 5 {
        return Err(fail("时间应使用 HH:mm。"));
    }
    chrono::NaiveTime::parse_from_str(value, "%H:%M").map_err(|_| fail("时间应使用 HH:mm。"))
}
fn weekdays(days: &[u32]) -> Result<()> {
    if days.is_empty()
        || days.len() > 7
        || days.iter().any(|d| !(1..=7).contains(d))
        || days.iter().collect::<HashSet<_>>().len() != days.len()
    {
        return Err(fail("请设置不重复的有效星期。"));
    }
    Ok(())
}
pub fn target(
    t: &Target,
    c: &crate::models::Config,
    e: &crate::v2::models::Extension,
) -> Result<()> {
    validate_id(&t.scene_id)?;
    if !c.scenes.iter().any(|s| s.id == t.scene_id) {
        return Err(fail("关联场景已不存在。"));
    }
    if let Some(w) = &t.workflow_id {
        validate_id(w)?;
        if !e
            .workflows
            .iter()
            .any(|x| x.id == *w && x.scene_id == t.scene_id)
        {
            return Err(fail("关联工作流不属于此场景。"));
        }
    }
    Ok(())
}
pub fn validate(
    c: &Config,
    old: &crate::models::Config,
    e: &crate::v2::models::Extension,
) -> Result<()> {
    if c.schema_version != 1
        || serde_json::to_vec(c)?.len() > 512 * 1024
        || c.retention_days == 0
        || c.retention_days > 365
        || c.rules.len() > 256
        || c.modes.len() > 64
        || c.networks.len() > 64
    {
        return Err(fail("智能配置版本或数量超出限制。"));
    }
    let mut ids = HashSet::new();
    for n in &c.networks {
        validate_id(&n.id)?;
        crate::workflow::validator::label(&n.name, 80)?;
        if n.sealed_ssid.len() > 16384 || !ids.insert(n.id.clone()) {
            return Err(fail("信任网络配置无效。"));
        }
    }
    for m in &c.modes {
        validate_id(&m.id)?;
        crate::workflow::validator::label(&m.name, 80)?;
        if !ids.insert(m.id.clone())
            || m.targets.is_empty()
            || m.targets.len() > 4
            || m.exclusive_group.len() > 80
            || m.description.len() > 1000
            || !(0..=100).contains(&m.priority)
            || !["manual", "suggest", "auto"].contains(&m.strategy.as_str())
        {
            return Err(fail("工作模式参数无效。"));
        }
        if m.color.len() != 7
            || !m.color.starts_with('#')
            || !m.color[1..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err(fail("模式颜色无效。"));
        }
        let mut scenes = HashSet::new();
        for t in &m.targets {
            target(t, old, e)?;
            if !scenes.insert(&t.scene_id) {
                return Err(fail("工作模式不能重复关联同一场景。"));
            }
        }
    }
    for r in &c.rules {
        validate_id(&r.id)?;
        crate::workflow::validator::label(&r.name, 120)?;
        if !ids.insert(r.id.clone())
            || r.version == 0
            || r.description.len() > 1000
            || r.triggers.is_empty()
            || r.triggers.len() > 8
            || r.cooldown_seconds > 86400
            || r.stability_seconds > 300
            || !(0..=100).contains(&r.priority)
            || !["notify", "confirm", "auto"].contains(&r.policy.as_str())
        {
            return Err(fail("规则参数、冷却或稳定时间无效。"));
        }
        let kinds: HashSet<_> = r.triggers.iter().map(|k| format!("{k:?}")).collect();
        if kinds.len() != r.triggers.len() {
            return Err(fail("触发事件不能重复。"));
        }
        if let Some(key) = &r.mode_id {
            if !c.modes.iter().any(|m| m.id == *key) {
                return Err(fail("工作模式引用不存在。"));
            }
        } else {
            target(&r.target, old, e)?;
        }
        if r.triggers.contains(&EventKind::Schedule) {
            let s = r
                .schedule
                .as_ref()
                .ok_or_else(|| fail("定时触发需设置时间和星期。"))?;
            time(&s.time)?;
            weekdays(&s.days)?;
            if s.catch_up_minutes > 120 {
                return Err(fail("补执行窗口最多 120 分钟。"));
            }
        } else if r.schedule.is_some() {
            return Err(fail("非定时规则不能保存隐藏的时间计划。"));
        }
        let mut nodes = 0;
        let mut node_ids = HashSet::new();
        condition(&r.condition, 0, &mut nodes, &mut node_ids, c, old)?;
    }
    if crate::environment::providers::selected(c).1.len() > 8 {
        return Err(fail("最多启用 8 个不同的 HTTPS 服务探测。"));
    }
    Ok(())
}
fn condition(
    n: &Condition,
    depth: u32,
    count: &mut u32,
    ids: &mut HashSet<String>,
    config: &Config,
    c: &crate::models::Config,
) -> Result<()> {
    validate_id(&n.id)?;
    *count += 1;
    if *count > 64 || !ids.insert(n.id.clone()) {
        return Err(fail("每条规则最多 64 个条件，条件 ID 必须唯一。"));
    }
    match &n.expression {
        Expression::Group { operator, children } => {
            if depth >= 3
                || children.is_empty()
                || children.len() > 16
                || !["and", "or", "not"].contains(&operator.as_str())
                || (operator == "not" && children.len() != 1)
                || children.iter().all(|c| !c.enabled)
            {
                return Err(fail(
                    "条件组最多 3 层，NOT 仅一个子条件，至少启用一个条件。",
                ));
            }
            for child in children {
                condition(child, depth + 1, count, ids, config, c)?;
            }
        }
        Expression::Wifi { network_id } => {
            if !config.networks.iter().any(|n| n.id == *network_id) {
                return Err(fail("请选择已配置的信任 Wi-Fi。"));
            }
        }
        Expression::Monitors { minimum, maximum } => {
            if *minimum > 16 || *maximum > 16 || minimum > maximum {
                return Err(fail("显示器数量范围无效。"));
            }
        }
        Expression::Power { source } => {
            if !["ac", "battery"].contains(&source.as_str()) {
                return Err(fail("电源条件无效。"));
            }
        }
        Expression::Session { state } => {
            if !["active", "locked", "disconnected"].contains(&state.as_str()) {
                return Err(fail("会话条件无效。"));
            }
        }
        Expression::Weekdays { days } => weekdays(days)?,
        Expression::Time { start, end } => {
            if time(start)? == time(end)? {
                return Err(fail("时间区间起止不能相同。"));
            }
        }
        Expression::Process { task_id, state } => {
            if !c.tasks.iter().any(|t| t.id == *task_id && t.kind == "app")
                || !["running", "stopped", "window", "no_window"].contains(&state.as_str())
            {
                return Err(fail("进程条件需关联应用任务和有效状态。"));
            }
        }
        Expression::Service { url } => crate::workflow::validator::service(url, 5)?,
        Expression::Network { .. } => {}
    }
    Ok(())
}
