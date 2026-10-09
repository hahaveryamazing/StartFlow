use crate::{
    accounts::models::{Account, AccountKind},
    error::{AppError, Result},
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum LocatorRule {
    Css { value: String },
    Role { role: String, name: String },
    Label { value: String },
    Placeholder { value: String },
    TestId { value: String },
}
impl LocatorRule {
    pub fn validate(&self) -> Result<()> {
        let value = match self {
            Self::Role { role, name } => {
                if !["textbox", "button", "link", "heading", "status"].contains(&role.as_str()) {
                    return Err(AppError::new("locator", "定位角色不受支持。"));
                }
                name
            }
            Self::Css { value } => {
                if value.contains(">>")
                    || value.starts_with("xpath=")
                    || value.starts_with("text=")
                    || value.starts_with("javascript=")
                    || value.starts_with("//")
                {
                    return Err(AppError::new(
                        "locator",
                        "只允许单页面 CSS 或类型化定位，不支持脚本。",
                    ));
                }
                value
            }
            Self::Label { value } | Self::Placeholder { value } | Self::TestId { value } => value,
        };
        if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
            return Err(AppError::new(
                "locator",
                "定位内容不能为空，每项最多 256 字节。",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LocatorSet {
    pub username: LocatorRule,
    pub password: LocatorRule,
    pub submit: LocatorRule,
    pub success: LocatorRule,
    pub identity: LocatorRule,
    pub challenge: LocatorRule,
    pub failure: LocatorRule,
}
fn schema_one() -> u32 {
    1
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LoginConfig {
    pub id: String,
    pub account_id: String,
    pub name: String,
    pub origin: String,
    pub login_url: String,
    pub form_action_url: String,
    pub username_selector: String,
    pub password_selector: String,
    pub submit_selector: String,
    pub success_selector: String,
    pub identity_selector: String,
    pub challenge_selector: String,
    pub failure_selector: String,
    pub timeout_seconds: u32,
    #[serde(default = "schema_one")]
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locators: Option<LocatorSet>,
}
pub fn secure_url(value: &str) -> Result<url::Url> {
    let u =
        url::Url::parse(value).map_err(|_| AppError::new("login", "请输入完整的 HTTPS 地址。"))?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || value.len() > 2048
        || value.chars().any(char::is_control)
    {
        return Err(AppError::new(
            "login",
            "登录地址必须为 HTTPS，不能包含凭据、查询参数或片段。",
        ));
    }
    Ok(u)
}
impl LoginConfig {
    pub fn validate(&self, account: &Account) -> Result<()> {
        crate::models::validate_id(&self.id)?;
        crate::models::validate_id(&self.account_id)?;
        if ![1, 2].contains(&self.schema_version)
            || (self.schema_version == 2
                && (self.locators.is_none()
                    || self.credential_ref.as_deref() != Some(account.credential_ref.as_str())))
        {
            return Err(AppError::new(
                "locator",
                "录制配置版本或凭据绑定已变化，请重新选择账号并保存。",
            ));
        }
        if let Some(reference) = &self.credential_ref {
            crate::models::validate_id(reference)?;
            if reference != &account.credential_ref {
                return Err(AppError::new(
                    "locator",
                    "凭据绑定已更新，请重新保存登录配置。",
                ));
            }
        }
        if let Some(rules) = &self.locators {
            for rule in [
                &rules.username,
                &rules.password,
                &rules.submit,
                &rules.success,
                &rules.identity,
                &rules.challenge,
                &rules.failure,
            ] {
                rule.validate()?;
            }
            if rules.username == rules.password || rules.success == rules.failure {
                return Err(AppError::new("locator", "输入框或结果定位不能重复。"));
            }
        }
        if self.account_id != account.id
            || account.kind != AccountKind::Web
            || self.origin != account.target
            || secure_url(&self.origin)?.origin().ascii_serialization() != self.origin
        {
            return Err(AppError::new(
                "login",
                "仅允许绑定网页账号的精确 HTTPS 网站根地址。",
            ));
        }
        for address in [&self.login_url, &self.form_action_url] {
            if secure_url(address)?.origin().ascii_serialization() != self.origin {
                return Err(AppError::new(
                    "login",
                    "登录页和表单提交目标必须属于已绑定的网站。",
                ));
            }
        }
        if self.name.trim().is_empty()
            || self.name.len() > 240
            || self.name.chars().any(char::is_control)
            || !(3..=120).contains(&self.timeout_seconds)
        {
            return Err(AppError::new(
                "login",
                "名称或登录超时设置无效（3～120 秒）。",
            ));
        }
        let selectors = [
            &self.username_selector,
            &self.password_selector,
            &self.submit_selector,
            &self.success_selector,
            &self.identity_selector,
            &self.challenge_selector,
            &self.failure_selector,
        ];
        if selectors.iter().any(|s| {
            s.trim().is_empty()
                || s.len() > 512
                || s.chars().any(char::is_control)
                || s.contains(">>")
                || s.starts_with("xpath=")
                || s.starts_with("text=")
        }) {
            return Err(AppError::new(
                "login",
                "请输入有效的 CSS 选择器，每项最多 512 字节，不支持脚本或跨帧定位。",
            ));
        }
        if self.username_selector == self.password_selector
            || self.success_selector == self.failure_selector
        {
            return Err(AppError::new("login", "输入框或结果选择器不能重复。"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    CheckingSession,
    LoggingIn,
    Authenticated,
    SessionReused,
    SessionExpired,
    WaitingManual,
    Failed,
    Timeout,
    Blocked,
    AuthorizationRequired,
    Cooldown,
    Closed,
    Interrupted,
    LocatorInvalid,
}
impl Status {
    pub fn message(&self) -> &'static str {
        match self {
            Self::CheckingSession => "正在验证网站和已有会话。",
            Self::LoggingIn => "页面身份已验证，正在提交一次登录。",
            Self::Authenticated => "已验证登录状态及账号身份。",
            Self::SessionReused => "已验证并复用有效会话，未读取密码。",
            Self::SessionExpired => "会话已过期；不会自动再次提交密码。",
            Self::WaitingManual => {
                "需要在专用浏览器完成验证码、扫码、MFA 或 Passkey；自动提交已停止。"
            }
            Self::Failed => "网站显示登录失败；不会重试密码。",
            Self::Timeout => "未能在限定时间确认登录成功；不会重试密码。",
            Self::Blocked => "页面、表单、请求来源或运行时验证不通过，已阻止登录。",
            Self::AuthorizationRequired => "未授权使用密码，只检查了会话。",
            Self::Cooldown => "最近已授权一次填密，五分钟内不自动再次提交。",
            Self::Closed => "专用浏览器已关闭。",
            Self::Interrupted => "登录因程序退出或运行时中断而停止。",
            Self::LocatorInvalid => "页面结构已变化或定位匹配不唯一，请测试定位或重新录制。",
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct LoginRun {
    pub id: String,
    pub config_id: String,
    pub account_id: String,
    pub status: Status,
    pub submitted: bool,
    pub started_at: String,
    pub updated_at: String,
    pub message: String,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkerEvent {
    Heartbeat {},
    NeedPassword { nonce: String },
    Status { status: Status, submitted: bool },
    Closed {},
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (LoginConfig, Account) {
        let a = Account {
            id: crate::models::id(),
            name: "test".into(),
            username: "test".into(),
            kind: AccountKind::Web,
            target: "https://example.test".into(),
            credential_ref: crate::models::id(),
            created_at: "x".into(),
            updated_at: "x".into(),
            revision: 1,
        };
        let c = LoginConfig {
            id: crate::models::id(),
            account_id: a.id.clone(),
            name: "test".into(),
            origin: a.target.clone(),
            login_url: format!("{}/login", a.target),
            form_action_url: format!("{}/session", a.target),
            username_selector: "#user".into(),
            password_selector: "#pass".into(),
            submit_selector: "#submit".into(),
            success_selector: "#success".into(),
            identity_selector: "#identity".into(),
            challenge_selector: "[data-challenge]".into(),
            failure_selector: "#failure".into(),
            timeout_seconds: 15,
            schema_version: 1,
            credential_ref: None,
            locators: None,
        };
        (c, a)
    }
    #[test]
    fn config_requires_exact_https_binding() {
        let (mut c, a) = fixture();
        assert!(c.validate(&a).is_ok());
        for v in [
            "http://example.test/login",
            "https://evil.test/login",
            "https://x:secret@example.test/login",
            "https://example.test/login?token=x",
        ] {
            c.login_url = v.into();
            assert!(c.validate(&a).is_err());
        }
    }
    #[test]
    fn config_rejects_secret_or_profile_fields_and_script_selectors() {
        let (mut c, a) = fixture();
        let mut j = serde_json::to_value(&c).unwrap();
        j["password"] = serde_json::json!("secret");
        assert!(serde_json::from_value::<LoginConfig>(j).is_err());
        c.password_selector = "xpath=//input".into();
        assert!(c.validate(&a).is_err());
    }
    #[test]
    fn protocol_never_accepts_arbitrary_password_or_message_response() {
        assert!(serde_json::from_str::<WorkerEvent>(
            r#"{"type":"status","status":"authenticated","submitted":false,"password":"bad"}"#
        )
        .is_err());
        for json in [
            r#"{"type":"heartbeat","password":"bad"}"#,
            r#"{"type":"closed","cookie":"bad"}"#,
        ] {
            assert!(serde_json::from_str::<WorkerEvent>(json).is_err());
        }
    }
    #[test]
    fn legacy_payload_and_recorded_schema_coexist_without_rewriting_old_data() {
        let (mut config, account) = fixture();
        let mut json = serde_json::to_value(&config).unwrap();
        json.as_object_mut().unwrap().remove("schema_version");
        let old_payload = serde_json::to_string(&json).unwrap();
        let old: LoginConfig = serde_json::from_str(&old_payload).unwrap();
        assert_eq!(old.schema_version, 1);
        old.validate(&account).unwrap();
        let css = |value: &str| LocatorRule::Css {
            value: value.into(),
        };
        config.id = crate::models::id();
        config.schema_version = 2;
        config.credential_ref = Some(account.credential_ref.clone());
        config.locators = Some(LocatorSet {
            username: css("#u"),
            password: css("#p"),
            submit: css("#b"),
            success: css("#s"),
            identity: css("#i"),
            challenge: css("#c"),
            failure: css("#f"),
        });
        config.validate(&account).unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE web_login_configs(id TEXT PRIMARY KEY,account_id TEXT,payload TEXT)",
        )
        .unwrap();
        db.execute(
            "INSERT INTO web_login_configs VALUES(?1,?2,?3)",
            rusqlite::params![old.id, old.account_id, old_payload],
        )
        .unwrap();
        super::super::repository::save(&db, &config).unwrap();
        assert_eq!(super::super::repository::configs(&db).unwrap().len(), 2);
        let retained: String = db
            .query_row(
                "SELECT payload FROM web_login_configs WHERE id=?1",
                [&old.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(retained, old_payload);
        config.credential_ref = Some(crate::models::id());
        assert!(config.validate(&account).is_err());
    }
    #[test]
    fn typed_locators_reject_unknown_commands_and_schema_versions() {
        for json in [
            r#"{"kind":"role","role":"document","name":"x"}"#,
            r#"{"kind":"css","value":"xpath=//input"}"#,
        ] {
            let rule: LocatorRule = serde_json::from_str(json).unwrap();
            assert!(rule.validate().is_err());
        }
        assert!(serde_json::from_str::<LocatorRule>(
            r#"{"kind":"css","value":"input","password":"bad"}"#
        )
        .is_err());
        let (mut config, account) = fixture();
        config.schema_version = 3;
        assert!(config.validate(&account).is_err());
    }
}
