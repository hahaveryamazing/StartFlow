use super::{
    job::Job,
    models::{secure_url, LocatorRule},
    provision,
    runtime::{self, Session},
};
use crate::{
    accounts,
    database::Db,
    error::{AppError, Result},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Field {
    Username,
    Password,
    Submit,
    Success,
    Identity,
    Challenge,
    Failure,
}
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingStatus {
    Starting,
    Ready,
    Picking,
    Manual,
    Invalid,
    Blocked,
    Failed,
    Closed,
    Interrupted,
}
impl RecordingStatus {
    fn message(self) -> &'static str {
        match self {
            Self::Starting=>"正在打开独立录制浏览器。",
            Self::Ready=>"请在 StartFlow 选择下一步，再到浏览器点击目标控件。",
            Self::Picking=>"正在选择控件；点击不会提交登录。Esc 可暂停选择。",
            Self::Manual=>"请在录制浏览器手动登录，再回到 StartFlow 选择成功与账号身份标识。不会读取凭据或保存输入。",
            Self::Invalid=>"控件不适合登录或无法唯一定位，请选择其他控件、调整规则并重新测试。",
            Self::Blocked=>"网站来源、跳转或表单目标不符合授权范围，录制已停止。",
            Self::Failed=>"录制浏览器打开失败，请检查网站、浏览器和网络后重试。",
            Self::Closed=>"录制浏览器已关闭；未保存的草稿只保留在当前应用内存。",
            Self::Interrupted=>"录制服务已中断，请重新录制。",
        }
    }
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchResult {
    Ok,
    Absent,
    Ambiguous,
    Invalid,
    FormMismatch,
    IdentityMismatch,
}
#[derive(Clone, Serialize)]
pub struct Recording {
    pub id: String,
    pub account_id: String,
    pub credential_ref: String,
    pub origin: String,
    pub login_url: String,
    pub status: RecordingStatus,
    pub message: String,
    pub active: bool,
    pub rules: BTreeMap<Field, LocatorRule>,
    pub form_action_url: Option<String>,
    pub results: BTreeMap<Field, MatchResult>,
    pub verified_login: bool,
    pub verified_success: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum RecorderCommand {
    Arm { field: Field },
    Test { rules: BTreeMap<Field, LocatorRule> },
    Manual {},
    Reload {},
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Event {
    Heartbeat {},
    Closed {},
    State {
        status: RecordingStatus,
    },
    Picked {
        field: Field,
        rule: LocatorRule,
        form_action_url: Option<String>,
        page_url: String,
    },
    Tested {
        results: BTreeMap<Field, MatchResult>,
        verified_login: bool,
        verified_success: bool,
        form_action_url: Option<String>,
    },
}
pub struct Recorder {
    session: Arc<Session>,
    snapshot: Mutex<Recording>,
}
#[derive(Default)]
pub struct Recorders(pub Mutex<Option<Arc<Recorder>>>);
fn publish(
    app: &tauri::AppHandle,
    recorder: &Recorder,
    status: Option<RecordingStatus>,
) -> Result<Recording> {
    let mut snapshot = recorder
        .snapshot
        .lock()
        .map_err(|_| AppError::new("recorder", "录制状态不可用。"))?;
    if let Some(status) = status {
        snapshot.status = status;
        snapshot.message = status.message().into();
    }
    snapshot.active = !recorder.session.is_done();
    let value = snapshot.clone();
    let _ = app.emit("web-login-recording", value.clone());
    Ok(value)
}
pub fn snapshot(app: &tauri::AppHandle) -> Result<Option<Recording>> {
    let state = app.state::<Recorders>();
    let recorder = state
        .0
        .lock()
        .map_err(|_| AppError::new("recorder", "录制管理不可用。"))?
        .clone();
    recorder
        .map(|r| {
            r.snapshot
                .lock()
                .map(|s| {
                    let mut s = s.clone();
                    s.active = !r.session.is_done();
                    s
                })
                .map_err(|_| AppError::new("recorder", "录制状态不可用。"))
        })
        .transpose()
}
pub fn active(app: &tauri::AppHandle) -> bool {
    snapshot(app).ok().flatten().is_some_and(|s| s.active)
}
pub fn stop(app: &tauri::AppHandle) {
    if let Ok(guard) = app.state::<Recorders>().0.lock() {
        if let Some(recorder) = &*guard {
            recorder.session.close();
        }
    };
}
pub fn command(app: &tauri::AppHandle, id: &str, command: RecorderCommand) -> Result<()> {
    crate::models::validate_id(id)?;
    if let RecorderCommand::Test { rules } = &command {
        for rule in rules.values() {
            rule.validate()?;
        }
    }
    let state = app.state::<Recorders>();
    let recorder = state
        .0
        .lock()
        .map_err(|_| AppError::new("recorder", "录制管理不可用。"))?
        .clone()
        .ok_or_else(|| AppError::new("recorder", "录制不存在。"))?;
    let snapshot = recorder
        .snapshot
        .lock()
        .map_err(|_| AppError::new("recorder", "录制状态不可用。"))?;
    if snapshot.id != id || recorder.session.is_done() {
        return Err(AppError::new("recorder", "录制浏览器已关闭，请重新打开。"));
    }
    drop(snapshot);
    if let RecorderCommand::Test { rules } = &command {
        let mut snapshot = recorder
            .snapshot
            .lock()
            .map_err(|_| AppError::new("recorder", "录制状态不可用。"))?;
        for field in [Field::Username, Field::Password, Field::Submit] {
            if snapshot.rules.get(&field) != rules.get(&field) {
                snapshot.verified_login = false;
            }
        }
        for field in [Field::Success, Field::Identity] {
            if snapshot.rules.get(&field) != rules.get(&field) {
                snapshot.verified_success = false;
            }
        }
        snapshot.rules = rules.clone();
        snapshot.results.clear();
    }
    recorder.session.send(&command)
}
pub fn start(app: &tauri::AppHandle, account_id: &str, login_url: &str) -> Result<Recording> {
    crate::models::validate_id(account_id)?;
    let account = {
        let db = app.state::<Db>();
        let g = db.lock()?;
        accounts::repository::find(&g.conn, account_id)?
    };
    if account.kind != accounts::models::AccountKind::Web
        || secure_url(login_url)?.origin().ascii_serialization() != account.target
    {
        return Err(AppError::new(
            "recorder",
            "录制地址必须属于绑定账号的 HTTPS 网站，不能包含查询参数或片段。",
        ));
    }
    let folder = runtime::runtime(app)?;
    let (browser, _) = provision::executable(app)?;
    let state = app.state::<Recorders>();
    let mut guard = state
        .0
        .lock()
        .map_err(|_| AppError::new("recorder", "录制管理不可用。"))?;
    if guard.as_ref().is_some_and(|r| !r.session.is_done()) {
        return Err(AppError::new(
            "recorder",
            "录制浏览器已打开，请先结束当前录制。",
        ));
    }
    let session = Arc::new(Session::new(account.id.clone()));
    let initial = Recording {
        id: crate::models::id(),
        account_id: account.id.clone(),
        credential_ref: account.credential_ref.clone(),
        origin: account.target.clone(),
        login_url: login_url.into(),
        status: RecordingStatus::Starting,
        message: RecordingStatus::Starting.message().into(),
        active: true,
        rules: BTreeMap::new(),
        form_action_url: None,
        results: BTreeMap::new(),
        verified_login: false,
        verified_success: false,
    };
    let recorder = Arc::new(Recorder {
        session,
        snapshot: Mutex::new(initial.clone()),
    });
    *guard = Some(recorder.clone());
    drop(guard);
    let app = app.clone();
    let login_url = login_url.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = (|| -> Result<()> {
            let mut command = Command::new(folder.join("node.exe"));
            command
                .arg(folder.join("recorder-worker.mjs"))
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
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = command
                .spawn()
                .map_err(|_| AppError::new("recorder", "录制服务启动失败。"))?;
            let job = match Job::attach(child.id()) {
                Ok(j) => Arc::new(j),
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(e);
                }
            };
            recorder.session.connect(child.stdin.take(), job)?;
            let init = serde_json::json!({"type":"init","origin":account.target,"login_url":login_url,"username":account.username,"browser_executable":browser});
            #[cfg(debug_assertions)]
            let init = {
                let mut init = init;
                init["test_mode"] = serde_json::json!(true);
                init["test_pin"] =
                    serde_json::json!(std::env::var("STARTFLOW_LOGIN_TEST_CERT_PIN").ok());
                init["test_headless"] = serde_json::json!(
                    std::env::var("STARTFLOW_LOGIN_TEST_HEADLESS").as_deref() == Ok("1")
                );
                if std::env::var("STARTFLOW_RECORDER_TEST_CDP_PORT").as_deref() == Ok("9234") {
                    init["test_cdp_port"] = serde_json::json!(9234);
                }
                init
            };
            recorder.session.send(&init)?;
            recorder.session.watch();
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| AppError::new("recorder", "录制管道不可用。"))?;
            let mut reader = BufReader::new(stdout);
            loop {
                let mut buffer = zeroize::Zeroizing::new(Vec::new());
                let length = std::io::Read::take(&mut reader, 8193)
                    .read_until(b'\n', &mut buffer)
                    .map_err(|_| AppError::new("recorder", "录制通信中断。"))?;
                if length == 0 {
                    break;
                }
                if length > 8192 || buffer.last() != Some(&b'\n') {
                    return Err(AppError::new("recorder", "录制协议超出限制。"));
                }
                let event: Event = serde_json::from_slice(&buffer)
                    .map_err(|_| AppError::new("recorder", "录制协议无效。"))?;
                recorder.session.pulse();
                match event {
                    Event::Heartbeat {} => {}
                    Event::Closed {} => break,
                    Event::State { status } => {
                        publish(&app, &recorder, Some(status))?;
                    }
                    Event::Picked {
                        field,
                        rule,
                        form_action_url,
                        page_url,
                    } => {
                        rule.validate()?;
                        if let Some(url) = &form_action_url {
                            if secure_url(url)?.origin().ascii_serialization() != account.target {
                                return Err(AppError::new("recorder", "录制表单跨越授权网站。"));
                            }
                        }
                        if secure_url(&page_url)?.origin().ascii_serialization() != account.target {
                            return Err(AppError::new("recorder", "录制页面跨越授权网站。"));
                        }
                        let mut s = recorder
                            .snapshot
                            .lock()
                            .map_err(|_| AppError::new("recorder", "录制状态不可用。"))?;
                        s.rules.insert(field, rule);
                        s.form_action_url = form_action_url;
                        s.results.clear();
                        if [Field::Username, Field::Password, Field::Submit].contains(&field) {
                            s.login_url = page_url;
                        }
                        if [Field::Username, Field::Password, Field::Submit].contains(&field) {
                            s.verified_login = false;
                        } else {
                            s.verified_success = false;
                        }
                        drop(s);
                        publish(&app, &recorder, None)?;
                    }
                    Event::Tested {
                        results,
                        verified_login,
                        verified_success,
                        form_action_url,
                    } => {
                        if let Some(action) = &form_action_url {
                            if secure_url(action)?.origin().ascii_serialization() != account.target
                            {
                                return Err(AppError::new("recorder", "表单目标超出绑定网站。"));
                            }
                        }
                        let mut s = recorder
                            .snapshot
                            .lock()
                            .map_err(|_| AppError::new("recorder", "录制状态不可用。"))?;
                        s.results = results;
                        s.verified_login = verified_login;
                        s.verified_success = verified_success;
                        s.form_action_url = form_action_url;
                        drop(s);
                        publish(&app, &recorder, None)?;
                    }
                }
            }
            recorder.session.close();
            let exit = child
                .wait()
                .map_err(|_| AppError::new("recorder", "录制服务中断。"))?;
            if !exit.success() {
                return Err(AppError::new("recorder", "录制服务异常结束。"));
            }
            Ok(())
        })();
        recorder.session.finish();
        let status = if outcome.is_err() {
            Some(RecordingStatus::Interrupted)
        } else {
            let status = recorder.snapshot.lock().ok().map(|s| s.status);
            if status == Some(RecordingStatus::Blocked) || status == Some(RecordingStatus::Failed) {
                None
            } else {
                Some(RecordingStatus::Closed)
            }
        };
        let _ = publish(&app, &recorder, status);
    });
    Ok(initial)
}
#[tauri::command]
pub async fn web_recorder_start(
    window: tauri::WebviewWindow,
    account_id: String,
    login_url: String,
) -> Result<Recording> {
    accounts::commands::authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || start(&app, &account_id, &login_url))
        .await
        .map_err(|_| AppError::new("recorder", "录制服务不可用。"))?
}
#[tauri::command]
pub fn web_recorder_snapshot(window: tauri::WebviewWindow) -> Result<Option<Recording>> {
    accounts::commands::authorize(&window)?;
    snapshot(window.app_handle())
}
#[tauri::command]
pub fn web_recorder_command(
    window: tauri::WebviewWindow,
    id: String,
    command: RecorderCommand,
) -> Result<()> {
    accounts::commands::authorize(&window)?;
    self::command(window.app_handle(), &id, command)
}
#[tauri::command]
pub fn web_recorder_close(window: tauri::WebviewWindow, id: String) -> Result<()> {
    accounts::commands::authorize(&window)?;
    crate::models::validate_id(&id)?;
    if snapshot(window.app_handle())?.is_some_and(|s| s.id == id) {
        stop(window.app_handle());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_does_not_allow_secret_capture_or_arbitrary_browser_commands() {
        for json in [
            r##"{"type":"state","status":"ready","password":"bad"}"##,
            r##"{"type":"picked","field":"password","rule":{"kind":"css","value":"#p"},"form_action_url":null,"cookie":"bad"}"##,
        ] {
            assert!(serde_json::from_str::<Event>(json).is_err());
        }
        for json in [
            r#"{"type":"evaluate","script":"evil"}"#,
            r#"{"type":"arm","field":"cookie"}"#,
            r#"{"type":"manual","password":"bad"}"#,
        ] {
            assert!(serde_json::from_str::<RecorderCommand>(json).is_err());
        }
    }
}
