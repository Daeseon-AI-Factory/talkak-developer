use serde::Serialize;

mod agent_transcript;
mod clipboard_commands;
mod project_commands;
mod session_commands;
mod session_runtime;
mod transcript_line_filter;
mod transcript_service;

#[cfg(test)]
mod project_commands_tests;
#[cfg(test)]
mod session_client_tests;

use clipboard_commands::{clipboard_read_image_path, clipboard_read_text, clipboard_write_text};
use project_commands::{project_validate_command, project_validate_path};
use session_commands::{
    session_discard, session_kill, session_live, session_read, session_resize, session_snapshot,
    session_spawn, session_write,
};
use session_runtime::SessionRuntime;
use tauri::Manager;
use transcript_service::{agent_transcript, TranscriptService};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostInfo {
    os: &'static str,
    architecture: &'static str,
    supports_wsl_discovery: bool,
    /// The Windows build, or None off Windows. xterm needs it to know it is driving a ConPTY:
    /// without it, it applies its non-Windows buffer heuristics, and growing a pane pulls lines
    /// back out of scrollback instead of appending blank rows — content duplicates and the
    /// viewport moves under the reader.
    windows_build: Option<u32>,
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
        windows_build: windows_build(),
    }
}

/// The OS build number, read from the OS rather than guessed in the renderer.
#[cfg(windows)]
fn windows_build() -> Option<u32> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Prints "Microsoft Windows [Version 10.0.26200.9106]"; the build is the third dotted field.
    let output = std::process::Command::new("cmd.exe")
        .args(["/D", "/S", "/C", "ver"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let bracketed = text.split('[').nth(1)?.split(']').next()?;
    bracketed.split('.').nth(2)?.trim().parse().ok()
}

#[cfg(not(windows))]
fn windows_build() -> Option<u32> {
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The client of the detached session broker. It outlives the app, so an app restart
            // reattaches still-running sessions exactly as they were left.
            let app_data_dir = app.path().app_data_dir().ok();
            app.manage(SessionRuntime::attach(app_data_dir.clone()));
            app.manage(TranscriptService::new(
                app_data_dir.map(|directory| directory.join("sessions")),
            ));
            Ok(())
        });

    #[cfg(feature = "webdriver-ci")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .invoke_handler(tauri::generate_handler![
            app_quit,
            agent_transcript,
            clipboard_read_image_path,
            clipboard_read_text,
            clipboard_write_text,
            host_info,
            project_validate_path,
            project_validate_command,
            session_live,
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
