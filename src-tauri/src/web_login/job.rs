use crate::error::{AppError, Result};
#[cfg(windows)]
pub struct Job(isize);
#[cfg(windows)]
impl Job {
    pub fn attach(pid: u32) -> Result<Self> {
        use windows::Win32::{
            Foundation::CloseHandle,
            System::{JobObjects::*, Threading::*},
        };
        unsafe {
            let h = CreateJobObjectW(None, None)
                .map_err(|_| AppError::new("login", "无法建立浏览器进程隔离。"))?;
            let job = Self(h.0 as isize);
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
            )
            .map_err(|_| AppError::new("login", "无法设置浏览器退出清理。"))?;
            let p = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                .map_err(|_| AppError::new("login", "无法管理浏览器进程。"))?;
            let result = AssignProcessToJobObject(h, p);
            let _ = CloseHandle(p);
            result.map_err(|_| AppError::new("login", "无法绑定浏览器进程隔离。"))?;
            Ok(job)
        }
    }
    pub fn terminate(&self) {
        unsafe {
            let _ = windows::Win32::System::JobObjects::TerminateJobObject(
                windows::Win32::Foundation::HANDLE(self.0 as *mut std::ffi::c_void),
                1,
            );
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                self.0 as *mut std::ffi::c_void,
            ));
        }
    }
}
#[cfg(not(windows))]
pub struct Job;
#[cfg(not(windows))]
impl Job {
    pub fn attach(_: u32) -> Result<Self> {
        Err(AppError::new(
            "login",
            "当前环境不支持 Windows 浏览器进程管理。",
        ))
    }
    pub fn terminate(&self) {}
}
