use super::models::{Request, Response};
use crate::error::{AppError, Result};
use std::io::{Read, Write};
use std::sync::Mutex;
static WORKERS: Mutex<usize> = Mutex::new(0);
struct Slot;
impl Slot {
    fn acquire() -> Result<Self> {
        let mut count = WORKERS
            .lock()
            .map_err(|_| AppError::new("busy", "自动化服务暂时不可用。"))?;
        if *count >= 4 {
            return Err(AppError::new(
                "busy",
                "自动化查询较多，请等待当前操作完成。",
            ));
        }
        *count += 1;
        Ok(Self)
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        if let Ok(mut count) = WORKERS.lock() {
            *count = count.saturating_sub(1);
        }
    }
}
// Private anonymous stdin/stdout pipes. Fixed argv contains no account or credential data.
pub fn entry() {
    let result = (|| -> Result<Response> {
        let mut input = vec![];
        std::io::stdin()
            .take(65537)
            .read_to_end(&mut input)
            .map_err(|_| AppError::new("worker", "无法读取私有请求。"))?;
        if input.len() > 65536 {
            return Err(AppError::new("worker", "请求过大。"));
        }
        let request: Request = serde_json::from_slice(&input)
            .map_err(|_| AppError::new("worker", "私有请求结构无效。"))?;
        #[cfg(windows)]
        {
            super::windows::execute(request)
        }
        #[cfg(not(windows))]
        {
            let _ = request;
            Err(AppError::new(
                "unsupported",
                "仅支持 Windows UI Automation。",
            ))
        }
    })();
    let response = result.unwrap_or_else(|e| Response::status(&e.code, &e.message));
    if let Ok(bytes) = serde_json::to_vec(&response) {
        let _ = std::io::stdout().write_all(&bytes);
    }
}
pub fn call(request: Request, timeout: u64) -> Result<Response> {
    call_control(request, timeout, None)
}
pub fn call_control(
    request: Request,
    timeout: u64,
    control: Option<&crate::runtime::Control>,
) -> Result<Response> {
    if let Some(c) = control {
        c.check()?;
    }
    let _slot = Slot::acquire()?;
    let bytes = serde_json::to_vec(&request)?;
    if bytes.len() > 65536 {
        return Err(AppError::new("worker", "请求过大。"));
    }
    use std::process::{Command, Stdio};
    let exe =
        std::env::current_exe().map_err(|_| AppError::new("worker", "无法找到自动化工作进程。"))?;
    let mut cmd = Command::new(exe);
    cmd.arg("--desktop-login-worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|_| AppError::new("worker", "无法启动自动化工作进程。"))?;
    let job = match crate::web_login::job::Job::attach(child.id()) {
        Ok(j) => j,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::new("worker", "私有管道不可用。"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::new("worker", "私有响应不可用。"))?;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let reader = std::thread::spawn(move || {
        let mut out = vec![];
        // Both writing and reading are inside the deadline, including a wedged startup.
        let r = stdin.write_all(&bytes).and_then(|()| {
            drop(stdin);
            stdout.take(262145).read_to_end(&mut out)
        });
        let _ = tx.send((r, out));
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout);
    let received: Result<_> = loop {
        if let Some(c) = control {
            if let Err(e) = c.check() {
                break Err(e);
            }
        }
        if std::time::Instant::now() >= deadline {
            break Err(AppError::new(
                "timeout",
                "控件提供程序未及时响应，自动化已停止；请人工检查登录状态。",
            ));
        }
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok(v) => break Ok(v),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => break Err(AppError::new("worker", "工作进程响应中断。")),
        }
    };
    job.terminate();
    let _ = child.wait();
    let _ = reader.join();
    let (read, out) = received?;
    if read.is_err() || out.len() > 262144 {
        return Err(AppError::new("worker", "自动化响应无效。"));
    }
    serde_json::from_slice(&out).map_err(|_| AppError::new("worker", "自动化响应无法识别。"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_worker_slots_release_after_failure() {
        let slots = (0..4).map(|_| Slot::acquire().unwrap()).collect::<Vec<_>>();
        assert!(Slot::acquire().is_err());
        drop(slots);
        assert!(Slot::acquire().is_ok());
    }
}
