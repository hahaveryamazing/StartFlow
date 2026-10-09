use rusqlite::Connection;
use startflow_lib::{database::Db, v2::repository};

#[test]
fn populated_v2_fixture_preserves_all_old_tables_and_consistent_backup() {
    assert_upgrade(include_str!("fixtures/v2-populated.sql"), 2);
}

#[test]
fn populated_v3_fixture_preserves_all_old_tables_and_consistent_backup() {
    assert_upgrade(include_str!("fixtures/v3-populated.sql"), 3);
}

fn assert_upgrade(fixture: &str, source_version: i32) {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("startflow.sqlite3");
    let legacy = Connection::open(&file).unwrap();
    legacy.execute_batch(fixture).unwrap();
    let tables: Vec<String> = legacy
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let contents = |conn: &Connection, table: &str| {
        let mut statement = conn
            .prepare(&format!("SELECT * FROM \"{table}\" ORDER BY rowid"))
            .unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                (0..columns)
                    .map(|i| row.get::<_, rusqlite::types::Value>(i))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let before: Vec<_> = tables.iter().map(|t| contents(&legacy, t)).collect();
    let db = Db::open(directory.path()).unwrap();
    let guard = db.lock().unwrap();
    for (table, rows) in tables.iter().zip(before.iter()) {
        if !["migrations", "backup_records"].contains(&table.as_str()) {
            assert_eq!(
                &contents(&guard.conn, table),
                rows,
                "{table} changed during migration"
            );
        }
    }
    assert_eq!(
        repository::load(&guard.conn).unwrap().workflows.len(),
        before[tables.iter().position(|t| t == "workflows").unwrap()].len()
    );
    assert_eq!(
        guard
            .conn
            .query_row("SELECT MAX(version) FROM migrations", [], |r| r
                .get::<_, i32>(0))
            .unwrap(),
        5
    );
    let mut statement = guard
        .conn
        .prepare("SELECT filename FROM backup_records WHERE backup_type='upgrade'")
        .unwrap();
    let names: Vec<String> = statement
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let saved = names
        .into_iter()
        .map(|name| directory.path().join("backups").join(name))
        .filter(|path| path.is_file())
        .map(|path| {
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
        })
        .find(|conn| {
            conn.query_row("SELECT MAX(version) FROM migrations", [], |r| {
                r.get::<_, i32>(0)
            })
            .unwrap()
                == source_version
        })
        .unwrap();
    for (table, rows) in tables.iter().zip(before.iter()) {
        assert_eq!(
            &contents(&saved, table),
            rows,
            "backup of {table} is inconsistent"
        );
    }
    assert_eq!(
        guard
            .conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
}

#[test]
fn v3_backup_failure_stops_upgrade_without_erasing_configuration() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("startflow.sqlite3");
    let legacy = Connection::open(&file).unwrap();
    legacy
        .execute_batch(include_str!("fixtures/v3-populated.sql"))
        .unwrap();
    let count: i64 = legacy
        .query_row("SELECT COUNT(*) FROM scenes", [], |r| r.get(0))
        .unwrap();
    // A file occupying the required backup directory reliably injects a filesystem failure.
    std::fs::write(directory.path().join("backups"), b"blocked").unwrap();
    assert!(Db::open(directory.path()).is_err());
    assert_eq!(
        legacy
            .query_row("SELECT MAX(version) FROM migrations", [], |r| r
                .get::<_, i32>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        legacy
            .query_row("SELECT COUNT(*) FROM scenes", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        count
    );
    assert_eq!(
        legacy
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='credential_accounts'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
