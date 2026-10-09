use crate::{
    accounts::models::{Account, AccountKind},
    error::{AppError, Result},
    models::validate_id,
};
use serde::{Deserialize, Serialize};
// Metadata only: neither IPC responses nor persisted models contain password values.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Locator {
    pub automation_id: String,
    pub control_type: i32,
    pub name: String,
    pub ancestor_id: String,
}
impl Locator {
    pub fn validate(&self) -> Result<()> {
        for s in [&self.automation_id, &self.name, &self.ancestor_id] {
            label(s, 200)?;
        }
        if !(50000..=50040).contains(&self.control_type)
            || (self.automation_id.is_empty() && self.name.is_empty())
            || (self.control_type == 50004
                && (self.automation_id.is_empty() || !self.name.is_empty()))
        {
            return Err(AppError::new(
                "invalid_locator",
                "输入框必须有稳定 AutomationId；控件定位规则无效。",
            ));
        }
        Ok(())
    }
}
fn label(s: &str, max: usize) -> Result<()> {
    if s.len() > max || s.chars().any(char::is_control) {
        return Err(AppError::new(
            "desktop_config",
            "定位字段过长或含控制字符。",
        ));
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub id: String,
    pub account_id: String,
    pub credential_ref: String,
    pub schema_version: u32,
    pub name: String,
    pub executable_path: String,
    pub window_class: String,
    pub window_title: String,
    pub username: Locator,
    pub password: Locator,
    pub submit: Locator,
    pub success: Locator,
    pub identity: Locator,
    pub failure: Option<Locator>,
    pub challenge: Option<Locator>,
    pub timeout_seconds: u32,
}
impl Config {
    pub fn validate(&self, a: &Account) -> Result<()> {
        for s in [&self.id, &self.account_id, &self.credential_ref] {
            validate_id(s)?;
        }
        label(&self.name, 120)?;
        label(&self.window_class, 200)?;
        label(&self.window_title, 200)?;
        if self.name.trim().is_empty()
            || self.window_class.is_empty()
            || self.window_title.is_empty()
            || self.schema_version != 1
            || !(3..=120).contains(&self.timeout_seconds)
            || a.kind != AccountKind::App
            || a.id != self.account_id
            || a.credential_ref != self.credential_ref
            || !same_path(&a.target, &self.executable_path)
            || !self.executable_path.to_ascii_lowercase().ends_with(".exe")
        {
            return Err(AppError::new("desktop_config","请选择绑定此完整 EXE 路径的应用账号、明确窗口及有效超时。快捷方式请先绑定实际 EXE。"));
        }
        crate::models::validate_path(&self.executable_path)?;
        for l in [
            &self.username,
            &self.password,
            &self.submit,
            &self.success,
            &self.identity,
        ]
        .into_iter()
        .chain(self.failure.iter())
        .chain(self.challenge.iter())
        {
            l.validate()?;
        }
        if self.username.control_type != 50004
            || self.password.control_type != 50004
            || self.submit.control_type != 50000
            || self.identity.control_type != 50020
            || self.username == self.password
            || self.success == self.submit
            || self.success == self.username
            || self.success == self.password
        {
            return Err(AppError::new("invalid_locator","账号/密码须为不同输入框，登录须为按钮，身份须为显示用户名的文本；成功控件不能是登录表单。"));
        }
        Ok(())
    }
}
pub fn same_path(a: &str, b: &str) -> bool {
    a.trim_start_matches("\\\\?\\")
        .eq_ignore_ascii_case(b.trim_start_matches("\\\\?\\"))
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Window {
    pub handle: i64,
    pub pid: u32,
    pub creation_time: String,
    pub executable_path: String,
    pub title: String,
    pub class_name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Control {
    pub locator: Locator,
    pub is_password: bool,
    pub enabled: bool,
    pub visible: bool,
    pub value_supported: bool,
    pub invoke_supported: bool,
    pub read_only: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub username: String,
    pub credential_ref: String,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Windows {
        executable_path: String,
    },
    Inspect {
        window: Window,
    },
    Test {
        window: Window,
        config: Box<Config>,
    },
    Login {
        window: Window,
        config: Box<Config>,
        binding: Binding,
        authorized: bool,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Response {
    pub status: String,
    pub message: String,
    pub windows: Vec<Window>,
    pub controls: Vec<Control>,
    pub submitted: bool,
}
impl Response {
    pub fn status(s: &str, m: &str) -> Self {
        Self {
            status: s.into(),
            message: m.into(),
            windows: vec![],
            controls: vec![],
            submitted: false,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Run {
    pub id: String,
    pub config_id: String,
    pub account_id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub result: Response,
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edit_names_cannot_capture_values() {
        let mut l = Locator {
            automation_id: "user".into(),
            control_type: 50004,
            name: String::new(),
            ancestor_id: String::new(),
        };
        assert!(l.validate().is_ok());
        l.name = "secret".into();
        assert!(l.validate().is_err());
        l.name.clear();
        l.automation_id.clear();
        assert!(l.validate().is_err());
    }
    #[test]
    fn unknown_secret_fields_rejected() {
        assert!(serde_json::from_str::<Locator>(r#"{"automation_id":"x","control_type":50004,"name":"","ancestor_id":"","password":"s"}"#).is_err());
        assert!(serde_json::from_str::<Request>(
            r#"{"operation":"windows","executable_path":"C:\\x.exe","password":"s"}"#
        )
        .is_err());
    }
    #[test]
    fn config_is_bound_to_app_path_and_credential_and_forbids_form_success() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("App.exe").to_string_lossy().to_string();
        let a = Account {
            id: uuid::Uuid::new_v4().to_string(),
            name: "app".into(),
            username: "user".into(),
            kind: AccountKind::App,
            target: path.clone(),
            credential_ref: uuid::Uuid::new_v4().to_string(),
            created_at: "now".into(),
            updated_at: "now".into(),
            revision: 1,
        };
        let l = |id: &str, t| Locator {
            automation_id: id.into(),
            control_type: t,
            name: String::new(),
            ancestor_id: String::new(),
        };
        let c = Config {
            id: uuid::Uuid::new_v4().to_string(),
            account_id: a.id.clone(),
            credential_ref: a.credential_ref.clone(),
            schema_version: 1,
            name: "app login".into(),
            executable_path: path,
            window_class: "class".into(),
            window_title: "title".into(),
            username: l("user", 50004),
            password: l("password", 50004),
            submit: l("button", 50000),
            success: l("done", 50020),
            identity: l("identity", 50020),
            failure: None,
            challenge: None,
            timeout_seconds: 30,
        };
        assert!(c.validate(&a).is_ok());
        let mut wrong = c.clone();
        wrong.credential_ref = uuid::Uuid::new_v4().to_string();
        assert!(wrong.validate(&a).is_err());
        wrong = c.clone();
        wrong.executable_path.push_str(".exe");
        assert!(wrong.validate(&a).is_err());
        wrong = c.clone();
        wrong.success = wrong.submit.clone();
        assert!(wrong.validate(&a).is_err());
        wrong = c.clone();
        wrong.username = wrong.password.clone();
        assert!(wrong.validate(&a).is_err());
        wrong = c.clone();
        wrong.timeout_seconds = 121;
        assert!(wrong.validate(&a).is_err());
        wrong = c.clone();
        wrong.schema_version = 2;
        assert!(wrong.validate(&a).is_err());
        let mut a = a;
        a.kind = AccountKind::Web;
        assert!(c.validate(&a).is_err());
    }
}
