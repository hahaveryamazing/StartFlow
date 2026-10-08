// A controlled Windows EXE fixture: records argv, working directory and a marker.
// Used only by integration tests; it is never shipped in the installer.
#![cfg_attr(windows, windows_subsystem = "windows")]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(output) = args.first() {
        let report = serde_json::json!({"arguments":args,"working_directory":std::env::current_dir()?.to_string_lossy(),"received_at":chrono::Utc::now().to_rfc3339()});
        std::fs::write(output, serde_json::to_vec_pretty(&report)?)?;
    }
    if args.iter().any(|a| a == "--hold") {
        std::thread::sleep(std::time::Duration::from_secs(5));
    }
    Ok(())
}
