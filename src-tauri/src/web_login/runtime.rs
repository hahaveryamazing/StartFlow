use super::{job::Job, models::*, provision, repository};
use crate::{
    accounts::{
        self,
        models::{Account, Secret},
    },
    database::Db,
    error::{AppError, Result},
    models::now,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
#[derive(Default)]
pub struct Browsers(pub Mutex<HashMap<String, Arc<Session>>>);
pub struct Session {
    input: Mutex<Option<ChildStdin>>,
    job: Mutex<Option<Arc<Job>>>,
    heartbeat: AtomicU64,
    done: AtomicBool,
    closing: AtomicBool,
    close_started: Mutex<Option<std::time::Instant>>,
    pub account_id: String,
}
fn wall_clock() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
pub(crate) fn heartbeat_clock() -> u64 {
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs()
}
impl Session {
    pub(crate) fn new(account_id: String) -> Self {
        Self {
            input: Mutex::new(None),
            job: Mutex::new(None),
            heartbeat: AtomicU64::new(heartbeat_clock()),
            done: AtomicBool::new(false),
            closing: AtomicBool::new(false),
            close_started: Mutex::new(None),
            account_id,
        }
    }
    pub(crate) fn send(&self, value: &impl Serialize) -> Result<()> {
        let buffer = zeroize::Zeroizing::new(
            serde_json::to_vec(value)
                .map_err(|_| AppError::new("login", "浏览器协议编码失败。"))?,
        );
        self.write(&buffer)
    }
    fn write(&self, buffer: &[u8]) -> Result<()> {
        let mut guard = self
            .input
            .lock()
            .map_err(|_| AppError::new("login", "浏览器通信不可用。"))?;
        let writer = guard
            .as_mut()
            .ok_or_else(|| AppError::new("login", "浏览器尚未连接。"))?;
        writer
            .write_all(buffer)
            .and_then(|_| writer.write_all(b"\n"))
            .and_then(|_| writer.flush())
            .map_err(|_| AppError::new("login", "浏览器连接已中断。"))
    }
    fn credential(&self, nonce: &str, secret: Option<&Secret>) -> Result<()> {
        // The only secret serialization site: private inherited pipe, never a Tauri response.
        let password = zeroize::Zeroizing::new(
            secret
                .map(|s| serde_json::to_string(s.value()))
                .transpose()
                .map_err(|_| AppError::new("login", "凭据传输编码失败。"))?
                .unwrap_or_else(|| "null".into()),
        );
        let nonce =
            serde_json::to_string(nonce).map_err(|_| AppError::new("login", "协议标识无效。"))?;
        let line = zeroize::Zeroizing::new(format!(
            "{{\"type\":\"credential\",\"nonce\":{nonce},\"password\":{}}}",
            *password
        ));
        self.write(line.as_bytes())
    }
    pub fn close(&self) {
        if let Ok(mut started) = self.close_started.lock() {
            started.get_or_insert_with(std::time::Instant::now);
        }
        self.closing.store(true, Ordering::SeqCst);
        let _ = self.send(&serde_json::json!({"type":"close"}));
    }
    pub(crate) fn kill(&self) {
        if let Ok(g) = self.job.lock() {
            if let Some(job) = &*g {
                job.terminate();
            }
        }
    }
    pub(crate) fn is_done(&self) -> bool {
        self.done.load(Ordering::SeqCst)
    }
    pub(crate) fn finish(&self) {
        self.done.store(true, Ordering::SeqCst);
        self.kill();
    }
    pub(crate) fn pulse(&self) {
        self.heartbeat.store(heartbeat_clock(), Ordering::SeqCst);
    }
    pub(crate) fn connect(&self, input: Option<ChildStdin>, job: Arc<Job>) -> Result<()> {
        *self
            .input
            .lock()
            .map_err(|_| AppError::new("login", "浏览器管道不可用。"))? = input;
        *self
            .job
            .lock()
            .map_err(|_| AppError::new("login", "浏览器进程管理不可用。"))? = Some(job);
        Ok(())
    }
    pub(crate) fn watch(self: &Arc<Self>) {
        let watched = self.clone();
        std::thread::spawn(move || {
            while !watched.done.load(Ordering::SeqCst) {
                let close_expired = watched
                    .close_started
                    .lock()
                    .map(|s| s.is_some_and(|at| at.elapsed().as_secs() >= 5))
                    .unwrap_or(true);
                if close_expired
                    || heartbeat_clock().saturating_sub(watched.heartbeat.load(Ordering::SeqCst))
                        > 15
                {
                    watched.kill();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        });
    }
}
pub fn runtime(app: &tauri::AppHandle) -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/browser-runtime");
    #[cfg(not(debug_assertions))]
    let folder = app
        .path()
        .resource_dir()
        .map_err(|_| AppError::new("login", "无法定位浏览器运行时。"))?
        .join("resources/browser-runtime");
    let _ = app;
    for (name, expected) in [
        (
            "worker.mjs",
            include_bytes!("../../../automation/web-login/worker.mjs").as_slice(),
        ),
        (
            "engine.mjs",
            include_bytes!("../../../automation/web-login/engine.mjs").as_slice(),
        ),
        (
            "browser-runtime.mjs",
            include_bytes!("../../../automation/web-login/browser-runtime.mjs").as_slice(),
        ),
        (
            "locators.mjs",
            include_bytes!("../../../automation/web-login/locators.mjs").as_slice(),
        ),
        (
            "picker.mjs",
            include_bytes!("../../../automation/web-login/picker.mjs").as_slice(),
        ),
        (
            "recorder.mjs",
            include_bytes!("../../../automation/web-login/recorder.mjs").as_slice(),
        ),
        (
            "recorder-worker.mjs",
            include_bytes!("../../../automation/web-login/recorder-worker.mjs").as_slice(),
        ),
    ] {
        if std::fs::read(folder.join(name)).ok().as_deref() != Some(expected) {
            return Err(AppError::new(
                "login",
                "浏览器服务代码与此版本不匹配，请重新准备运行时。",
            ));
        }
    }
    if !folder.join("node.exe").is_file()
        || !folder.join("worker.mjs").is_file()
        || !folder
            .join("node_modules/playwright/package.json")
            .is_file()
    {
        return Err(AppError::new(
            "login",
            "专用浏览器运行时尚未准备，请运行 npm run browser:prepare 后重新构建。",
        ));
    }
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(folder.join("manifest.json"))
            .map_err(|_| AppError::new("login", "浏览器运行时清单缺失。"))?,
    )
    .map_err(|_| AppError::new("login", "浏览器运行时清单无效。"))?;
    if manifest["playwright"] != "1.64.0" || manifest["browser_strategy"] != "detect-or-download" {
        return Err(AppError::new(
            "login",
            "浏览器版本不匹配或文件缺失，请重新准备运行时。",
        ));
    }
    Ok(folder)
}
pub fn active(app: &tauri::AppHandle) -> Result<Vec<String>> {
    Ok(app
        .state::<Browsers>()
        .0
        .lock()
        .map_err(|_| AppError::new("login", "浏览器管理不可用。"))?
        .keys()
        .cloned()
        .collect())
}
fn update(
    app: &tauri::AppHandle,
    run: &mut LoginRun,
    status: Status,
    submitted: bool,
) -> Result<()> {
    run.status = status;
    run.submitted |= submitted;
    run.updated_at = now();
    run.message = run.status.message().into();
    let db = app.state::<Db>();
    repository::record(&db.lock()?.conn, run)?;
    let _ = app.emit("web-login-status", run.clone());
    Ok(())
}
fn password(
    app: &tauri::AppHandle,
    c: &LoginConfig,
    account: &Account,
    authorized: bool,
) -> Result<Option<Secret>> {
    if !authorized {
        return Ok(None);
    }
    let state = app.state::<accounts::Accounts>();
    let _guard = state
        .0
        .lock()
        .map_err(|_| AppError::new("login", "凭据管理不可用。"))?;
    let db = app.state::<Db>();
    let g = db.lock()?;
    let current = accounts::repository::find(&g.conn, &account.id)?;
    c.validate(&current)?;
    if current.revision != account.revision || current.credential_ref != account.credential_ref {
        return Err(AppError::new(
            "login",
            "账号在登录期间已被修改，请重新授权。",
        ));
    }
    accounts::vault::read_for_login(&current.credential_ref).map(Some)
}
pub fn start(
    app: &tauri::AppHandle,
    c: LoginConfig,
    account: Account,
    authorized: bool,
) -> Result<LoginRun> {
    let folder = runtime(app)?;
    let (browser_executable, browser_source) = provision::executable(app)?;
    let state = app.state::<Browsers>();
    let mut slots = state
        .0
        .lock()
        .map_err(|_| AppError::new("login", "浏览器管理不可用。"))?;
    if slots.values().any(|s| s.account_id == account.id) {
        return Err(AppError::new(
            "login",
            "此账号的专用浏览器已打开，请先关闭。",
        ));
    }
    if slots.len() >= 3 {
        return Err(AppError::new("login", "最多同时打开三个专用浏览器。"));
    }
    let db = app.state::<Db>();
    let root = PathBuf::from(&db.directory).join("browser-profiles");
    // Browser families use separate encryption/storage. Never point Edge at a Chrome profile.
    let family = if browser_source == "managed" {
        root.clone()
    } else {
        root.join(&browser_source)
    };
    let profile = family.join(&account.id);
    let parent = profile
        .parent()
        .ok_or_else(|| AppError::new("login", "目录无效。"))?;
    for path in [root.as_path(), parent, profile.as_path()] {
        std::fs::create_dir_all(path)
            .map_err(|_| AppError::new("login", "无法创建专用浏览器目录。"))?;
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|_| AppError::new("login", "目录不可访问。"))?;
        #[cfg(windows)]
        let linked = {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes() & 0x400 != 0
        };
        #[cfg(not(windows))]
        let linked = metadata.file_type().is_symlink();
        if linked {
            return Err(AppError::new("login", "专用浏览器目录不能为链接。"));
        }
    }
    let mut run = LoginRun {
        id: crate::models::id(),
        config_id: c.id.clone(),
        account_id: account.id.clone(),
        status: Status::CheckingSession,
        submitted: false,
        started_at: now(),
        updated_at: now(),
        message: Status::CheckingSession.message().into(),
    };
    let previous_session = repository::previous_session(&db.lock()?.conn, &account.id)?;
    repository::record(&db.lock()?.conn, &run)?;
    let session = Arc::new(Session::new(account.id.clone()));
    slots.insert(run.id.clone(), session.clone());
    drop(slots);
    let result = run.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = (|| -> Result<()> {
            let mut command = Command::new(folder.join("node.exe"));
            command
                .arg(folder.join("worker.mjs"))
                .current_dir(&folder)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .env_clear();
            for name in [
                "SystemRoot",
                "WINDIR",
                "SystemDrive",
                "TEMP",
                "TMP",
                "USERPROFILE",
                "LOCALAPPDATA",
                "APPDATA",
            ] {
                if let Some(value) = std::env::var_os(name) {
                    command.env(name, value);
                }
            }
            command.env(
                "PLAYWRIGHT_BROWSERS_PATH",
                PathBuf::from(&handle.state::<Db>().directory).join("browser-cache/browsers"),
            );
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = command
                .spawn()
                .map_err(|_| AppError::new("login", "专用浏览器服务启动失败。"))?;
            let job = match Job::attach(child.id()) {
                Ok(j) => Arc::new(j),
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(e);
                }
            };
            *session
                .job
                .lock()
                .map_err(|_| AppError::new("login", "进程隔离不可用。"))? = Some(job);
            *session
                .input
                .lock()
                .map_err(|_| AppError::new("login", "浏览器通信不可用。"))? = child.stdin.take();
            let init = serde_json::json!({"type":"init","config":c,"profile":profile,"username":account.username,"previous_session":previous_session,"browser_executable":browser_executable});
            #[cfg(debug_assertions)]
            let init = {
                let mut init = init;
                init["test_mode"] = serde_json::json!(true);
                init["test_pin"] =
                    serde_json::json!(std::env::var("STARTFLOW_LOGIN_TEST_CERT_PIN").ok());
                init["test_headless"] = serde_json::json!(
                    std::env::var("STARTFLOW_LOGIN_TEST_HEADLESS")
                        .ok()
                        .as_deref()
                        == Some("1")
                );
                init
            };
            session.send(&init)?;
            if session.closing.load(Ordering::SeqCst) {
                session.close();
            }
            let watched = session.clone();
            std::thread::spawn(move || {
                while !watched.done.load(Ordering::SeqCst) {
                    let close_expired = watched
                        .close_started
                        .lock()
                        .map(|s| s.is_some_and(|at| at.elapsed().as_secs() >= 5))
                        .unwrap_or(true);
                    if close_expired
                        || heartbeat_clock()
                            .saturating_sub(watched.heartbeat.load(Ordering::SeqCst))
                            > 15
                    {
                        watched.kill();
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
            });
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| AppError::new("login", "浏览器未建立管道。"))?;
            let mut reader = BufReader::new(stdout);
            let mut credential_sent = false;
            loop {
                let mut data = zeroize::Zeroizing::new(Vec::new());
                let length = std::io::Read::take(&mut reader, 8193)
                    .read_until(b'\n', &mut data)
                    .map_err(|_| AppError::new("login", "浏览器通信中断。"))?;
                if length == 0 {
                    break;
                }
                if length > 8192 || data.last() != Some(&b'\n') {
                    return Err(AppError::new("login", "浏览器协议超出限制。"));
                }
                let event: WorkerEvent = serde_json::from_slice(&data)
                    .map_err(|_| AppError::new("login", "浏览器协议无效。"))?;
                session.heartbeat.store(heartbeat_clock(), Ordering::SeqCst);
                match event {
                    WorkerEvent::Heartbeat {} => {}
                    WorkerEvent::Closed {} => break,
                    WorkerEvent::Status { status, submitted } => {
                        if run.status != Status::Cooldown {
                            update(&handle, &mut run, status, submitted)?;
                        }
                    }
                    WorkerEvent::NeedPassword { nonce } => {
                        if credential_sent || crate::models::validate_id(&nonce).is_err() {
                            return Err(AppError::new("login", "已阻止重复凭据请求。"));
                        }
                        credential_sent = true;
                        if session.closing.load(Ordering::SeqCst) {
                            session.credential(&nonce, None)?;
                            continue;
                        }
                        let secret = password(&handle, &c, &account, authorized)?;
                        if secret.is_some()
                            && !repository::claim_attempt(
                                &handle.state::<Db>().lock()?.conn,
                                &account.id,
                                wall_clock(),
                            )?
                        {
                            update(&handle, &mut run, Status::Cooldown, false)?;
                            session.credential(&nonce, None)?;
                            continue;
                        }
                        session.credential(&nonce, secret.as_ref())?;
                    }
                }
            }
            session.close();
            let status = child
                .wait()
                .map_err(|_| AppError::new("login", "浏览器服务未正常结束。"))?;
            if !status.success() {
                return Err(AppError::new("login", "浏览器运行中断。"));
            }
            Ok(())
        })();
        session.done.store(true, Ordering::SeqCst);
        session.kill();
        if outcome.is_err() {
            let _ = update(&handle, &mut run, Status::Interrupted, false);
        } else if matches!(
            run.status,
            Status::CheckingSession | Status::LoggingIn | Status::WaitingManual
        ) {
            let _ = update(&handle, &mut run, Status::Closed, false);
        }
        if let Ok(mut slots) = handle.state::<Browsers>().0.lock() {
            slots.remove(&run.id);
        };
        let _ = handle.emit("web-login-status", run);
    });
    Ok(result)
}
pub fn stop_all(app: &tauri::AppHandle) {
    super::recorder::stop(app);
    provision::stop(app);
    if let Ok(slots) = app.state::<Browsers>().0.lock() {
        for session in slots.values() {
            session.close();
        }
    }
}
pub fn close(app: &tauri::AppHandle, id: &str) -> Result<()> {
    crate::models::validate_id(id)?;
    let state = app.state::<Browsers>();
    let slots = state
        .0
        .lock()
        .map_err(|_| AppError::new("login", "浏览器管理不可用。"))?;
    if let Some(session) = slots.get(id) {
        session.close();
    }
    Ok(())
}
