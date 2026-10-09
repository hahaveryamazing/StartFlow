use rusqlite::{params, Connection};
use startflow_lib::{
    database::Db,
    desktop_login::commands::claim,
    models::{id, now},
};
fn v5(dir: &std::path::Path) -> String {
    let c = Connection::open(dir.join("startflow.sqlite3")).unwrap();
    c.execute_batch(include_str!("fixtures/v3-populated.sql"))
        .unwrap();
    drop(c);
    let db = Db::open(dir).unwrap();
    let g = db.lock().unwrap();
    let account = id();
    g.conn.execute("INSERT INTO credential_accounts VALUES(?1,'应用账号','user','app','C:\\Program Files\\App.exe',?2,?3,?3,1)",params![account,id(),now()]).unwrap();
    g.conn
        .execute(
            "INSERT INTO web_login_configs VALUES(?1,?2,'{\"original\":true}')",
            params![id(), account],
        )
        .unwrap();
    g.conn.execute_batch("DROP TABLE desktop_login_configs;DROP TABLE desktop_login_runs;DROP TABLE desktop_login_attempts;DELETE FROM migrations WHERE version=6;").unwrap();
    account
}
#[test]
fn v5_upgrade_preserves_accounts_web_config_and_all_legacy_tables() {
    let dir = tempfile::tempdir().unwrap();
    let account = v5(dir.path());
    let old = Connection::open(dir.path().join("startflow.sqlite3")).unwrap();
    let tables = [
        "scenes",
        "tasks",
        "scene_tasks",
        "schedules",
        "workflows",
        "window_layouts",
        "shortcuts",
        "execution_runs",
        "execution_logs",
        "credential_accounts",
        "web_login_configs",
    ];
    let before: Vec<i64> = tables
        .iter()
        .map(|t| {
            old.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                .unwrap()
        })
        .collect();
    let reference: String = old
        .query_row(
            "SELECT credential_ref FROM credential_accounts WHERE id=?1",
            [&account],
            |r| r.get(0),
        )
        .unwrap();
    drop(old);
    let db = Db::open(dir.path()).unwrap();
    let g = db.lock().unwrap();
    for (t, count) in tables.iter().zip(before) {
        assert_eq!(
            g.conn
                .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            count
        );
    }
    assert_eq!(
        g.conn
            .query_row("SELECT MAX(version) FROM migrations", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        6
    );
    assert_eq!(
        g.conn
            .query_row(
                "SELECT credential_ref FROM credential_accounts WHERE id=?1",
                [&account],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        reference
    );
    let found = std::fs::read_dir(dir.path().join("backups"))
        .unwrap()
        .flatten()
        .any(|file| {
            let c = Connection::open(file.path()).unwrap();
            c.query_row("SELECT MAX(version) FROM migrations", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
                == 5
                && c.query_row("SELECT COUNT(*) FROM web_login_configs", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap()
                    == 1
        });
    assert!(found);
}
#[test]
fn failed_ddl_rolls_back_and_keeps_original_v5() {
    let dir = tempfile::tempdir().unwrap();
    let account = v5(dir.path());
    let c = Connection::open(dir.path().join("startflow.sqlite3")).unwrap();
    c.execute_batch("CREATE TABLE desktop_login_runs(broken TEXT);")
        .unwrap();
    assert!(Db::open(dir.path()).is_err());
    assert_eq!(
        c.query_row("SELECT MAX(version) FROM migrations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM credential_accounts WHERE id=?1",
            [account],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='desktop_login_configs'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}
#[test]
fn backup_failure_leaves_v5_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let account = v5(dir.path());
    let backup = dir.path().join("backups");
    assert!(backup.starts_with(dir.path()));
    std::fs::remove_dir_all(&backup).unwrap();
    std::fs::write(backup, b"blocked").unwrap();
    assert!(Db::open(dir.path()).is_err());
    let c = Connection::open(dir.path().join("startflow.sqlite3")).unwrap();
    assert_eq!(
        c.query_row("SELECT MAX(version) FROM migrations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        5
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM credential_accounts WHERE id=?1",
            [account],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
#[test]
fn attempt_budget_is_persistent_across_reopen_and_clock_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let account = v5(dir.path());
    let db = Db::open(dir.path()).unwrap();
    claim(&db.lock().unwrap().conn, &account, 1000).unwrap();
    drop(db);
    let db = Db::open(dir.path()).unwrap();
    let g = db.lock().unwrap();
    assert!(claim(&g.conn, &account, 900).is_err());
    assert!(claim(&g.conn, &account, 1299).is_err());
    assert!(claim(&g.conn, &account, 1300).is_ok());
}
#[test]
fn crash_recovery_interrupts_without_replay_and_fk_delete_keeps_history() {
    let dir = tempfile::tempdir().unwrap();
    let account = v5(dir.path());
    let db = Db::open(dir.path()).unwrap();
    let g = db.lock().unwrap();
    let config = id();
    g.conn
        .execute(
            "INSERT INTO desktop_login_configs VALUES(?1,?2,'{}')",
            params![config, account],
        )
        .unwrap();
    claim(&g.conn, &account, 1000).unwrap();
    g.conn.execute("INSERT INTO desktop_login_runs VALUES(?1,?2,'running','{\"result\":{\"status\":\"running\"},\"finished_at\":null}')",params![id(),account]).unwrap();
    drop(g);
    drop(db);
    let db = Db::open(dir.path()).unwrap();
    let g = db.lock().unwrap();
    assert_eq!(
        g.conn
            .query_row("SELECT status FROM desktop_login_runs", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "interrupted"
    );
    assert!(claim(&g.conn, &account, 1001).is_err());
    g.conn
        .execute("DELETE FROM credential_accounts WHERE id=?1", [account])
        .unwrap();
    assert_eq!(
        g.conn
            .query_row("SELECT COUNT(*) FROM desktop_login_configs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        g.conn
            .query_row("SELECT COUNT(*) FROM desktop_login_attempts", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        g.conn
            .query_row("SELECT COUNT(*) FROM desktop_login_runs", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
}
