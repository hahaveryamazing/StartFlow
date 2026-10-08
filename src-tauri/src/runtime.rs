use crate::{
    error::{AppError, Result},
    launcher,
    models::Task,
};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tokio::sync::watch;
#[derive(Default)]
pub struct Runtime {
    pub controls: Mutex<HashMap<String, watch::Sender<bool>>>,
}
#[derive(Clone)]
pub struct Control {
    receiver: watch::Receiver<bool>,
}
impl Runtime {
    pub fn register(&self, id: &str) -> Result<Control> {
        let (tx, rx) = watch::channel(false);
        self.controls
            .lock()
            .map_err(AppError::internal)?
            .insert(id.into(), tx);
        Ok(Control { receiver: rx })
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        let controls = self.controls.lock().map_err(AppError::internal)?;
        let tx = controls
            .get(id)
            .ok_or_else(|| AppError::new("not_found", "执行已结束，无法取消。"))?;
        tx.send(true)
            .map_err(|_| AppError::new("not_found", "执行已结束。"))
    }
    pub fn remove(&self, id: &str) {
        if let Ok(mut c) = self.controls.lock() {
            c.remove(id);
        }
    }
}
impl Control {
    pub fn check(&self) -> Result<()> {
        if *self.receiver.borrow() {
            Err(AppError::new(
                "cancelled",
                "用户已取消执行；已提交的程序不会被终止。",
            ))
        } else {
            Ok(())
        }
    }
    pub async fn guard<T>(
        &self,
        future: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        self.check()?;
        let mut rx = self.receiver.clone();
        tokio::select! {biased; _=rx.changed()=>Err(AppError::new("cancelled","用户已取消执行。")), result=future=>result}
    }
    pub async fn wait(&self, duration: Duration) -> Result<()> {
        self.guard(async {
            tokio::time::sleep(duration).await;
            Ok(())
        })
        .await
    }
}
pub async fn task(t: &Task, control: &Control) -> Result<launcher::LaunchOutcome> {
    control.check()?;
    if !t.enabled {
        return Ok(launcher::LaunchOutcome {
            status: "skipped",
            message: "该任务已停用。",
            pid: None,
        });
    }
    control.wait(Duration::from_millis(t.delay_ms)).await?;
    if t.kind == "web" && t.wait_for_network {
        crate::conditions::wait_network("local", "", 30, control).await?;
    }
    control.check()?;
    let t = t.clone();
    // Once submitted, a Windows launch is allowed to finish; cancellation never kills it.
    tauri::async_runtime::spawn_blocking(move || launcher::launch_with_pid(&t))
        .await
        .map_err(AppError::internal)?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelling_wait_prevents_future_work() {
        let runtime = Runtime::default();
        let control = runtime.register("run").unwrap();
        let child = control.clone();
        let work = tokio::spawn(async move { child.wait(Duration::from_secs(60)).await });
        runtime.cancel("run").unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), work)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err().code, "cancelled");
        assert!(control.check().is_err());
        runtime.remove("run");
        assert!(runtime.cancel("run").is_err());
    }
}
