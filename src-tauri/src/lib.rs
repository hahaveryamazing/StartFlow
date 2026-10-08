pub mod backups;
mod commands;
pub mod conditions;
pub mod database;
mod engine;
pub mod error;
pub mod launcher;
pub mod migrations;
pub mod models;
pub mod runtime;
pub mod scheduler;
pub mod shortcuts;
mod tray;
pub mod v2;
pub mod window_manager;
pub mod workflow;
use tauri::{Emitter, Manager};

pub fn run() {
    let login = std::env::args().any(|a| a == "--autostart");
    let result = tauri::Builder::default()
        .manage(runtime::Runtime::default())
        .manage(shortcuts::Shortcuts::default())
        .manage(v2::commands::Mutations::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        shortcuts::dispatch(app, shortcut.id());
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|a| a == "--autostart") {
                tray::show(app, None);
            }
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--autostart"])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let path = app.path().app_data_dir()?;
            // Debug builds only: isolated storage for native desktop integration tests.
            #[cfg(debug_assertions)]
            let path = if let Ok(test_path) = std::env::var("STARTFLOW_TEST_DATA_DIR") {
                models::validate_path(&test_path)?;
                std::path::PathBuf::from(test_path)
            } else {
                path
            };
            let db = database::Db::open(&path)?;
            let initial_config = database::config(&db.lock()?.conn)?;
            let initial_login_rules = initial_config
                .schedules
                .iter()
                .filter(|s| s.trigger_type == "login" && s.enabled)
                .map(|s| s.id.clone())
                .collect();
            let settings = initial_config.settings;
            app.manage(db);
            let extension = {
                let db = app.state::<database::Db>();
                let result = v2::repository::load(&db.lock()?.conn)?;
                result
            };
            shortcuts::initialize(app.handle(), &extension.shortcuts)?;
            tray::setup(app.handle())?;
            if !login || settings.show_on_autostart {
                tray::show(app.handle(), None);
            }
            scheduler::start(app.handle().clone(), login, initial_login_rules);
            backups::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "palette" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                    tauri::WindowEvent::Focused(false) => {
                        let _ = window.hide();
                    }
                    _ => {}
                }
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let db = window.state::<database::Db>();
                let hide = db
                    .lock()
                    .and_then(|g| database::config(&g.conn))
                    .map(|c| c.settings.close_to_tray)
                    .unwrap_or(true);
                if hide {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.emit("main-visible", false);
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::snapshot,
            commands::save_scene,
            commands::save_task,
            commands::save_schedule,
            commands::delete_entity,
            commands::duplicate_scene,
            commands::save_settings,
            commands::set_autostart,
            commands::run_scene,
            commands::run_task,
            commands::clear_logs,
            commands::query_logs,
            commands::read_import,
            commands::apply_import,
            commands::export_config,
            commands::open_data_directory,
            commands::quit,
            v2::commands::v2_save_extension,
            v2::commands::v2_validate_workflow,
            v2::commands::v2_convert_scene,
            v2::commands::v2_run_workflow,
            v2::commands::v2_cancel_run,
            v2::commands::v2_window_inventory,
            v2::commands::v2_restore_layout,
            v2::commands::v2_create_backup,
            v2::commands::v2_delete_backup,
            v2::commands::v2_read_backup,
            v2::commands::v2_read_import,
            v2::commands::v2_export,
            v2::commands::v2_apply_import,
            v2::commands::v2_choose_background,
            v2::commands::v2_read_background,
            v2::commands::v2_show_palette,
            v2::commands::v2_hide_palette,
            v2::commands::v2_palette_data,
            v2::commands::v2_palette_action,
            v2::commands::v2_query_node_logs
        ])
        .run(tauri::generate_context!());
    if let Err(e) = result {
        eprintln!("StartFlow 初始化失败: {e}");
        #[cfg(windows)]
        unsafe {
            use windows::{
                core::PCWSTR,
                Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK},
            };
            let message: Vec<u16> = "StartFlow 无法启动。请检查数据目录权限，或重新安装软件。"
                .encode_utf16()
                .chain([0])
                .collect();
            let title: Vec<u16> = "StartFlow".encode_utf16().chain([0]).collect();
            MessageBoxW(
                None,
                PCWSTR(message.as_ptr()),
                PCWSTR(title.as_ptr()),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}
