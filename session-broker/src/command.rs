//! How a spawn request becomes the command a PTY boots: the shell chosen when the project names
//! none, the terminal identity every child is told, and the colour suppressors stripped from the
//! inherited environment.

use crate::runtime::SpawnSessionRequest;
use portable_pty::{CommandBuilder, PtySize};

pub fn command_for_request(request: &SpawnSessionRequest) -> CommandBuilder {
    let mut command = match request.command.as_deref() {
        Some(program) => CommandBuilder::new(program),
        None => default_shell_command(),
    };
    command.args(&request.args);
    if let Some(cwd) = request.cwd.as_deref() {
        command.cwd(cwd);
    }
    // portable-pty inherits this process's environment, and a Windows GUI process carries neither
    // variable, so every colour-capable CLI fell back to monochrome. The renderer is xterm.js on
    // both platforms, so tell the child exactly what it is talking to.
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    // ...and drop anything in the inherited environment that countermands that. The broker outlives
    // the app that starts it, so whatever environment happened to launch it is stamped on every
    // shell it will ever open. Launched once from a terminal carrying NO_COLOR=1, it set
    // $PSStyle.OutputRendering to PlainText in every pane — `Write-Host -ForegroundColor Red` came
    // out as bare text — while TERM and COLORTERM sat there claiming the opposite.
    for suppressor in ["NO_COLOR", "ANSI_COLORS_DISABLED"] {
        command.env_remove(suppressor);
    }
    // CLICOLOR=0 is the BSD and macOS spelling of the same instruction, and this product has to
    // behave identically on both platforms — a mac launched from a shell carrying it would lose
    // colour exactly as Windows did with NO_COLOR. Asked of the builder, which is already seeded
    // from this process's environment, so the question is what the child would really receive.
    // Only the disabling "0" goes: CLICOLOR_FORCE and a deliberate CLICOLOR=1 are someone choosing
    // colour, and removing those would override the user rather than the accident.
    if command
        .get_env("CLICOLOR")
        .is_some_and(|value| value == "0")
    {
        command.env_remove("CLICOLOR");
    }
    command
}

/// The shell a pane boots when the project names no command. portable-pty's default on Windows is
/// %COMSPEC% — cmd.exe — where a developer's first `ls` answers "not recognized". A developer
/// workspace boots a developer shell: pwsh if installed, Windows PowerShell otherwise, and cmd only
/// when neither resolves. Unix keeps the login shell portable-pty already picks.
#[cfg(windows)]
pub fn default_shell_command() -> CommandBuilder {
    for shell in ["pwsh.exe", "powershell.exe"] {
        if resolves_on_path(shell) {
            let mut command = CommandBuilder::new(shell);
            // Skip the copyright banner; the user's profile still loads.
            command.args(["-NoLogo"]);
            return command;
        }
    }
    CommandBuilder::new_default_prog()
}

#[cfg(not(windows))]
pub fn default_shell_command() -> CommandBuilder {
    CommandBuilder::new_default_prog()
}

#[cfg(windows)]
fn resolves_on_path(program: &str) -> bool {
    let Some(search_path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&search_path)
        .filter(|directory| !directory.as_os_str().is_empty())
        .any(|directory| directory.join(program).is_file())
}

pub(crate) fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}
