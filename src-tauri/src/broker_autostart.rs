//! Start the session broker at login, so the sessions it restores are back before the app is.
//!
//! macOS: a LaunchAgent plist under ~/Library/LaunchAgents, RunAtLoad, no KeepAlive — launchd
//! starts the broker once per login and the app starts it on demand the rest of the time; a
//! second copy finding the endpoint taken exits on its own. Windows: a value under the user's
//! Run key. Both run the same installable broker copy and store the app launches, so every path
//! meets at one endpoint. Turning it off removes the entry and leaves a running broker alone —
//! unloading the job would end every session it holds.

use std::path::Path;

// macOS-only at runtime; every platform renders it in the tests.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const LABEL: &str = "dev.talkak.desktop.broker";
// Used by the Windows registration and by its test on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const RUN_VALUE: &str = "TalkakDevBroker";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutostartStatus {
    /// Whether this platform has a login launcher the app knows how to write.
    pub supported: bool,
    pub enabled: bool,
    /// What the entry runs, for the settings panel to show rather than describe.
    pub program: Option<String>,
}

/// The plist launchd reads. Every path is XML-escaped: a data directory can carry `&`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn render_launch_agent(label: &str, program: &Path, arguments: &[String]) -> String {
    let mut lines = vec![
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>".to_string(),
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">".to_string(),
        "<plist version=\"1.0\">".to_string(),
        "<dict>".to_string(),
        "    <key>Label</key>".to_string(),
        format!("    <string>{}</string>", escape(label)),
        "    <key>ProgramArguments</key>".to_string(),
        "    <array>".to_string(),
        format!("        <string>{}</string>", escape(&program.to_string_lossy())),
    ];
    lines.extend(
        arguments
            .iter()
            .map(|argument| format!("        <string>{}</string>", escape(argument))),
    );
    lines.extend(
        [
            "    </array>",
            "    <key>RunAtLoad</key>",
            "    <true/>",
            "    <key>ProcessType</key>",
            "    <string>Background</string>",
            "</dict>",
            "</plist>",
            "",
        ]
        .map(str::to_string),
    );
    lines.join("\n")
}

/// The command line for the Run key: the program quoted, every argument quoted.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn render_run_value(program: &Path, arguments: &[String]) -> String {
    let mut parts = vec![quote_windows(&program.to_string_lossy())];
    parts.extend(arguments.iter().map(|argument| quote_windows(argument)));
    parts.join(" ")
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg_attr(not(windows), allow(dead_code))]
fn quote_windows(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\\\""))
}

#[cfg(target_os = "macos")]
fn plist_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        std::path::PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{LABEL}.plist")),
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn status(program: Option<&Path>) -> AutostartStatus {
    AutostartStatus {
        supported: true,
        enabled: plist_path().is_some_and(|path| path.exists()),
        program: program.map(|path| path.to_string_lossy().into_owned()),
    }
}

