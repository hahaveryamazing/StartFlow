pub mod commands;
pub mod credentials;
pub mod provider;
use crate::{
    error::{AppError, Result},
    rules::models::Rule,
    workflow::models::Workflow,
};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub id: String,
    pub enabled: bool,
    pub provider_type: String,
    pub endpoint: String,
    pub model: String,
    pub history: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            id: "00000000-0000-4000-8000-0000000000a1".into(),
            enabled: false,
            provider_type: "local".into(),
            endpoint: String::new(),
            model: String::new(),
            history: false,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Configuration {
    Rule {
        rule: Option<Rule>,
        missing: Vec<String>,
        notes: Vec<String>,
    },
    Workflow {
        workflow: Option<Workflow>,
        missing: Vec<String>,
        notes: Vec<String>,
    },
    Explanation {
        explanation: String,
    },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Draft {
    pub schema_version: u32,
    pub id: String,
    pub created_at: String,
    pub configuration: Configuration,
    pub valid: bool,
    pub errors: Vec<String>,
    pub provider: String,
}
#[derive(Default)]
pub struct Assistant {
    pub previews: std::sync::Mutex<std::collections::HashMap<String, provider::Prepared>>,
}
pub fn settings(conn: &rusqlite::Connection) -> Result<Settings> {
    match conn.query_row(
        "SELECT value_json FROM settings WHERE key='ai_provider'",
        [],
        |r| r.get::<_, String>(0),
    ) {
        Ok(json) => Ok(serde_json::from_str(&json)?),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Settings::default()),
        Err(e) => Err(e.into()),
    }
}
pub fn validate_settings(s: &Settings) -> Result<()> {
    crate::models::validate_id(&s.id)?;
    if !["cloud", "local"].contains(&s.provider_type.as_str())
        || s.model.len() > 120
        || s.endpoint.len() > 2048
    {
        return Err(AppError::new("ai", "AI 服务配置无效。"));
    }
    if !s.enabled && s.endpoint.is_empty() {
        return Ok(());
    }
    let u = url::Url::parse(&s.endpoint)
        .map_err(|_| AppError::new("ai", "请输入完整兼容接口地址。"))?;
    let loopback = match u.host() {
        Some(url::Host::Domain(v)) => v.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(v)) => v.is_loopback(),
        Some(url::Host::Ipv6(v)) => v.is_loopback(),
        _ => false,
    };
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || !(u.scheme() == "https"
            || (s.provider_type == "local" && loopback && u.scheme() == "http"))
        || !u.path().ends_with("/chat/completions")
        || s.model.trim().is_empty()
    {
        return Err(AppError::new("ai","云端接口需 HTTPS；本地仅允许回环 HTTP。地址应以 /chat/completions 结束，不可包含凭据或查询参数。"));
    }
    Ok(())
}
pub fn validate(
    configuration: &Configuration,
    c: &crate::models::Config,
    e: &crate::v2::models::Extension,
    a: &crate::rules::models::Config,
) -> Vec<String> {
    let result: Result<()> = match configuration {
        Configuration::Rule {
            rule,
            missing,
            notes,
        } => {
            if missing.len() > 32
                || notes.len() > 32
                || missing.iter().chain(notes.iter()).any(|s| s.len() > 1000)
            {
                Err(AppError::new("ai", "草稿说明超出长度限制。"))
            } else if !missing.is_empty() {
                Err(AppError::new("ai", "规则缺少必要参数，请补充后再保存。"))
            } else if let Some(r) = rule {
                let mut full = a.clone();
                full.rules.retain(|x| x.id != r.id);
                full.rules.push(r.clone());
                crate::rules::validator::validate(&full, c, e)
            } else {
                Err(AppError::new(
                    "ai",
                    "模型未提供可用的规则，请补充本地关联。",
                ))
            }
        }
        Configuration::Workflow {
            workflow,
            missing,
            notes,
        } => {
            if missing.len() > 32
                || notes.len() > 32
                || missing.iter().chain(notes.iter()).any(|s| s.len() > 1000)
            {
                Err(AppError::new("ai", "草稿说明超出限制。"))
            } else if !missing.is_empty() {
                Err(AppError::new("ai", "工作流缺少应用或布局关联，请补充。"))
            } else if let Some(w) = workflow {
                crate::workflow::validator::validate(w, c, e)
            } else {
                Err(AppError::new("ai", "模型未提供有效工作流。"))
            }
        }
        Configuration::Explanation { explanation } => {
            if explanation.len() <= 8000 {
                Ok(())
            } else {
                Err(AppError::new("ai", "解释超出长度限制。"))
            }
        }
    };
    match result {
        Ok(()) => vec![],
        Err(e) => vec![e.message],
    }
}
pub fn normalize(configuration: &mut Configuration) {
    match configuration {
        Configuration::Rule {
            rule: Some(rule), ..
        } => {
            rule.enabled = false;
            rule.policy = "confirm".into();
        }
        Configuration::Workflow {
            workflow: Some(workflow),
            ..
        } => workflow.enabled = false,
        _ => {}
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malicious_node_and_shell_rules_are_rejected() {
        let value = r#"{"type":"workflow","workflow":{"nodes":[{"type":"powershell","script":"bad"}]},"missing":[],"notes":[]}"#;
        assert!(serde_json::from_str::<Configuration>(value).is_err());
        assert!(serde_json::from_str::<Configuration>(
            r#"{"type":"execute_shell","command":"bad"}"#
        )
        .is_err());
    }
    #[test]
    fn local_endpoint_is_bounded_and_cloud_requires_tls() {
        let mut s = Settings {
            enabled: true,
            endpoint: "http://127.0.0.1:11434/v1/chat/completions".into(),
            model: "user-model".into(),
            ..Settings::default()
        };
        assert!(validate_settings(&s).is_ok());
        s.provider_type = "cloud".into();
        assert!(validate_settings(&s).is_err());
        s.endpoint = "https://user:secret@example.com/v1/chat/completions".into();
        assert!(validate_settings(&s).is_err());
        s.endpoint = "https://example.com/v1/chat/completions?api_key=secret".into();
        assert!(validate_settings(&s).is_err());
    }
}
