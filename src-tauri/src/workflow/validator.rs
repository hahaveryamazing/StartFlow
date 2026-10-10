use super::models::*;
use crate::{
    error::{AppError, Result},
    models::{validate_id, validate_path, validate_program, validate_url, Config},
    v2::models::Extension,
};
use std::collections::{HashMap, HashSet, VecDeque};
fn invalid(message: &str) -> AppError {
    AppError::new("workflow_validation", message)
}
pub fn label(value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max || value.contains('\0') {
        return Err(invalid("名称或文字内容为空、过长或含无效字符。"));
    }
    Ok(())
}
pub fn condition(c: &Condition) -> Result<()> {
    match c {
        Condition::Time { start, end } => {
            for t in [start, end] {
                if t.len() != 5 || chrono::NaiveTime::parse_from_str(t, "%H:%M").is_err() {
                    return Err(invalid("时间条件应使用 HH:mm。"));
                }
            }
            if start == end {
                return Err(invalid("时间范围的开始与结束不能相同。"));
            }
        }
        Condition::Weekdays { days } => {
            if days.is_empty()
                || days.len() > 7
                || days.iter().any(|d| !(1..=7).contains(d))
                || days.iter().collect::<HashSet<_>>().len() != days.len()
            {
                return Err(invalid("请选择不重复的有效星期。"));
            }
        }
        Condition::Process { path } => validate_program(path, false)?,
        Condition::File { path } | Condition::Folder { path } => validate_path(path)?,
        Condition::Service {
            url,
            timeout_seconds,
        } => service(url, *timeout_seconds)?,
        Condition::Network => {}
    }
    Ok(())
}
pub fn service(url: &str, timeout: u32) -> Result<()> {
    validate_url(url)?;
    if !url.starts_with("https://") || !(1..=90).contains(&timeout) {
        return Err(invalid("服务探测仅支持 HTTPS，超时为 1～90 秒。"));
    }
    Ok(())
}
pub fn validate(w: &Workflow, c: &Config, e: &Extension) -> Result<()> {
    validate_id(&w.id)?;
    validate_id(&w.scene_id)?;
    label(&w.name, 120)?;
    if !c.scenes.iter().any(|s| s.id == w.scene_id) {
        return Err(invalid("工作流关联场景不存在。"));
    }
    if w.schema_version != 1
        || w.nodes.len() < 2
        || w.nodes.len() > 200
        || w.edges.len() > 399
        || !(1..=3600).contains(&w.max_seconds)
        || w.description.len() > 2000
    {
        return Err(invalid(
            "工作流版本、节点数量或最长运行时间无效（最多 200 节点、60 分钟）。",
        ));
    }
    let mut nodes = HashMap::new();
    for n in &w.nodes {
        validate_id(&n.id)?;
        label(&n.name, 120)?;
        if nodes.insert(n.id.as_str(), n).is_some() {
            return Err(invalid("节点 ID 重复。"));
        }
        if !n.x.is_finite()
            || !n.y.is_finite()
            || n.x.abs() > 1e6
            || n.y.abs() > 1e6
            || !["stop", "continue"].contains(&n.on_error.as_str())
        {
            return Err(invalid("节点坐标或错误处理策略无效。"));
        }
        match &n.config {
            NodeConfig::Web { task_id }
            | NodeConfig::App { task_id }
            | NodeConfig::Folder { task_id } => {
                let t = c
                    .tasks
                    .iter()
                    .find(|t| t.id == *task_id)
                    .ok_or_else(|| invalid("启动节点尚未选择有效任务。"))?;
                if t.kind != n.config.kind() {
                    return Err(invalid("启动节点与关联任务类型不一致。"));
                }
            }
            NodeConfig::Delay { milliseconds } => {
                if *milliseconds > 600_000 {
                    return Err(invalid("单次等待最多 10 分钟。"));
                }
            }
            NodeConfig::Condition { mode, conditions } => {
                if n.on_error != "stop"
                    || !["and", "or"].contains(&mode.as_str())
                    || conditions.is_empty()
                    || conditions.len() > 16
                {
                    return Err(invalid(
                        "条件组应包含 1～16 项，选择全部 / 任意；条件错误必须停止。",
                    ));
                }
                for x in conditions {
                    condition(x)?;
                }
            }
            NodeConfig::Network {
                mode,
                url,
                timeout_seconds,
            } => {
                if !(1..=90).contains(timeout_seconds) {
                    return Err(invalid("网络等待超时应为 1～90 秒。"));
                }
                match mode.as_str() {
                    "local" => {}
                    "service" => service(url, *timeout_seconds)?,
                    _ => return Err(invalid("网络检查方式无效。")),
                }
            }
            NodeConfig::Layout {
                layout_id,
                timeout_seconds,
            } => {
                if !(1..=60).contains(timeout_seconds)
                    || !e.layouts.iter().any(|l| l.id == *layout_id)
                {
                    return Err(invalid("请选择有效窗口布局，等待超时为 1～60 秒。"));
                }
            }
            NodeConfig::Notification { title, body, level } => {
                label(title, 120)?;
                label(body, 1000)?;
                if !["info", "success", "warning", "error"].contains(&level.as_str()) {
                    return Err(invalid("通知级别无效。"));
                }
            }
            NodeConfig::Scene { scene_id } => {
                if scene_id == &w.scene_id
                    || !c.scenes.iter().any(|s| s.id == *scene_id)
                    || e.bindings.iter().any(|b| b.scene_id == *scene_id)
                {
                    return Err(invalid(
                        "场景节点只可引用其它简单场景，防止嵌套工作流循环。",
                    ));
                }
            }
            NodeConfig::Start | NodeConfig::End => {}
            NodeConfig::LoginCheck {
                target,
                config_id,
                timeout_seconds,
            }
            | NodeConfig::ManualVerification {
                target,
                config_id,
                timeout_seconds,
            }
            | NodeConfig::AutoLogin {
                target,
                config_id,
                timeout_seconds,
                ..
            } => {
                validate_id(config_id)?;
                if !["web", "desktop"].contains(&target.as_str())
                    || !(3..=600).contains(timeout_seconds)
                {
                    return Err(invalid(
                        "请选择网页登录或桌面登录配置，等待时间为 3～600 秒。",
                    ));
                }
                if let NodeConfig::AutoLogin { failure_policy, .. } = &n.config {
                    if !["stop", "skip", "manual"].contains(&failure_policy.as_str()) {
                        return Err(invalid("登录失败策略无效。"));
                    }
                    if n.on_error != "stop" {
                        return Err(invalid("自动登录必须使用节点内的失败策略。"));
                    }
                }
            }
            NodeConfig::LoginBranch { target, config_id } => {
                validate_id(config_id)?;
                if !["web", "desktop"].contains(&target.as_str()) || n.on_error != "stop" {
                    return Err(invalid("登录分支需要有效类型，未知状态必须停止流程。"));
                }
            }
        }
    }
    let starts: Vec<_> = w
        .nodes
        .iter()
        .filter(|n| matches!(n.config, NodeConfig::Start))
        .collect();
    if starts.len() != 1 || !w.nodes.iter().any(|n| matches!(n.config, NodeConfig::End)) {
        return Err(invalid("必须且只能有一个开始节点，并至少有一个结束节点。"));
    }
    let mut incoming: HashMap<&str, usize> = nodes.keys().map(|k| (*k, 0)).collect();
    let mut outgoing: HashMap<&str, Vec<&Edge>> = HashMap::new();
    let mut edge_ids = HashSet::new();
    for edge in &w.edges {
        validate_id(&edge.id)?;
        if !edge_ids.insert(&edge.id)
            || !nodes.contains_key(edge.source.as_str())
            || !nodes.contains_key(edge.target.as_str())
        {
            return Err(invalid("连线 ID 重复或引用了已删除节点。"));
        }
        *incoming
            .get_mut(edge.target.as_str())
            .ok_or_else(|| invalid("连线目标无效。"))? += 1;
        outgoing.entry(&edge.source).or_default().push(edge);
    }
    for n in &w.nodes {
        let count = incoming[n.id.as_str()];
        let out = outgoing.get(n.id.as_str()).cloned().unwrap_or_default();
        if (matches!(n.config, NodeConfig::Start) && count != 0)
            || (!matches!(n.config, NodeConfig::Start) && count != 1)
        {
            return Err(invalid(
                "开始节点不能有入边，其它节点必须且只能有一条入边；不支持分支汇合。",
            ));
        }
        match n.config {
            NodeConfig::End => {
                if !out.is_empty() {
                    return Err(invalid("结束节点不能连接后续节点。"));
                }
            }
            NodeConfig::Condition { .. } | NodeConfig::LoginBranch { .. } => {
                if out.len() != 2
                    || !out.iter().any(|x| x.handle == "true")
                    || !out.iter().any(|x| x.handle == "false")
                {
                    return Err(invalid("条件节点必须分别连接一条 True 和一条 False 分支。"));
                }
            }
            _ => {
                if out.len() != 1 || out[0].handle != "next" {
                    return Err(invalid("每个顺序节点需要一条明确的后续连线。"));
                }
            }
        }
    }
    let mut seen = HashSet::new();
    let mut queue = VecDeque::from([starts[0].id.as_str()]);
    while let Some(id) = queue.pop_front() {
        if !seen.insert(id) {
            return Err(invalid("流程存在循环或汇合。"));
        }
        if let Some(edges) = outgoing.get(id) {
            for x in edges {
                queue.push_back(x.target.as_str());
            }
        }
    }
    if seen.len() != w.nodes.len() {
        return Err(invalid("流程含不可达节点或环形连线。"));
    }
    Ok(())
}
pub fn environment(w: &Workflow, c: &Config) -> Result<()> {
    for n in &w.nodes {
        let task = match &n.config {
            NodeConfig::Web { task_id }
            | NodeConfig::App { task_id }
            | NodeConfig::Folder { task_id } => c.tasks.iter().find(|t| t.id == *task_id),
            _ => None,
        };
        if let Some(t) = task {
            let (path, folder) = match t.kind.as_str() {
                "app" => (&t.executable_path, false),
                "folder" => (&t.executable_path, true),
                "web" if t.browser_mode == "custom" => (&t.browser_path, false),
                _ => continue,
            };
            match std::fs::metadata(path) {
                Ok(m) if if folder { m.is_dir() } else { m.is_file() } => {}
                _ => {
                    return Err(invalid(&format!(
                        "节点“{}”的本地路径不存在或无法访问，请重新选择。",
                        n.name
                    )))
                }
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{id, now, Scene};
    fn fixture() -> (Workflow, Config, Extension) {
        let mut c = Config::default();
        let scene = id();
        c.scenes.push(Scene {
            id: scene.clone(),
            name: "测试".into(),
            description: "".into(),
            icon: "briefcase".into(),
            color: "#3B82F6".into(),
            enabled: true,
            sort_order: 0,
            created_at: now(),
            updated_at: now(),
        });
        let a = id();
        let b = id();
        let w = Workflow {
            id: id(),
            scene_id: scene,
            name: "流程".into(),
            description: "".into(),
            schema_version: 1,
            enabled: true,
            max_seconds: 30,
            nodes: vec![
                Node {
                    id: a.clone(),
                    name: "开始".into(),
                    x: 0.,
                    y: 0.,
                    config: NodeConfig::Start,
                    on_error: "stop".into(),
                },
                Node {
                    id: b.clone(),
                    name: "结束".into(),
                    x: 200.,
                    y: 0.,
                    config: NodeConfig::End,
                    on_error: "stop".into(),
                },
            ],
            edges: vec![Edge {
                id: id(),
                source: a,
                target: b,
                handle: "next".into(),
            }],
            created_at: now(),
            updated_at: now(),
        };
        (w, c, Extension::default())
    }
    #[test]
    fn valid_empty_workflow() {
        let (w, c, e) = fixture();
        assert!(validate(&w, &c, &e).is_ok());
    }
    #[test]
    fn rejects_cycles_missing_end_duplicate_id() {
        let (mut w, c, e) = fixture();
        w.nodes[1].config = NodeConfig::Delay { milliseconds: 1 };
        w.edges.push(Edge {
            id: id(),
            source: w.nodes[1].id.clone(),
            target: w.nodes[0].id.clone(),
            handle: "next".into(),
        });
        assert!(validate(&w, &c, &e).is_err());
        let (mut w, c, e) = fixture();
        w.nodes[1].id = w.nodes[0].id.clone();
        assert!(validate(&w, &c, &e).is_err());
    }
    #[test]
    fn rejects_unselected_task_and_unsafe_conditions() {
        let (mut w, c, e) = fixture();
        w.nodes[1].config = NodeConfig::Web { task_id: id() };
        assert!(validate(&w, &c, &e).is_err());
        assert!(condition(&Condition::Service {
            url: "http://example.com".into(),
            timeout_seconds: 5
        })
        .is_err());
        assert!(condition(&Condition::Weekdays { days: vec![1, 1] }).is_err());
    }
    #[test]
    fn branch_requires_both_handles_and_no_merge() {
        let (mut w, c, e) = fixture();
        let cond = id();
        let second = id();
        w.nodes.push(Node {
            id: cond.clone(),
            name: "星期".into(),
            x: 100.,
            y: 0.,
            config: NodeConfig::Condition {
                mode: "and".into(),
                conditions: vec![Condition::Weekdays {
                    days: vec![1, 2, 3, 4, 5],
                }],
            },
            on_error: "stop".into(),
        });
        w.nodes.push(Node {
            id: second.clone(),
            name: "结束二".into(),
            x: 200.,
            y: 100.,
            config: NodeConfig::End,
            on_error: "stop".into(),
        });
        w.edges[0].target = cond.clone();
        w.edges.push(Edge {
            id: id(),
            source: cond.clone(),
            target: w.nodes[1].id.clone(),
            handle: "true".into(),
        });
        w.edges.push(Edge {
            id: id(),
            source: cond,
            target: second,
            handle: "false".into(),
        });
        assert!(validate(&w, &c, &e).is_ok());
        w.nodes[2].config = NodeConfig::LoginBranch {
            target: "web".into(),
            config_id: id(),
        };
        assert!(validate(&w, &c, &e).is_ok());
        w.nodes[2].on_error = "continue".into();
        assert!(validate(&w, &c, &e).is_err());
        w.nodes[2].on_error = "stop".into();
        w.edges[2].target = w.edges[1].target.clone();
        assert!(validate(&w, &c, &e).is_err());
    }
}
