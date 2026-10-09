use crate::{
    context::Snapshot,
    error::{AppError, Result},
    rules::{models::*, validator},
};
use rusqlite::{params, Connection};
pub fn load(conn: &Connection) -> Result<Config> {
    match conn.query_row(
        "SELECT value_json FROM settings WHERE key='automation'",
        [],
        |r| r.get::<_, String>(0),
    ) {
        Ok(json) => Ok(serde_json::from_str(&json)?),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Config::default()),
        Err(e) => Err(e.into()),
    }
}
pub fn write(conn: &Connection, c: &Config) -> Result<()> {
    validator::validate(
        c,
        &crate::database::config(conn)?,
        &crate::v2::repository::load(conn)?,
    )?;
    for m in &c.modes {
        conn.execute("INSERT INTO workspace_modes VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",params![m.id,serde_json::to_string(m)?])?;
    }
    for (table, ids) in [
        (
            "environment_rules",
            c.rules
                .iter()
                .map(|r| r.id.as_str())
                .collect::<std::collections::HashSet<_>>(),
        ),
        (
            "workspace_modes",
            c.modes.iter().map(|m| m.id.as_str()).collect(),
        ),
    ] {
        if table == "workspace_modes" {
            for r in &c.rules {
                conn.execute("INSERT INTO environment_rules VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET mode_id=excluded.mode_id,payload=excluded.payload",params![r.id,r.mode_id,serde_json::to_string(r)?])?;
            }
        }
        let query = if table == "environment_rules" {
            "SELECT id FROM environment_rules"
        } else {
            "SELECT id FROM workspace_modes"
        };
        let existing = conn
            .prepare(query)?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for id in existing {
            if !ids.contains(id.as_str()) {
                conn.execute(
                    if table == "environment_rules" {
                        "DELETE FROM environment_rules WHERE id=?1"
                    } else {
                        "DELETE FROM workspace_modes WHERE id=?1"
                    },
                    [id],
                )?;
            }
        }
    }
    conn.execute("INSERT INTO settings VALUES('automation',?1) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",[serde_json::to_string(c)?])?;
    Ok(())
}
pub fn validate_references(
    conn: &Connection,
    c: &crate::models::Config,
    e: &crate::v2::models::Extension,
) -> Result<()> {
    validator::validate(&load(conn)?, c, e)
}
pub fn inputs(
    conn: &Connection,
    active: std::collections::HashSet<String>,
    stable_seconds: u64,
) -> Result<Inputs> {
    let legacy = crate::database::config(conn)?;
    let extension = crate::v2::repository::load(conn)?;
    let mut statement = conn.prepare("SELECT rule_id,last_action_at FROM automation_rule_state")?;
    let last_actions = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<std::result::Result<_, _>>()?;
    Ok(Inputs {
        paused: legacy.settings.paused,
        active_scenes: active,
        last_actions,
        stable_seconds,
        override_mode: current_override(conn)?,
        confirmed_rule: None,
        disabled_scenes: legacy
            .scenes
            .into_iter()
            .filter(|s| !s.enabled)
            .map(|s| s.id)
            .collect(),
        disabled_workflows: extension
            .workflows
            .into_iter()
            .filter(|w| !w.enabled)
            .map(|w| w.id)
            .collect(),
        scene_workflows: extension
            .bindings
            .into_iter()
            .map(|b| (b.scene_id, b.workflow_id))
            .collect(),
    })
}
pub fn current_override(conn: &Connection) -> Result<Option<Override>> {
    match conn.query_row(
        "SELECT payload FROM automation_overrides ORDER BY rowid DESC LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    ) {
        Ok(json) => Ok(Some(serde_json::from_str(&json)?)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub fn event(conn: &Connection, event: &Event) -> Result<bool> {
    if conn.execute(
        "INSERT OR IGNORE INTO automation_event_claims VALUES(?1,?2)",
        params![event.key, event.occurred_at],
    )? == 0
    {
        return Ok(false);
    }
    Ok(conn.execute(
        "INSERT OR IGNORE INTO automation_events VALUES(?1,?2,?3,?4,'evaluating')",
        params![
            event.id,
            event.key,
            serde_json::to_string(&event.kind)?,
            event.occurred_at
        ],
    )? != 0)
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Evaluation {
    pub config: Config,
    pub event: Event,
    pub inputs: Inputs,
}
pub fn save_decision(
    conn: &Connection,
    decision: &Decision,
    evaluation: &Evaluation,
) -> Result<()> {
    let mut safe = evaluation.clone();
    for n in &mut safe.config.networks {
        n.sealed_ssid.clear();
    }
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM automation_evaluations WHERE event_id=?1)",
        [&decision.event_id],
        |r| r.get(0),
    )?;
    if !exists {
        let json = serde_json::to_string(&safe.config)?;
        conn.execute(
            "INSERT OR IGNORE INTO automation_config_versions VALUES(?1,?2)",
            params![crate::models::id(), json],
        )?;
        let version: String = conn.query_row(
            "SELECT id FROM automation_config_versions WHERE config_json=?1",
            [json],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO automation_evaluations VALUES(?1,?2,?3,?4)",
            params![
                decision.event_id,
                version,
                serde_json::to_string(&safe.event)?,
                serde_json::to_string(&safe.inputs)?
            ],
        )?;
    }
    conn.execute("INSERT INTO automation_decisions VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload",params![decision.id,decision.event_id,decision.rule_id,decision.snapshot_id,decision.evaluated_at,decision.decision,serde_json::to_string(decision)?])?;
    Ok(())
}
pub fn snapshot(conn: &Connection, s: &Snapshot) -> Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO environment_snapshots VALUES(?1,?2,?3,?4)",
        params![
            s.id,
            s.captured_at,
            s.schema_version,
            serde_json::to_string(&s.redacted())?
        ],
    )?;
    Ok(())
}
pub fn decisions(conn: &Connection) -> Result<Vec<Decision>> {
    let mut stmt = conn.prepare(
        "SELECT payload FROM automation_decisions ORDER BY evaluated_at DESC,rowid DESC LIMIT 200",
    )?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
}
pub fn prune(conn: &Connection, days: u32) -> Result<()> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::days(i64::from(days))).to_rfc3339();
    conn.execute("DELETE FROM automation_events WHERE julianday(occurred_at) < julianday(?1) OR id IN (SELECT id FROM automation_events ORDER BY rowid DESC LIMIT -1 OFFSET 1000)",[cutoff.clone()])?;
    conn.execute("DELETE FROM environment_snapshots WHERE julianday(captured_at) < julianday(?1) OR id IN (SELECT id FROM environment_snapshots ORDER BY rowid DESC LIMIT -1 OFFSET 1000)",[cutoff])?;
    conn.execute("DELETE FROM automation_decisions WHERE id IN (SELECT id FROM automation_decisions ORDER BY rowid DESC LIMIT -1 OFFSET 5000)",[])?;
    conn.execute("DELETE FROM automation_config_versions WHERE NOT EXISTS(SELECT 1 FROM automation_evaluations WHERE config_id=automation_config_versions.id)",[])?;
    // Claims are separate from user-clearable history. Keep the latest 20,000 and 30 days.
    conn.execute("DELETE FROM automation_event_claims WHERE julianday(claimed_at)<julianday('now','-30 days') OR event_key IN (SELECT event_key FROM automation_event_claims ORDER BY rowid DESC LIMIT -1 OFFSET 20000)",[])?;
    Ok(())
}
pub fn history(conn: &Connection, id: &str) -> Result<(Decision, Evaluation, Snapshot)> {
    let (d,c,e,i,s):(String,String,String,String,String)=conn.query_row("SELECT d.payload,c.config_json,e.event_json,e.inputs_json,s.context_json FROM automation_decisions d JOIN environment_snapshots s ON s.id=d.snapshot_id JOIN automation_evaluations e ON e.event_id=d.event_id JOIN automation_config_versions c ON c.id=e.config_id WHERE d.id=?1",[id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?))).map_err(|_|AppError::new("history","记录已清理或缺少可回放快照。"))?;
    Ok((
        serde_json::from_str(&d)?,
        Evaluation {
            config: serde_json::from_str(&c)?,
            event: serde_json::from_str(&e)?,
            inputs: serde_json::from_str(&i)?,
        },
        serde_json::from_str(&s)?,
    ))
}
