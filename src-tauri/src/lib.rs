use serde::Serialize;

mod project_commands;
mod session_commands;
mod session_runtime;

#[cfg(test)]
mod project_commands_tests;
#[cfg(test)]
mod session_runtime_tests;

use project_commands::project_validate_path;
use session_commands::{
    session_discard, session_kill, session_read, session_resize, session_snapshot, session_spawn,
    session_write,
};
use session_runtime::SessionRuntime;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostInfo {
    os: &'static str,
    architecture: &'static str,
    supports_wsl_discovery: bool,
}

#[tauri::command]
fn host_info() -> HostInfo {
    HostInfo {
        os: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        supports_wsl_discovery: cfg!(target_os = "windows"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionRuntime::default())
        .invoke_handler(tauri::generate_handler![
            host_info,
            project_validate_path,
            session_spawn,
            session_snapshot,
            session_read,
            session_write,
            session_resize,
            session_kill,
            session_discard
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Talkak Dev");
}

#[cfg(test)]
mod tests {
    use super::host_info;

    #[test]
    fn host_info_reports_the_compiled_target() {
        let info = host_info();
        assert!(!info.os.is_empty());
        assert!(!info.architecture.is_empty());
        assert_eq!(info.supports_wsl_discovery, cfg!(target_os = "windows"));
    }
}
