use crate::{
    error::{AppError, Result},
    models::*,
};
use rusqlite::{params, Connection};
use std::{collections::HashSet, path::Path, sync::Mutex};
pub struct Db {
    pub inner: Mutex<Inner>,
    pub directory: String,
}
pub struct Inner {
    pub conn: Connection,
    pub active: HashSet<String>,
}
impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        std::fs::create_dir_all(path).map_err(AppError::internal)?;
        let file = path.join("startflow.sqlite3");
        let existing = file.exists();
        let mut conn = Connection::open(&file)?;
        let has_migrations: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='migrations')",
            [],
            |r| r.get(0),
        )?;
        if existing && !has_migrations {
            return Err(AppError::new(
                "migration",
                "已有文件不是可识别的 StartFlow 数据库；已停止初始化，未覆盖数据。",
            ));
        }
        if has_migrations
            && conn.query_row("SELECT COALESCE(MAX(version),0) FROM migrations", [], |r| {
                r.get::<_, i32>(0)
            })? > 7
        {
            return Err(AppError::new(
                "migration",
                "此数据库来自更新版本，未修改原数据。",
            ));
        }
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS scenes(id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL, sort_order INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));
          CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('web','app','folder')), enabled INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));
          CREATE TABLE IF NOT EXISTS scene_tasks(id TEXT PRIMARY KEY, scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, sort_order INTEGER NOT NULL, UNIQUE(scene_id,task_id));
          CREATE INDEX IF NOT EXISTS scene_order ON scene_tasks(scene_id,sort_order);
          CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, trigger_type TEXT NOT NULL, enabled INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)));
          CREATE INDEX IF NOT EXISTS schedule_enabled ON schedules(enabled,scene_id);
          CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL CHECK(json_valid(value_json)));
          CREATE TABLE IF NOT EXISTS execution_runs(id TEXT PRIMARY KEY, scene_id TEXT, scene_name_snapshot TEXT NOT NULL, trigger_type TEXT NOT NULL, rule_id TEXT, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, local_run_date TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS runs_date ON execution_runs(started_at DESC);
          CREATE TABLE IF NOT EXISTS execution_logs(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES execution_runs(id) ON DELETE CASCADE, task_id TEXT NOT NULL, task_name_snapshot TEXT NOT NULL, started_at TEXT, finished_at TEXT, status TEXT NOT NULL, message TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS logs_run ON execution_logs(run_id);
          CREATE TABLE IF NOT EXISTS automatic_claims(scene_id TEXT NOT NULL, local_date TEXT NOT NULL, rule_id TEXT NOT NULL, claimed_at TEXT NOT NULL, PRIMARY KEY(scene_id,local_date));
          CREATE TABLE IF NOT EXISTS rule_history(rule_id TEXT NOT NULL, local_date TEXT NOT NULL, triggered_at TEXT NOT NULL, PRIMARY KEY(rule_id,local_date));
          INSERT OR IGNORE INTO migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));")?;
        crate::migrations::migrate(&mut conn, path, existing)?;
        crate::web_login::repository::interrupted(&conn)?;
        conn.execute("UPDATE desktop_login_runs SET status='interrupted',payload=json_set(payload,'$.result.status','interrupted','$.result.message','上次登录因程序退出而中断，不会自动重试。','$.finished_at',?1) WHERE status='running'", [now()])?;
        // A crash or explicit quit must never leave a run permanently 'running'.
        conn.execute("UPDATE execution_logs SET status='failed', message='上次执行因软件退出或异常中断。', finished_at=?1 WHERE status IN ('pending','running')",[now()])?;
        conn.execute(
            "UPDATE execution_runs SET status='interrupted',finished_at=?1 WHERE status='running'",
            [now()],
        )?;
        conn.execute("UPDATE workflow_execution_logs SET status=CASE WHEN status='pending' THEN 'skipped' ELSE 'interrupted' END,error_message='上次流程因退出或异常中断；不会从中间节点自动恢复。',finished_at=?1 WHERE status IN ('pending','running','waiting_manual')",[now()])?;
        conn.execute("UPDATE automation_decisions SET status='interrupted',payload=json_set(payload,'$.decision','interrupted') WHERE status IN ('execute','running','evaluating')",[])?;
        conn.execute(
            "UPDATE automation_events SET status='interrupted' WHERE status='evaluating'",
            [],
        )?;
        Ok(Self {
            inner: Mutex::new(Inner {
                conn,
                active: HashSet::new(),
            }),
            directory: path.to_string_lossy().into(),
        })
    }
    pub fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>> {
        self.inner
            .lock()
            .map_err(|_| AppError::new("storage", "数据服务暂时不可用，请重新启动。"))
    }
}
fn payloads<T: serde::de::DeserializeOwned>(conn: &Connection, table: &str) -> Result<Vec<T>> {
    let sql = match table {
        "scenes" => "SELECT payload FROM scenes ORDER BY sort_order,rowid",
        "tasks" => "SELECT payload FROM tasks ORDER BY rowid",
        "schedules" => "SELECT payload FROM schedules ORDER BY rowid",
        _ => return Err(AppError::new("storage", "未知数据类型。")),
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
}
pub fn config(conn: &Connection) -> Result<Config> {
    let settings = conn.query_row(
        "SELECT value_json FROM settings WHERE key='general'",
        [],
        |r| r.get::<_, String>(0),
    );
    let settings = match settings {
        Ok(s) => serde_json::from_str(&s)?,
        Err(rusqlite::Error::QueryReturnedNoRows) => Settings::default(),
        Err(e) => return Err(e.into()),
    };
    let mut stmt = conn.prepare(
        "SELECT id,scene_id,task_id,sort_order FROM scene_tasks ORDER BY scene_id,sort_order,rowid",
    )?;
    let links = stmt
        .query_map([], |r| {
            Ok(SceneTask {
                id: r.get(0)?,
                scene_id: r.get(1)?,
                task_id: r.get(2)?,
                sort_order: r.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(Config {
        version: 1,
        scenes: payloads(conn, "scenes")?,
        tasks: payloads(conn, "tasks")?,
        schedules: payloads(conn, "schedules")?,
        scene_tasks: links,
        settings,
    })
}
pub fn write_config(conn: &mut Connection, c: &Config) -> Result<()> {
    c.validate()?;
    crate::v2::repository::validate_changes(conn, c)?;
    let tx = conn.transaction()?;
    write_config_rows(&tx, c)?;
    tx.commit()?;
    Ok(())
}
pub fn write_config_rows(conn: &Connection, c: &Config) -> Result<()> {
    c.validate()?;
    let tx = conn;
    tx.execute_batch("DELETE FROM scene_tasks; DELETE FROM schedules;")?;
    for (table, ids) in [
        (
            "scenes",
            c.scenes
                .iter()
                .map(|s| s.id.as_str())
                .collect::<HashSet<_>>(),
        ),
        (
            "tasks",
            c.tasks
                .iter()
                .map(|s| s.id.as_str())
                .collect::<HashSet<_>>(),
        ),
    ] {
        let sql = if table == "scenes" {
            "SELECT id FROM scenes"
        } else {
            "SELECT id FROM tasks"
        };
        let existing = tx
            .prepare(sql)?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for key in existing {
            if !ids.contains(key.as_str()) {
                tx.execute(
                    if table == "scenes" {
                        "DELETE FROM scenes WHERE id=?1"
                    } else {
                        "DELETE FROM tasks WHERE id=?1"
                    },
                    [key],
                )?;
            }
        }
    }
    for s in &c.scenes {
        tx.execute(
            "INSERT INTO scenes VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,sort_order=excluded.sort_order,payload=excluded.payload",
            params![
                s.id,
                s.name,
                s.enabled,
                s.sort_order,
                serde_json::to_string(s)?
            ],
        )?;
    }
    for t in &c.tasks {
        tx.execute(
            "INSERT INTO tasks VALUES(?1,?2,?3,?4,?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,enabled=excluded.enabled,payload=excluded.payload",
            params![t.id, t.name, t.kind, t.enabled, serde_json::to_string(t)?],
        )?;
    }
    for a in &c.scene_tasks {
        tx.execute(
            "INSERT INTO scene_tasks VALUES(?1,?2,?3,?4)",
            params![a.id, a.scene_id, a.task_id, a.sort_order],
        )?;
    }
    for s in &c.schedules {
        tx.execute(
            "INSERT INTO schedules VALUES(?1,?2,?3,?4,?5)",
            params![
                s.id,
                s.scene_id,
                s.trigger_type,
                s.enabled,
                serde_json::to_string(s)?
            ],
        )?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO settings VALUES('general',?1)",
        [serde_json::to_string(&c.settings)?],
    )?;
    tx.execute("DELETE FROM shortcuts WHERE json_extract(payload,'$.action')='scene' AND json_extract(payload,'$.target_id') NOT IN(SELECT id FROM scenes)",[])?;
    Ok(())
}
pub fn runs(conn: &Connection) -> Result<Vec<Run>> {
    let mut s=conn.prepare("SELECT id,scene_id,scene_name_snapshot,trigger_type,rule_id,started_at,finished_at,status,local_run_date FROM execution_runs ORDER BY started_at DESC,rowid DESC LIMIT 500")?;
    let result = s
        .query_map([], |r| {
            Ok(Run {
                id: r.get(0)?,
                scene_id: r.get(1)?,
                scene_name_snapshot: r.get(2)?,
                trigger_type: r.get(3)?,
                rule_id: r.get(4)?,
                started_at: r.get(5)?,
                finished_at: r.get(6)?,
                status: r.get(7)?,
                local_run_date: r.get(8)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(result)
}
pub fn logs(conn: &Connection) -> Result<Vec<Log>> {
    let mut s=conn.prepare("SELECT id,run_id,task_id,task_name_snapshot,started_at,finished_at,status,message FROM execution_logs WHERE run_id IN (SELECT id FROM execution_runs ORDER BY started_at DESC,rowid DESC LIMIT 500) ORDER BY rowid")?;
    let result = s
        .query_map([], |r| {
            Ok(Log {
                id: r.get(0)?,
                run_id: r.get(1)?,
                task_id: r.get(2)?,
                task_name_snapshot: r.get(3)?,
                started_at: r.get(4)?,
                finished_at: r.get(5)?,
                status: r.get(6)?,
                message: r.get(7)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(result)
}
pub fn claim(conn: &Connection, scene: &str, date: &str, rule: &str) -> Result<bool> {
    Ok(conn.execute(
        "INSERT OR IGNORE INTO automatic_claims VALUES(?1,?2,?3,?4)",
        params![scene, date, rule, now()],
    )? == 1)
}
// Called inside the same transaction that creates the execution run.
// A recovery belongs to its planned occurrence, but consumes today's execution
// allowance. Both dates must be checked to avoid a second launch across midnight.
pub fn reserve_automatic(
    conn: &Connection,
    scene: &str,
    execution_date: &str,
    occurrence_date: &str,
    rule: &str,
) -> Result<bool> {
    let duplicate:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM automatic_claims WHERE scene_id=?1 AND local_date IN (?2,?3)) OR EXISTS(SELECT 1 FROM rule_history WHERE rule_id=?4 AND local_date=?3)",params![scene,execution_date,occurrence_date,rule],|r|r.get(0))?;
    if duplicate || !claim(conn, scene, execution_date, rule)? {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO rule_history VALUES(?1,?2,?3)",
        params![rule, occurrence_date, now()],
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cross_midnight_recovery_consumes_execution_day() {
        let d = tempfile::tempdir().unwrap();
        let db = Db::open(d.path()).unwrap();
        let g = db.lock().unwrap();
        assert!(reserve_automatic(&g.conn, "s", "2026-10-09", "2026-10-08", "late").unwrap());
        assert!(!reserve_automatic(&g.conn, "s", "2026-10-09", "2026-10-09", "today").unwrap());
        assert!(!reserve_automatic(&g.conn, "s", "2026-10-10", "2026-10-08", "late").unwrap());
        assert!(reserve_automatic(&g.conn, "s", "2026-10-10", "2026-10-10", "today").unwrap());
        assert!(reserve_automatic(&g.conn, "s2", "2026-10-08", "2026-10-08", "earlier").unwrap());
        assert!(!reserve_automatic(&g.conn, "s2", "2026-10-09", "2026-10-08", "later").unwrap());
    }
    #[test]
    fn reservation_rolls_back_with_failed_run() {
        let d = tempfile::tempdir().unwrap();
        let db = Db::open(d.path()).unwrap();
        let mut g = db.lock().unwrap();
        {
            let tx = g.conn.transaction().unwrap();
            assert!(reserve_automatic(&tx, "s", "2026-10-08", "2026-10-08", "r").unwrap());
        }
        assert!(reserve_automatic(&g.conn, "s", "2026-10-08", "2026-10-08", "r").unwrap());
    }
    #[test]
    fn persistent_claims_and_clear_logs() {
        let d = tempfile::tempdir().unwrap();
        {
            let db = Db::open(d.path()).unwrap();
            let g = db.lock().unwrap();
            assert!(claim(&g.conn, "s", "2026-10-08", "r1").unwrap());
            assert!(!claim(&g.conn, "s", "2026-10-08", "r2").unwrap());
            g.conn.execute("DELETE FROM execution_runs", []).unwrap();
            assert!(!claim(&g.conn, "s", "2026-10-08", "r1").unwrap());
        }
        let db = Db::open(d.path()).unwrap();
        let g = db.lock().unwrap();
        assert!(!claim(&g.conn, "s", "2026-10-08", "r1").unwrap());
        assert!(claim(&g.conn, "s", "2026-10-09", "r1").unwrap());
    }
    #[test]
    fn invalid_import_does_not_replace_data() {
        let d = tempfile::tempdir().unwrap();
        let db = Db::open(d.path()).unwrap();
        let mut g = db.lock().unwrap();
        let c = Config::default();
        write_config(&mut g.conn, &c).unwrap();
        let mut invalid = c.clone();
        invalid.settings.theme = "bad".into();
        assert!(write_config(&mut g.conn, &invalid).is_err());
        assert_eq!(config(&g.conn).unwrap().settings.theme, "dark");
    }
    #[test]
    fn schema_migration_is_idempotent() {
        let d = tempfile::tempdir().unwrap();
        drop(Db::open(d.path()).unwrap());
        let db = Db::open(d.path()).unwrap();
        assert_eq!(
            db.lock()
                .unwrap()
                .conn
                .query_row("SELECT COUNT(*) FROM migrations", [], |r| r
                    .get::<_, i32>(0))
                .unwrap(),
            7
        );
    }
}
