use crate::{
    context::{Availability, Display, Field, ProcessState},
    error::{AppError, Result},
};
use std::{collections::BTreeMap, path::Path};
use windows::{
    core::{BOOL, PCWSTR},
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        NetworkManagement::{IpHelper::*, Ndis::IfOperStatusUp, WiFi::*},
        Security::Cryptography::*,
        System::{Diagnostics::ToolHelp::*, Power::*, Threading::*},
        UI::HiDpi::*,
    },
};
fn win_field<T>(code: u32) -> Field<T> {
    Field::absent(
        if code == 5 {
            Availability::PermissionDenied
        } else if code == 1062 || code == 50 {
            Availability::Unsupported
        } else {
            Availability::Error
        },
        if code == 5 {
            "Windows 拒绝访问，请检查系统权限；不能解释为未连接。"
        } else {
            "Windows 检测不可用，请检查系统服务或设备。"
        },
    )
}
pub fn network() -> (Field<bool>, Field<String>) {
    unsafe {
        let mut table = std::ptr::null_mut();
        let code = GetIfTable2(&mut table);
        if code.0 != 0 || table.is_null() {
            return (win_field(code.0), win_field(code.0));
        }
        let rows =
            std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        let kinds: Vec<_> = rows
            .iter()
            .filter(|r| r.OperStatus == IfOperStatusUp && r.Type != 24)
            .map(|r| match r.Type {
                71 => "wifi",
                6 => "ethernet",
                131 => "tunnel",
                _ => "other",
            })
            .collect();
        let connected = !kinds.is_empty();
        let kind = if kinds.contains(&"wifi") {
            "wifi"
        } else if kinds.contains(&"ethernet") {
            "ethernet"
        } else {
            kinds.first().copied().unwrap_or("none")
        };
        let result = (
            Field::available(connected),
            Field::available(kind.to_owned()),
        );
        FreeMibTable(table.cast());
        result
    }
}
pub fn wifi() -> Field<String> {
    unsafe {
        let mut handle = HANDLE::default();
        let mut version = 0;
        let code = WlanOpenHandle(2, None, &mut version, &mut handle);
        if code != 0 {
            return win_field(code);
        }
        let mut list = std::ptr::null_mut();
        let code = WlanEnumInterfaces(handle, None, &mut list);
        let mut result = if code != 0 {
            win_field(code)
        } else {
            Field::absent(
                Availability::Unavailable,
                "没有连接的 Wi-Fi 接口；SSID 为未知。",
            )
        };
        if code == 0 && !list.is_null() {
            for interface in std::slice::from_raw_parts(
                (*list).InterfaceInfo.as_ptr(),
                (*list).dwNumberOfItems as usize,
            ) {
                if interface.isState != wlan_interface_state_connected {
                    continue;
                }
                let mut size = 0;
                let mut data = std::ptr::null_mut();
                let code = WlanQueryInterface(
                    handle,
                    &interface.InterfaceGuid,
                    wlan_intf_opcode_current_connection,
                    None,
                    &mut size,
                    &mut data,
                    None,
                );
                if code == 0
                    && !data.is_null()
                    && size as usize >= std::mem::size_of::<WLAN_CONNECTION_ATTRIBUTES>()
                {
                    let attributes = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
                    let ssid = &attributes.wlanAssociationAttributes.dot11Ssid;
                    let bytes = &ssid.ucSSID[..(ssid.uSSIDLength as usize).min(32)];
                    result = match std::str::from_utf8(bytes) {
                        Ok(value) => Field::available(value.into()),
                        Err(_) => Field::absent(
                            Availability::Unavailable,
                            "SSID 不是 UTF-8 名称，无法安全匹配。",
                        ),
                    };
                } else {
                    result = win_field(code);
                }
                if !data.is_null() {
                    WlanFreeMemory(data);
                }
                break;
            }
            WlanFreeMemory(list.cast());
        }
        WlanCloseHandle(handle, None);
        result
    }
}
pub fn power() -> (Field<String>, Field<u8>) {
    unsafe {
        let mut value = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut value).is_err() {
            return (win_field(1), win_field(1));
        }
        let source = match value.ACLineStatus {
            0 => Field::available("battery".into()),
            1 => Field::available("ac".into()),
            _ => Field::absent(Availability::Unavailable, "系统未提供电源来源。"),
        };
        let battery = if value.BatteryFlag & 128 != 0 {
            Field::absent(Availability::Unsupported, "此设备没有电池。")
        } else if value.BatteryLifePercent <= 100 {
            Field::available(value.BatteryLifePercent)
        } else {
            Field::absent(Availability::Unavailable, "系统未提供电池百分比。")
        };
        (source, battery)
    }
}
struct DisplayResult {
    values: Vec<Display>,
    failed: bool,
}
unsafe extern "system" fn monitor_callback(
    monitor: HMONITOR,
    _: HDC,
    _: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let out = &mut *(data.0 as *mut DisplayResult);
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    let mut x = 0;
    let mut y = 0;
    if !GetMonitorInfoW(monitor, &mut info.monitorInfo).as_bool()
        || GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut x, &mut y).is_err()
    {
        out.failed = true;
        return BOOL(1);
    }
    let rect = info.monitorInfo.rcMonitor;
    let name = String::from_utf16_lossy(
        &info.szDevice[..info
            .szDevice
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(info.szDevice.len())],
    );
    out.values.push(Display {
        id: name,
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        primary: info.monitorInfo.dwFlags & 1 != 0,
        scale: f64::from(x) / 96.0,
    });
    BOOL(1)
}
pub fn displays() -> Field<Vec<Display>> {
    unsafe {
        let old = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let mut result = DisplayResult {
            values: vec![],
            failed: false,
        };
        let ok = EnumDisplayMonitors(
            None,
            None,
            Some(monitor_callback),
            LPARAM(&mut result as *mut _ as isize),
        )
        .as_bool();
        if !old.0.is_null() {
            SetThreadDpiAwarenessContext(old);
        }
        if !ok || result.failed {
            return win_field(1);
        }
        result.values.sort_by(|a, b| a.id.cmp(&b.id));
        Field::available(result.values)
    }
}
fn normalized(path: &str) -> Result<String> {
    Ok(std::fs::canonicalize(path)
        .map_err(|_| AppError::new("process", "无法读取所配置程序路径。"))?
        .to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .to_lowercase())
}
pub fn processes(tasks: &[(String, String)]) -> BTreeMap<String, ProcessState> {
    let mut result = BTreeMap::new();
    let mut targets = vec![];
    for (id, path) in tasks {
        let field = match normalized(path) {
            Ok(p) => {
                targets.push((
                    id.clone(),
                    p,
                    Path::new(path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_lowercase(),
                ));
                Field::available(false)
            }
            Err(e) => Field::absent(Availability::Error, e.message),
        };
        result.insert(
            id.clone(),
            ProcessState {
                running: field,
                window: Field::absent(Availability::Unavailable, "窗口尚未查询。"),
            },
        );
    }
    unsafe {
        if let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut has = Process32FirstW(snapshot, &mut entry).is_ok();
            while has {
                let basename = String::from_utf16_lossy(
                    &entry.szExeFile[..entry
                        .szExeFile
                        .iter()
                        .position(|v| *v == 0)
                        .unwrap_or(entry.szExeFile.len())],
                )
                .to_lowercase();
                let relevant: Vec<_> = targets
                    .iter()
                    .filter(|(_, _, name)| *name == basename)
                    .collect();
                if !relevant.is_empty() {
                    let image = if let Ok(handle) = OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION,
                        false,
                        entry.th32ProcessID,
                    ) {
                        let mut buffer = vec![0u16; 32768];
                        let mut len = buffer.len() as u32;
                        let ok = QueryFullProcessImageNameW(
                            handle,
                            PROCESS_NAME_WIN32,
                            windows::core::PWSTR(buffer.as_mut_ptr()),
                            &mut len,
                        )
                        .is_ok();
                        let _ = CloseHandle(handle);
                        if ok {
                            Some(
                                String::from_utf16_lossy(&buffer[..len as usize])
                                    .trim_start_matches("\\\\?\\")
                                    .to_lowercase(),
                            )
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    for (id, path, _) in relevant {
                        if let Some(state) = result.get_mut(id) {
                            if image.as_ref() == Some(path) {
                                state.running = Field::available(true);
                            } else if image.is_none() && state.running.value != Some(true) {
                                state.running = Field::absent(
                                    Availability::PermissionDenied,
                                    "同名进程无法查询完整路径，状态未知。",
                                );
                            }
                        }
                    }
                }
                has = Process32NextW(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
        } else {
            for state in result.values_mut() {
                state.running = win_field(1);
            }
        }
    }
    match crate::window_manager::inventory() {
        Ok(inventory) => {
            for (id, path, _) in targets {
                if let Some(s) = result.get_mut(&id) {
                    s.window = if inventory.windows.iter().any(|w| {
                        w.executable_path
                            .trim_start_matches("\\\\?\\")
                            .to_lowercase()
                            == path
                    }) {
                        Field::available(true)
                    } else if s.running.status == Availability::Available {
                        Field::available(false)
                    } else {
                        Field::absent(s.running.status, s.running.reason.clone())
                    };
                }
            }
        }
        Err(e) => {
            for state in result.values_mut() {
                state.window = Field::absent(Availability::Error, e.message.clone());
            }
        }
    }
    result
}
pub fn seal(value: &str) -> Result<String> {
    use base64::Engine;
    unsafe {
        let mut bytes = value.as_bytes().to_vec();
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_mut_ptr(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| AppError::new("privacy", "无法保护本地网络配置。"))?;
        let encoded = base64::engine::general_purpose::STANDARD.encode(std::slice::from_raw_parts(
            output.pbData,
            output.cbData as usize,
        ));
        LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(encoded)
    }
}
pub fn unseal(value: &str) -> Result<String> {
    use base64::Engine;
    unsafe {
        let mut bytes = base64::engine::general_purpose::STANDARD
            .decode(value)
            .map_err(|_| AppError::new("privacy", "受保护配置无效。"))?;
        let input = CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_mut_ptr(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| AppError::new("privacy", "配置属于其他 Windows 用户或设备，请重新输入。"))?;
        let decoded = String::from_utf8(
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec(),
        );
        LocalFree(Some(HLOCAL(output.pbData.cast())));
        decoded.map_err(|_| AppError::new("privacy", "配置编码无效。"))
    }
}
