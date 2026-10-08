use serde::Serialize;
#[derive(Debug, Serialize, Clone)]
pub struct AppError {
    pub code: String,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, AppError>;
impl AppError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn internal(e: impl std::fmt::Display) -> Self {
        eprintln!("StartFlow: {e}");
        Self::new(
            "storage",
            "本地数据操作失败，请检查磁盘空间和数据目录权限。",
        )
    }
}
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for AppError {}
impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        Self::internal(e)
    }
}
impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        eprintln!("StartFlow JSON: {e}");
        Self::new("format", "配置文件格式错误或版本不兼容。")
    }
}
