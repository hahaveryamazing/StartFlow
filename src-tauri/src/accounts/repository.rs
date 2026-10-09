use super::models::{Account, AccountKind};
use crate::error::{AppError, Result};
use rusqlite::{params, Connection, OptionalExtension};
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Account> {
    let kind: String = r.get(3)?;
    Ok(Account {
        id: r.get(0)?,
        name: r.get(1)?,
        username: r.get(2)?,
        kind: if kind == "web" {
            AccountKind::Web
        } else {
            AccountKind::App
        },
        target: r.get(4)?,
        credential_ref: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
        revision: r.get(8)?,
    })
}
pub fn list(conn: &Connection) -> Result<Vec<Account>> {
    let mut s=conn.prepare("SELECT id,name,username,kind,target,credential_ref,created_at,updated_at,revision FROM credential_accounts ORDER BY name,id")?;
    let rows = s
        .query_map([], row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
pub fn find(conn: &Connection, id: &str) -> Result<Account> {
    crate::models::validate_id(id)?;
    conn.query_row("SELECT id,name,username,kind,target,credential_ref,created_at,updated_at,revision FROM credential_accounts WHERE id=?1",[id],row).optional()?.ok_or_else(||AppError::new("account","账号已不存在，请刷新列表。"))
}
pub fn write(conn: &Connection, a: &Account) -> Result<()> {
    conn.execute("INSERT INTO credential_accounts VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET name=excluded.name,username=excluded.username,kind=excluded.kind,target=excluded.target,credential_ref=excluded.credential_ref,updated_at=excluded.updated_at,revision=excluded.revision",params![a.id,a.name,a.username,a.kind.as_str(),a.target,a.credential_ref,a.created_at,a.updated_at,a.revision])?;
    Ok(())
}
pub fn pending(conn: &Connection) -> Result<usize> {
    Ok(
        conn.query_row("SELECT COUNT(*) FROM credential_cleanup", [], |r| {
            r.get::<_, i64>(0)
        })? as usize,
    )
}
