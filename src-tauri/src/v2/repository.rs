use super::models::*;
use crate::{
    error::{AppError, Result},
    models::{id, Config},
    workflow::{models::*, validator},
};
use rusqlite::{params, Connection};
use std::collections::HashSet;
fn payload<T: serde::de::DeserializeOwned>(conn: &Connection, sql: &str) -> Result<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let result = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .map(|r| Ok(serde_json::from_str(&r?)?))
        .collect();
    result
}
pub fn load(conn: &Connection) -> Result<Extension> {
    let mut workflows: Vec<Workflow> =
        payload(conn, "SELECT payload FROM workflows ORDER BY rowid")?;
    for w in &mut workflows {
        let mut stmt =
            conn.prepare("SELECT payload FROM workflow_nodes WHERE workflow_id=?1 ORDER BY rowid")?;
        w.nodes = stmt
            .query_map([&w.id], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect::<Result<Vec<_>>>()?;
        let mut stmt=conn.prepare("SELECT id,source_node_id,target_node_id,source_handle FROM workflow_edges WHERE workflow_id=?1 ORDER BY rowid")?;
        w.edges = stmt
            .query_map([&w.id], |r| {
                Ok(Edge {
                    id: r.get(0)?,
                    source: r.get(1)?,
                    target: r.get(2)?,
                    handle: r.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
    }
    let mut stmt = conn.prepare("SELECT scene_id,workflow_id FROM scene_workflows")?;
    let bindings = stmt
        .query_map([], |r| {
            Ok(Binding {
                scene_id: r.get(0)?,
                workflow_id: r.get(1)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut layouts: Vec<crate::window_manager::Layout> =
        payload(conn, "SELECT payload FROM window_layouts ORDER BY rowid")?;
    for layout in &mut layouts {
        layout.scene_id = conn.query_row(
            "SELECT scene_id FROM window_layouts WHERE id=?1",
            [&layout.id],
            |r| r.get(0),
        )?;
    }
    let theme = match conn.query_row("SELECT value_json FROM settings WHERE key='v2'", [], |r| {
        r.get::<_, String>(0)
    }) {
        Ok(v) => serde_json::from_str(&v)?,
        Err(rusqlite::Error::QueryReturnedNoRows) => Theme::default(),
        Err(e) => return Err(e.into()),
    };
    Ok(Extension {
        workflows,
        bindings,
        layouts,
        theme,
        shortcuts: payload(conn, "SELECT payload FROM shortcuts ORDER BY rowid")?,
        templates: payload(
            conn,
            "SELECT payload FROM workflow_templates ORDER BY rowid",
        )?,
    })
}
pub fn validate(e: &Extension, c: &Config) -> Result<()> {
    c.validate()?;
    if e.workflows.len() > 1000
        || e.layouts.len() > 100
        || e.shortcuts.len() > 100
        || e.templates.len() > 200
    {
        return Err(AppError::new("validation", "扩展配置数量超过限制。"));
    }
    let mut ids = HashSet::new();
    let mut node_ids = HashSet::new();
    let mut edge_ids = HashSet::new();
    for w in &e.workflows {
        if !ids.insert(&w.id) {
            return Err(AppError::new("validation", "工作流 ID 重复。"));
        }
        validator::validate(w, c, e)?;
        for n in &w.nodes {
            if !node_ids.insert(&n.id) {
                return Err(AppError::new("validation", "不同工作流不能共用节点 ID。"));
            }
        }
        for edge in &w.edges {
            if !edge_ids.insert(&edge.id) {
                return Err(AppError::new("validation", "不同工作流不能共用连线 ID。"));
            }
        }
    }
    ids.clear();
    for b in &e.bindings {
        if !ids.insert(&b.scene_id)
            || !e
                .workflows
                .iter()
                .any(|w| w.id == b.workflow_id && w.scene_id == b.scene_id)
        {
            return Err(AppError::new("validation", "场景高级模式关联无效或重复。"));
        }
    }
    let mut item_ids = HashSet::new();
    let mut layout_scenes = HashSet::new();
    ids.clear();
    for l in &e.layouts {
        for item in &l.items {
            if !item_ids.insert(&item.id) {
                return Err(AppError::new("layout", "不同布局的窗口规则 ID 不能重复。"));
            }
        }
        if let Some(scene) = &l.scene_id {
            if !layout_scenes.insert(scene) {
                return Err(AppError::new(
                    "layout",
                    "每个简单场景只可关联一个自动恢复布局。",
                ));
            }
        }
        crate::window_manager::validate(l)?;
        if !ids.insert(&l.id)
            || l.scene_id
                .as_ref()
                .is_some_and(|s| !c.scenes.iter().any(|x| &x.id == s))
        {
            return Err(AppError::new("validation", "布局 ID 或关联场景无效。"));
        }
        if l.missing_monitor == "fallback" {
            let fallback = e
                .layouts
                .iter()
                .find(|x| Some(&x.id) == l.fallback_layout_id.as_ref())
                .ok_or_else(|| AppError::new("layout", "请选择备用布局。"))?;
            if fallback.missing_monitor == "fallback" {
                return Err(AppError::new("layout", "备用布局不能再引用备用布局。"));
            }
        }
    }
    crate::shortcuts::validate(&e.shortcuts, c)?;
    let t = &e.theme;
    if !["ocean", "white", "graphite", "forest", "twilight"].contains(&t.preset.as_str())
        || t.radius > 24
        || !["compact", "comfortable"].contains(&t.density.as_str())
        || !["solid", "gradient", "image"].contains(&t.background_style.as_str())
        || !["cover", "contain", "tile"].contains(&t.background_fit.as_str())
        || !t.background_opacity.is_finite()
        || !(0.0..=0.8).contains(&t.background_opacity)
        || t.background_blur > 30
        || !["off", "daily", "weekly"].contains(&t.backup_frequency.as_str())
        || !(1..=50).contains(&t.backup_retention)
    {
        return Err(AppError::new("validation", "主题或备份设置无效。"));
    }
    if let Some(background) = &t.background_id {
        crate::backups::background_name(background)?;
    }
    ids.clear();
    for t in &e.templates {
        crate::models::validate_id(&t.id)?;
        validator::label(&t.name, 120)?;
        if !ids.insert(&t.id) {
            return Err(AppError::new("validation", "模板 ID 重复。"));
        }
        validator::validate(&t.workflow, c, e)?;
    }
    Ok(())
}
pub fn validate_changes(conn: &Connection, c: &Config) -> Result<()> {
    let mut e = load(conn)?;
    e.workflows
        .retain(|w| c.scenes.iter().any(|s| s.id == w.scene_id));
    e.bindings
        .retain(|b| c.scenes.iter().any(|s| s.id == b.scene_id));
    for l in &mut e.layouts {
        if l.scene_id
            .as_ref()
            .is_some_and(|id| !c.scenes.iter().any(|s| &s.id == id))
        {
            l.scene_id = None;
        }
    }
    e.shortcuts
        .retain(|x| x.action != "scene" || c.scenes.iter().any(|s| s.id == x.target_id));
    // Deleting a referenced task/scene is refused, rather than corrupting an unrelated workflow.
    validate(&e, c)?;
    crate::automation::repository::validate_references(conn, c, &e)
}
pub fn write(conn: &Connection, e: &Extension) -> Result<()> {
    // Retain only exact local grants across unrelated theme/binding saves.
    let mut stmt =
        conn.prepare("SELECT workflow_id,binding_json,authorized_at FROM workflow_login_grants")?;
    let grants = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    // Caller holds a transaction and has validated the complete Config + Extension.
    conn.execute_batch("DELETE FROM scene_workflows;DELETE FROM workflows;DELETE FROM window_layouts;DELETE FROM shortcuts;DELETE FROM workflow_templates;")?;
    for w in &e.workflows {
        let mut metadata = w.clone();
        metadata.nodes.clear();
        metadata.edges.clear();
        conn.execute(
            "INSERT INTO workflows VALUES(?1,?2,?3)",
            params![w.id, w.scene_id, serde_json::to_string(&metadata)?],
        )?;
        for n in &w.nodes {
            conn.execute(
                "INSERT INTO workflow_nodes VALUES(?1,?2,?3,?4)",
                params![n.id, w.id, n.config.kind(), serde_json::to_string(n)?],
            )?;
        }
        for a in &w.edges {
            conn.execute(
                "INSERT INTO workflow_edges VALUES(?1,?2,?3,?4,?5)",
                params![a.id, w.id, a.source, a.target, a.handle],
            )?;
        }
    }
    for (key, binding, time) in grants {
        if let Some(w) = e.workflows.iter().find(|w| w.id == key) {
            if crate::login::fingerprint(conn, w).is_ok_and(|v| v == binding) {
                conn.execute(
                    "INSERT INTO workflow_login_grants VALUES(?1,?2,?3)",
                    params![key, binding, time],
                )?;
            }
        }
    }
    for b in &e.bindings {
        conn.execute(
            "INSERT INTO scene_workflows VALUES(?1,?2)",
            params![b.scene_id, b.workflow_id],
        )?;
    }
    for l in &e.layouts {
        conn.execute(
            "INSERT INTO window_layouts VALUES(?1,?2,?3)",
            params![l.id, l.scene_id, serde_json::to_string(l)?],
        )?;
        for item in &l.items {
            conn.execute(
                "INSERT INTO window_layout_items VALUES(?1,?2,?3)",
                params![item.id, l.id, serde_json::to_string(item)?],
            )?;
        }
    }
    for s in &e.shortcuts {
        conn.execute(
            "INSERT INTO shortcuts VALUES(?1,?2)",
            params![s.id, serde_json::to_string(s)?],
        )?;
    }
    for t in &e.templates {
        conn.execute(
            "INSERT INTO workflow_templates VALUES(?1,?2)",
            params![t.id, serde_json::to_string(t)?],
        )?;
    }
    conn.execute(
        "INSERT OR REPLACE INTO settings VALUES('v2',?1)",
        [serde_json::to_string(&e.theme)?],
    )?;
    Ok(())
}
pub fn node_logs(conn: &Connection) -> Result<Vec<NodeLog>> {
    node_logs_for(conn, None)
}
pub fn node_logs_for(conn: &Connection, run: Option<&str>) -> Result<Vec<NodeLog>> {
    let mut stmt=conn.prepare("SELECT id,run_id,node_id,node_name,node_type,started_at,finished_at,status,result_json,error_message FROM workflow_execution_logs WHERE (?1 IS NOT NULL AND run_id=?1) OR (?1 IS NULL AND (run_id IN(SELECT id FROM execution_runs ORDER BY started_at DESC,rowid DESC LIMIT 50) OR run_id IN(SELECT id FROM execution_runs WHERE status='running'))) ORDER BY rowid")?;
    let rows = stmt.query_map([run], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
            r.get::<_, String>(9)?,
        ))
    })?;
    rows.map(|r| {
        let (a, b, c, d, e, f, g, h, i, j) = r?;
        Ok(NodeLog {
            id: a,
            run_id: b,
            node_id: c,
            node_name: d,
            node_type: e,
            started_at: f,
            finished_at: g,
            status: h,
            result: serde_json::from_str(&i)?,
            error_message: j,
        })
    })
    .collect()
}
pub fn palette_preferences(conn: &Connection) -> Result<(Theme, Vec<Shortcut>)> {
    let theme = match conn.query_row("SELECT value_json FROM settings WHERE key='v2'", [], |r| {
        r.get::<_, String>(0)
    }) {
        Ok(v) => serde_json::from_str(&v)?,
        Err(rusqlite::Error::QueryReturnedNoRows) => Theme::default(),
        Err(e) => return Err(e.into()),
    };
    Ok((
        theme,
        payload(conn, "SELECT payload FROM shortcuts ORDER BY rowid")?,
    ))
}
pub fn workflow_runs(conn: &Connection) -> Result<Vec<WorkflowRun>> {
    let mut stmt=conn.prepare("SELECT run_id,workflow_id,name FROM workflow_runs WHERE run_id IN(SELECT id FROM execution_runs ORDER BY started_at DESC,rowid DESC LIMIT 500)")?;
    let v = stmt
        .query_map([], |r| {
            Ok(WorkflowRun {
                run_id: r.get(0)?,
                workflow_id: r.get(1)?,
                name: r.get(2)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}
pub fn clone_workflow(w: &Workflow, scene_id: &str) -> Workflow {
    let mut copy = w.clone();
    copy.id = id();
    copy.scene_id = scene_id.into();
    let map: std::collections::HashMap<_, _> =
        copy.nodes.iter().map(|n| (n.id.clone(), id())).collect();
    for n in &mut copy.nodes {
        n.id = map[&n.id].clone();
    }
    for e in &mut copy.edges {
        e.id = id();
        e.source = map[&e.source].clone();
        e.target = map[&e.target].clone();
    }
    copy
}
