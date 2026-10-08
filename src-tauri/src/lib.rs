mod commands;
pub mod database;
mod engine;
pub mod error;
pub mod launcher;
pub mod models;
pub mod scheduler;
mod tray;
use tauri::Manager;

pub fn run() {
    let login = std::env::args().any(|a| a == "--autostart");
    let result = tauri::Builder::default()
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
            tray::setup(app.handle())?;
            if !login || settings.show_on_autostart {
                tray::show(app.handle(), None);
            }
            scheduler::start(app.handle().clone(), login, initial_login_rules);
            Ok(())
        })
        .on_window_event(|window, event| {
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
            commands::quit
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
