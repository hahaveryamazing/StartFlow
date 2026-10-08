use crate::{
    error::{AppError, Result},
    models::{validate_path, validate_program, validate_url, Task},
};
use std::path::Path;
fn launch_error() -> AppError {
    AppError::new(
        "launch",
        "Windows 未接受启动请求，请检查文件权限、程序关联或安全软件设置。",
    )
}
fn exists(path: &str, folder: bool) -> Result<()> {
    validate_path(path)?;
    if (folder && !Path::new(path).is_dir()) || (!folder && !Path::new(path).is_file()) {
        return Err(AppError::new(
            "not_found",
            if folder {
                "文件夹不存在或无法访问，请重新选择。"
            } else {
                "程序不存在或无法访问，请重新选择。"
            },
        ));
    }
    Ok(())
}
fn spawn(path: &str, args: &[String], cwd: &str) -> Result<()> {
    validate_program(path, false)?;
    exists(path, false)?;
    let mut cmd = std::process::Command::new(path);
    cmd.args(args);
    if !cwd.is_empty() {
        exists(cwd, true)?;
        cmd.current_dir(cwd);
    }
    cmd.spawn().map_err(|e| {
        eprintln!("StartFlow CreateProcess: {:?}", e.kind());
        launch_error()
    })?;
    Ok(())
}
pub fn launch(t: &Task) -> Result<(&'static str, &'static str)> {
    match t.kind.as_str() {
        "web" => {
            validate_url(&t.url)?;
            if t.browser_mode == "custom" {
                spawn(&t.browser_path, std::slice::from_ref(&t.url), "")?;
            } else {
                platform::open(&t.url, &[], "")?;
            }
        }
        "app" => {
            validate_program(&t.executable_path, true)?;
            exists(&t.executable_path, false)?;
            if !t.working_directory.is_empty() {
                exists(&t.working_directory, true)?;
            }
            if t.skip_if_running
                && t.executable_path.to_ascii_lowercase().ends_with(".exe")
                && platform::is_running(&t.executable_path)?
            {
                return Ok(("skipped", "匹配到相同完整路径的运行进程，已跳过。"));
            }
            if t.executable_path.to_ascii_lowercase().ends_with(".lnk") {
                platform::open(&t.executable_path, &t.arguments, &t.working_directory)?;
            } else {
                spawn(&t.executable_path, &t.arguments, &t.working_directory)?;
            }
        }
        "folder" => {
            exists(&t.executable_path, true)?;
            platform::open(&t.executable_path, &[], "")?;
        }
        _ => return Err(AppError::new("validation", "不支持的任务类型。")),
    }
    Ok((
        "launch_requested",
        "Windows 已接受启动请求；第三方应用就绪情况由应用自身决定。",
    ))
}
// Standard Windows argv quoting, used only for ShellExecute's parameter field.
// No shell command, executable path and parameters always remain separate.
#[cfg(windows)]
fn quote_arg(arg: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in arg.chars() {
        if c == '\\' {
            slashes += 1;
        } else {
            if c == '"' {
                out.push_str(&"\\".repeat(slashes * 2 + 1));
            } else {
                out.push_str(&"\\".repeat(slashes));
            }
            out.push(c);
            slashes = 0;
        }
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}
#[cfg(windows)]
mod platform {
    use super::*;
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::{
            Foundation::{CloseHandle, HANDLE},
            NetworkManagement::{
                IpHelper::{FreeMibTable, GetIfTable2},
                Ndis::IfOperStatusUp,
            },
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                    TH32CS_SNAPPROCESS,
                },
                Threading::{
                    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                    PROCESS_QUERY_LIMITED_INFORMATION,
                },
            },
            UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        },
    };
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }
    pub fn open(path: &str, args: &[String], cwd: &str) -> Result<()> {
        let op = wide("open");
        let target = wide(path);
        let params = wide(
            &args
                .iter()
                .map(|a| quote_arg(a))
                .collect::<Vec<_>>()
                .join(" "),
        );
        let dir = wide(cwd);
        let r = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(op.as_ptr()),
                PCWSTR(target.as_ptr()),
                PCWSTR(params.as_ptr()),
                if cwd.is_empty() {
                    PCWSTR::null()
                } else {
                    PCWSTR(dir.as_ptr())
                },
                SW_SHOWNORMAL,
            )
        };
        if r.0 as isize <= 32 {
            return Err(launch_error());
        }
        Ok(())
    }
    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
    fn normalized(p: &Path) -> Result<String> {
        Ok(std::fs::canonicalize(p)
            .map_err(|_| AppError::new("path", "无法读取程序的完整路径。"))?
            .to_string_lossy()
            .trim_start_matches("\\\\?\\")
            .to_lowercase())
    }
    pub fn is_running(path: &str) -> Result<bool> {
        let target = normalized(Path::new(path))?;
        let snapshot = OwnedHandle(
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.map_err(|_| {
                AppError::new("process", "无法查询系统进程，请关闭已运行检测后重试。")
            })?,
        );
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut has = unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_ok();
        while has {
            if let Ok(handle) = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION,
                    false,
                    entry.th32ProcessID,
                )
            } {
                let process = OwnedHandle(handle);
                let mut buffer = vec![0u16; 32768];
                let mut size = buffer.len() as u32;
                if unsafe {
                    QueryFullProcessImageNameW(
                        process.0,
                        PROCESS_NAME_WIN32,
                        PWSTR(buffer.as_mut_ptr()),
                        &mut size,
                    )
                }
                .is_ok()
                {
                    let image = String::from_utf16_lossy(&buffer[..size as usize]);
                    if normalized(Path::new(&image)).is_ok_and(|p| p == target) {
                        return Ok(true);
                    }
                }
            }
            has = unsafe { Process32NextW(snapshot.0, &mut entry) }.is_ok();
        }
        Ok(false)
    }
    // Network-interface availability, never a claim that a target website is reachable.
    pub fn network_available() -> bool {
        let mut table = std::ptr::null_mut();
        unsafe {
            if GetIfTable2(&mut table).0 != 0 || table.is_null() {
                return false;
            }
            let rows =
                std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
            let up = rows
                .iter()
                .any(|r| r.OperStatus == IfOperStatusUp && r.Type != 24);
            FreeMibTable(table.cast());
            up
        }
    }
}
#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn open(_: &str, _: &[String], _: &str) -> Result<()> {
        Err(AppError::new("platform", "启动功能仅支持 Windows。"))
    }
    pub fn is_running(_: &str) -> Result<bool> {
        Ok(false)
    }
    pub fn network_available() -> bool {
        false
    }
}
pub use platform::network_available;

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn windows_argument_quoting() {
        assert_eq!(quote_arg("a b"), "\"a b\"");
        assert_eq!(quote_arg("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote_arg("C:\\尾部\\"), "\"C:\\尾部\\\\\"");
    }
    #[test]
    fn missing_path_returns_error() {
        assert!(exists("C:\\StartFlow-test-does-not-exist.exe", false).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn current_process_full_path_detection() {
        let path = std::env::current_exe().unwrap();
        assert!(platform::is_running(path.to_str().unwrap()).unwrap());
    }
}
