use crate::{
    error::{AppError, Result},
    rules::models::{EventKind, Permissions},
};
use std::{
    sync::{
        atomic::{AtomicU8, Ordering},
        mpsc::SyncSender,
        Arc,
    },
    thread::JoinHandle,
};
use windows::{
    core::{w, PWSTR},
    Win32::{
        Foundation::*,
        NetworkManagement::{IpHelper::*, WiFi::*},
        Networking::WinSock::AF_UNSPEC,
        System::{LibraryLoader::GetModuleHandleW, Power::*, RemoteDesktop::*},
        UI::WindowsAndMessaging::*,
    },
};
struct Sink {
    sender: SyncSender<EventKind>,
}
struct Data {
    sink: Arc<Sink>,
    session: Arc<AtomicU8>,
    flags: u32,
    wlan: HANDLE,
    wts: bool,
    power: Vec<HPOWERNOTIFY>,
    hwnd: HWND,
}
unsafe extern "system" fn network_changed(
    ctx: *const core::ffi::c_void,
    _: *const MIB_IPINTERFACE_ROW,
    _: MIB_NOTIFICATION_TYPE,
) {
    if let Some(data) = (ctx as *const Sink).as_ref() {
        let _ = data.sender.try_send(EventKind::Network);
    }
}
unsafe extern "system" fn wifi_changed(_: *mut L2_NOTIFICATION_DATA, ctx: *mut core::ffi::c_void) {
    if let Some(data) = (ctx as *const Sink).as_ref() {
        let _ = data.sender.try_send(EventKind::Network);
    }
}
unsafe fn configure(d: &mut Data, flags: u32) {
    if flags & 1 != 0 && d.wlan.is_invalid() {
        let mut version = 0;
        let mut handle = HANDLE::default();
        if WlanOpenHandle(2, None, &mut version, &mut handle) == 0 {
            if WlanRegisterNotification(
                handle,
                WLAN_NOTIFICATION_SOURCE_ACM,
                true,
                Some(wifi_changed),
                Some(Arc::as_ptr(&d.sink).cast()),
                None,
                None,
            ) == 0
            {
                d.wlan = handle;
            } else {
                WlanCloseHandle(handle, None);
            }
        }
    }
    if flags & 1 == 0 && !d.wlan.is_invalid() {
        WlanRegisterNotification(
            d.wlan,
            WLAN_NOTIFICATION_SOURCE_NONE,
            true,
            None,
            None,
            None,
            None,
        );
        WlanCloseHandle(d.wlan, None);
        d.wlan = HANDLE::default();
    }
    if flags & 2 != 0 && !d.wts {
        d.wts = WTSRegisterSessionNotification(d.hwnd, NOTIFY_FOR_THIS_SESSION).is_ok();
        if d.wts {
            d.session.store(current_session(), Ordering::Release);
        }
    }
    if flags & 2 == 0 && d.wts {
        let _ = WTSUnRegisterSessionNotification(d.hwnd);
        d.wts = false;
        d.session.store(0, Ordering::Release);
    }
    if flags & 4 != 0 && d.power.is_empty() {
        for guid in [
            windows::core::GUID::from_u128(0x5d3e9a59_e9d5_4b00_a6bd_ff34ff516548),
            windows::core::GUID::from_u128(0xa7ad8041_b45a_4cae_87a3_eecbb468a9e1),
        ] {
            if let Ok(handle) = RegisterPowerSettingNotification(
                HANDLE(d.hwnd.0),
                &guid,
                DEVICE_NOTIFY_WINDOW_HANDLE,
            ) {
                d.power.push(handle);
            }
        }
    }
    if flags & 4 == 0 {
        for handle in d.power.drain(..) {
            let _ = UnregisterPowerSettingNotification(handle);
        }
    }
    d.flags = flags;
}
unsafe fn current_session() -> u8 {
    let mut buffer = PWSTR::null();
    let mut bytes = 0;
    let mut state = 0;
    if WTSQuerySessionInformationW(
        None,
        WTS_CURRENT_SESSION,
        WTSSessionInfoEx,
        &mut buffer,
        &mut bytes,
    )
    .is_ok()
    {
        if bytes as usize >= std::mem::size_of::<WTSINFOEXW>() {
            let info = &*(buffer.0 as *const WTSINFOEXW);
            if info.Level == 1 {
                let first = info.Data.WTSInfoExLevel1;
                state = if first.SessionState != WTSActive {
                    3
                } else if first.SessionFlags == 0 {
                    2
                } else if first.SessionFlags == 1 {
                    1
                } else {
                    0
                };
            }
        }
        WTSFreeMemory(buffer.0.cast());
    }
    state
}
unsafe extern "system" fn procedure(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let pointer = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Data;
    if let Some(data) = pointer.as_mut() {
        match message {
            m if m == WM_APP + 1 => {
                configure(data, wparam.0 as u32);
                return LRESULT(0);
            }
            WM_DISPLAYCHANGE if data.flags & 8 != 0 => {
                let _ = data.sink.sender.try_send(EventKind::Displays);
            }
            WM_POWERBROADCAST => {
                let kind = if wparam.0 as u32 == PBT_APMRESUMEAUTOMATIC
                    || wparam.0 as u32 == PBT_APMRESUMESUSPEND
                {
                    Some(EventKind::Resume)
                } else if data.flags & 4 != 0
                    && (wparam.0 as u32 == PBT_APMPOWERSTATUSCHANGE
                        || wparam.0 as u32 == PBT_POWERSETTINGCHANGE)
                {
                    Some(EventKind::Power)
                } else {
                    None
                };
                if let Some(kind) = kind {
                    if kind != EventKind::Resume || data.flags & 2 != 0 {
                        let _ = data.sink.sender.try_send(kind);
                    }
                }
                return LRESULT(1);
            }
            WM_WTSSESSION_CHANGE if data.wts => match wparam.0 {
                7 => {
                    data.session.store(2, Ordering::Release);
                }
                8 => {
                    data.session.store(1, Ordering::Release);
                    let _ = data.sink.sender.try_send(EventKind::Unlock);
                }
                4 => {
                    data.session.store(3, Ordering::Release);
                }
                3 => {
                    data.session.store(1, Ordering::Release);
                }
                _ => {}
            },
            WM_CLOSE => {
                configure(data, 0);
                let _ = DestroyWindow(hwnd);
                return LRESULT(0);
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                return LRESULT(0);
            }
            _ => {}
        }
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}
fn flags(p: &Permissions) -> u32 {
    u32::from(p.wifi)
        | u32::from(p.session) << 1
        | u32::from(p.power) << 2
        | u32::from(p.displays) << 3
}
pub struct Subscriptions {
    hwnd: isize,
    join: Option<JoinHandle<()>>,
    pub session: Arc<AtomicU8>,
}
impl Subscriptions {
    pub fn start(sender: SyncSender<EventKind>, permissions: &Permissions) -> Result<Self> {
        let (ready, receive) = std::sync::mpsc::sync_channel(1);
        let session = Arc::new(AtomicU8::new(0));
        let shared = session.clone();
        let initial = flags(permissions);
        let join = std::thread::Builder::new()
            .name("StartFlow environment events".into())
            .spawn(move || unsafe {
                let result: Result<isize> = (|| {
                    let module = GetModuleHandleW(None).map_err(AppError::internal)?;
                    let class = w!("StartFlowEnvironmentEventsV3");
                    let wc = WNDCLASSW {
                        lpfnWndProc: Some(procedure),
                        hInstance: HINSTANCE(module.0),
                        lpszClassName: class,
                        ..Default::default()
                    };
                    if RegisterClassW(&wc) == 0 {
                        return Err(AppError::new(
                            "environment",
                            "Windows 环境通知窗口注册失败。",
                        ));
                    }
                    // Hidden top-level window, not HWND_MESSAGE: receives display and power broadcasts.
                    let hwnd = CreateWindowExW(
                        WINDOW_EX_STYLE::default(),
                        class,
                        w!("StartFlow environment"),
                        WS_POPUP,
                        0,
                        0,
                        0,
                        0,
                        None,
                        None,
                        Some(HINSTANCE(module.0)),
                        None,
                    )
                    .map_err(AppError::internal)?;
                    let mut data = Box::new(Data {
                        sink: Arc::new(Sink { sender }),
                        session: shared,
                        flags: 0,
                        wlan: HANDLE::default(),
                        wts: false,
                        power: vec![],
                        hwnd,
                    });
                    SetWindowLongPtrW(hwnd, GWLP_USERDATA, &mut *data as *mut _ as isize);
                    configure(&mut data, initial);
                    let mut network = HANDLE::default();
                    let subscribed = NotifyIpInterfaceChange(
                        AF_UNSPEC,
                        Some(network_changed),
                        Some(Arc::as_ptr(&data.sink).cast()),
                        false,
                        &mut network,
                    )
                    .0 == 0;
                    let _ = ready.send(Ok(hwnd.0 as isize));
                    let mut message = MSG::default();
                    while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                    if subscribed {
                        let _ = CancelMibChangeNotify2(network);
                    }
                    configure(&mut data, 0);
                    let _ = UnregisterClassW(class, Some(HINSTANCE(module.0)));
                    Ok(hwnd.0 as isize)
                })();
                if let Err(error) = result {
                    let _ = ready.send(Err(error));
                }
            })
            .map_err(AppError::internal)?;
        let hwnd = receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| AppError::new("environment", "Windows 事件订阅初始化超时。"))??;
        Ok(Self {
            hwnd,
            join: Some(join),
            session,
        })
    }
    pub fn configure(&self, p: &Permissions) -> Result<()> {
        unsafe {
            PostMessageW(
                Some(HWND(self.hwnd as *mut _)),
                WM_APP + 1,
                WPARAM(flags(p) as usize),
                LPARAM(0),
            )
            .map_err(AppError::internal)
        }
    }
    pub fn session_state(&self) -> &'static str {
        match self.session.load(Ordering::Acquire) {
            1 => "active",
            2 => "locked",
            3 => "disconnected",
            _ => "unknown",
        }
    }
}
impl Drop for Subscriptions {
    fn drop(&mut self) {
        unsafe {
            let _ = PostMessageW(
                Some(HWND(self.hwnd as *mut _)),
                WM_CLOSE,
                WPARAM(0),
                LPARAM(0),
            );
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}
