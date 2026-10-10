use crate::{
    error::{AppError, Result},
    models::now,
};
use rusqlite::{params, Connection, MAIN_DB};
use std::path::Path;
pub fn migrate(c: &mut Connection, directory: &Path, existing: bool) -> Result<()> {
    let version: i32 = c.query_row("SELECT MAX(version) FROM migrations", [], |r| r.get(0))?;
    if version >= 7 {
        return Ok(());
    }
    let backup = if existing {
        let dir = directory.join("backups");
        std::fs::create_dir_all(&dir).map_err(AppError::internal)?;
        let id = uuid::Uuid::new_v4().to_string();
        let path = dir.join(format!("upgrade-{id}.sqlite3"));
        c.backup(MAIN_DB, &path, None)?;
        let size = std::fs::metadata(&path).map_err(AppError::internal)?.len();
        Some((id, path, size))
    } else {
        None
    };
    let tx = c.transaction()?;
    tx.execute_batch("CREATE TABLE workflow_login_grants(workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE, binding_json TEXT NOT NULL CHECK(json_valid(binding_json)), authorized_at TEXT NOT NULL);
      INSERT INTO migrations VALUES(7,strftime('%Y-%m-%dT%H:%M:%fZ','now'));")?;
    if let Some((id, path, size)) = backup {
        let filename = path
            .file_name()
            .ok_or_else(|| AppError::new("migration", "升级备份名称无效。"))?
            .to_string_lossy();
        tx.execute(
            "INSERT INTO backup_records VALUES(?1,?2,'upgrade',?3,?4,'ready')",
            params![id, filename, now(), size as i64],
        )?;
    }
    let bad: i64 = tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
        r.get(0)
    })?;
    if bad != 0 {
        return Err(AppError::new(
            "migration",
            "数据库引用校验失败，升级已回滚。",
        ));
    }
    tx.commit()?;
    Ok(())
}
