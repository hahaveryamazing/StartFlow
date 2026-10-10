use crate::{
    accounts::{
        models::{Account, WriteAccount},
        repository,
    },
    error::{AppError, Result},
    workflow::models::Workflow,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
#[derive(Default, Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    pub accounts: Vec<Account>,
    pub web: Vec<crate::web_login::models::LoginConfig>,
    pub desktop: Vec<crate::desktop_login::models::Config>,
}
pub fn load(c: &Connection) -> Result<Metadata> {
    let accounts = if exists(c, "credential_accounts")? {
        repository::list(c)?
    } else {
        vec![]
    };
    let web = if exists(c, "web_login_configs")? {
        crate::web_login::repository::configs(c)?
    } else {
        vec![]
    };
    if !exists(c, "desktop_login_configs")? {
        return Ok(Metadata {
            accounts,
            web,
            desktop: vec![],
        });
    }
    let mut stmt = c.prepare("SELECT payload FROM desktop_login_configs ORDER BY id")?;
    let desktop = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .map(|r| Ok(serde_json::from_str(&r?)?))
        .collect::<Result<_>>()?;
    Ok(Metadata {
        accounts,
        web,
        desktop,
    })
}
impl Metadata {
    pub fn validate(&self) -> Result<()> {
        if self.accounts.len() > 500 || self.web.len() > 500 || self.desktop.len() > 500 {
            return Err(AppError::new("format", "登录配置数量超过上限。"));
        }
        let mut ids = HashSet::new();
        let mut refs = HashSet::new();
        for a in &self.accounts {
            crate::models::validate_id(&a.id)?;
            crate::models::validate_id(&a.credential_ref)?;
            if !ids.insert(&a.id) || !refs.insert(&a.credential_ref) || a.revision < 1 {
                return Err(AppError::new("format", "账号或凭据引用重复/无效。"));
            }
            let mut v = WriteAccount {
                id: Some(a.id.clone()),
                name: a.name.clone(),
                username: a.username.clone(),
                kind: a.kind.clone(),
                target: a.target.clone(),
                password: None,
                expected_revision: None,
            };
            v.validate()?;
            if v.target != a.target {
                return Err(AppError::new("format", "账号目标不是规范化地址。"));
            }
        }
        let mut configs = HashSet::new();
        for c in &self.web {
            if !configs.insert(&c.id) {
                return Err(AppError::new("format", "登录配置 ID 重复。"));
            }
            c.validate(
                self.accounts
                    .iter()
                    .find(|a| a.id == c.account_id)
                    .ok_or_else(|| AppError::new("format", "网页登录引用账号缺失。"))?,
            )?;
        }
        for c in &self.desktop {
            if !configs.insert(&c.id) {
                return Err(AppError::new("format", "登录配置 ID 重复。"));
            }
            c.validate(
                self.accounts
                    .iter()
                    .find(|a| a.id == c.account_id)
                    .ok_or_else(|| AppError::new("format", "桌面登录引用账号缺失。"))?,
            )?;
        }
        Ok(())
    }
    pub fn workflow(&self, w: &Workflow) -> Result<()> {
        for n in &w.nodes {
            if let Some((target, id)) = n.config.login_reference() {
                let valid = match target {
                    "web" => self.web.iter().any(|c| c.id == id),
                    "desktop" => self.desktop.iter().any(|c| c.id == id),
                    _ => false,
                };
                if !valid {
                    return Err(AppError::new("format", "工作流引用了未备份的登录配置。"));
                }
            }
        }
        Ok(())
    }
}
// Imports never reuse a supplied vault reference, even on the same computer.
// Original vault entries and the current account library remain intact.
pub fn remap(b: &mut crate::v2::models::Bundle) -> Result<()> {
    let Some(meta) = &mut b.login else {
        return Ok(());
    };
    meta.validate()?;
    let mut map = std::collections::HashMap::new();
    for a in &meta.accounts {
        map.insert(a.id.clone(), crate::models::id());
        map.insert(a.credential_ref.clone(), crate::models::id());
    }
    for c in &meta.web {
        map.insert(c.id.clone(), crate::models::id());
    }
    for c in &meta.desktop {
        map.insert(c.id.clone(), crate::models::id());
    }
    fn rewrite(
        v: &mut serde_json::Value,
        map: &std::collections::HashMap<String, String>,
        key: Option<&str>,
    ) {
        match v {
            serde_json::Value::Object(o) => {
                for (k, v) in o {
                    rewrite(v, map, Some(k));
                }
            }
            serde_json::Value::Array(a) => {
                for v in a {
                    rewrite(v, map, key);
                }
            }
            serde_json::Value::String(s)
                if matches!(
                    key,
                    Some("id" | "account_id" | "config_id" | "credential_ref")
                ) =>
            {
                if let Some(new) = map.get(s) {
                    *s = new.clone();
                }
            }
            _ => {}
        }
    }
    let mut value = serde_json::to_value(&b)?;
    rewrite(&mut value, &map, None);
    *b = serde_json::from_value(value)?;
    Ok(())
}
pub fn write(c: &Connection, m: &Metadata) -> Result<()> {
    m.validate()?;
    for a in &m.accounts {
        repository::write(c, a)?;
    }
    for cfg in &m.web {
        crate::web_login::repository::save(c, cfg)?;
    }
    for cfg in &m.desktop {
        c.execute("INSERT INTO desktop_login_configs VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,payload=excluded.payload",rusqlite::params![cfg.id,cfg.account_id,serde_json::to_string(cfg)?])?;
    }
    Ok(())
}

fn exists(c: &Connection, table: &str) -> Result<bool> {
    Ok(c.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)",
        [table],
        |r| r.get(0),
    )?)
}
