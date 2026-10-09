use crate::error::{AppError, Result};
#[cfg(windows)]
mod platform {
    use super::*;
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::Security::Credentials::*,
    };
    fn target(id: &str) -> Result<Vec<u16>> {
        crate::models::validate_id(id)?;
        Ok(format!("StartFlow.V3.AI.{id}")
            .encode_utf16()
            .chain([0])
            .collect())
    }
    pub fn set(id: &str, key: &str) -> Result<()> {
        if key.is_empty() || key.len() > 4096 || key.contains('\0') {
            return Err(AppError::new("credential", "凭据长度无效。"));
        }
        let mut name = target(id)?;
        let mut bytes = key.as_bytes().to_vec();
        let credential = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(name.as_mut_ptr()),
            CredentialBlobSize: bytes.len() as u32,
            CredentialBlob: bytes.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        unsafe {
            CredWriteW(&credential, 0)
                .map_err(|_| AppError::new("credential", "Windows 凭据管理器保存失败。"))
        }
    }
    pub fn get(id: &str) -> Result<Option<String>> {
        let name = target(id)?;
        let mut pointer = std::ptr::null_mut();
        unsafe {
            match CredReadW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None, &mut pointer) {
                Ok(()) => {
                    if pointer.is_null() {
                        return Err(AppError::new("credential", "Windows 凭据读取失败。"));
                    }
                    let credential = &*pointer;
                    if credential.CredentialBlob.is_null()
                        || credential.CredentialBlobSize == 0
                        || credential.CredentialBlobSize > 4096
                    {
                        CredFree(pointer.cast());
                        return Err(AppError::new("credential", "凭据格式无效，请重新填写。"));
                    }
                    let bytes = std::slice::from_raw_parts(
                        credential.CredentialBlob,
                        credential.CredentialBlobSize as usize,
                    )
                    .to_vec();
                    CredFree(pointer.cast());
                    let value = String::from_utf8(bytes)
                        .map_err(|_| AppError::new("credential", "凭据格式无效，请重新填写。"))?;
                    Ok(Some(value))
                }
                Err(error) if error.code().0 as u32 == 0x80070490 => Ok(None),
                Err(_) => Err(AppError::new("credential", "无法访问 Windows 凭据管理器。")),
            }
        }
    }
    pub fn delete(id: &str) -> Result<()> {
        let name = target(id)?;
        unsafe {
            match CredDeleteW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None) {
                Ok(()) => Ok(()),
                Err(error) if error.code().0 as u32 == 0x80070490 => Ok(()),
                Err(_) => Err(AppError::new("credential", "Windows 凭据删除失败。")),
            }
        }
    }
}
#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn set(_: &str, _: &str) -> Result<()> {
        Err(AppError::new(
            "credential",
            "此环境不支持 Windows 凭据保护。",
        ))
    }
    pub fn get(_: &str) -> Result<Option<String>> {
        Ok(None)
    }
    pub fn delete(_: &str) -> Result<()> {
        Ok(())
    }
}
pub use platform::{delete, get, set};
