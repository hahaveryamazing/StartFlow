#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    if std::env::args().any(|a| a == "--desktop-login-worker") {
        startflow_lib::desktop_login::worker::entry();
        return;
    }
    startflow_lib::run();
}
