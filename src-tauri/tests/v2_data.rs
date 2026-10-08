use rusqlite::{params, Connection};
use startflow_lib::{
    database::{config, write_config, Db},
    models::{id, now, Scene},
    v2::{models::Extension, repository},
    workflow::executor,
};
#[test]
fn genuine_v1_schema_with_wal_is_backed_up_before_migration() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("startflow.sqlite3");
    let legacy = Connection::open(&file).unwrap();
    legacy
        .execute_batch(include_str!("fixtures/v1-schema.sql").trim_start_matches('\u{feff}'))
        .unwrap();
    let scene = Scene {
        id: id(),
        name: "原场景".into(),
        description: "".into(),
        icon: "briefcase".into(),
        color: "#3B82F6".into(),
        enabled: true,
        sort_order: 0,
        created_at: now(),
        updated_at: now(),
    };
    legacy
        .execute(
            "INSERT INTO scenes VALUES(?1,?2,1,0,?3)",
            params![scene.id, scene.name, serde_json::to_string(&scene).unwrap()],
        )
        .unwrap();
    let upgraded = Db::open(directory.path()).unwrap();
    let g = upgraded.lock().unwrap();
    assert_eq!(config(&g.conn).unwrap().scenes[0].name, scene.name);
    let backup: String = g
        .conn
        .query_row(
            "SELECT filename FROM backup_records WHERE backup_type='upgrade'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let saved = Connection::open(directory.path().join("backups").join(backup)).unwrap();
    assert_eq!(
        saved
            .query_row("SELECT MAX(version) FROM migrations", [], |r| r
                .get::<_, i32>(0))
            .unwrap(),
        1
    );
    assert_eq!(config(&saved).unwrap().scenes[0].id, scene.id);
    assert_eq!(
        g.conn
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i32>(
                0
            ))
            .unwrap(),
        0
    );
}
#[test]
fn v1_scene_edit_preserves_workflow_and_failed_extension_transaction_rolls_back() {
    let d = tempfile::tempdir().unwrap();
    let db = Db::open(d.path()).unwrap();
    let mut g = db.lock().unwrap();
    let mut c = config(&g.conn).unwrap();
    let scene = Scene {
        id: id(),
        name: "测试".into(),
        description: "".into(),
        icon: "briefcase".into(),
        color: "#3B82F6".into(),
        enabled: true,
        sort_order: 0,
        created_at: now(),
        updated_at: now(),
    };
    let key = scene.id.clone();
    c.scenes.push(scene);
    write_config(&mut g.conn, &c).unwrap();
    let mut e = Extension::default();
    let workflow = executor::convert(&key, &c).unwrap();
    e.workflows.push(workflow.clone());
    let tx = g.conn.transaction().unwrap();
    repository::write(&tx, &e).unwrap();
    tx.commit().unwrap();
    c.scenes[0].name = "编辑后".into();
    write_config(&mut g.conn, &c).unwrap();
    assert_eq!(
        repository::load(&g.conn).unwrap().workflows[0].id,
        workflow.id
    );
    {
        let tx = g.conn.transaction().unwrap();
        tx.execute("DELETE FROM workflows", []).unwrap();
        assert!(tx
            .execute(
                "INSERT INTO scene_workflows VALUES('missing','missing')",
                []
            )
            .is_err());
    }
    assert_eq!(repository::load(&g.conn).unwrap().workflows.len(), 1);
}
#[test]
fn unknown_or_future_database_is_never_reset() {
    for future in [false, true] {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("startflow.sqlite3");
        let conn = Connection::open(&file).unwrap();
        conn.execute_batch(
            "CREATE TABLE user_data(value TEXT);INSERT INTO user_data VALUES('precious');",
        )
        .unwrap();
        if future {
            conn.execute_batch("CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT);INSERT INTO migrations VALUES(99,'future');").unwrap();
        }
        assert!(Db::open(d.path()).is_err());
        assert_eq!(
            conn.query_row("SELECT value FROM user_data", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "precious"
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='scenes'",
                [],
                |r| r.get::<_, i32>(0)
            )
            .unwrap(),
            0
        );
    }
}
