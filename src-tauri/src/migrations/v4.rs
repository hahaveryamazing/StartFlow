use crate::{
    error::{AppError, Result},
    models::{id, now},
};
use rusqlite::{params, Connection, MAIN_DB};
use std::path::Path;
pub fn migrate(conn: &mut Connection, directory: &Path, existing: bool) -> Result<()> {
    let version: i32 = conn.query_row("SELECT MAX(version) FROM migrations", [], |r| r.get(0))?;
    if version >= 4 {
        return Ok(());
    }
    let backup = if existing {
        let key = id();
        let filename = format!("upgrade-{key}.sqlite3");
        let folder = directory.join("backups");
        std::fs::create_dir_all(&folder).map_err(AppError::internal)?;
        conn.backup(MAIN_DB, folder.join(&filename), None)
            .map_err(|_| AppError::new("migration", "凭据管理升级前备份失败，原库保留。"))?;
        let size = std::fs::metadata(folder.join(&filename))
            .map_err(AppError::internal)?
            .len();
        Some((key, filename, size))
    } else {
        None
    };
    apply(conn, backup)
}
fn apply(conn: &mut Connection, backup: Option<(String, String, u64)>) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "CREATE TABLE credential_accounts(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('web','app')), target TEXT NOT NULL,
      credential_ref TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>0));
      CREATE INDEX credential_accounts_target ON credential_accounts(kind,target);
      CREATE TABLE credential_cleanup(credential_ref TEXT PRIMARY KEY);
      INSERT INTO migrations VALUES(4,strftime('%Y-%m-%dT%H:%M:%fZ','now')); ",
    )?;
    if let Some((key, filename, size)) = backup {
        tx.execute(
            "INSERT INTO backup_records VALUES(?1,?2,'upgrade',?3,?4,'ready')",
            params![key, filename, now(), size as i64],
        )?;
    }
    let errors: i64 = tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
        r.get(0)
    })?;
    if errors != 0 {
        return Err(AppError::new(
            "migration",
            "凭据升级引用校验失败，迁移已回滚。",
        ));
    }
    tx.commit()?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failure_preserves_old_data_and_version() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT);INSERT INTO migrations VALUES(3,'x');CREATE TABLE original(value TEXT);INSERT INTO original VALUES('保留');CREATE TABLE credential_cleanup(value TEXT);").unwrap();
        assert!(apply(&mut c, None).is_err());
        assert_eq!(
            c.query_row("SELECT MAX(version) FROM migrations", [], |r| r
                .get::<_, i32>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            c.query_row("SELECT value FROM original", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "保留"
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='credential_accounts'",
                [],
                |r| r.get::<_, i32>(0)
            )
            .unwrap(),
            0
        );
    }
}
