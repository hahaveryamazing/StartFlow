use super::{models::*, repository, vault::Vault};
use crate::{
    error::{AppError, Result},
    models::{id, now},
};
use rusqlite::Connection;
pub fn view(account: Account, vault: &dyn Vault) -> AccountView {
    let state = match vault.exists(&account.credential_ref) {
        Ok(true) => "saved",
        Ok(false) => "missing",
        Err(_) => "unavailable",
    };
    AccountView {
        account,
        credential_state: state.into(),
    }
}
pub fn list(conn: &Connection, vault: &dyn Vault) -> Result<AccountList> {
    Ok(AccountList {
        accounts: repository::list(conn)?
            .into_iter()
            .map(|a| view(a, vault))
            .collect(),
        pending_cleanup: repository::pending(conn)?,
    })
}
// Called only under the account mutation gate. No password reads or copy into SQLite.
pub fn cleanup(conn: &Connection, vault: &dyn Vault) -> Result<usize> {
    let mut s = conn.prepare("SELECT credential_ref FROM credential_cleanup LIMIT 500")?;
    let refs = s
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(s);
    for reference in refs {
        let used: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM credential_accounts WHERE credential_ref=?1)",
            [&reference],
            |r| r.get(0),
        )?;
        if used {
            continue;
        }
        if vault.delete(&reference).is_ok() {
            conn.execute(
                "DELETE FROM credential_cleanup WHERE credential_ref=?1",
                [&reference],
            )?;
        }
    }
    repository::pending(conn)
}
pub fn save(
    conn: &mut Connection,
    vault: &dyn Vault,
    mut request: WriteAccount,
) -> Result<Mutation> {
    request.validate()?;
    let old = request
        .id
        .as_ref()
        .map(|key| repository::find(conn, key))
        .transpose()?;
    if let Some(old) = &old {
        if request.expected_revision != Some(old.revision) {
            return Err(AppError::new(
                "conflict",
                "账号已被修改，请刷新后重新编辑。",
            ));
        }
    } else {
        if request.password.is_none() {
            return Err(AppError::new("credential", "新增账号时请填写密码。"));
        }
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM credential_accounts", [], |r| r.get(0))?;
        if count >= 500 {
            return Err(AppError::new(
                "account",
                "账号数量已达 500，请先清理不需要的账号。",
            ));
        }
    }
    let replaced = request.password.is_some();
    let reference = if replaced {
        id()
    } else {
        old.as_ref()
            .ok_or_else(|| AppError::new("credential", "请填写密码。"))?
            .credential_ref
            .clone()
    };
    let account = Account {
        id: old.as_ref().map(|a| a.id.clone()).unwrap_or_else(id),
        name: request.name,
        username: request.username,
        kind: request.kind,
        target: request.target,
        credential_ref: reference.clone(),
        created_at: old
            .as_ref()
            .map(|a| a.created_at.clone())
            .unwrap_or_else(now),
        updated_at: now(),
        revision: old
            .as_ref()
            .map(|a| {
                a.revision
                    .checked_add(1)
                    .ok_or_else(|| AppError::new("account", "账号版本超出限制。"))
            })
            .transpose()?
            .unwrap_or(1),
    };
    if let Some(password) = &request.password {
        // Commit a cleanup journal BEFORE writing a new immutable vault reference.
        // A crash before metadata commit leaves a recoverable orphan, never loses the old secret.
        conn.execute("INSERT INTO credential_cleanup VALUES(?1)", [&reference])?;
        if let Err(e) = vault.put(&reference, &account.username, password) {
            let _ = cleanup(conn, vault);
            return Err(e);
        }
    }
    let result = (|| -> Result<()> {
        let tx = conn.transaction()?;
        repository::write(&tx, &account)?;
        if replaced {
            tx.execute(
                "DELETE FROM credential_cleanup WHERE credential_ref=?1",
                [&reference],
            )?;
            if let Some(old) = &old {
                tx.execute(
                    "INSERT OR IGNORE INTO credential_cleanup VALUES(?1)",
                    [&old.credential_ref],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    })();
    if let Err(e) = result {
        let _ = cleanup(conn, vault);
        return Err(e);
    }
    // Metadata commit is authoritative; cleanup failure is visible and retried, not a fake rollback.
    let _ = cleanup(conn, vault);
    Ok(Mutation {
        account: Some(view(account, vault)),
        pending_cleanup: repository::pending(conn)?,
    })
}
pub fn delete(
    conn: &mut Connection,
    vault: &dyn Vault,
    id: &str,
    expected: i64,
) -> Result<Mutation> {
    let old = repository::find(conn, id)?;
    if old.revision != expected {
        return Err(AppError::new("conflict", "账号已被修改，请刷新后再删除。"));
    }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM credential_accounts WHERE id=?1", [id])?;
    tx.execute(
        "INSERT OR IGNORE INTO credential_cleanup VALUES(?1)",
        [&old.credential_ref],
    )?;
    tx.commit()?;
    let _ = cleanup(conn, vault);
    Ok(Mutation {
        account: None,
        pending_cleanup: repository::pending(conn)?,
    })
}
