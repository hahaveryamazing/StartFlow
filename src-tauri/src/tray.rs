use crate::{
    database::{self, Db},
    engine,
    error::{AppError, Result},
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
pub fn show(app: &tauri::AppHandle, page: Option<&str>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = w.emit("main-visible", true);
    }
    if let Some(page) = page {
        let _ = app.emit("navigate", page);
    }
}
fn menu(app: &tauri::AppHandle) -> Result<Menu<tauri::Wry>> {
    let db = app.state::<Db>();
    let g = db.lock()?;
    let c = database::config(&g.conn)?;
    let runs = database::runs(&g.conn)?;
    drop(g);
    let menu = Menu::new(app).map_err(AppError::internal)?;
    menu.append(
        &MenuItem::with_id(app, "open", "打开 StartFlow", true, None::<&str>)
            .map_err(AppError::internal)?,
    )
    .map_err(AppError::internal)?;
    menu.append(
        &MenuItem::with_id(app, "palette", "快速命令面板", true, None::<&str>)
            .map_err(AppError::internal)?,
    )
    .map_err(AppError::internal)?;
    menu.append(
        &MenuItem::with_id(
            app,
            "default",
            "启动默认场景",
            c.settings.default_scene_id.is_some(),
            None::<&str>,
        )
        .map_err(AppError::internal)?,
    )
    .map_err(AppError::internal)?;
    let recent = Submenu::new(app, "最近使用的场景", true).map_err(AppError::internal)?;
    let mut seen = std::collections::HashSet::new();
    for run in &runs {
        if let Some(id) = &run.scene_id {
            if !seen.contains(id) {
                if let Some(s) = c.scenes.iter().find(|s| &s.id == id) {
                    seen.insert(id.clone());
                    recent
                        .append(
                            &MenuItem::with_id(
                                app,
                                format!("scene:{id}"),
                                &s.name,
                                s.enabled,
                                None::<&str>,
                            )
                            .map_err(AppError::internal)?,
                        )
                        .map_err(AppError::internal)?;
                    if seen.len() == 5 {
                        break;
                    }
                }
            }
        }
    }
    if seen.is_empty() {
        recent
            .append(
                &MenuItem::new(app, "暂无运行场景", false, None::<&str>)
                    .map_err(AppError::internal)?,
            )
            .map_err(AppError::internal)?;
    }
    menu.append(&recent).map_err(AppError::internal)?;
    menu.append(
        &CheckMenuItem::with_id(
            app,
            "pause",
            "暂停自动任务",
            true,
            c.settings.paused,
            None::<&str>,
        )
        .map_err(AppError::internal)?,
    )
    .map_err(AppError::internal)?;
    menu.append(
        &MenuItem::with_id(app, "settings", "系统设置", true, None::<&str>)
            .map_err(AppError::internal)?,
    )
    .map_err(AppError::internal)?;
    menu.append(
        &MenuItem::with_id(app, "quit", "退出程序", true, None::<&str>)
            .map_err(AppError::internal)?,
    )
    .map_err(AppError::internal)?;
    Ok(menu)
}
pub fn refresh(app: &tauri::AppHandle) -> Result<()> {
    if let Some(tray) = app.tray_by_id("startflow") {
        tray.set_menu(Some(menu(app)?))
            .map_err(AppError::internal)?;
    }
    Ok(())
}
pub fn setup(app: &tauri::AppHandle) -> Result<()> {
    let mut builder = TrayIconBuilder::with_id("startflow")
        .tooltip("StartFlow · 智能工作启动中心")
        .menu(&menu(app)?)
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show(tray.app_handle(), None);
            }
        })
        .on_menu_event(|app, event| {
            let result: Result<()> = (|| {
                match event.id.as_ref() {
                    "open" => show(app, None),
                    "palette" => crate::shortcuts::show_palette(app)?,
                    "settings" => show(app, Some("settings")),
                    "quit" => app.exit(0),
                    "pause" => {
                        let db = app.state::<Db>();
                        let mut c = database::config(&db.lock()?.conn)?;
                        c.settings.paused = !c.settings.paused;
                        crate::commands::save_settings(app.clone(), db, c.settings, None)?;
                    }
                    "default" => {
                        let db = app.state::<Db>();
                        let c = database::config(&db.lock()?.conn)?;
                        if let Some(id) = c.settings.default_scene_id {
                            engine::submit_scene(app, &id, "manual", None)?;
                        }
                    }
                    id if id.starts_with("scene:") => {
                        engine::submit_scene(app, &id[6..], "manual", None)?;
                    }
                    _ => {}
                }
                Ok(())
            })();
            if let Err(e) = result {
                engine::report_error(app, &e);
                show(app, None);
            }
        })
        .build(app)
        .map_err(AppError::internal)?;
    Ok(())
}
