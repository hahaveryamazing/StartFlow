use crate::{
    error::{AppError, Result},
    models::{id, now},
};
use rusqlite::{params, Connection, MAIN_DB};
use std::path::Path;
pub fn migrate(c: &mut Connection, dir: &Path, existing: bool) -> Result<()> {
    let version: i32 = c.query_row("SELECT MAX(version) FROM migrations", [], |r| r.get(0))?;
    if version >= 5 {
        return Ok(());
    }
    let backup = if existing {
        let key = id();
        let filename = format!("upgrade-{key}.sqlite3");
        let folder = dir.join("backups");
        std::fs::create_dir_all(&folder).map_err(AppError::internal)?;
        c.backup(MAIN_DB, folder.join(&filename), None)
            .map_err(|_| AppError::new("migration", "网页登录升级前备份失败，原库保留。"))?;
        let size = std::fs::metadata(folder.join(&filename))
            .map_err(AppError::internal)?
            .len();
        Some((key, filename, size))
    } else {
        None
    };
    apply(c, backup)
}
fn apply(c: &mut Connection, backup: Option<(String, String, u64)>) -> Result<()> {
    let tx = c.transaction()?;
    tx.execute_batch("CREATE TABLE web_login_configs(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES credential_accounts(id) ON DELETE CASCADE,payload TEXT NOT NULL CHECK(json_valid(payload)));CREATE INDEX web_login_account ON web_login_configs(account_id);CREATE TABLE web_login_runs(id TEXT PRIMARY KEY,account_id TEXT,status TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)));CREATE INDEX web_login_run_account ON web_login_runs(account_id);CREATE TABLE web_login_attempts(account_id TEXT PRIMARY KEY REFERENCES credential_accounts(id) ON DELETE CASCADE,last_requested_at INTEGER NOT NULL);INSERT INTO migrations VALUES(5,strftime('%Y-%m-%dT%H:%M:%fZ','now'));")?;
    if let Some((key, file, size)) = backup {
        tx.execute(
            "INSERT INTO backup_records VALUES(?1,?2,'upgrade',?3,?4,'ready')",
            params![key, file, now(), size as i64],
        )?;
    }
    let failures: i64 = tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
        r.get(0)
    })?;
    if failures != 0 {
        return Err(AppError::new(
            "migration",
            "引用检查失败，网页登录迁移已回滚。",
        ));
    }
    tx.commit()?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_failure_keeps_accounts_and_version() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE migrations(version INTEGER,applied_at TEXT);INSERT INTO migrations VALUES(4,'x');CREATE TABLE credential_accounts(id TEXT PRIMARY KEY);INSERT INTO credential_accounts VALUES('original');CREATE TABLE web_login_runs(broken TEXT);").unwrap();
        assert!(apply(&mut c, None).is_err());
        assert_eq!(
            c.query_row("SELECT MAX(version) FROM migrations", [], |r| r
                .get::<_, i32>(0))
                .unwrap(),
            4
        );
        assert_eq!(
            c.query_row("SELECT id FROM credential_accounts", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "original"
        );
        assert_eq!(
            c.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='web_login_configs'",
                [],
                |r| r.get::<_, i32>(0)
            )
            .unwrap(),
            0
        );
    }
}
