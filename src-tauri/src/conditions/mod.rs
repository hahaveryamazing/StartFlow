use crate::{
    error::{AppError, Result},
    launcher,
    runtime::Control,
    workflow::models::Condition,
};
use chrono::{Datelike, Timelike};
use std::{path::Path, time::Duration};
pub async fn service(url: &str, seconds: u32) -> Result<bool> {
    crate::workflow::validator::service(url, seconds)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(seconds as u64))
        .timeout(Duration::from_secs(seconds as u64))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(AppError::internal)?;
    match client.get(url).send().await {
        Ok(response) => Ok(response.status().is_success()),
        Err(e) => {
            use std::error::Error;
            let mut cause = e.source();
            let mut tls = false;
            let mut unavailable = false;
            while let Some(error) = cause {
                let message = error.to_string().to_ascii_lowercase();
                if [
                    "certificate",
                    "cert verify",
                    "tls",
                    "ssl",
                    "handshake",
                    "证书",
                ]
                .iter()
                .any(|s| message.contains(s))
                {
                    tls = true;
                }
                if let Some(io) = error.downcast_ref::<std::io::Error>() {
                    unavailable |= matches!(
                        io.kind(),
                        std::io::ErrorKind::ConnectionRefused
                            | std::io::ErrorKind::ConnectionReset
                            | std::io::ErrorKind::ConnectionAborted
                            | std::io::ErrorKind::NotConnected
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::HostUnreachable
                            | std::io::ErrorKind::NetworkUnreachable
                            | std::io::ErrorKind::NetworkDown
                            | std::io::ErrorKind::AddrNotAvailable
                    );
                }
                cause = error.source();
            }
            if !tls && (e.is_timeout() || unavailable) {
                Ok(false)
            } else {
                Err(AppError::new(
                    "condition",
                    "HTTPS 服务探测失败，请检查证书、服务地址或网络设置。",
                ))
            }
        }
    }
}
pub fn path_exists(path: &str, folder: bool) -> Result<bool> {
    crate::models::validate_path(path)?;
    match std::fs::metadata(Path::new(path)) {
        Ok(m) => Ok(if folder { m.is_dir() } else { m.is_file() }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(AppError::new(
            "condition",
            "无法读取条件路径，请检查权限；此错误不会当作不存在。",
        )),
    }
}
pub async fn evaluate(c: &Condition) -> Result<bool> {
    crate::workflow::validator::condition(c)?;
    match c {
        Condition::Time { start, end } => {
            let a =
                chrono::NaiveTime::parse_from_str(start, "%H:%M").map_err(AppError::internal)?;
            let b = chrono::NaiveTime::parse_from_str(end, "%H:%M").map_err(AppError::internal)?;
            let t = chrono::Local::now()
                .time()
                .with_second(0)
                .ok_or_else(|| AppError::new("condition", "无法读取本地时间。"))?;
            Ok(if a < b {
                t >= a && t < b
            } else {
                t >= a || t < b
            })
        }
        Condition::Weekdays { days } => {
            Ok(days.contains(&chrono::Local::now().weekday().number_from_monday()))
        }
        Condition::Process { path } => {
            let p = path.clone();
            tauri::async_runtime::spawn_blocking(move || launcher::process_running(&p))
                .await
                .map_err(AppError::internal)?
        }
        Condition::Network => Ok(launcher::network_available()),
        Condition::Service {
            url,
            timeout_seconds,
        } => service(url, *timeout_seconds).await,
        Condition::File { path } => path_exists(path, false),
        Condition::Folder { path } => path_exists(path, true),
    }
}
pub async fn group(mode: &str, conditions: &[Condition], control: &Control) -> Result<bool> {
    // Evaluate all terms so an access error cannot disappear behind a true/false short circuit.
    let mut values = Vec::with_capacity(conditions.len());
    for c in conditions {
        values.push(control.guard(evaluate(c)).await?);
    }
    Ok(if mode == "and" {
        values.iter().all(|v| *v)
    } else {
        values.iter().any(|v| *v)
    })
}
pub async fn wait_network(mode: &str, url: &str, seconds: u32, control: &Control) -> Result<()> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds as u64);
    loop {
        control.check()?;
        let available = if mode == "service" {
            let left = deadline
                .saturating_duration_since(tokio::time::Instant::now())
                .as_secs()
                .clamp(1, 5) as u32;
            control
                .guard(async {
                    tokio::time::timeout_at(deadline, service(url, left))
                        .await
                        .map_err(|_| AppError::new("timeout", "等待指定服务超时。"))?
                })
                .await?
        } else {
            launcher::network_available()
        };
        if available {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::new(
                "timeout",
                "等待网络超时；本地接口连接不等同于互联网可达。",
            ));
        }
        control.wait(Duration::from_millis(500)).await?;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_and_folder_distinction() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("test.txt");
        std::fs::write(&f, "x").unwrap();
        assert!(path_exists(f.to_str().unwrap(), false).unwrap());
        assert!(!path_exists(f.to_str().unwrap(), true).unwrap());
        assert!(!path_exists(d.path().join("missing").to_str().unwrap(), false).unwrap());
    }
    #[tokio::test]
    async fn refused_service_is_false_and_bad_tls_is_error() {
        use std::io::Write;
        use std::net::TcpListener;
        let refused = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = refused.local_addr().unwrap();
        drop(refused);
        assert!(!service(&format!("https://{address}"), 2).await.unwrap());
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        });
        assert!(service(&format!("https://{address}"), 2).await.is_err());
        worker.join().unwrap();
    }
}
