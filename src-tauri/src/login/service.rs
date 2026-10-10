use crate::{
    database::Db,
    error::{AppError, Result},
    runtime::Control,
    web_login::{
        models::{LoginRun, Status},
        repository, runtime,
    },
};
use std::time::{Duration, Instant};
use tauri::Manager;
#[derive(Clone, serde::Serialize)]
pub struct Outcome {
    pub login_status: String,
    pub authenticated: bool,
    pub submitted: bool,
    pub login_run_id: String,
}
impl Outcome {
    pub fn known_logged_out(&self) -> bool {
        matches!(
            self.login_status.as_str(),
            "authorization_required"
                | "session_expired"
                | "waiting_manual"
                | "manual_required"
                | "failed"
                | "cooldown"
        )
    }
    pub fn new(status: &str, submitted: bool, id: &str) -> Self {
        Self {
            login_status: status.into(),
            authenticated: matches!(status, "success" | "session_reused" | "authenticated"),
            submitted,
            login_run_id: id.into(),
        }
    }
}
fn web_state(app: &tauri::AppHandle, id: &str) -> Result<Option<LoginRun>> {
    let active = runtime::active(app)?;
    let db = app.state::<Db>();
    let g = db.lock()?;
    Ok(repository::runs_with_active(&g.conn, &active)?
        .into_iter()
        .find(|r| r.config_id == id && active.contains(&r.id)))
}
struct BrowserGuard {
    app: tauri::AppHandle,
    id: String,
    keep: bool,
}
impl Drop for BrowserGuard {
    fn drop(&mut self) {
        if !self.keep {
            let _ = runtime::close(&self.app, &self.id);
        }
    }
}
async fn start_web(
    app: &tauri::AppHandle,
    id: &str,
    authorized: bool,
    control: &Control,
    workflow: Option<&crate::workflow::models::Workflow>,
) -> Result<LoginRun> {
    control.check()?;
    let (cfg, a) = {
        let db = app.state::<Db>();
        let g = db.lock()?;
        let cfg = repository::configs(&g.conn)?
            .into_iter()
            .find(|v| v.id == id)
            .ok_or_else(|| AppError::new("login_config", "登录配置不存在。"))?;
        let a = crate::accounts::repository::find(&g.conn, &cfg.account_id)?;
        cfg.validate(&a)?;
        (cfg, a)
    };
    // Existing sidecar launches only the dedicated account profile; no default browser launcher.
    runtime::start_with_workflow(app, cfg, a, authorized, workflow.cloned())
}
async fn web(
    app: &tauri::AppHandle,
    id: &str,
    authorized: bool,
    manual: bool,
    seconds: u32,
    control: &Control,
    workflow: Option<&crate::workflow::models::Workflow>,
) -> Result<Outcome> {
    let deadline = Instant::now() + Duration::from_secs(seconds as u64);
    let existing = web_state(app, id)?;
    let mut run = match existing.clone() {
        Some(r) => r,
        None => start_web(app, id, authorized, control, workflow).await?,
    };
    let mut guard = BrowserGuard {
        app: app.clone(),
        id: run.id.clone(),
        keep: false,
    };
    if existing.is_some() && !matches!(run.status, Status::CheckingSession | Status::LoggingIn) {
        let nonce = runtime::probe(app, &run.id, id)?;
        loop {
            control.check()?;
            if let Some(status) = runtime::probe_result(app, &run.id, &nonce)? {
                run.status = status;
                break;
            }
            control.wait(Duration::from_millis(100)).await?;
        }
    }
    let mut restarted = false;
    loop {
        control.check()?;
        if Instant::now() >= deadline {
            return Ok(Outcome::new("timeout", run.submitted, &run.id));
        }
        let active = runtime::active(app)?;
        let db = app.state::<Db>();
        let latest = repository::runs_with_active(&db.lock()?.conn, &active)?
            .into_iter()
            .find(|r| r.id == run.id);
        if let Some(r) = latest {
            run = r;
        }
        if matches!(run.status, Status::Authenticated | Status::SessionReused) {
            guard.keep = true;
            return Ok(Outcome::new(
                if run.status == Status::SessionReused {
                    "session_reused"
                } else {
                    "authenticated"
                },
                run.submitted,
                &run.id,
            ));
        }
        if !active.contains(&run.id) {
            return Ok(Outcome::new("interrupted", run.submitted, &run.id));
        }
        if authorized
            && !restarted
            && matches!(
                run.status,
                Status::AuthorizationRequired | Status::SessionExpired
            )
            && !run.submitted
        {
            runtime::close(app, &run.id)?;
            while runtime::active(app)?.contains(&run.id) {
                control.wait(Duration::from_millis(200)).await?;
                if Instant::now() >= deadline {
                    return Ok(Outcome::new("timeout", false, &run.id));
                }
            }
            run = start_web(app, id, true, control, workflow).await?;
            guard.id = run.id.clone();
            restarted = true;
            continue;
        }
        if !matches!(run.status, Status::CheckingSession | Status::LoggingIn) {
            if !manual {
                guard.keep = true;
                return Ok(Outcome::new(
                    serde_json::to_value(&run.status)?
                        .as_str()
                        .unwrap_or("failed"),
                    run.submitted,
                    &run.id,
                ));
            }
            if matches!(
                run.status,
                Status::Blocked | Status::LocatorInvalid | Status::Closed | Status::Interrupted
            ) {
                return Ok(Outcome::new("blocked", run.submitted, &run.id));
            }
        }
        control.wait(Duration::from_millis(350)).await?;
    }
}
pub struct Request<'a> {
    pub target: &'a str,
    pub id: &'a str,
    pub authorized: bool,
    pub manual: bool,
    pub seconds: u32,
    pub workflow: Option<&'a crate::workflow::models::Workflow>,
}
pub async fn perform(
    app: &tauri::AppHandle,
    request: Request<'_>,
    control: &Control,
) -> Result<Outcome> {
    let Request {
        target,
        id,
        authorized,
        manual,
        seconds,
        workflow,
    } = request;
    let bounded = control.with_deadline(seconds);
    let control = &bounded;
    if target == "web" {
        return web(app, id, authorized, manual, seconds, control, workflow).await;
    }
    if target != "desktop" {
        return Err(AppError::new("login_config", "登录类型无效。"));
    }
    let deadline = Instant::now() + Duration::from_secs(seconds as u64);
    let mut allow = authorized;
    loop {
        control.check()?;
        if Instant::now() >= deadline {
            return Ok(Outcome::new("timeout", false, ""));
        }
        let app = app.clone();
        let key = id.to_owned();
        let c = control.clone();
        let workflow = workflow.cloned();
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::desktop_login::commands::execute_with_workflow(
                &app,
                &key,
                allow,
                Some(&c),
                workflow.as_ref(),
            )
        })
        .await
        .map_err(AppError::internal)?;

        control.check()?; // Cancellation wins over a worker response converted into a status.
        match result {
            Ok(run) => {
                allow = false; // Only a completed operation consumes this workflow attempt.
                let outcome = Outcome::new(&run.result.status, run.result.submitted, &run.id);
                if outcome.authenticated || !manual {
                    return Ok(outcome);
                }
                if ![
                    "manual_required",
                    "waiting_manual",
                    "authorization_required",
                    "session_expired",
                    "failed",
                    "timeout",
                ]
                .contains(&outcome.login_status.as_str())
                {
                    return Ok(outcome);
                }
            }
            Err(e) if e.code == "cancelled" => return Err(e),
            Err(e) if e.code == "wrong_target" => {} // Wait for the already launched app to expose its window.
            Err(e) => return Err(e),
        }
        control.wait(Duration::from_millis(1500)).await?;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_identity_verified_results_are_success() {
        for s in [
            "running",
            "launch_requested",
            "logging_in",
            "waiting_manual",
            "failed",
            "timeout",
            "authorization_required",
            "wrong_account",
        ] {
            assert!(!Outcome::new(s, true, "x").authenticated);
        }
        for s in ["success", "authenticated", "session_reused"] {
            assert!(Outcome::new(s, false, "x").authenticated);
        }
    }
}
