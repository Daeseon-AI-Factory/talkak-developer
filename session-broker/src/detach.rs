//! The ONE platform-specific seam of the broker: spawning it **detached** so it outlives the app
//! (that detachment is what makes sessions persist). Everything else in the crate is neutral.
//!
//! The app calls `spawn_detached(broker_path, &[socket_path])` once (via its `ensure_broker`), then
//! talks to the broker over the transport. Unix is exercised on macOS in tests; the Windows arm is
//! `#[cfg(windows)]` (GHA-compiled, VM-run).

use std::process::{Child, Command, Stdio};

/// Launch the broker binary as a detached background process.
pub fn spawn_detached(program: &str, args: &[&str]) -> std::io::Result<Child> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // New process group (setpgid to 0): the broker leaves the app's process group, so a SIGINT
        // to the app's foreground group or a terminal SIGHUP never reaches it. Combined with the app
        // not waiting on it, the broker survives the app exiting — the persistence guarantee.
        cmd.process_group(0);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS: no console inherited. CREATE_NEW_PROCESS_GROUP: not killed by the app's
        // Ctrl-C/console close. A Job Object that does NOT set KILL_ON_JOB_CLOSE is added app-side so
        // the broker is not reaped when the app's job ends (Phase 5).
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }

    cmd.spawn()
}
