use super::{models::*, repository, service, vault::Vault};
use crate::{
    database::Db,
    error::{AppError, Result},
};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
};
#[derive(Default)]
struct MockVault {
    values: RefCell<HashMap<String, String>>,
    fail_write: Cell<bool>,
    fail_delete: Cell<bool>,
    fail_read: Cell<bool>,
}
impl Vault for MockVault {
    fn put(&self, id: &str, _: &str, password: &Secret) -> Result<()> {
        if self.fail_write.get() {
            return Err(AppError::new("credential", "测试写入故障。"));
        }
        self.values
            .borrow_mut()
            .insert(id.into(), password.value().into());
        Ok(())
    }
    fn exists(&self, id: &str) -> Result<bool> {
        if self.fail_read.get() {
            return Err(AppError::new("credential", "测试读取故障。"));
        }
        Ok(self.values.borrow().contains_key(id))
    }
    fn delete(&self, id: &str) -> Result<()> {
        if self.fail_delete.get() {
            return Err(AppError::new("credential", "测试删除故障。"));
        }
        self.values.borrow_mut().remove(id);
        Ok(())
    }
}
fn request(password: Option<&str>) -> WriteAccount {
    WriteAccount {
        id: None,
        name: "工作账号".into(),
        username: "user@example.test".into(),
        kind: AccountKind::Web,
        target: "https://example.test/path".into(),
        password: password.map(|s| serde_json::from_value(serde_json::json!(s)).unwrap()),
        expected_revision: None,
    }
}
#[test]
fn multiple_accounts_same_target_and_password_never_in_metadata_or_backup() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(dir.path()).unwrap();
    let mut g = db.lock().unwrap();
    let vault = MockVault::default();
    let first = service::save(
        &mut g.conn,
        &vault,
        request(Some("test-secret-DO-NOT-PERSIST")),
    )
    .unwrap()
    .account
    .unwrap();
    let mut other = request(Some("test-secret-OTHER"));
    other.username = "other@example.test".into();
    service::save(&mut g.conn, &vault, other).unwrap();
    let list = service::list(&g.conn, &vault).unwrap();
    assert_eq!(list.accounts.len(), 2);
    assert!(list
        .accounts
        .iter()
        .all(|a| a.account.target == "https://example.test"));
    let json = serde_json::to_string(&list).unwrap();
    assert!(!json.contains("test-secret"));
    assert!(!json.contains("password"));
    let backup = dir.path().join("security.sqlite3");
    g.conn.backup(rusqlite::MAIN_DB, &backup, None).unwrap();
    assert!(!String::from_utf8_lossy(&std::fs::read(backup).unwrap()).contains("test-secret"));
    assert!(vault.exists(&first.account.credential_ref).unwrap());
}
#[test]
fn update_rotates_secret_and_metadata_only_keeps_reference() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(dir.path()).unwrap();
    let mut g = db.lock().unwrap();
    let vault = MockVault::default();
    let first = service::save(&mut g.conn, &vault, request(Some("old")))
        .unwrap()
        .account
        .unwrap()
        .account;
    let mut edit = request(None);
    edit.id = Some(first.id.clone());
    edit.expected_revision = Some(first.revision);
    edit.username = "renamed".into();
    let metadata = service::save(&mut g.conn, &vault, edit)
        .unwrap()
        .account
        .unwrap()
        .account;
    assert_eq!(metadata.credential_ref, first.credential_ref);
    let mut edit = request(Some("new"));
    edit.id = Some(first.id.clone());
    edit.expected_revision = Some(metadata.revision);
    let updated = service::save(&mut g.conn, &vault, edit)
        .unwrap()
        .account
        .unwrap()
        .account;
    assert_ne!(updated.credential_ref, first.credential_ref);
    assert!(!vault.exists(&first.credential_ref).unwrap());
    assert_eq!(vault.values.borrow()[&updated.credential_ref], "new");
    service::delete(&mut g.conn, &vault, &updated.id, updated.revision).unwrap();
    assert!(repository::list(&g.conn).unwrap().is_empty());
    assert!(vault.values.borrow().is_empty());
}
#[test]
fn failed_vault_write_or_database_commit_preserves_old_account() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(dir.path()).unwrap();
    let mut g = db.lock().unwrap();
    let vault = MockVault::default();
    let first = service::save(&mut g.conn, &vault, request(Some("old")))
        .unwrap()
        .account
        .unwrap()
        .account;
    let edit = || {
        let mut r = request(Some("new"));
        r.id = Some(first.id.clone());
        r.expected_revision = Some(first.revision);
        r
    };
    vault.fail_write.set(true);
    assert!(service::save(&mut g.conn, &vault, edit()).is_err());
    vault.fail_write.set(false);
    g.conn.execute_batch("CREATE TRIGGER fail_account BEFORE UPDATE ON credential_accounts BEGIN SELECT RAISE(ABORT,'injected failure');END;").unwrap();
    assert!(service::save(&mut g.conn, &vault, edit()).is_err());
    assert_eq!(
        repository::find(&g.conn, &first.id).unwrap().credential_ref,
        first.credential_ref
    );
    assert_eq!(vault.values.borrow().len(), 1);
    assert_eq!(repository::pending(&g.conn).unwrap(), 0);
}
#[test]
fn deferred_cleanup_survives_restart_and_never_deletes_active_reference() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(dir.path()).unwrap();
    let mut g = db.lock().unwrap();
    let vault = MockVault::default();
    let first = service::save(&mut g.conn, &vault, request(Some("old")))
        .unwrap()
        .account
        .unwrap()
        .account;
    vault.fail_delete.set(true);
    assert_eq!(
        service::delete(&mut g.conn, &vault, &first.id, first.revision)
            .unwrap()
            .pending_cleanup,
        1
    );
    drop(g);
    drop(db);
    let db = Db::open(dir.path()).unwrap();
    let mut g = db.lock().unwrap();
    vault.fail_delete.set(false);
    assert_eq!(service::cleanup(&g.conn, &vault).unwrap(), 0);
    assert!(vault.values.borrow().is_empty());
    let active = service::save(&mut g.conn, &vault, request(Some("active")))
        .unwrap()
        .account
        .unwrap()
        .account;
    g.conn
        .execute(
            "INSERT INTO credential_cleanup VALUES(?1)",
            [&active.credential_ref],
        )
        .unwrap();
    assert_eq!(service::cleanup(&g.conn, &vault).unwrap(), 1);
    assert!(vault.exists(&active.credential_ref).unwrap());
}
#[test]
fn stale_edit_and_invalid_or_foreign_references_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(dir.path()).unwrap();
    let mut g = db.lock().unwrap();
    let vault = MockVault::default();
    let first = service::save(&mut g.conn, &vault, request(Some("old")))
        .unwrap()
        .account
        .unwrap()
        .account;
    let mut stale = request(Some("new"));
    stale.id = Some(first.id.clone());
    stale.expected_revision = Some(-1);
    assert_eq!(
        service::save(&mut g.conn, &vault, stale)
            .err()
            .unwrap()
            .code,
        "conflict"
    );
    assert!(repository::find(&g.conn, &crate::models::id()).is_err());
    let json = serde_json::json!({"id":null,"name":"x","username":"x","kind":"web","target":"https://example.test","password":"test-only","expected_revision":null,"credential_ref":crate::models::id()});
    assert!(serde_json::from_value::<WriteAccount>(json).is_err());
}
#[test]
fn schema_rejects_inline_secrets_shell_targets_and_oversized_password() {
    for target in [
        "https://user:secret@example.test",
        "https://example.test/?token=secret",
        "javascript:alert(1)",
    ] {
        let mut r = request(Some("test"));
        r.target = target.into();
        assert!(r.validate().is_err());
    }
    let mut r = request(Some(&"a".repeat(2561)));
    assert!(r.validate().is_err());
    let mut r = request(Some("test"));
    r.kind = AccountKind::App;
    r.target = "C:\\sample.cmd".into();
    assert!(r.validate().is_err());
}

