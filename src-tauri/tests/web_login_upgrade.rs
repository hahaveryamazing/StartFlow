use rusqlite::{params, Connection};
use startflow_lib::{
    database::Db,
    models::{id, now},
};

fn v4_fixture(dir: &std::path::Path) -> String {
    let c = Connection::open(dir.join("startflow.sqlite3")).unwrap();
    c.execute_batch(include_str!("fixtures/v3-populated.sql"))
        .unwrap();
    drop(c);
    let db = Db::open(dir).unwrap();
    let g = db.lock().unwrap();
    let account = id();
    g.conn.execute("INSERT INTO credential_accounts VALUES(?1,'原账号','original@example.test','web','https://example.test',?2,?3,?3,2)", params![account,id(),now()]).unwrap();
    g.conn.execute_batch("DROP TABLE web_login_configs;DROP TABLE web_login_runs;DROP TABLE web_login_attempts;DELETE FROM migrations WHERE version=5;").unwrap();
    account
}

#[test]
fn populated_v4_preserves_credential_references_old_config_and_consistent_backup() {
    let dir = tempfile::tempdir().unwrap();
    let account = v4_fixture(dir.path());
    let old = Connection::open(dir.path().join("startflow.sqlite3")).unwrap();
    let reference: String = old
        .query_row(
            "SELECT credential_ref FROM credential_accounts WHERE id=?1",
            [&account],
            |r| r.get(0),
        )
        .unwrap();
    let before: String = old
        .query_row("SELECT group_concat(payload) FROM workflows", [], |r| {
            r.get(0)
        })
        .unwrap();
    let db = Db::open(dir.path()).unwrap();
    let g = db.lock().unwrap();
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
    assert_eq!(
        g.conn
            .query_row("SELECT group_concat(payload) FROM workflows", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
        before
    );
    assert_eq!(
        g.conn
            .query_row("SELECT MAX(version) FROM migrations", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        5
    );
    let backups = std::fs::read_dir(dir.path().join("backups")).unwrap();
    let mut found = false;
    for file in backups.flatten() {
        if file.path().extension().and_then(|x| x.to_str()) != Some("sqlite3") {
            continue;
        }
        let saved = Connection::open(file.path()).unwrap();
        if saved
            .query_row("SELECT MAX(version) FROM migrations", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
            == 4
            && saved
                .query_row(
                    "SELECT COUNT(*) FROM credential_accounts WHERE id=?1",
                    [&account],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap()
                == 1
        {
            assert_eq!(
                saved
                    .query_row(
                        "SELECT credential_ref FROM credential_accounts WHERE id=?1",
                        [&account],
                        |r| r.get::<_, String>(0)
                    )
                    .unwrap(),
                reference
            );
            found = true;
        }
    }
    assert!(found);
    assert_eq!(
        g.conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
}

#[test]
fn failed_v4_backup_never_resets_accounts_or_old_version() {
    let dir = tempfile::tempdir().unwrap();
    let account = v4_fixture(dir.path());
    // Existing backups belong only to this synthetic test directory.
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
        4
    );
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM credential_accounts WHERE id=?1",
            [&account],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}
