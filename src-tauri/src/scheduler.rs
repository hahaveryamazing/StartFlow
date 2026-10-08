use crate::{database, engine, models::Schedule};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, TimeZone};
use tauri::Manager;

pub fn due_date<T: TimeZone>(rule: &Schedule, now: &DateTime<T>) -> Option<String> {
    if !rule.enabled || rule.trigger_type == "login" {
        return None;
    }
    let time = chrono::NaiveTime::parse_from_str(&rule.time_of_day, "%H:%M").ok()?;
    for date in [now.date_naive().pred_opt()?, now.date_naive()] {
        if rule.trigger_type == "weekly"
            && !rule.weekdays.contains(&date.weekday().number_from_monday())
        {
            continue;
        }
        // On a DST fold choose the first occurrence; nonexistent local times do not run.
        let Some(due) = now
            .timezone()
            .from_local_datetime(&NaiveDateTime::new(date, time))
            .earliest()
        else {
            continue;
        };
        // num_seconds truncates toward zero: a negative fractional second must
        // never be interpreted as having reached the scheduled instant.
        if now < &due {
            continue;
        }
        let elapsed = now.clone().signed_duration_since(due).num_seconds();
        let window = if rule.catch_up_minutes == 0 {
            60
        } else {
            i64::from(rule.catch_up_minutes) * 60
        };
        if elapsed >= 0 && elapsed < window {
            return Some(date.to_string());
        }
    }
    None
}
pub fn next_time<T: TimeZone>(rule: &Schedule, now: &DateTime<T>) -> Option<String>
where
    T::Offset: std::fmt::Display,
{
    if !rule.enabled || rule.trigger_type == "login" {
        return None;
    }
    let time = chrono::NaiveTime::parse_from_str(&rule.time_of_day, "%H:%M").ok()?;
    for n in 0..9 {
        let date = now.date_naive().checked_add_signed(Duration::days(n))?;
        if rule.trigger_type == "weekly"
            && !rule.weekdays.contains(&date.weekday().number_from_monday())
        {
            continue;
        }
        if let Some(due) = now
            .timezone()
            .from_local_datetime(&date.and_time(time))
            .earliest()
        {
            if due > *now {
                return Some(due.to_rfc3339());
            }
        }
    }
    None
}
pub fn start(
    app: tauri::AppHandle,
    login: bool,
    initial_login_rules: std::collections::HashSet<String>,
) {
    let login_date = Local::now().date_naive().to_string();
    tauri::async_runtime::spawn(async move {
        let initialized = std::time::Instant::now();
        let mut login_consumed = std::collections::HashSet::new();
        let mut errors = std::collections::HashSet::new();
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            let config = {
                let db = app.state::<database::Db>();
                db.lock().and_then(|g| database::config(&g.conn))
            };
            let c = match config {
                Ok(c) => c,
                Err(e) => {
                    if errors.insert(e.message.clone()) {
                        engine::report_error(&app, &e);
                    }
                    continue;
                }
            };
            if c.settings.paused {
                continue;
            }
            let now = Local::now();
            for rule in c.schedules.iter().filter(|s| s.enabled) {
                let date = if rule.trigger_type == "login" {
                    if !login
                        || !initial_login_rules.contains(&rule.id)
                        || login_consumed.contains(&rule.id)
                        || initialized.elapsed().as_secs() < rule.delay_seconds
                    {
                        continue;
                    }
                    login_date.clone()
                } else {
                    match due_date(rule, &now) {
                        Some(d) => d,
                        None => continue,
                    }
                };
                let trigger = if rule.trigger_type == "login" {
                    "login"
                } else {
                    let due = chrono::NaiveTime::parse_from_str(&rule.time_of_day, "%H:%M")
                        .ok()
                        .map(|t| date.parse::<NaiveDate>().ok().map(|d| d.and_time(t)));
                    let late = due.flatten().is_some_and(|d| {
                        now.naive_local().signed_duration_since(d).num_seconds() >= 60
                    });
                    if late {
                        "recovery"
                    } else {
                        &rule.trigger_type
                    }
                };
                match engine::submit_scene(&app, &rule.scene_id, trigger, Some((&rule.id, &date))) {
                    Ok(_) => {
                        login_consumed.insert(rule.id.clone());
                    }
                    Err(e) if e.code == "dedup" || e.code == "disabled" => {
                        login_consumed.insert(rule.id.clone());
                    }
                    Err(e) if e.code == "busy" => {}
                    Err(e) => {
                        if errors.insert(format!("{}:{}", rule.id, e.code)) {
                            engine::report_error(&app, &e);
                        }
                    }
                }
            }
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    fn rule() -> Schedule {
        Schedule {
            id: "r".into(),
            scene_id: "s".into(),
            trigger_type: "daily".into(),
            time_of_day: "09:00".into(),
            weekdays: vec![2, 3, 4, 5, 6, 7],
            delay_seconds: 0,
            catch_up_minutes: 120,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
    #[test]
    fn catchup_window_and_no_early_run() {
        let tz = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
        let r = rule();
        assert!(due_date(&r, &tz.with_ymd_and_hms(2026, 10, 8, 8, 59, 59).unwrap()).is_none());
        assert!(due_date(&r, &tz.with_ymd_and_hms(2026, 10, 8, 10, 59, 59).unwrap()).is_some());
        assert!(due_date(&r, &tz.with_ymd_and_hms(2026, 10, 8, 11, 0, 0).unwrap()).is_none());
    }
    #[test]
    fn fractional_second_before_due_is_not_due() {
        let tz = chrono::FixedOffset::east_opt(8 * 3600).unwrap();
        let due = tz.with_ymd_and_hms(2026, 10, 8, 9, 0, 0).unwrap();
        assert!(due_date(&rule(), &(due - Duration::milliseconds(500))).is_none());
        assert!(due_date(&rule(), &due).is_some());
    }
    #[test]
    fn previous_day_catchup() {
        let mut r = rule();
        r.time_of_day = "23:30".into();
        let tz = chrono::FixedOffset::east_opt(0).unwrap();
        assert_eq!(
            due_date(&r, &tz.with_ymd_and_hms(2026, 10, 9, 0, 15, 0).unwrap()),
            Some("2026-10-08".into())
        );
    }
    #[test]
    fn weekday_disabled_and_no_catchup() {
        let tz = chrono::FixedOffset::east_opt(0).unwrap();
        let mut r = rule();
        r.trigger_type = "weekly".into();
        assert!(due_date(&r, &tz.with_ymd_and_hms(2026, 10, 5, 9, 0, 0).unwrap()).is_none());
        r.trigger_type = "daily".into();
        r.catch_up_minutes = 0;
        assert!(due_date(&r, &tz.with_ymd_and_hms(2026, 10, 8, 9, 1, 0).unwrap()).is_none());
        r.enabled = false;
        assert!(due_date(&r, &tz.with_ymd_and_hms(2026, 10, 8, 9, 0, 0).unwrap()).is_none());
    }
    #[test]
    fn dst_gap_fold() {
        let tz = chrono_tz::America::New_York;
        let mut r = rule();
        r.time_of_day = "02:30".into();
        assert!(due_date(&r, &tz.with_ymd_and_hms(2026, 3, 8, 3, 0, 0).unwrap()).is_none());
        r.time_of_day = "01:30".into();
        let t = tz
            .with_ymd_and_hms(2026, 11, 1, 1, 30, 0)
            .earliest()
            .unwrap();
        assert!(due_date(&r, &t).is_some());
    }
}