/// Write the plist and hand it to launchd. If the job is already loaded (an earlier login), the
/// file is only rewritten — it takes effect at the next login — because unloading would end the
/// running broker and its sessions.
#[cfg(target_os = "macos")]
pub(crate) fn enable(program: &Path, arguments: &[String]) -> Result<(), String> {
    let path = plist_path().ok_or("no home directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(&path, render_launch_agent(LABEL, program, arguments))
        .map_err(|error| format!("write {}: {error}", path.display()))?;
    let uid = user_id()?;
    let target = format!("gui/{uid}/{LABEL}");
    let loaded = std::process::Command::new("launchctl")
        .args(["print", &target])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false);
    if loaded {
        return Ok(());
    }
    let output = std::process::Command::new("launchctl")
        .args(["bootstrap", &format!("gui/{uid}"), &path.to_string_lossy()])
        .output()
        .map_err(|error| format!("launchctl: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    // The file stays: launchd reads ~/Library/LaunchAgents at the next login regardless.
    let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if detail.is_empty() {
        Ok(())
    } else {
        Err(format!("launchctl bootstrap: {detail}"))
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn disable() -> Result<(), String> {
    let path = plist_path().ok_or("no home directory")?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove {}: {error}", path.display())),
    }
}

#[cfg(target_os = "macos")]
fn user_id() -> Result<String, String> {
    let output = std::process::Command::new("id")
        .arg("-u")
        .output()
        .map_err(|error| format!("id -u: {error}"))?;
    let uid = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if uid.is_empty() {
        return Err("id -u answered nothing".into());
    }
    Ok(uid)
}

#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
pub(crate) fn status(program: Option<&Path>) -> AutostartStatus {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;
    let enabled = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, KEY_READ)
        .and_then(|key| key.get_value::<String, _>(RUN_VALUE))
        .is_ok();
    AutostartStatus {
        supported: true,
        enabled,
        program: program.map(|path| path.to_string_lossy().into_owned()),
    }
}

#[cfg(windows)]
pub(crate) fn enable(program: &Path, arguments: &[String]) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(RUN_KEY)
        .map_err(|error| format!("open Run key: {error}"))?;
    key.set_value(RUN_VALUE, &render_run_value(program, arguments))
        .map_err(|error| format!("write Run value: {error}"))
}

#[cfg(windows)]
pub(crate) fn disable() -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;
    let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)
    {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("open Run key: {error}")),
    };
    match key.delete_value(RUN_VALUE) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("remove Run value: {error}")),
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(crate) fn status(program: Option<&Path>) -> AutostartStatus {
    AutostartStatus {
        supported: false,
        enabled: false,
        program: program.map(|path| path.to_string_lossy().into_owned()),
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(crate) fn enable(_program: &Path, _arguments: &[String]) -> Result<(), String> {
    Err("login start is not available on this platform".into())
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(crate) fn disable() -> Result<(), String> {
    Ok(())
}

#[tauri::command(async)]
pub(crate) fn broker_autostart_status(
    runtime: tauri::State<'_, crate::session_runtime::SessionRuntime>,
) -> AutostartStatus {
    let command = runtime.autostart_command();
    status(command.as_ref().map(|(program, _)| program.as_path()))
}

#[tauri::command(async)]
pub(crate) fn broker_autostart_set(
    runtime: tauri::State<'_, crate::session_runtime::SessionRuntime>,
    enabled: bool,
) -> Result<AutostartStatus, String> {
    let command = runtime.autostart_command();
    if enabled {
        let (program, arguments) = command
            .as_ref()
            .ok_or("the broker has no data directory to start from")?;
        enable(program, arguments)?;
    } else {
        disable()?;
    }
    Ok(status(
        command.as_ref().map(|(program, _)| program.as_path()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_launch_agent_runs_the_broker_at_load_with_every_argument_escaped() {
        let plist = render_launch_agent(
            "dev.talkak.desktop.broker",
            Path::new("/Users/me/Library/Application Support/dev.talkak.desktop/broker/b&roker"),
            &[
                "/Users/me/Library/Application Support/TalkakDev/broker/broker.sock".to_string(),
                "/Users/me/Library/Application Support/dev.talkak.desktop/sessions".to_string(),
            ],
        );
        assert!(plist.contains("<key>Label</key>\n    <string>dev.talkak.desktop.broker</string>"));
        assert!(plist.contains("<string>/Users/me/Library/Application Support/dev.talkak.desktop/broker/b&amp;roker</string>"));
        assert!(plist.contains("broker.sock</string>\n        <string>/Users/me/Library/Application Support/dev.talkak.desktop/sessions</string>\n    </array>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n    <true/>"));
        assert!(
            !plist.contains("KeepAlive"),
            "launchd must not restart a broker the app retired"
        );
    }

    #[test]
    fn the_run_value_quotes_the_program_and_each_argument() {
        let value = render_run_value(
            Path::new(
                r"C:\Users\me\AppData\Roaming\dev.talkak.desktop\broker\talkak-dev-broker-1.0.0-abcd.exe",
            ),
            &[
                r"\\.\pipe\talkak-dev-broker-me".to_string(),
                r"C:\Users\me\AppData\Roaming\dev.talkak.desktop\sessions".to_string(),
            ],
        );
        assert_eq!(
            value,
            r#""C:\Users\me\AppData\Roaming\dev.talkak.desktop\broker\talkak-dev-broker-1.0.0-abcd.exe" "\\.\pipe\talkak-dev-broker-me" "C:\Users\me\AppData\Roaming\dev.talkak.desktop\sessions""#
        );
    }
}
