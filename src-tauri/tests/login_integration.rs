use rusqlite::params;
use startflow_lib::{
    database::Db,
    login::{self, backup},
    models::{id, now},
    v2::models::Extension,
    workflow::{executor::convert, models::NodeConfig},
};
fn fixture() -> (
    tempfile::TempDir,
    Db,
    startflow_lib::workflow::models::Workflow,
    backup::Metadata,
) {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(dir.path()).unwrap();
    let c = rusqlite::Connection::open(dir.path().join("startflow.sqlite3")).unwrap();
    let stamp = now();
    let sid = id();
    let mut config = startflow_lib::models::Config::default();
    config.scenes.push(startflow_lib::models::Scene {
        id: sid.clone(),
        name: "登录工作流".into(),
        description: "".into(),
        icon: "briefcase".into(),
        color: "#3B82F6".into(),
        enabled: true,
        sort_order: 0,
        created_at: stamp.clone(),
        updated_at: stamp.clone(),
    });
    startflow_lib::database::write_config_rows(&c, &config).unwrap();
    let a = startflow_lib::accounts::models::Account {
        id: id(),
        name: "测试账号".into(),
        username: "test@example.test".into(),
        kind: startflow_lib::accounts::models::AccountKind::Web,
        target: "https://example.test".into(),
        credential_ref: id(),
        created_at: stamp.clone(),
        updated_at: stamp,
        revision: 1,
    };
    let web = startflow_lib::web_login::models::LoginConfig {
        id: id(),
        account_id: a.id.clone(),
        name: "网页规则".into(),
        origin: a.target.clone(),
        login_url: "https://example.test/login".into(),
        form_action_url: "https://example.test/session".into(),
        username_selector: "#user".into(),
        password_selector: "#pass".into(),
        submit_selector: "#submit".into(),
        success_selector: "#success".into(),
        identity_selector: "#identity".into(),
        challenge_selector: "#mfa".into(),
        failure_selector: "#error".into(),
        timeout_seconds: 10,
        schema_version: 1,
        credential_ref: Some(a.credential_ref.clone()),
        locators: None,
    };
    let meta = backup::Metadata {
        accounts: vec![a],
        web: vec![web.clone()],
        desktop: vec![],
    };
    backup::write(&c, &meta).unwrap();
    let mut w = convert(&sid, &config).unwrap();
    let end = w.nodes.pop().unwrap();
    let mut n = end.clone();
    n.id = id();
    n.name = "登录".into();
    n.config = NodeConfig::AutoLogin {
        target: "web".into(),
        config_id: web.id,
        timeout_seconds: 30,
        failure_policy: "stop".into(),
    };
    w.nodes.push(n.clone());
    w.nodes.push(end.clone());
    w.edges[0].target = n.id.clone();
    w.edges.push(startflow_lib::workflow::models::Edge {
        id: id(),
        source: n.id,
        target: end.id,
        handle: "next".into(),
    });
    let e = Extension {
        workflows: vec![w.clone()],
        ..Default::default()
    };
    startflow_lib::v2::repository::write(&c, &e).unwrap();
    (dir, db, w, meta)
}
#[test]
fn grants_bind_workflow_config_and_credential_revision_but_ignore_visual_coordinates() {
    let (_dir, db, mut w, m) = fixture();
    let g = db.lock().unwrap();
    let v = login::fingerprint(&g.conn, &w).unwrap();
    g.conn
        .execute(
            "INSERT INTO workflow_login_grants VALUES(?1,?2,?3)",
            params![w.id, v, now()],
        )
        .unwrap();
    assert!(login::granted(&g.conn, &w).unwrap());
    w.updated_at = now();
    w.nodes[1].x = 100.;
    assert!(login::granted(&g.conn, &w).unwrap());
    w.max_seconds += 1;
    assert!(!login::granted(&g.conn, &w).unwrap());
    w.max_seconds -= 1;
    g.conn
        .execute(
            "UPDATE credential_accounts SET revision=revision+1 WHERE id=?1",
            [&m.accounts[0].id],
        )
        .unwrap();
    assert!(!login::granted(&g.conn, &w).unwrap());
}
#[test]
fn exports_and_merge_preserve_login_links_without_reusing_password_references() {
    let (dir, db, w, m) = fixture();
    let g = db.lock().unwrap();
    let b = startflow_lib::backups::make_bundle(&g.conn, dir.path()).unwrap();
    assert_eq!(b.schema_version, 4);
    startflow_lib::backups::validate_bundle(&b).unwrap();
    let merged = startflow_lib::backups::merge(&b, &b).unwrap();
    let meta = merged.login.unwrap();
    assert_eq!(meta.accounts.len(), 2);
    assert_ne!(
        meta.accounts[0].credential_ref,
        meta.accounts[1].credential_ref
    );
    assert_eq!(
        meta.accounts[0].credential_ref,
        m.accounts[0].credential_ref
    );
    let new = &merged.extension.workflows[1];
    assert_ne!(new.id, w.id);
    let (_, key) = new.nodes[1].config.login_reference().unwrap();
    assert_eq!(key, meta.web[1].id);
    assert_eq!(meta.web[1].account_id, meta.accounts[1].id);
    assert_eq!(
        meta.web[1].credential_ref.as_deref(),
        Some(meta.accounts[1].credential_ref.as_str())
    );
    let mut json = serde_json::to_value(b).unwrap();
    json["login"]["accounts"][0]["password"] = serde_json::json!("forbidden");
    assert!(serde_json::from_value::<startflow_lib::v2::models::Bundle>(json).is_err());
}
#[test]
fn imported_rules_cannot_add_inline_secret_or_login_authorization() {
    for text in [
        r#"{"type":"auto_login","target":"web","config_id":"x","timeout_seconds":30,"failure_policy":"stop","password":"bad"}"#,
        r#"{"type":"auto_login","target":"web","config_id":"x","timeout_seconds":30,"failure_policy":"stop","authorized":true}"#,
        r#"{"type":"login_check","target":"web","config_id":"x","timeout_seconds":30,"cookie":"bad"}"#,
    ] {
        assert!(serde_json::from_str::<NodeConfig>(text).is_err());
    }
}
#[test]
fn schema7_backup_keeps_all_legacy_rows_and_failed_migration_rolls_back() {
    let (dir, db, _w, _m) = fixture();
    drop(db);
    let c = rusqlite::Connection::open(dir.path().join("startflow.sqlite3")).unwrap();
    c.execute_batch("DROP TABLE workflow_login_grants;DELETE FROM migrations WHERE version=7;")
        .unwrap();
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM workflows", [], |r| r.get(0))
        .unwrap();
    drop(c);
    let db = Db::open(dir.path()).unwrap();
    let g = db.lock().unwrap();
    assert_eq!(
        g.conn
            .query_row("SELECT MAX(version) FROM migrations", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        7
    );
    assert_eq!(
        g.conn
            .query_row("SELECT COUNT(*) FROM workflows", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        n
    );
    assert!(std::fs::read_dir(dir.path().join("backups"))
        .unwrap()
        .flatten()
        .any(|f| {
            let c = rusqlite::Connection::open(f.path()).unwrap();
            c.query_row("SELECT MAX(version) FROM migrations", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap()
                == 6
        }));
    drop(g);
    drop(db);
    let c = rusqlite::Connection::open(dir.path().join("startflow.sqlite3")).unwrap();
    c.execute_batch("DELETE FROM migrations WHERE version=7;")
        .unwrap();
    assert!(Db::open(dir.path()).is_err());
    assert_eq!(
        c.query_row("SELECT MAX(version) FROM migrations", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        6
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM workflows", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        n
    );
}
#[test]
fn unchanged_extension_save_preserves_local_grant_and_edit_revokes_it() {
    let (_dir, db, w, _m) = fixture();
    let g = db.lock().unwrap();
    g.conn
        .execute(
            "INSERT INTO workflow_login_grants VALUES(?1,?2,?3)",
            params![w.id, login::fingerprint(&g.conn, &w).unwrap(), now()],
        )
        .unwrap();
    let mut e = startflow_lib::v2::repository::load(&g.conn).unwrap();
    startflow_lib::v2::repository::write(&g.conn, &e).unwrap();
    assert!(login::granted(&g.conn, &w).unwrap());
    e.workflows[0].max_seconds += 1;
    startflow_lib::v2::repository::write(&g.conn, &e).unwrap();
    assert!(!login::granted(&g.conn, &e.workflows[0]).unwrap());
}
#[tokio::test]
async fn login_wait_uses_real_cancel_control() {
    let r = startflow_lib::runtime::Runtime::default();
    let c = r.register("login").unwrap().with_deadline(600);
    let work = tokio::spawn(async move { c.wait(std::time::Duration::from_secs(30)).await });
    r.cancel("login").unwrap();
    let error = tokio::time::timeout(std::time::Duration::from_secs(1), work)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(error.code, "cancelled");
}
