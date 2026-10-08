use crate::{
    error::{AppError, Result},
    models::{id, now},
};
use rusqlite::{params, Connection, MAIN_DB};
use std::path::Path;
pub fn migrate(conn: &mut Connection, directory: &Path, existing: bool) -> Result<()> {
    let version: i32 =
        conn.query_row("SELECT COALESCE(MAX(version),0) FROM migrations", [], |r| {
            r.get(0)
        })?;
    if version > 2 {
        return Err(AppError::new(
            "migration",
            "此数据库由更新版本创建，请使用对应版本；未修改数据。",
        ));
    }
    if version >= 2 {
        return Ok(());
    }
    let backup = if existing {
        let folder = directory.join("backups");
        std::fs::create_dir_all(&folder).map_err(AppError::internal)?;
        let key = id();
        let filename = format!("upgrade-{key}.sqlite3");
        let path = folder.join(&filename);
        conn.backup(MAIN_DB, &path, None).map_err(|e| {
            eprintln!("migration backup: {e}");
            AppError::new("migration", "升级前备份失败，升级已停止，原数据保留。")
        })?;
        Some((
            key,
            filename,
            std::fs::metadata(&path).map_err(AppError::internal)?.len(),
        ))
    } else {
        None
    };
    apply(conn, backup)
}
fn apply(conn: &mut Connection, backup: Option<(String, String, u64)>) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch("CREATE TABLE workflows(id TEXT PRIMARY KEY,scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,payload TEXT NOT NULL CHECK(json_valid(payload)));
    CREATE INDEX workflows_scene ON workflows(scene_id);
    CREATE TABLE workflow_nodes(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,node_type TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)));
    CREATE INDEX nodes_workflow ON workflow_nodes(workflow_id);
    CREATE TABLE workflow_edges(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,source_node_id TEXT NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,target_node_id TEXT NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,source_handle TEXT NOT NULL);
    CREATE TABLE scene_workflows(scene_id TEXT PRIMARY KEY REFERENCES scenes(id) ON DELETE CASCADE,workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE);
    CREATE TABLE window_layouts(id TEXT PRIMARY KEY,scene_id TEXT REFERENCES scenes(id) ON DELETE SET NULL,payload TEXT NOT NULL CHECK(json_valid(payload)));
    CREATE TABLE window_layout_items(id TEXT PRIMARY KEY,layout_id TEXT NOT NULL REFERENCES window_layouts(id) ON DELETE CASCADE,payload TEXT NOT NULL CHECK(json_valid(payload)));
    CREATE TABLE shortcuts(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload)));
    CREATE TABLE workflow_templates(id TEXT PRIMARY KEY,payload TEXT NOT NULL CHECK(json_valid(payload)));
    CREATE TABLE backup_records(id TEXT PRIMARY KEY,filename TEXT NOT NULL UNIQUE,backup_type TEXT NOT NULL,created_at TEXT NOT NULL,size INTEGER NOT NULL,status TEXT NOT NULL);
    CREATE TABLE workflow_runs(run_id TEXT PRIMARY KEY REFERENCES execution_runs(id) ON DELETE CASCADE,workflow_id TEXT NOT NULL,name TEXT NOT NULL);
    CREATE TABLE workflow_execution_logs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE,node_id TEXT NOT NULL,node_name TEXT NOT NULL,node_type TEXT NOT NULL,started_at TEXT,finished_at TEXT,status TEXT NOT NULL,result_json TEXT NOT NULL CHECK(json_valid(result_json)),error_message TEXT NOT NULL);
    CREATE INDEX workflow_logs_run ON workflow_execution_logs(run_id);
    INSERT INTO migrations VALUES(2,strftime('%Y-%m-%dT%H:%M:%fZ','now'));")?;
    if let Some((key, file, size)) = backup {
        tx.execute(
            "INSERT INTO backup_records VALUES(?1,?2,'upgrade',?3,?4,'ready')",
            params![key, file, now(), size as i64],
        )?;
    }
    let errors: i64 = tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
        r.get(0)
    })?;
    if errors != 0 {
        return Err(AppError::new("migration", "迁移引用校验失败，已回滚。"));
    }
    tx.commit()?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_ddl_rolls_back_version() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT);INSERT INTO migrations VALUES(1,'x');CREATE TABLE scenes(id TEXT PRIMARY KEY);CREATE TABLE workflow_edges(id TEXT PRIMARY KEY);").unwrap();
        assert!(apply(&mut c, None).is_err());
        let n: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='workflows'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
        assert_eq!(
            c.query_row("SELECT MAX(version) FROM migrations", [], |r| r
                .get::<_, i32>(0))
                .unwrap(),
            1
        );
    }
}
