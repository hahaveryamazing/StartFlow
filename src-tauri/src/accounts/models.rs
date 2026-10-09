use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;
// Intentionally no Serialize, Debug or Clone: a write-only IPC secret.
#[derive(Deserialize)]
#[serde(transparent)]
pub struct Secret(Zeroizing<String>);
impl Secret {
    pub(crate) fn value(&self) -> &str {
        &self.0
    }
    pub(crate) fn validate(&self) -> Result<()> {
        if self.0.is_empty() || self.0.len() > 2560 || self.0.contains('\0') {
            return Err(AppError::new(
                "credential",
                "密码不能为空，且 UTF-8 长度不能超过 2560 字节或包含空字符。",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    Web,
    App,
}
impl AccountKind {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Web => "web",
            Self::App => "app",
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub username: String,
    pub kind: AccountKind,
    pub target: String,
    pub credential_ref: String,
    pub created_at: String,
    pub updated_at: String,
    pub revision: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteAccount {
    pub id: Option<String>,
    pub name: String,
    pub username: String,
    pub kind: AccountKind,
    pub target: String,
    pub password: Option<Secret>,
    // Optimistic edit token prevents a stale dialog from overwriting another update.
    pub expected_revision: Option<i64>,
}
impl WriteAccount {
    pub fn validate(&mut self) -> Result<()> {
        if let Some(id) = &self.id {
            crate::models::validate_id(id)?;
        }
        self.name = self.name.trim().to_owned();
        self.username = self.username.trim().to_owned();
        for (value, max) in [(&self.name, 120), (&self.username, 320)] {
            if value.is_empty()
                || value.chars().count() > max
                || value.chars().any(char::is_control)
            {
                return Err(AppError::new("account", "请填写有效的账号名称和用户名。"));
            }
        }
        if let Some(password) = &self.password {
            password.validate()?;
        }
        self.target = self.target.trim().to_owned();
        if self.target.len() > 4096 || self.target.chars().any(char::is_control) {
            return Err(AppError::new("account", "关联目标过长或包含无效字符。"));
        }
        match self.kind {
            AccountKind::Web => {
                let u = url::Url::parse(&self.target).map_err(|_| {
                    AppError::new("account", "请输入完整的 http 或 https 网站地址。")
                })?;
                if !["http", "https"].contains(&u.scheme())
                    || u.host_str().is_none()
                    || !u.username().is_empty()
                    || u.password().is_some()
                    || u.query().is_some()
                    || u.fragment().is_some()
                {
                    return Err(AppError::new(
                        "account",
                        "网站地址不能包含账号密码、查询参数或片段。",
                    ));
                }
                self.target = u.origin().ascii_serialization();
            }
            AccountKind::App => {
                crate::models::validate_path(&self.target)?;
                let ext = std::path::Path::new(&self.target)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                if !ext.eq_ignore_ascii_case("exe") && !ext.eq_ignore_ascii_case("lnk") {
                    return Err(AppError::new("account", "应用目标请选择 EXE 或 LNK 文件。"));
                }
            }
        }
        Ok(())
    }
}
#[derive(Serialize)]
pub struct AccountView {
    #[serde(flatten)]
    pub account: Account,
    pub credential_state: String,
}
#[derive(Serialize)]
pub struct AccountList {
    pub accounts: Vec<AccountView>,
    pub pending_cleanup: usize,
}
#[derive(Serialize)]
pub struct Mutation {
    pub account: Option<AccountView>,
    pub pending_cleanup: usize,
}
