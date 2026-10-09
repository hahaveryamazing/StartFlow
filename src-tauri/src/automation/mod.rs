pub mod commands;
pub mod coordinator;
pub mod repository;
pub mod service;
use crate::{context::Snapshot, rules::models::Config};
use std::sync::{
    atomic::{AtomicBool, AtomicU64},
    Mutex,
};
pub struct Live {
    pub snapshot: Snapshot,
    pub config: Config,
    pub stable_since: std::time::Instant,
    pub current_mode: Option<String>,
    pub subscription_error: Option<String>,
}
pub struct Automation {
    pub live: Mutex<Live>,
    pub gate: Mutex<()>,
    pub refresh: AtomicBool,
    pub revision: AtomicU64,
    pub stop: AtomicBool,
    pub worker: Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl Default for Automation {
    fn default() -> Self {
        Self {
            live: Mutex::new(Live {
                snapshot: Snapshot::default(),
                config: Config::default(),
                stable_since: std::time::Instant::now(),
                current_mode: None,
                subscription_error: None,
            }),
            gate: Mutex::new(()),
            refresh: AtomicBool::new(false),
            revision: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            worker: Mutex::new(None),
        }
    }
}
pub fn reconfigure(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(state) = app.try_state::<Automation>() {
        state
            .revision
            .fetch_add(1, std::sync::atomic::Ordering::Release);
    }
}
