use crate::{
    error::{AppError, Result},
    models::{id, now},
};
use rusqlite::{params, Connection, MAIN_DB};
use std::path::Path;
pub fn migrate(conn: &mut Connection, directory: &Path, existing: bool) -> Result<()> {
    let version: i32 = conn.query_row("SELECT MAX(version) FROM migrations", [], |r| r.get(0))?;
    if version >= 3 {
        return Ok(());
    }
    let backup = if existing {
        let folder = directory.join("backups");
        std::fs::create_dir_all(&folder).map_err(AppError::internal)?;
        let key = id();
        let filename = format!("upgrade-{key}.sqlite3");
        let file = folder.join(&filename);
        conn.backup(MAIN_DB, &file, None)
            .map_err(|_| AppError::new("migration", "V3 升级前备份失败，原库保留。"))?;
        Some((
            key,
            filename,
            std::fs::metadata(file).map_err(AppError::internal)?.len(),
        ))
    } else {
        None
    };
    apply(conn, backup)
}
pub fn apply(conn: &mut Connection, backup: Option<(String, String, u64)>) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch("CREATE TABLE workspace_modes(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE TABLE environment_rules(id TEXT PRIMARY KEY,mode_id TEXT REFERENCES workspace_modes(id) ON DELETE RESTRICT,payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE TABLE environment_snapshots(id TEXT PRIMARY KEY,captured_at TEXT NOT NULL,schema_version INTEGER NOT NULL,context_json TEXT NOT NULL CHECK(json_valid(context_json)));
      CREATE INDEX environment_snapshot_date ON environment_snapshots(captured_at);
      CREATE TABLE automation_events(id TEXT PRIMARY KEY,event_key TEXT NOT NULL UNIQUE,event_type TEXT NOT NULL,occurred_at TEXT NOT NULL,status TEXT NOT NULL);
      CREATE INDEX automation_event_date ON automation_events(occurred_at);
      CREATE TABLE automation_event_claims(event_key TEXT PRIMARY KEY,claimed_at TEXT NOT NULL);
      CREATE TABLE automation_config_versions(id TEXT PRIMARY KEY,config_json TEXT NOT NULL UNIQUE CHECK(json_valid(config_json)));
      CREATE TABLE automation_evaluations(event_id TEXT PRIMARY KEY REFERENCES automation_events(id) ON DELETE CASCADE,config_id TEXT NOT NULL REFERENCES automation_config_versions(id),event_json TEXT NOT NULL CHECK(json_valid(event_json)),inputs_json TEXT NOT NULL CHECK(json_valid(inputs_json)));
      CREATE TABLE automation_decisions(id TEXT PRIMARY KEY,event_id TEXT REFERENCES automation_events(id) ON DELETE CASCADE,rule_id TEXT REFERENCES environment_rules(id) ON DELETE SET NULL,snapshot_id TEXT REFERENCES environment_snapshots(id) ON DELETE SET NULL,evaluated_at TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE INDEX automation_decision_date ON automation_decisions(evaluated_at DESC);
      CREATE INDEX automation_decision_rule ON automation_decisions(rule_id,evaluated_at DESC);
      CREATE TABLE automation_rule_state(rule_id TEXT PRIMARY KEY REFERENCES environment_rules(id) ON DELETE CASCADE,last_action_at TEXT NOT NULL);
      CREATE TABLE automation_overrides(id TEXT PRIMARY KEY,mode_id TEXT NOT NULL REFERENCES workspace_modes(id) ON DELETE CASCADE,payload TEXT NOT NULL CHECK(json_valid(payload)));
      CREATE TABLE ai_configuration_drafts(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)));
      INSERT INTO migrations VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now')); ")?;
    if let Some((key, file, size)) = backup {
        tx.execute(
            "INSERT INTO backup_records VALUES(?1,?2,'upgrade',?3,?4,'ready')",
            params![key, file, now(), size as i64],
        )?;
    }
    let broken: i64 = tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
        r.get(0)
    })?;
    if broken != 0 {
        return Err(AppError::new("migration", "V3 外键校验失败，迁移已回滚。"));
    }
    tx.commit()?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_v3_ddl_rolls_back() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT);INSERT INTO migrations VALUES(2,'x');CREATE TABLE automation_events(id TEXT PRIMARY KEY);CREATE TABLE original_config(value TEXT);INSERT INTO original_config VALUES('保留用户数据');").unwrap();
        assert!(apply(&mut c, None).is_err());
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='workspace_modes'",
                [],
                |r| r.get::<_, i32>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(
            c.query_row("SELECT MAX(version) FROM migrations", [], |r| r
                .get::<_, i32>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            c.query_row("SELECT value FROM original_config", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "保留用户数据"
        );
    }
}
