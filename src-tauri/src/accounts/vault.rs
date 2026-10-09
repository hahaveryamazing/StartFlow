use super::models::Secret;
use crate::error::{AppError, Result};
pub trait Vault {
    fn put(&self, reference: &str, username: &str, password: &Secret) -> Result<()>;
    fn exists(&self, reference: &str) -> Result<bool>;
    fn delete(&self, reference: &str) -> Result<()>;
}
pub struct WindowsVault;
#[cfg(windows)]
mod platform {
    use super::*;
    use windows::{
        core::{PCWSTR, PWSTR},
        Win32::Security::Credentials::*,
    };
    use zeroize::Zeroize;
    fn target(reference: &str) -> Result<Vec<u16>> {
        crate::models::validate_id(reference)?;
        Ok(format!("StartFlow.V3.1.Account.{reference}")
            .encode_utf16()
            .chain([0])
            .collect())
    }
    fn not_found(e: &windows::core::Error) -> bool {
        e.code().0 as u32 == 0x80070490
    }
    struct ReadCredential(*mut CREDENTIALW);
    impl Drop for ReadCredential {
        fn drop(&mut self) {
            unsafe {
                if !self.0.is_null() {
                    let c = &mut *self.0;
                    if !c.CredentialBlob.is_null()
                        && c.CredentialBlobSize <= CRED_MAX_CREDENTIAL_BLOB_SIZE
                    {
                        std::slice::from_raw_parts_mut(
                            c.CredentialBlob,
                            c.CredentialBlobSize as usize,
                        )
                        .zeroize();
                    }
                    CredFree(self.0.cast());
                }
            }
        }
    }
    impl Vault for WindowsVault {
        fn put(&self, reference: &str, _username: &str, password: &Secret) -> Result<()> {
            password.validate()?;
            let mut name = target(reference)?;
            let mut bytes = zeroize::Zeroizing::new(password.value().as_bytes().to_vec());
            let c = CREDENTIALW {
                Type: CRED_TYPE_GENERIC,
                TargetName: PWSTR(name.as_mut_ptr()),
                CredentialBlobSize: bytes.len() as u32,
                CredentialBlob: bytes.as_mut_ptr(),
                Persist: CRED_PERSIST_LOCAL_MACHINE,
                ..Default::default()
            };
            unsafe {
                CredWriteW(&c, 0).map_err(|_| {
                    AppError::new(
                        "credential",
                        "Windows 凭据管理器保存失败，原账号配置未更改。",
                    )
                })
            }
        }
        fn exists(&self, reference: &str) -> Result<bool> {
            let name = target(reference)?;
            let mut pointer = std::ptr::null_mut();
            unsafe {
                match CredReadW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None, &mut pointer) {
                    Ok(()) => {
                        let c = ReadCredential(pointer);
                        if c.0.is_null() {
                            return Err(AppError::new("credential", "Windows 凭据状态读取失败。"));
                        }
                        Ok(true)
                    }
                    Err(e) if not_found(&e) => Ok(false),
                    Err(_) => Err(AppError::new(
                        "credential",
                        "无法访问 Windows 凭据管理器，请检查当前用户会话。",
                    )),
                }
            }
        }
        fn delete(&self, reference: &str) -> Result<()> {
            let name = target(reference)?;
            unsafe {
                match CredDeleteW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None) {
                    Ok(()) => Ok(()),
                    Err(e) if not_found(&e) => Ok(()),
                    Err(_) => Err(AppError::new(
                        "credential",
                        "Windows 密码清理失败，请重试。",
                    )),
                }
            }
        }
    }
    #[cfg(test)]
    pub(super) fn matches(reference: &str, password: &str) -> Result<bool> {
        let name = target(reference)?;
        let mut pointer = std::ptr::null_mut();
        unsafe {
            CredReadW(PCWSTR(name.as_ptr()), CRED_TYPE_GENERIC, None, &mut pointer)
                .map_err(|_| AppError::new("test", "测试凭据读取失败。"))?;
            let c = ReadCredential(pointer);
            let c = &*c.0;
            Ok(
                std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize)
                    == password.as_bytes(),
            )
        }
    }
}
#[cfg(not(windows))]
impl Vault for WindowsVault {
    fn put(&self, _: &str, _: &str, _: &Secret) -> Result<()> {
        Err(AppError::new(
            "credential",
            "当前环境不支持 Windows 凭据管理器。",
        ))
    }
    fn exists(&self, _: &str) -> Result<bool> {
        Err(AppError::new(
            "credential",
            "当前环境不支持 Windows 凭据管理器。",
        ))
    }
    fn delete(&self, _: &str) -> Result<()> {
        Err(AppError::new(
            "credential",
            "当前环境不支持 Windows 凭据管理器。",
        ))
    }
}
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn actual_windows_credential_crud() {
        let reference = crate::models::id();
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = WindowsVault.delete(&self.0);
            }
        }
        let _cleanup = Cleanup(reference.clone());
        let password: Secret = serde_json::from_str("\"测试口令 first\"").unwrap();
        assert!(!WindowsVault.exists(&reference).unwrap());
        WindowsVault.put(&reference, "测试账号", &password).unwrap();
        assert!(WindowsVault.exists(&reference).unwrap());
        assert!(platform::matches(&reference, "测试口令 first").unwrap());
        let password: Secret = serde_json::from_str("\"updated test secret\"").unwrap();
        WindowsVault.put(&reference, "测试账号", &password).unwrap();
        assert!(platform::matches(&reference, "updated test secret").unwrap());
        WindowsVault.delete(&reference).unwrap();
        assert!(!WindowsVault.exists(&reference).unwrap());
        WindowsVault.delete(&reference).unwrap();
    }
}
