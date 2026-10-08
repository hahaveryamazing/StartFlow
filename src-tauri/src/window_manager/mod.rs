use crate::{
    error::{AppError, Result},
    models::{validate_id, validate_path},
    runtime::Control,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Monitor {
    pub id: String,
    pub name: String,
    pub work: Rect,
    pub primary: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub id: String,
    pub executable_path: String,
    pub title: String,
    pub title_mode: String,
    pub monitor_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub state: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    pub id: String,
    pub scene_id: Option<String>,
    pub name: String,
    pub monitors: Vec<Monitor>,
    pub items: Vec<Item>,
    pub missing_monitor: String,
    pub fallback_layout_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub handle: i64,
    pub pid: u32,
    pub executable_path: String,
    pub title: String,
    pub rect: Rect,
    pub monitor_id: String,
    pub maximized: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Inventory {
    pub windows: Vec<WindowInfo>,
    pub monitors: Vec<Monitor>,
    pub excluded_count: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreResult {
    pub item_id: String,
    pub status: String,
    pub message: String,
    pub actual: Option<Rect>,
}
pub fn validate(l: &Layout) -> Result<()> {
    validate_id(&l.id)?;
    crate::workflow::validator::label(&l.name, 120)?;
    if l.items.is_empty()
        || l.items.len() > 32
        || l.monitors.len() > 16
        || !["primary", "skip", "fallback"].contains(&l.missing_monitor.as_str())
    {
        return Err(AppError::new(
            "layout",
            "布局应包含 1～32 个窗口，显示器回退策略无效。",
        ));
    }
    if let Some(s) = &l.scene_id {
        validate_id(s)?;
    }
    if let Some(s) = &l.fallback_layout_id {
        validate_id(s)?;
        if s == &l.id {
            return Err(AppError::new("layout", "备用布局不能是自身。"));
        }
    }
    let mut ids = std::collections::HashSet::new();
    for i in &l.items {
        validate_id(&i.id)?;
        validate_path(&i.executable_path)?;
        if !ids.insert(&i.id)
            || i.title.len() > 512
            || i.title.contains('\0')
            || !["none", "contains", "exact"].contains(&i.title_mode.as_str())
            || !["normal", "maximized"].contains(&i.state.as_str())
            || i.monitor_id.len() > 128
        {
            return Err(AppError::new("layout", "窗口匹配规则无效或重复。"));
        }
        if [i.x, i.y, i.width, i.height]
            .iter()
            .any(|x| !x.is_finite() || *x < 0. || *x > 1.)
            || i.width < 0.05
            || i.height < 0.05
            || i.x + i.width > 1.001
            || i.y + i.height > 1.001
        {
            return Err(AppError::new(
                "layout",
                "窗口相对位置和尺寸必须在显示器工作区内。",
            ));
        }
    }
    Ok(())
}
pub fn target_rect(item: &Item, work: &Rect) -> Rect {
    let w = (work.right - work.left).max(1);
    let h = (work.bottom - work.top).max(1);
    let width = ((w as f64 * item.width).round() as i32).clamp(120.min(w), w);
    let height = ((h as f64 * item.height).round() as i32).clamp(100.min(h), h);
    let left = work.left + ((w as f64 * item.x).round() as i32).clamp(0, w - width);
    let top = work.top + ((h as f64 * item.y).round() as i32).clamp(0, h - height);
    Rect {
        left,
        top,
        right: left + width,
        bottom: top + height,
    }
}
pub fn inventory() -> Result<Inventory> {
    platform::inventory()
}
fn same_path(a: &str, b: &str) -> bool {
    a.trim_start_matches("\\\\?\\")
        .eq_ignore_ascii_case(b.trim_start_matches("\\\\?\\"))
}
fn find<'a>(
    item: &Item,
    windows: &'a [WindowInfo],
    pid: Option<u32>,
) -> Result<Option<&'a WindowInfo>> {
    let candidates: Vec<_> = windows
        .iter()
        .filter(|w| {
            same_path(&w.executable_path, &item.executable_path)
                && match item.title_mode.as_str() {
                    "exact" => w.title == item.title,
                    "contains" => w.title.contains(&item.title),
                    _ => true,
                }
        })
        .collect();
    if let Some(pid) = pid {
        let exact: Vec<_> = candidates
            .iter()
            .copied()
            .filter(|w| w.pid == pid)
            .collect();
        if exact.len() == 1 {
            return Ok(Some(exact[0]));
        }
    }
    if candidates.len() > 1 {
        return Err(AppError::new(
            "layout",
            "同一程序存在多个匹配窗口，请增加明确的窗口标题规则。",
        ));
    }
    Ok(candidates.first().copied())
}
pub async fn restore(
    layout: &Layout,
    all: &[Layout],
    seconds: u32,
    pids: &HashMap<String, u32>,
    control: &Control,
) -> Result<Vec<RestoreResult>> {
    validate(layout)?;
    let inv = inventory()?;
    if layout.missing_monitor == "fallback"
        && layout
            .items
            .iter()
            .any(|i| !inv.monitors.iter().any(|m| m.id == i.monitor_id))
    {
        let fallback = all
            .iter()
            .find(|l| Some(&l.id) == layout.fallback_layout_id.as_ref())
            .ok_or_else(|| AppError::new("layout", "目标显示器断开且备用布局不存在。"))?;
        // One explicit fallback level, never recurse through layout chains.
        return restore_items(fallback, seconds, pids, control).await;
    }
    restore_items(layout, seconds, pids, control).await
}
async fn restore_items(
    layout: &Layout,
    seconds: u32,
    pids: &HashMap<String, u32>,
    control: &Control,
) -> Result<Vec<RestoreResult>> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds as u64);
    let mut results = Vec::new();
    for item in &layout.items {
        control.check()?;
        let result:Result<RestoreResult>=async {
            loop {
                control.check()?;let inv=inventory()?;
                let monitor=inv.monitors.iter().find(|m|m.id==item.monitor_id).or_else(||if layout.missing_monitor=="primary"{inv.monitors.iter().find(|m|m.primary)}else{None});
                let Some(monitor)=monitor else {return Ok(RestoreResult{item_id:item.id.clone(),status:"skipped".into(),message:"目标显示器不可用，按设置跳过。".into(),actual:None});};
                let pid=pids.iter().find(|(p,_)|same_path(p,&item.executable_path)).map(|(_,id)|*id);
                if let Some(window)=find(item,&inv.windows,pid)? {
                    let rect=target_rect(item,&monitor.work);
                    platform::move_window(window.handle,&rect,&item.state)?;
                    // ASYNCWINDOWPOS avoids waiting on a hung third-party message queue.
                    let verify_deadline=tokio::time::Instant::now()+Duration::from_secs(2);
                    loop {
                        control.wait(Duration::from_millis(120)).await?;
                        let observed=inventory()?;
                        if let Some(w)=observed.windows.iter().find(|w|w.handle==window.handle) {
                            let matched=if item.state=="maximized"{w.maximized}else{(w.rect.left-rect.left).abs()<=20 && (w.rect.top-rect.top).abs()<=20 && (w.rect.right-rect.right).abs()<=20 && (w.rect.bottom-rect.bottom).abs()<=20};
                            if matched {return Ok(RestoreResult{item_id:item.id.clone(),status:"completed".into(),message:"已读取并确认窗口位置。".into(),actual:Some(w.rect.clone())});}
                        }
                        if tokio::time::Instant::now()>=verify_deadline {return Err(AppError::new("layout","Windows 已收到调整请求，但窗口未达到目标位置；应用可能限制移动或调整大小。"));}
                    }
                }
                if tokio::time::Instant::now()>=deadline {return Err(AppError::new("layout_timeout","等待匹配窗口超时，请检查程序、标题规则和权限。"));}
                control.wait(Duration::from_millis(400)).await?;
            }
        }.await;
        match result {
            Ok(r) => results.push(r),
            Err(e) if e.code == "cancelled" => return Err(e),
            Err(e) => results.push(RestoreResult {
                item_id: item.id.clone(),
                status: "failed".into(),
                message: e.message,
                actual: None,
            }),
        }
    }
    Ok(results)
}
#[cfg(windows)]
mod platform {
    use super::*;
    use windows::{
        core::{BOOL, PWSTR},
        Win32::{
            Foundation::{CloseHandle, HWND, LPARAM, RECT},
            Graphics::Gdi::{
                EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR,
                MONITORINFOEXW, MONITOR_DEFAULTTONEAREST,
            },
            System::Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
            UI::{
                HiDpi::{
                    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
                    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
                },
                WindowsAndMessaging::*,
            },
        },
    };
    struct DpiGuard(DPI_AWARENESS_CONTEXT);
    impl DpiGuard {
        fn new() -> Self {
            Self(unsafe {
                SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
            })
        }
    }
    impl Drop for DpiGuard {
        fn drop(&mut self) {
            unsafe {
                if !self.0 .0.is_null() {
                    SetThreadDpiAwarenessContext(self.0);
                }
            }
        }
    }
    fn rect(r: RECT) -> Rect {
        Rect {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
        }
    }
    fn monitor(h: HMONITOR) -> Option<Monitor> {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !unsafe { GetMonitorInfoW(h, &mut info.monitorInfo) }.as_bool() {
            return None;
        }
        let id = String::from_utf16_lossy(
            &info.szDevice[..info
                .szDevice
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(info.szDevice.len())],
        );
        Some(Monitor {
            id: id.clone(),
            name: id,
            work: rect(info.monitorInfo.rcWork),
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        })
    }
    unsafe extern "system" fn monitor_cb(h: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let out = &mut *(data.0 as *mut Vec<Monitor>);
        if let Some(m) = monitor(h) {
            out.push(m);
        }
        BOOL(1)
    }
    unsafe extern "system" fn window_cb(h: HWND, data: LPARAM) -> BOOL {
        let out = &mut *(data.0 as *mut Inventory);
        if !IsWindowVisible(h).as_bool()
            || h == GetShellWindow()
            || GetWindowLongPtrW(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW.0 as isize != 0
        {
            return BOOL(1);
        }
        let mut pid = 0;
        GetWindowThreadProcessId(h, Some(&mut pid));
        if pid == 0 || pid == std::process::id() {
            return BOOL(1);
        }
        let len = GetWindowTextLengthW(h);
        if len <= 0 {
            return BOOL(1);
        }
        let mut title = vec![0u16; (len as usize + 1).min(513)];
        let count = GetWindowTextW(h, &mut title);
        let Ok(p) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            out.excluded_count += 1;
            return BOOL(1);
        };
        let mut path = vec![0u16; 32768];
        let mut size = path.len() as u32;
        let result =
            QueryFullProcessImageNameW(p, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut size);
        let _ = CloseHandle(p);
        if result.is_err() {
            out.excluded_count += 1;
            return BOOL(1);
        }
        let executable = String::from_utf16_lossy(&path[..size as usize]);
        if executable
            .to_lowercase()
            .ends_with("\\applicationframehost.exe")
        {
            out.excluded_count += 1;
            return BOOL(1);
        }
        let mut current = RECT::default();
        if GetWindowRect(h, &mut current).is_err() {
            return BOOL(1);
        }
        let Some(m) = monitor(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST)) else {
            return BOOL(1);
        };
        if current.right - current.left < 80 || current.bottom - current.top < 60 {
            return BOOL(1);
        }
        let maximized = IsZoomed(h).as_bool();
        // Persist restored workspace geometry, then convert workspace to screen coordinates.
        if maximized || IsIconic(h).as_bool() {
            let mut placement = WINDOWPLACEMENT {
                length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
                ..Default::default()
            };
            if GetWindowPlacement(h, &mut placement).is_ok() {
                current = placement.rcNormalPosition;
                let mut mi = MONITORINFOEXW::default();
                mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
                if GetMonitorInfoW(
                    MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST),
                    &mut mi.monitorInfo,
                )
                .as_bool()
                {
                    let dx = mi.monitorInfo.rcWork.left - mi.monitorInfo.rcMonitor.left;
                    let dy = mi.monitorInfo.rcWork.top - mi.monitorInfo.rcMonitor.top;
                    current.left += dx;
                    current.right += dx;
                    current.top += dy;
                    current.bottom += dy;
                }
            }
        }
        out.windows.push(WindowInfo {
            handle: h.0 as i64,
            pid,
            executable_path: executable,
            title: String::from_utf16_lossy(&title[..count.max(0) as usize]),
            rect: rect(current),
            monitor_id: m.id,
            maximized,
        });
        BOOL(1)
    }
    pub fn inventory() -> Result<Inventory> {
        let _dpi = DpiGuard::new();
        let mut inv = Inventory {
            windows: vec![],
            monitors: vec![],
            excluded_count: 0,
        };
        if !unsafe {
            EnumDisplayMonitors(
                None,
                None,
                Some(monitor_cb),
                LPARAM(&mut inv.monitors as *mut _ as isize),
            )
        }
        .as_bool()
        {
            return Err(AppError::new("window", "无法枚举显示器。"));
        }
        unsafe { EnumWindows(Some(window_cb), LPARAM(&mut inv as *mut _ as isize)) }
            .map_err(|_| AppError::new("window", "无法枚举应用窗口。"))?;
        Ok(inv)
    }
    pub fn move_window(handle: i64, r: &Rect, state: &str) -> Result<()> {
        let _dpi = DpiGuard::new();
        let h = HWND(handle as *mut std::ffi::c_void);
        if !unsafe { IsWindow(Some(h)) }.as_bool() {
            return Err(AppError::new("window", "目标窗口已关闭。"));
        }
        if !unsafe { ShowWindowAsync(h, SW_RESTORE) }.as_bool() {
            return Err(AppError::new("window", "无法恢复窗口，请检查应用权限。"));
        }
        unsafe {
            SetWindowPos(
                h,
                None,
                r.left,
                r.top,
                r.right - r.left,
                r.bottom - r.top,
                SWP_NOACTIVATE | SWP_NOZORDER | SWP_ASYNCWINDOWPOS,
            )
        }
        .map_err(|_| {
            AppError::new(
                "window",
                "Windows 拒绝调整窗口，可能权限不足或目标不支持；不会绕过 UAC。",
            )
        })?;
        if state == "maximized" && !unsafe { ShowWindowAsync(h, SW_MAXIMIZE) }.as_bool() {
            return Err(AppError::new("window", "无法提交窗口最大化请求。"));
        }
        Ok(())
    }
}
#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn inventory() -> Result<Inventory> {
        Err(AppError::new("platform", "窗口管理仅支持 Windows。"))
    }
    pub fn move_window(_: i64, _: &Rect, _: &str) -> Result<()> {
        Err(AppError::new("platform", "窗口管理仅支持 Windows。"))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_rect_never_offscreen() {
        let i = Item {
            id: "".into(),
            executable_path: "".into(),
            title: "".into(),
            title_mode: "none".into(),
            monitor_id: "".into(),
            x: 0.8,
            y: 0.8,
            width: 0.8,
            height: 0.8,
            state: "normal".into(),
        };
        let work = Rect {
            left: -1920,
            top: 40,
            right: 0,
            bottom: 1080,
        };
        let r = target_rect(&i, &work);
        assert!(
            r.left >= work.left
                && r.top >= work.top
                && r.right <= work.right
                && r.bottom <= work.bottom
        );
    }
}
