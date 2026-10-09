use super::models::*;
use crate::{error::Result, models::now};
use rusqlite::{params, Connection, OptionalExtension};
// Durable per-account budget; a crash, closing during submit or a new config ID
// cannot reset the five-minute window. Clock rollback fails closed.
pub fn claim_attempt(c: &Connection, account: &str, seconds: u64) -> Result<bool> {
    Ok(c.execute("INSERT INTO web_login_attempts VALUES(?1,?2) ON CONFLICT(account_id) DO UPDATE SET last_requested_at=excluded.last_requested_at WHERE excluded.last_requested_at-web_login_attempts.last_requested_at>=300", params![account, seconds as i64])? == 1)
}
pub fn configs(c: &Connection) -> Result<Vec<LoginConfig>> {
    let mut s = c.prepare("SELECT payload FROM web_login_configs ORDER BY rowid DESC")?;
    let rows = s
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|v| Ok(serde_json::from_str(&v)?))
        .collect()
}
pub fn runs(c: &Connection) -> Result<Vec<LoginRun>> {
    let mut s = c.prepare("SELECT payload FROM web_login_runs ORDER BY rowid DESC LIMIT 100")?;
    let rows = s
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(|v| Ok(serde_json::from_str(&v)?))
        .collect()
}
pub fn runs_with_active(c: &Connection, active: &[String]) -> Result<Vec<LoginRun>> {
    let mut rows = runs(c)?;
    for id in active {
        if rows.iter().any(|r| &r.id == id) {
            continue;
        }
        let payload: Option<String> = c
            .query_row(
                "SELECT payload FROM web_login_runs WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(payload) = payload {
            rows.push(serde_json::from_str(&payload)?);
        }
    }
    Ok(rows)
}
pub fn previous_session(c: &Connection, account: &str) -> Result<bool> {
    Ok(c.query_row(r#"SELECT EXISTS(SELECT 1 FROM web_login_runs WHERE account_id=?1 AND status IN ('"authenticated"','"session_reused"','"session_expired"'))"#, [account], |r|r.get::<_,bool>(0))?)
}
pub fn save(c: &Connection, config: &LoginConfig) -> Result<()> {
    c.execute("INSERT INTO web_login_configs VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,payload=excluded.payload",params![config.id,config.account_id,serde_json::to_string(config)?])?;
    Ok(())
}
pub fn record(c: &Connection, run: &LoginRun) -> Result<()> {
    c.execute("INSERT INTO web_login_runs VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload",params![run.id,run.account_id,serde_json::to_string(&run.status)?,serde_json::to_string(run)?])?;
    Ok(())
}
pub fn interrupted(c: &Connection) -> Result<()> {
    c.execute(r#"UPDATE web_login_runs SET status='"interrupted"',payload=json_set(payload,'$.status','interrupted','$.updated_at',?1,'$.message',?2) WHERE status IN ('"checking_session"','"logging_in"','"waiting_manual"')"#, params![now(),Status::Interrupted.message()])?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attempt_budget_is_persistent_per_account_and_clock_rollback_safe() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("budget.sqlite3");
        let c = Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE web_login_attempts(account_id TEXT PRIMARY KEY,last_requested_at INTEGER NOT NULL)").unwrap();
        assert!(claim_attempt(&c, "a", 1000).unwrap());
        assert!(claim_attempt(&c, "b", 1001).unwrap());
        assert!(!claim_attempt(&c, "a", 1299).unwrap());
        drop(c);
        let c = Connection::open(path).unwrap();
        assert!(!claim_attempt(&c, "a", 900).unwrap());
        assert!(claim_attempt(&c, "a", 1300).unwrap());
    }
    #[test]
    fn active_and_interrupted_records_are_not_lost_beyond_display_limit() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE web_login_runs(id TEXT PRIMARY KEY,account_id TEXT,status TEXT,payload TEXT)").unwrap();
        let make = |status| LoginRun {
            id: crate::models::id(),
            config_id: crate::models::id(),
            account_id: "account".into(),
            status,
            submitted: false,
            started_at: now(),
            updated_at: now(),
            message: "test".into(),
        };
        record(&c, &make(Status::Authenticated)).unwrap();
        let active = make(Status::WaitingManual);
        record(&c, &active).unwrap();
        for _ in 0..110 {
            record(&c, &make(Status::Closed)).unwrap();
        }
        assert_eq!(runs(&c).unwrap().len(), 100);
        assert!(runs_with_active(&c, std::slice::from_ref(&active.id))
            .unwrap()
            .iter()
            .any(|r| r.id == active.id));
        assert!(previous_session(&c, "account").unwrap());
        interrupted(&c).unwrap();
        let payload: String = c
            .query_row(
                "SELECT payload FROM web_login_runs WHERE id=?1",
                [&active.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<LoginRun>(&payload).unwrap().status,
            Status::Interrupted
        );
    }
}
