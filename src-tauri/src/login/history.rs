use crate::{database::Db, error::Result};
use tauri::Manager;
#[derive(serde::Serialize)]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub target: String,
    pub status: String,
    pub timestamp: String,
    pub submitted: bool,
}
#[tauri::command]
pub fn login_history(window: tauri::WebviewWindow) -> Result<Vec<Entry>> {
    crate::accounts::commands::authorize(&window)?;
    let db = window.state::<Db>();
    let g = db.lock()?;
    let mut rows = vec![];
    let web = crate::web_login::repository::configs(&g.conn)?;
    for r in crate::web_login::repository::runs(&g.conn)? {
        rows.push(Entry {
            id: r.id,
            name: web
                .iter()
                .find(|c| c.id == r.config_id)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| "已删除的网页登录配置".into()),
            target: "web".into(),
            status: serde_json::to_value(r.status)?
                .as_str()
                .unwrap_or("failed")
                .into(),
            timestamp: r.updated_at,
            submitted: r.submitted,
        });
    }
    let mut stmt = g
        .conn
        .prepare("SELECT payload FROM desktop_login_runs ORDER BY rowid DESC LIMIT 100")?;
    for text in stmt.query_map([], |r| r.get::<_, String>(0))? {
        let r: crate::desktop_login::models::Run = serde_json::from_str(&text?)?;
        rows.push(Entry {
            id: r.id,
            name: "桌面应用登录".into(),
            target: "desktop".into(),
            status: r.result.status,
            timestamp: r.finished_at.unwrap_or(r.started_at),
            submitted: r.result.submitted,
        });
    }
    rows.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    rows.truncate(30);
    Ok(rows)
}
