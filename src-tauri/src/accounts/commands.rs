use super::{
    models::*,
    repository, service,
    vault::{Vault, WindowsVault},
    Accounts,
};
use crate::{
    database::Db,
    error::{AppError, Result},
};
use tauri::Manager;
fn authorize(window: &tauri::WebviewWindow) -> Result<()> {
    if window.label() != "main" {
        return Err(AppError::new(
            "permission",
            "账号管理仅允许在 StartFlow 主窗口操作。",
        ));
    }
    let url = window
        .url()
        .map_err(|_| AppError::new("permission", "无法验证当前窗口来源。"))?;
    if !trusted_origin(&url) {
        return Err(AppError::new(
            "permission",
            "不允许从远程页面访问账号管理。",
        ));
    }
    Ok(())
}
fn trusted_origin(url: &url::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let local =
        url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none()
            || url.origin().ascii_serialization() == "http://tauri.localhost";
    #[cfg(debug_assertions)]
    let local = local
        || url.scheme() == "http"
            && url.host_str() == Some("127.0.0.1")
            && url.port() == Some(1420);
    local
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credential_origin_is_exact_and_never_trusts_external_pages() {
        for value in [
            "https://example.test",
            "http://tauri.localhost:9999",
            "http://tauri.localhost.evil.test",
            "http://user@tauri.localhost",
            "tauri://localhost:1234",
            "http://127.0.0.1:9999",
        ] {
            assert!(!trusted_origin(&url::Url::parse(value).unwrap()));
        }
        for value in ["http://tauri.localhost/", "tauri://localhost/"] {
            assert!(trusted_origin(&url::Url::parse(value).unwrap()));
        }
    }
}
#[tauri::command]
pub async fn accounts_list(window: tauri::WebviewWindow) -> Result<AccountList> {
    authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let g = db.lock()?;
        service::list(&g.conn, &WindowsVault)
    })
    .await
    .map_err(|_| AppError::new("account", "账号服务暂时不可用。"))?
}
#[tauri::command]
pub async fn accounts_save(
    window: tauri::WebviewWindow,
    request: WriteAccount,
) -> Result<Mutation> {
    authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Accounts>();
        let _gate = state
            .0
            .lock()
            .map_err(|_| AppError::new("account", "账号服务暂时不可用。"))?;
        let db = app.state::<Db>();
        let mut g = db.lock()?;
        service::save(&mut g.conn, &WindowsVault, request)
    })
    .await
    .map_err(|_| AppError::new("account", "账号保存未完成，请刷新检查状态。"))?
}
#[tauri::command]
pub async fn accounts_delete(
    window: tauri::WebviewWindow,
    id: String,
    expected_revision: i64,
) -> Result<Mutation> {
    authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Accounts>();
        let _gate = state
            .0
            .lock()
            .map_err(|_| AppError::new("account", "账号服务暂时不可用。"))?;
        let db = app.state::<Db>();
        let mut g = db.lock()?;
        service::delete(&mut g.conn, &WindowsVault, &id, expected_revision)
    })
    .await
    .map_err(|_| AppError::new("account", "账号删除未完成，请刷新检查状态。"))?
}
#[tauri::command]
pub async fn accounts_exists(window: tauri::WebviewWindow, id: String) -> Result<bool> {
    authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let g = db.lock()?;
        let a = repository::find(&g.conn, &id)?;
        WindowsVault.exists(&a.credential_ref)
    })
    .await
    .map_err(|_| AppError::new("account", "凭据检查未完成。"))?
}
#[tauri::command]
pub async fn accounts_retry_cleanup(window: tauri::WebviewWindow) -> Result<usize> {
    authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Accounts>();
        let _gate = state
            .0
            .lock()
            .map_err(|_| AppError::new("account", "账号服务暂时不可用。"))?;
        let db = app.state::<Db>();
        let g = db.lock()?;
        service::cleanup(&g.conn, &WindowsVault)
    })
    .await
    .map_err(|_| AppError::new("account", "凭据清理未完成。"))?
}
pub fn recover(app: tauri::AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Accounts>();
        let Ok(_gate) = state.0.lock() else {
            return;
        };
        let db = app.state::<Db>();
        if let Ok(g) = db.lock() {
            let _ = service::cleanup(&g.conn, &WindowsVault);
        };
    });
}
