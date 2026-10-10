use crate::{
    error::{AppError, Result},
    models::Config,
    v2::models::Shortcut,
};
use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
    sync::Mutex,
};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut as Hotkey};
#[derive(Default)]
pub struct Shortcuts {
    pub registered: Mutex<HashMap<u32, Shortcut>>,
    pub errors: Mutex<Vec<(String, String)>>,
    gate: Mutex<()>,
}
pub fn parse(s: &str) -> Result<Hotkey> {
    if s.len() > 120 {
        return Err(AppError::new("shortcut", "快捷键格式过长。"));
    }
    let key = Hotkey::from_str(s)
        .map_err(|_| AppError::new("shortcut", "无法识别组合键，请使用录制按钮。"))?;
    if !key
        .mods
        .intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER)
    {
        return Err(AppError::new(
            "shortcut",
            "全局快捷键必须包含 Ctrl、Alt 或 Windows 键，避免截获普通输入。",
        ));
    }
    Ok(key)
}
pub fn validate(list: &[Shortcut], c: &Config) -> Result<()> {
    let mut ids = HashSet::new();
    let mut accelerators = HashSet::new();
    for s in list {
        crate::models::validate_id(&s.id)?;
        let key = parse(&s.accelerator)?;
        if !ids.insert(&s.id) || !accelerators.insert(key.id()) {
            return Err(AppError::new(
                "shortcut",
                "快捷键组合或标识重复；修饰键顺序不同也视为同一组合。",
            ));
        }
        if !["open", "palette", "scene", "pause", "resume"].contains(&s.action.as_str())
            || (s.action == "scene" && !c.scenes.iter().any(|x| x.id == s.target_id))
        {
            return Err(AppError::new("shortcut", "快捷键操作或关联场景无效。"));
        }
    }
    Ok(())
}
pub fn apply(app: &tauri::AppHandle, list: &[Shortcut]) -> Result<()> {
    let state = app.state::<Shortcuts>();
    let _gate = state.gate.lock().map_err(AppError::internal)?;
    let previous = state.registered.lock().map_err(AppError::internal)?.clone();
    app.global_shortcut()
        .unregister_all()
        .map_err(|_| AppError::new("shortcut", "无法注销旧快捷键，配置未保存。"))?;
    let mut new = HashMap::new();
    let mut failure = None;
    for s in list.iter().filter(|s| s.enabled) {
        let key = parse(&s.accelerator)?;
        if app.global_shortcut().register(key).is_err() {
            failure = Some(AppError::new(
                "shortcut",
                &format!(
                    "组合键 {} 被系统或其它软件占用，配置未保存。",
                    s.accelerator
                ),
            ));
            break;
        }
        new.insert(key.id(), s.clone());
    }
    if let Some(e) = failure {
        let _ = app.global_shortcut().unregister_all();
        let mut restored = HashMap::new();
        let mut errors = vec![];
        for (key, s) in previous {
            if app
                .global_shortcut()
                .register(parse(&s.accelerator)?)
                .is_ok()
            {
                restored.insert(key, s);
            } else {
                errors.push((s.id, "原快捷键重新注册失败，请更换组合。".into()));
            }
        }
        *state.registered.lock().map_err(AppError::internal)? = restored;
        *state.errors.lock().map_err(AppError::internal)? = errors;
        return Err(e);
    }
    *state.registered.lock().map_err(AppError::internal)? = new;
    state.errors.lock().map_err(AppError::internal)?.clear();
    Ok(())
}
pub fn initialize(app: &tauri::AppHandle, list: &[Shortcut]) -> Result<()> {
    let state = app.state::<Shortcuts>();
    let mut entries = HashMap::new();
    let mut errors = vec![];
    for s in list.iter().filter(|s| s.enabled) {
        match parse(&s.accelerator) {
            Ok(key) => {
                if app.global_shortcut().register(key).is_ok() {
                    entries.insert(key.id(), s.clone());
                } else {
                    errors.push((
                        s.id.clone(),
                        "快捷键被占用，未注册；请在设置中修改。".into(),
                    ));
                }
            }
            Err(e) => errors.push((s.id.clone(), e.message)),
        }
    }
    *state.registered.lock().map_err(AppError::internal)? = entries;
    *state.errors.lock().map_err(AppError::internal)? = errors;
    Ok(())
}
pub fn dispatch(app: &tauri::AppHandle, key: u32) {
    let app = app.clone();
    // Never wait for DB/runtime locks on the Windows event thread.
    tauri::async_runtime::spawn_blocking(move || {
        let action = app
            .state::<Shortcuts>()
            .registered
            .lock()
            .ok()
            .and_then(|m| m.get(&key).cloned());
        if let Some(s) = action {
            if let Err(e) = action_execute(&app, &s.action, &s.target_id) {
                crate::engine::report_error(&app, &e);
            }
        }
    });
}
pub fn synchronize_removed(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mutations = app.state::<crate::v2::commands::Mutations>();
        let Ok(_mutation) = mutations.0.lock() else {
            return;
        };
        let state = app.state::<Shortcuts>();
        let Ok(_gate) = state.gate.lock() else { return };
        let list = {
            let db = app.state::<crate::database::Db>();
            let result = db
                .lock()
                .and_then(|g| crate::v2::repository::palette_preferences(&g.conn));
            match result {
                Ok((_, list)) => list,
                Err(e) => {
                    crate::engine::report_error(&app, &e);
                    return;
                }
            }
        };
        let removed = state
            .registered
            .lock()
            .map(|m| {
                m.iter()
                    .filter(|(_, s)| !list.iter().any(|x| x.id == s.id && x.enabled))
                    .map(|(key, s)| (*key, s.clone()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (key, s) in removed {
            match parse(&s.accelerator).and_then(|h| {
                app.global_shortcut()
                    .unregister(h)
                    .map_err(AppError::internal)
            }) {
                Ok(()) => {
                    if let Ok(mut map) = state.registered.lock() {
                        map.remove(&key);
                    }
                }
                Err(e) => crate::engine::report_error(&app, &e),
            }
        }
    });
}
pub fn action_execute(app: &tauri::AppHandle, action: &str, target: &str) -> Result<()> {
    match action {
        "open" => crate::tray::show(app, None),
        "palette" => show_palette(app)?,
        "scene" => {
            crate::engine::submit_scene(app, target, "shortcut", None)?;
        }
        "task" => {
            crate::engine::submit_task(app, target)?;
        }
        "pause" | "resume" => {
            let db = app.state::<crate::database::Db>();
            let mut c = crate::database::config(&db.lock()?.conn)?;
            c.settings.paused = action == "pause";
            crate::commands::save_settings(app.clone(), db, c.settings, None)?;
        }
        _ => return Err(AppError::new("shortcut", "未知的快捷操作。")),
    }
    Ok(())
}
pub fn show_palette(app: &tauri::AppHandle) -> Result<()> {
    let window = app
        .get_webview_window("palette")
        .ok_or_else(|| AppError::new("window", "命令面板暂时不可用。"))?;
    window.center().map_err(AppError::internal)?;
    window.show().map_err(AppError::internal)?;
    window.set_focus().map_err(AppError::internal)?;
    window
        .emit("palette-open", ())
        .map_err(AppError::internal)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::id;
    #[test]
    fn duplicate_modifier_order_rejected() {
        let c = Config::default();
        let list = vec![
            Shortcut {
                id: id(),
                action: "open".into(),
                target_id: "".into(),
                accelerator: "Ctrl+Alt+1".into(),
                enabled: true,
            },
            Shortcut {
                id: id(),
                action: "palette".into(),
                target_id: "".into(),
                accelerator: "Alt+Ctrl+1".into(),
                enabled: true,
            },
        ];
        assert!(validate(&list, &c).is_err());
        assert!(parse("A").is_err());
    }
}
