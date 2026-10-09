use rusqlite::Connection;
use startflow_lib::{database::Db, v2::repository};

#[test]
fn populated_v2_fixture_preserves_all_old_tables_and_consistent_backup() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("startflow.sqlite3");
    let legacy = Connection::open(&file).unwrap();
    legacy
        .execute_batch(include_str!("fixtures/v2-populated.sql"))
        .unwrap();
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
    assert_eq!(repository::load(&guard.conn).unwrap().workflows.len(), 1);
    let backup: String = guard.conn.query_row(
        "SELECT filename FROM backup_records WHERE backup_type='upgrade' ORDER BY created_at DESC LIMIT 1", [], |r| r.get(0)
    ).unwrap();
    let saved = Connection::open(directory.path().join("backups").join(backup)).unwrap();
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
