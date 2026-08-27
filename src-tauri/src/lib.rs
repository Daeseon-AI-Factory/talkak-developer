use serde::Serialize;

mod clipboard_commands;
mod project_commands;
mod session_commands;
mod session_runtime;

#[cfg(test)]
mod project_commands_tests;
#[cfg(test)]
mod session_client_tests;

use clipboard_commands::{clipboard_read_text, clipboard_write_text};
use project_commands::{project_validate_command, project_validate_path};
use session_commands::{
    session_discard, session_kill, session_read, session_resize, session_restorable,
    session_snapshot, session_spawn, session_stored_output, session_write,
};
use session_runtime::SessionRuntime;
use tauri::Manager;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostInfo {
    os: &'static str,
    architecture: &'static str,
    supports_wsl_discovery: bool,
}

/// Quit chosen from the close-confirmation dialog. `kills` carries the sessions the user chose to
/// stop (each kill sweeps the session's whole process tree); an empty list is the keep-running
/// choice — the broker holds the sessions and the next launch reattaches. Individual kill
/// failures (a run that just exited on its own) must not block quitting.
#[tauri::command]
fn app_quit(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, SessionRuntime>,
    kills: Vec<session_runtime::RunSessionRequest>,
) {
    for request in kills {
        let _ = runtime.kill(request);
    }
    app.exit(0);
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The client of the detached session broker. Sessions and their records live in the
            // broker process under the OS application-data directory, so both a machine restart
            // AND an app restart bring the workspace back — with still-running sessions attached
            // live, exactly as they were left.
            app.manage(SessionRuntime::attach(app.path().app_data_dir().ok()));
            Ok(())
        });

    #[cfg(feature = "webdriver-ci")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .invoke_handler(tauri::generate_handler![
            app_quit,
            clipboard_read_text,
            clipboard_write_text,
            host_info,
            project_validate_path,
            project_validate_command,
            session_spawn,
            session_snapshot,
            session_read,
            session_write,
            session_resize,
            session_kill,
            session_discard,
            session_restorable,
            session_stored_output
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