#[test]
fn unavailable_vault_never_reported_as_missing_or_saved() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(dir.path()).unwrap();
    let mut g = db.lock().unwrap();
    let vault = MockVault::default();
    service::save(&mut g.conn, &vault, request(Some("test-only"))).unwrap();
    vault.fail_read.set(true);
    assert_eq!(
        service::list(&g.conn, &vault).unwrap().accounts[0].credential_state,
        "unavailable"
    );
}

#[test]
fn staged_orphan_recovered_and_legacy_config_restore_preserves_accounts() {
    let dir = tempfile::tempdir().unwrap();
    let db = Db::open(dir.path()).unwrap();
    let vault = MockVault::default();
    let mut g = db.lock().unwrap();
    let account = service::save(&mut g.conn, &vault, request(Some("existing-test-only")))
        .unwrap()
        .account
        .unwrap()
        .account;
    let orphan = crate::models::id();
    g.conn
        .execute("INSERT INTO credential_cleanup VALUES(?1)", [&orphan])
        .unwrap();
    let password: Secret = serde_json::from_value(serde_json::json!("orphan-test-only")).unwrap();
    vault.put(&orphan, "test", &password).unwrap();
    drop(g);
    drop(db);
    let db = Db::open(dir.path()).unwrap();
    let mut g = db.lock().unwrap();
    assert_eq!(service::cleanup(&g.conn, &vault).unwrap(), 0);
    assert!(!vault.exists(&orphan).unwrap());
    assert!(vault.exists(&account.credential_ref).unwrap());
    let bundle = crate::backups::make_bundle(&g.conn, dir.path()).unwrap();
    let json = serde_json::to_string(&bundle).unwrap();
    assert!(json.contains(&account.credential_ref)); // Typed metadata only, never a vault secret.
    assert!(!json.contains("existing-test-only"));
    crate::database::write_config(&mut g.conn, &bundle.config).unwrap();
    crate::v2::repository::write(&g.conn, &bundle.extension).unwrap();
    assert_eq!(
        repository::find(&g.conn, &account.id)
            .unwrap()
            .credential_ref,
        account.credential_ref
    );
}
