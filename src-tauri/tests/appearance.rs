use startflow_lib::{
    database::{self, Db},
    v2::{models::Theme, repository},
};

#[test]
fn saves_color_and_preset_together_without_rewriting_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("startflow.sqlite3")).unwrap();
    conn.execute_batch(include_str!("fixtures/v3-populated.sql"))
        .unwrap();
    drop(conn);
    let db = Db::open(dir.path()).unwrap();
    let mut g = db.lock().unwrap();
    let before = database::config(&g.conn).unwrap();
    let mut settings = before.settings.clone();
    settings.accent = "#22c55e".into();
    let theme = Theme {
        preset: "forest".into(),
        ..Theme::default()
    };
    repository::save_preferences(&mut g.conn, settings, Some(theme)).unwrap();
    let after = database::config(&g.conn).unwrap();
    assert_eq!(after.settings.accent, "#22c55e");
    assert_eq!(repository::load(&g.conn).unwrap().theme.preset, "forest");
    assert_eq!(
        serde_json::to_value(before.scenes).unwrap(),
        serde_json::to_value(after.scenes).unwrap()
    );
    assert_eq!(
        g.conn
            .query_row("SELECT MAX(version) FROM migrations", [], |r| r
                .get::<_, i32>(0))
            .unwrap(),
        7
    );
    // An appearance-only save must never delete workflow rows or login grants.
    g.conn.execute_batch("CREATE TRIGGER block_workflow_delete BEFORE DELETE ON workflows BEGIN SELECT RAISE(ABORT,'unexpected workflow rewrite'); END;").unwrap();
    let settings = after.settings;
    repository::save_preferences(&mut g.conn, settings, Some(Theme::default())).unwrap();
}

#[test]
fn failed_theme_write_rolls_back_color_and_preserves_old_api() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(dir.path()).unwrap();
    let mut g = db.lock().unwrap();
    let previous = database::config(&g.conn).unwrap().settings;
    g.conn.execute_batch("CREATE TRIGGER reject_theme BEFORE INSERT ON settings WHEN NEW.key='v2' BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END;").unwrap();
    let mut changed = previous.clone();
    changed.accent = "#ef4444".into();
    assert!(
        repository::save_preferences(&mut g.conn, changed.clone(), Some(Theme::default())).is_err()
    );
    assert_eq!(
        database::config(&g.conn).unwrap().settings.accent,
        previous.accent
    );
    repository::save_preferences(&mut g.conn, changed, None).unwrap();
    assert_eq!(
        database::config(&g.conn).unwrap().settings.accent,
        "#ef4444"
    );
}

#[test]
fn appearance_validation_and_backup_preferences_are_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(dir.path()).unwrap();
    let mut g = db.lock().unwrap();
    let mut extension = repository::load(&g.conn).unwrap();
    extension.theme.backup_frequency = "weekly".into();
    extension.theme.backup_retention = 12;
    repository::write(&g.conn, &extension).unwrap();
    let settings = database::config(&g.conn).unwrap().settings;
    let bad = Theme {
        preset: "unknown".into(),
        ..Theme::default()
    };
    assert!(repository::save_preferences(&mut g.conn, settings.clone(), Some(bad)).is_err());
    let mut bad_color = settings.clone();
    bad_color.accent = "red".into();
    assert!(repository::save_preferences(&mut g.conn, bad_color, Some(Theme::default())).is_err());
    repository::save_preferences(&mut g.conn, settings, Some(Theme::default())).unwrap();
    let saved = repository::load(&g.conn).unwrap().theme;
    assert_eq!(saved.backup_frequency, "weekly");
    assert_eq!(saved.backup_retention, 12);
}
