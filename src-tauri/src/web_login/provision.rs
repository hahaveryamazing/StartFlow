use super::{job::Job, runtime};
use crate::{
    database::Db,
    error::{AppError, Result},
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

#[derive(Clone, Default, Serialize)]
pub struct Availability {
    pub status: String,
    pub source: Option<String>,
    pub version: Option<String>,
    pub message: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    source: String,
    executable: PathBuf,
    version: String,
}
#[derive(Default)]
pub struct Provisioner {
    state: Mutex<Availability>,
    selection: Mutex<Option<Selection>>,
    busy: AtomicBool,
    job: Mutex<Option<Arc<Job>>>,
    cancelled: AtomicBool,
}
pub fn snapshot(app: &tauri::AppHandle) -> Availability {
    app.state::<Provisioner>()
        .state
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| Availability {
            status: "failed".into(),
            message: "浏览器检测状态不可用。".into(),
            ..Default::default()
        })
}
fn publish(app: &tauri::AppHandle, status: &str, browser: Option<&Selection>) {
    let message = match status {
        "checking" => "正在检测可用浏览器，不会读取日常浏览器资料。",
        "downloading" => "正在准备专用浏览器，可能需要数分钟；可取消，不会改变默认浏览器。",
        "ready" => "浏览器已通过启动和连接检测；登录使用账号独立资料目录。",
        "missing" => "未找到可用的 Edge / Chrome。可联网下载专用浏览器。",
        "cancelled" => "浏览器准备已取消，可重新检测或重试下载。",
        _ => "浏览器准备失败，请检查网络、磁盘空间或企业浏览器策略后重试。",
    };
    let state = Availability {
        status: status.into(),
        source: browser.map(|b| b.source.clone()),
        version: browser.map(|b| b.version.clone()),
        message: message.into(),
    };
    if let Ok(mut guard) = app.state::<Provisioner>().state.lock() {
        *guard = state.clone();
    }
    let _ = app.emit("web-login-browser", state);
}
fn candidates() -> Vec<Selection> {
    #[cfg(debug_assertions)]
    if std::env::var("STARTFLOW_LOGIN_TEST_NO_INSTALLED").as_deref() == Ok("1") {
        return vec![];
    }
    let mut candidates = vec![];
    for (source, tail) in [
        ("edge", "Microsoft/Edge/Application/msedge.exe"),
        ("chrome", "Google/Chrome/Application/chrome.exe"),
    ] {
        for base in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(base) {
                let executable = PathBuf::from(base).join(tail);
                if executable.is_absolute() && executable.is_file() {
                    candidates.push(Selection {
                        source: source.into(),
                        executable,
                        version: String::new(),
                    });
                    break;
                }
            }
        }
    }
    candidates
}
fn safe_dir(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)
        .map_err(|_| AppError::new("browser", "无法创建专用浏览器目录。"))?;
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| AppError::new("browser", "浏览器目录不可访问。"))?;
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let linked = metadata.file_type().is_symlink();
    if linked {
        return Err(AppError::new("browser", "专用浏览器目录不能为链接。"));
    }
    Ok(())
}
pub fn executable(app: &tauri::AppHandle) -> Result<(PathBuf, String)> {
    let state = app.state::<Provisioner>();
    if state.busy.load(Ordering::SeqCst) {
        return Err(AppError::new("browser", "浏览器正在检测或下载，请稍候。"));
    }
    let guard = state
        .selection
        .lock()
        .map_err(|_| AppError::new("browser", "浏览器检测不可用。"))?;
    guard
        .as_ref()
        .filter(|b| b.executable.is_file())
        .map(|b| (b.executable.clone(), b.source.clone()))
        .ok_or_else(|| AppError::new("browser", "没有可用浏览器，请先检测或下载专用浏览器。"))
}
fn valid_selection(browser: &Selection, known: &[Selection], cache: &Path) -> bool {
    browser.version.len() <= 80
        && !browser.version.chars().any(char::is_control)
        && (known
            .iter()
            .any(|c| c.source == browser.source && c.executable == browser.executable)
            || (browser.source == "managed"
                && browser.executable
                    == cache.join("browsers/chromium-1248/chrome-win64/chrome.exe")))
        && browser.executable.is_file()
}
pub fn prepare(app: &tauri::AppHandle, download: bool) -> Result<Availability> {
    let state = app.state::<Provisioner>();
    if state.busy.swap(true, Ordering::SeqCst) {
        return Err(AppError::new(
            "browser",
            "浏览器准备正在进行，请勿重复操作。",
        ));
    }
    struct Busy<'a>(&'a AtomicBool);
    impl Drop for Busy<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let busy = Busy(&state.busy);
    state.cancelled.store(false, Ordering::SeqCst);
    if !runtime::active(app)?.is_empty() {
        return Err(AppError::new(
            "browser",
            "请先关闭账号专用浏览器，再重新检测运行时。",
        ));
    }
    let operation = (|| -> Result<Option<Selection>> {
        publish(app, if download { "downloading" } else { "checking" }, None);
        let folder = runtime::runtime(app)?;
        let cache = PathBuf::from(&app.state::<Db>().directory).join("browser-cache");
        safe_dir(&cache)?;
        for tail in ["browsers", "probes"] {
            safe_dir(&cache.join(tail))?;
        }
        let known = candidates();
        let input = serde_json::to_vec(&serde_json::json!({"operation": if download {"install"} else {"detect"}, "cache":cache, "candidates": known.iter().map(|c| serde_json::json!({"source":c.source,"executable":c.executable})).collect::<Vec<_>>()})).map_err(|_| AppError::new("browser", "浏览器检测配置无效。"))?;
        let mut command = Command::new(folder.join("node.exe"));
        command
            .arg(folder.join("browser-runtime.mjs"))
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
            "ProgramFiles",
            "ProgramFiles(x86)",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.env("PLAYWRIGHT_BROWSERS_PATH", cache.join("browsers"));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|_| AppError::new("browser", "浏览器检测服务启动失败。"))?;
        let job = match Job::attach(child.id()) {
            Ok(job) => Arc::new(job),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e);
            }
        };
        *state
            .job
            .lock()
            .map_err(|_| AppError::new("browser", "浏览器进程管理不可用。"))? = Some(job.clone());
        let outcome = (|| -> Result<Option<Selection>> {
            child
                .stdin
                .take()
                .ok_or_else(|| AppError::new("browser", "检测管道不可用。"))?
                .write_all(&input)
                .map_err(|_| AppError::new("browser", "检测管道中断。"))?;
            let deadline = Instant::now() + Duration::from_secs(if download { 480 } else { 50 });
            let exit = loop {
                if state.cancelled.load(Ordering::SeqCst) || Instant::now() >= deadline {
                    return Err(AppError::new("browser", "浏览器准备已取消或超时。"));
                }
                if let Some(status) = child
                    .try_wait()
                    .map_err(|_| AppError::new("browser", "检测服务中断。"))?
                {
                    break status;
                }
                std::thread::sleep(Duration::from_millis(100));
            };
            if !exit.success() {
                return Err(AppError::new("browser", "浏览器检测或下载失败。"));
            }
            let mut output = vec![];
            child
                .stdout
                .take()
                .ok_or_else(|| AppError::new("browser", "检测管道不可用。"))?
                .take(8193)
                .read_to_end(&mut output)
                .map_err(|_| AppError::new("browser", "检测结果不可读。"))?;
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Response {
                browser: Option<Selection>,
            }
            if output.len() > 8192 {
                return Err(AppError::new("browser", "检测协议超出限制。"));
            }
            let response: Response = serde_json::from_slice(&output)
                .map_err(|_| AppError::new("browser", "检测结果无效。"))?;
            if response
                .browser
                .as_ref()
                .is_some_and(|b| !valid_selection(b, &known, &cache))
            {
                return Err(AppError::new("browser", "浏览器身份验证失败。"));
            }
            Ok(response.browser)
        })();
        job.terminate();
        let _ = child.wait();
        if let Ok(mut guard) = state.job.lock() {
            *guard = None;
        }
        outcome
    })();
    match operation {
        Ok(browser) => {
            publish(
                app,
                if browser.is_some() {
                    "ready"
                } else {
                    "missing"
                },
                browser.as_ref(),
            );
            *state
                .selection
                .lock()
                .map_err(|_| AppError::new("browser", "浏览器检测不可用。"))? = browser;
        }
        Err(e) => {
            if let Ok(mut g) = state.selection.lock() {
                *g = None;
            }
            publish(
                app,
                if state.cancelled.load(Ordering::SeqCst) {
                    "cancelled"
                } else {
                    "failed"
                },
                None,
            );
            drop(busy);
            let _ = app.emit("web-login-browser", snapshot(app));
            return Err(e);
        }
    }
    drop(busy);
    let result = snapshot(app);
    let _ = app.emit("web-login-browser", result.clone());
    Ok(result)
}
pub fn stop(app: &tauri::AppHandle) {
    let state = app.state::<Provisioner>();
    state.cancelled.store(true, Ordering::SeqCst);
    if let Ok(guard) = state.job.lock() {
        if let Some(job) = &*guard {
            job.terminate();
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detection_only_accepts_known_backend_paths() {
        let temp = tempfile::tempdir().expect("fixture");
        let exe = temp.path().join("edge.exe");
        std::fs::write(&exe, "fixture").expect("fixture");
        let mut b = Selection {
            source: "edge".into(),
            executable: exe,
            version: "Chrome/156".into(),
        };
        assert!(valid_selection(&b, &[b.clone()], temp.path()));
        assert!(!valid_selection(&b, &[], temp.path()));
        b.source = "managed".into();
        assert!(!valid_selection(&b, &[], temp.path()));
        b.version = "secret\n".into();
        assert!(!valid_selection(&b, &[b.clone()], temp.path()));
    }
    #[test]
    fn snapshot_never_contains_executable_or_credentials() {
        let a = Availability {
            status: "ready".into(),
            source: Some("edge".into()),
            version: Some("156".into()),
            message: "就绪".into(),
        };
        let json = serde_json::to_string(&a).expect("serialize");
        assert!(!json.contains("executable"));
        assert!(!json.contains("password"));
    }
}
