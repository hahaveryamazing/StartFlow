use super::models::*;
use crate::error::{AppError, Result};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};
use windows::{
    core::BSTR,
    Win32::{
        Foundation::*,
        Security::*,
        System::{
            Com::*, RemoteDesktop::ProcessIdToSessionId, StationsAndDesktops::*, Threading::*,
        },
        UI::{Accessibility::*, WindowsAndMessaging::*},
    },
};
struct SecretBstr(BSTR);
impl Drop for SecretBstr {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        unsafe {
            std::slice::from_raw_parts_mut(self.0.as_ptr() as *mut u16, self.0.len()).zeroize();
        }
    }
}

fn err() -> AppError {
    AppError::new(
        "invalid_controls",
        "目标控件不可用或已改变，请重新录制；不支持的应用请人工登录。",
    )
}
fn permission() -> AppError {
    AppError::new(
        "permission_denied",
        "无法访问目标应用。请检查应用权限；不会提升权限或绕过安全桌面。",
    )
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
struct Com;
impl Drop for Com {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
pub fn interactive() -> Result<()> {
    unsafe {
        let d = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
            .map_err(|_| permission())?;
        let mut name = [0u16; 128];
        let read = GetUserObjectInformationW(
            HANDLE(d.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            256,
            None,
        );
        let _ = CloseDesktop(d);
        read.map_err(|_| permission())?;
        let end = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        if String::from_utf16_lossy(&name[..end]) != "Default" {
            return Err(AppError::new(
                "locked",
                "Windows 已锁定或处于系统安全桌面，请解锁并自行完成系统验证。",
            ));
        }
        Ok(())
    }
}
fn integrity(process: HANDLE) -> Result<u32> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token).map_err(|_| permission())?;
        let _token = Handle(token);
        let mut len = 0;
        let _ = GetTokenInformation(token, TokenIntegrityLevel, None, 0, &mut len);
        if len == 0 || len > 16384 {
            return Err(permission());
        }
        // Vec<usize> supplies alignment required by TOKEN_MANDATORY_LABEL.
        let mut storage = vec![0usize; (len as usize).div_ceil(std::mem::size_of::<usize>())];
        GetTokenInformation(
            token,
            TokenIntegrityLevel,
            Some(storage.as_mut_ptr().cast()),
            len,
            &mut len,
        )
        .map_err(|_| permission())?;
        let label = &*(storage.as_ptr() as *const TOKEN_MANDATORY_LABEL);
        let count = *GetSidSubAuthorityCount(label.Label.Sid);
        if count == 0 {
            return Err(permission());
        }
        Ok(*GetSidSubAuthority(label.Label.Sid, (count - 1) as u32))
    }
}
fn identity(pid: u32) -> Result<(String, u64)> {
    unsafe {
        let p =
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|_| permission())?;
        let _p = Handle(p);
        let mut current_session = 0;
        let mut target_session = 0;
        ProcessIdToSessionId(GetCurrentProcessId(), &mut current_session)
            .map_err(|_| permission())?;
        ProcessIdToSessionId(pid, &mut target_session).map_err(|_| permission())?;
        if current_session != target_session || integrity(p)? > integrity(GetCurrentProcess())? {
            return Err(permission());
        }
        let mut text = vec![0u16; 32768];
        let mut len = text.len() as u32;
        QueryFullProcessImageNameW(
            p,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(text.as_mut_ptr()),
            &mut len,
        )
        .map_err(|_| permission())?;
        let path = String::from_utf16_lossy(&text[..len as usize]);
        if [
            "consent.exe",
            "logonui.exe",
            "credentialuibroker.exe",
            "winlogon.exe",
        ]
        .iter()
        .any(|x| path.to_ascii_lowercase().ends_with(x))
        {
            return Err(permission());
        }
        let (mut c, mut e, mut k, mut u) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        GetProcessTimes(p, &mut c, &mut e, &mut k, &mut u).map_err(|_| permission())?;
        Ok((
            path,
            ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64,
        ))
    }
}
fn token(hwnd: HWND) -> Result<Window> {
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() || !IsWindowVisible(hwnd).as_bool() {
            return Err(err());
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let (executable_path, creation_time) = identity(pid)?;
        let mut title = [0u16; 512];
        let len = GetWindowTextW(hwnd, &mut title);
        let mut class = [0u16; 256];
        let clen = GetClassNameW(hwnd, &mut class);
        Ok(Window {
            handle: hwnd.0 as i64,
            pid,
            creation_time: creation_time.to_string(),
            executable_path,
            title: String::from_utf16_lossy(&title[..len.max(0) as usize]),
            class_name: String::from_utf16_lossy(&class[..clen.max(0) as usize]),
        })
    }
}
fn guard(w: &Window) -> Result<HWND> {
    interactive()?;
    let hwnd = HWND(w.handle as *mut std::ffi::c_void);
    let actual = token(hwnd)?;
    if unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } & WS_DISABLED.0 as isize != 0 {
        return Err(AppError::new(
            "manual_required",
            "目标窗口正在等待对话框或人工验证，请自行完成后重试。",
        ));
    }
    if actual.pid != w.pid
        || actual.creation_time != w.creation_time
        || !same_path(&actual.executable_path, &w.executable_path)
        || actual.class_name != w.class_name
        || actual.title != w.title
    {
        return Err(AppError::new(
            "wrong_target",
            "窗口或进程身份已变化，操作已停止，请重新选择窗口。",
        ));
    }
    Ok(hwnd)
}
pub fn windows(path: &str) -> Result<Response> {
    interactive()?;
    crate::models::validate_path(path)?;
    let inv = crate::window_manager::inventory()?;
    let mut out = Response::status("ready", "请选择要配置的应用窗口。");
    for w in inv
        .windows
        .into_iter()
        .filter(|w| same_path(&w.executable_path, path))
        .take(32)
    {
        out.windows
            .push(token(HWND(w.handle as *mut std::ffi::c_void))?);
    }
    if out.windows.is_empty() {
        out.status = "not_found".into();
        out.message = "未找到绑定 EXE 的普通窗口，请先启动应用；受保护窗口需人工操作。".into();
    }
    Ok(out)
}
struct Entry {
    e: IUIAutomationElement,
    c: Control,
}
struct Client {
    uia: IUIAutomation,
    _com: Com,
}
impl Client {
    fn new() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|_| err())?;
            let com = Com;
            let uia =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).map_err(|_| err())?;
            Ok(Self { uia, _com: com })
        }
    }
    fn tree(&self, w: &Window) -> Result<Vec<Entry>> {
        unsafe {
            let hwnd = guard(w)?;
            let root = self.uia.ElementFromHandle(hwnd).map_err(|_| err())?;
            let walker = self.uia.ControlViewWalker().map_err(|_| err())?;
            let mut out = vec![];
            self.walk(&walker, &root, "", 0, w.pid, &mut out)?;
            Ok(out)
        }
    }
    unsafe fn walk(
        &self,
        walker: &IUIAutomationTreeWalker,
        parent: &IUIAutomationElement,
        ancestor: &str,
        depth: u32,
        pid: u32,
        out: &mut Vec<Entry>,
    ) -> Result<()> {
        if depth > 12 {
            return Err(AppError::new(
                "manual_required",
                "控件层级过深，请人工辅助登录。",
            ));
        }
        let mut child = walker.GetFirstChildElement(parent).ok();
        while let Some(e) = child {
            if out.len() >= 512 {
                return Err(AppError::new(
                    "manual_required",
                    "目标窗口超过 512 个控件，请人工辅助登录。",
                ));
            }
            if e.CurrentProcessId().map_err(|_| err())? as u32 != pid {
                return Err(AppError::new(
                    "wrong_target",
                    "目标窗口包含其他进程的控件，已停止跨进程填写。",
                ));
            }
            let kind = e.CurrentControlType().map_err(|_| err())?.0;
            let password = e.CurrentIsPassword().map_err(|_| err())?.as_bool();
            // Never read ValuePattern/ TextPattern values or the Name of an Edit/password.
            let name = if password || kind == 50004 {
                String::new()
            } else {
                e.CurrentName().map_err(|_| err())?.to_string()
            };
            let id = e.CurrentAutomationId().map_err(|_| err())?.to_string();
            let c = Control {
                locator: Locator {
                    automation_id: id.clone(),
                    control_type: kind,
                    name: if name.len() <= 200 && !name.chars().any(char::is_control) {
                        name
                    } else {
                        String::new()
                    },
                    ancestor_id: ancestor.into(),
                },
                is_password: password,
                enabled: e.CurrentIsEnabled().map_err(|_| err())?.as_bool(),
                visible: !e.CurrentIsOffscreen().map_err(|_| err())?.as_bool(),
                value_supported: e
                    .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .is_ok(),
                invoke_supported: e
                    .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    .is_ok(),
                read_only: e
                    .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .and_then(|p| p.CurrentIsReadOnly())
                    .map(|b| b.as_bool())
                    .unwrap_or(true),
            };
            out.push(Entry { e: e.clone(), c });
            // Nearest identified ancestor narrows repeated form fields without ordinal indexes.
            self.walk(
                walker,
                &e,
                if id.is_empty() { ancestor } else { &id },
                depth + 1,
                pid,
                out,
            )?;
            child = walker.GetNextSiblingElement(&e).ok();
        }
        Ok(())
    }
}
fn matches(c: &Control, l: &Locator) -> bool {
    c.locator.control_type == l.control_type
        && (l.automation_id.is_empty() || c.locator.automation_id == l.automation_id)
        && (l.name.is_empty() || c.locator.name == l.name)
        && (l.ancestor_id.is_empty() || c.locator.ancestor_id == l.ancestor_id)
}
fn select<'a>(tree: &'a [Entry], l: &Locator, required: bool) -> Result<Option<&'a Entry>> {
    l.validate()?;
    let found: Vec<_> = tree
        .iter()
        .filter(|e| e.c.visible && matches(&e.c, l))
        .collect();
    if found.len() > 1 {
        return Err(AppError::new(
            "ambiguous_controls",
            "定位规则匹配多个控件，请补充 AutomationId 或父级关系并重新录制。",
        ));
    }
    if required && found.is_empty() {
        return Err(err());
    }
    Ok(found.first().copied())
}
fn checked<'a>(tree: &'a [Entry], l: &Locator, password: bool) -> Result<&'a Entry> {
    let e = select(tree, l, true)?.ok_or_else(err)?;
    if !e.c.enabled || e.c.is_password != password || !e.c.value_supported || e.c.read_only {
        return Err(AppError::new(
            "manual_required",
            "输入框不支持安全填写或密码属性不符，请人工登录。",
        ));
    }
    Ok(e)
}
fn challenge(tree: &[Entry], cfg: &Config) -> Result<bool> {
    if let Some(l) = &cfg.challenge {
        if select(tree, l, false)?.is_some() {
            return Ok(true);
        }
    }
    let words = [
        "验证码",
        "扫码",
        "二维码",
        "人脸",
        "指纹",
        "安全密钥",
        "captcha",
        "verification code",
        "one-time",
        "passkey",
        "windows hello",
        "two-factor",
        "mfa",
    ];
    Ok(tree
        .iter()
        .filter(|e| e.c.visible && e.c.locator.control_type != 50004)
        .any(|e| {
            let n = e.c.locator.name.to_lowercase();
            words.iter().any(|k| n.contains(k))
        }))
}
fn logged(tree: &[Entry], cfg: &Config, username: &str) -> Result<bool> {
    let success = select(tree, &cfg.success, false)?.is_some();
    let identity = select(tree, &cfg.identity, false)?;
    if success && identity.is_some_and(|i| i.c.locator.name == username) {
        if select(tree, &cfg.password, false)?.is_some() {
            return Err(AppError::new(
                "invalid_controls",
                "成功页面仍显示密码输入框，无法可靠确认会话。",
            ));
        }
        return Ok(true);
    }
    if success && identity.is_some() {
        return Err(AppError::new(
            "wrong_account",
            "应用已有其他账号会话，请自行切换账号后重试。",
        ));
    }
    Ok(false)
}
pub fn execute(r: Request) -> Result<Response> {
    if let Request::Windows { executable_path } = r {
        return windows(&executable_path);
    }
    let client = Client::new()?;
    match r {
        Request::Inspect { window } => {
            let mut out = Response::status("ready", "控件已读取；输入值与密码不会被录制。");
            out.controls = client.tree(&window)?.into_iter().map(|e| e.c).collect();
            Ok(out)
        }
        Request::Test { window, config } => {
            check_config_window(&config, &window)?;
            let tree = client.tree(&window)?;
            for l in [
                &config.username,
                &config.password,
                &config.submit,
                &config.success,
                &config.identity,
            ]
            .into_iter()
            .chain(config.failure.iter())
            .chain(config.challenge.iter())
            {
                select(&tree, l, false)?;
            }
            if select(&tree, &config.success, false)?.is_none() {
                checked(&tree, &config.username, false)?;
                checked(&tree, &config.password, true)?;
                let button = select(&tree, &config.submit, true)?.ok_or_else(err)?;
                if !button.c.invoke_supported || !button.c.enabled {
                    return Err(AppError::new(
                        "manual_required",
                        "按钮不支持 InvokePattern，请人工辅助登录。",
                    ));
                }
            }
            Ok(Response::status(
                "validated",
                "当前页面定位有效；成功与身份控件应在登录后刷新录制并验证。",
            ))
        }
        Request::Login {
            window,
            config,
            binding,
            authorized,
        } => {
            check_config_window(&config, &window)?;
            crate::models::validate_id(&binding.credential_ref)?;
            if config.credential_ref != binding.credential_ref {
                return Err(err());
            }
            let tree = client.tree(&window)?;
            if challenge(&tree, &config)? {
                return Ok(Response::status(
                    "waiting_manual",
                    "检测到验证步骤，请自行完成验证码、扫码或系统验证。",
                ));
            }
            if logged(&tree, &config, &binding.username)? {
                return Ok(Response::status(
                    "session_reused",
                    "已确认绑定账号会话，未读取密码或重复提交。",
                ));
            }
            if !authorized {
                return Ok(Response::status(
                    "authorization_required",
                    "当前会话未登录。请明确授权后才能读取凭据。",
                ));
            }
            let user = checked(&tree, &config.username, false)?;
            let password = checked(&tree, &config.password, true)?;
            let button = select(&tree, &config.submit, true)?.ok_or_else(err)?;
            if !button.c.enabled || !button.c.invoke_supported {
                return Err(AppError::new(
                    "manual_required",
                    "登录按钮无法可靠操作，请人工登录。",
                ));
            }
            let deadline = Instant::now() + Duration::from_secs(config.timeout_seconds as u64);
            unsafe {
                let up = user
                    .e
                    .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .map_err(|_| err())?;
                let _ = password;
                let _ = button;
                guard(&window)?;
                let secret = crate::accounts::vault::read_for_login(&binding.credential_ref)?;
                let username = BSTR::from(binding.username.as_str());
                guard(&window)?;
                up.SetValue(&username).map_err(|_| err())?;
                // Resolve again after account changes: reactive providers may replace password/button.
                guard(&window)?;
                let fresh = client.tree(&window)?;
                if challenge(&fresh, &config)? {
                    return Ok(Response::status(
                        "waiting_manual",
                        "账号填写后出现人工验证，未填写密码或提交。",
                    ));
                }
                let password = checked(&fresh, &config.password, true)?;
                let pp = password
                    .e
                    .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                    .map_err(|_| err())?;
                let wide =
                    zeroize::Zeroizing::new(secret.value().encode_utf16().collect::<Vec<u16>>());
                let value = SecretBstr(BSTR::from_wide(&wide));
                drop(wide);
                guard(&window)?;
                pp.SetValue(&value.0).map_err(|_| err())?;
                drop(value);
                drop(secret);
                guard(&window)?;
                let fresh = client.tree(&window)?;
                if challenge(&fresh, &config)? {
                    return Ok(Response::status(
                        "waiting_manual",
                        "出现人工验证，未自动提交登录；请自行处理。",
                    ));
                }
                checked(&fresh, &config.password, true)?;
                let button = select(&fresh, &config.submit, true)?.ok_or_else(err)?;
                if !button.c.enabled || !button.c.invoke_supported {
                    return Err(err());
                }
                let bp = button
                    .e
                    .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                    .map_err(|_| err())?;
                guard(&window)?;
                bp.Invoke().map_err(|_| err())?;
            }
            let outcome = (|| -> Result<Response> {
                loop {
                    let tree = client.tree(&window)?;
                    if challenge(&tree, &config)? {
                        return Ok(Response::status(
                            "waiting_manual",
                            "已提交一次，后续验证需人工完成，不会重复提交。",
                        ));
                    }
                    if logged(&tree, &config, &binding.username)? {
                        return Ok(Response::status(
                            "success",
                            "已确认成功控件和绑定账号身份。",
                        ));
                    }
                    if let Some(l) = &config.failure {
                        if select(&tree, l, false)?.is_some() {
                            return Ok(Response::status(
                                "failed",
                                "应用显示登录失败，已停止自动重试。",
                            ));
                        }
                    }
                    if Instant::now() >= deadline {
                        return Ok(Response::status(
                            "timeout",
                            "在时限内未确认登录成功，请人工检查；不会自动重试。",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(350));
                }
            })();
            let mut out = outcome.unwrap_or_else(|e| Response::status(&e.code, &e.message));
            out.submitted = true;
            Ok(out)
        }
        Request::Windows { .. } => Err(err()),
    }
}
fn check_config_window(c: &Config, w: &Window) -> Result<()> {
    if !same_path(&c.executable_path, &w.executable_path)
        || c.window_class != w.class_name
        || c.window_title != w.title
    {
        return Err(AppError::new(
            "wrong_target",
            "窗口身份与保存的配置不匹配。",
        ));
    }
    let mut ids = HashSet::new();
    for l in [&c.username, &c.password, &c.submit] {
        l.validate()?;
        if !ids.insert((
            l.automation_id.clone(),
            l.control_type,
            l.ancestor_id.clone(),
        )) {
            return Err(err());
        }
    }
    Ok(())
}
