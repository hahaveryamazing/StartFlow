use crate::{
    database::Db,
    error::{AppError, Result},
};
use serde::Serialize;
use tauri::Manager;
#[derive(Serialize)]
pub struct Metrics {
    pub daily: Vec<(String, i64)>,
    pub results: Vec<(String, i64)>,
    pub workflows: Vec<(String, i64)>,
    pub failed_rules: Vec<(String, i64)>,
    pub total_runs: i64,
    pub automatic_runs: i64,
    pub launch_requests: i64,
    pub failed_tasks: i64,
    pub skipped_tasks: i64,
    pub average_seconds: Option<f64>,
    pub conflicts: i64,
}
#[tauri::command]
pub async fn v3_analytics(app: tauri::AppHandle, start: String, end: String) -> Result<Metrics> {
    tauri::async_runtime::spawn_blocking(move||{
    let a=chrono::NaiveDate::parse_from_str(&start,"%Y-%m-%d").map_err(|_|AppError::new("date","开始日期无效。"))?;let b=chrono::NaiveDate::parse_from_str(&end,"%Y-%m-%d").map_err(|_|AppError::new("date","结束日期无效。"))?;if b<a||b.signed_duration_since(a).num_days()>365{return Err(AppError::new("date","统计范围应为 1～366 天。"));}
    use chrono::TimeZone;let start=chrono::Local.from_local_datetime(&a.and_time(chrono::NaiveTime::MIN)).earliest().ok_or_else(||AppError::new("date","开始时间不可用。"))?.to_rfc3339();let end=chrono::Local.from_local_datetime(&b.succ_opt().ok_or_else(||AppError::new("date","结束日期超出范围。"))?.and_time(chrono::NaiveTime::MIN)).latest().ok_or_else(||AppError::new("date","结束时间不可用。"))?.to_rfc3339();
    let db=app.state::<Db>();let g=db.lock()?;let range=rusqlite::params![start,end];
    let pairs=|query:&str|->Result<Vec<(String,i64)>>{let mut statement=g.conn.prepare(query)?;let rows=statement.query_map(range,|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;Ok(rows)};
    let count=|query:&str|->Result<i64>{Ok(g.conn.query_row(query,range,|r|r.get(0))?)};
    let daily=pairs("SELECT local_run_date,COUNT(*) FROM execution_runs WHERE rule_id IS NOT NULL AND julianday(started_at)>=julianday(?1) AND julianday(started_at)<julianday(?2) GROUP BY local_run_date ORDER BY local_run_date")?;
    let results=pairs("SELECT status,COUNT(*) FROM execution_runs WHERE julianday(started_at)>=julianday(?1) AND julianday(started_at)<julianday(?2) GROUP BY status ORDER BY COUNT(*) DESC")?;
    let workflows=pairs("SELECT scene_name_snapshot,COUNT(*) FROM execution_runs WHERE julianday(started_at)>=julianday(?1) AND julianday(started_at)<julianday(?2) GROUP BY scene_name_snapshot ORDER BY COUNT(*) DESC LIMIT 12")?;
    let failed_rules=pairs("SELECT json_extract(payload,'$.rule_name'),COUNT(*) FROM automation_decisions WHERE status IN ('failed','interrupted','timed_out') AND julianday(evaluated_at)>=julianday(?1) AND julianday(evaluated_at)<julianday(?2) GROUP BY json_extract(payload,'$.rule_name') ORDER BY COUNT(*) DESC LIMIT 10")?;
    let total_runs=count("SELECT COUNT(*) FROM execution_runs WHERE julianday(started_at)>=julianday(?1) AND julianday(started_at)<julianday(?2)")?;let automatic_runs=count("SELECT COUNT(*) FROM execution_runs WHERE rule_id IS NOT NULL AND julianday(started_at)>=julianday(?1) AND julianday(started_at)<julianday(?2)")?;
    let task_counts=pairs("SELECT status,COUNT(*) FROM (SELECT l.status,r.started_at FROM execution_logs l JOIN execution_runs r ON r.id=l.run_id UNION ALL SELECT l.status,r.started_at FROM workflow_execution_logs l JOIN execution_runs r ON r.id=l.run_id WHERE l.node_type IN ('web','app','folder')) WHERE julianday(started_at)>=julianday(?1) AND julianday(started_at)<julianday(?2) GROUP BY status")?;
    let sum=|status:&str|task_counts.iter().find(|(s,_)|s==status).map(|(_,n)|*n).unwrap_or(0);let average_seconds=g.conn.query_row("SELECT AVG((julianday(finished_at)-julianday(started_at))*86400.0) FROM execution_runs WHERE finished_at IS NOT NULL AND julianday(started_at)>=julianday(?1) AND julianday(started_at)<julianday(?2)",range,|r|r.get(0))?;
    let conflicts=count("SELECT COUNT(*) FROM automation_decisions WHERE status='skipped' AND (payload LIKE '%互斥%' OR payload LIKE '%相同场景%') AND julianday(evaluated_at)>=julianday(?1) AND julianday(evaluated_at)<julianday(?2)")?;
    Ok(Metrics{daily,results,workflows,failed_rules,total_runs,automatic_runs,launch_requests:sum("launch_requested"),failed_tasks:sum("failed"),skipped_tasks:sum("skipped"),average_seconds,conflicts})
}).await.map_err(AppError::internal)?
}
