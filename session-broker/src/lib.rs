//! Talkak session broker — a persistent, process-wide terminal session server.
//!
//! The app (client) asks the broker to `spawn` PTYs; because the broker is a separate, detached
//! process, those sessions survive the app closing, and the app reattaches on next launch — the
//! tmux-reattach behavior, now ours and cross-platform. See
//! `docs/design-windows-session-broker-2026-07-06.md`.

pub mod broker;
pub mod detach;
pub mod protocol;
pub mod server;
pub mod session;

pub use broker::Broker;
pub use detach::spawn_detached;
pub use protocol::{Request, Response, SessionInfo};
pub use session::{Session, SpawnSpec};

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn make(id: &str, program: &str, args: &[&str]) -> SpawnSpec {
        SpawnSpec {
            session_id: id.to_string(),
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: Vec::new(),
            cols: 80,
            rows: 24,
        }
    }

    // OS-aware builders so the SAME broker tests RUN on real x86-64 Windows in CI (ConPTY + cmd.exe),
    // not just macOS/Linux (openpty + bash). This is how the broker is runtime-verified on Windows.
    #[cfg(unix)]
    fn print_spec(id: &str, text: &str) -> SpawnSpec {
        make(id, "bash", &["-c", &format!("printf %s {text}")])
    }
    #[cfg(windows)]
    fn print_spec(id: &str, text: &str) -> SpawnSpec {
        // Trailing ping keeps the process alive ~1s so ConPTY flushes the echo before teardown —
        // a `cmd /C echo` that exits instantly can be torn down before its output is delivered.
        make(
            id,
            "cmd",
            &["/C", &format!("echo {text}& ping -n 2 127.0.0.1 >nul")],
        )
    }

    // Distinctive multi-char line markers — single letters like 'a'/'d' collide with ConPTY's setup
    // sequences (window title "C:\Windows\...\cmd.EXE" contains 'd'), which raced the assertion.
    #[cfg(unix)]
    fn lines_spec(id: &str) -> SpawnSpec {
        make(id, "bash", &["-c", "printf 'LN-a\\nLN-b\\nLN-c\\nLN-d\\n'"])
    }
    #[cfg(windows)]
    fn lines_spec(id: &str) -> SpawnSpec {
        make(
            id,
            "cmd",
            &[
                "/C",
                "echo LN-a&echo LN-b&echo LN-c&echo LN-d& ping -n 2 127.0.0.1 >nul",
            ],
        )
    }

    #[cfg(unix)]
    fn quick_spec(id: &str) -> SpawnSpec {
        make(id, "bash", &["-c", "true"])
    }
    #[cfg(windows)]
    fn quick_spec(id: &str) -> SpawnSpec {
        make(id, "cmd", &["/C", "ver"])
    }

    #[cfg(unix)]
    fn sleep_spec(id: &str) -> SpawnSpec {
        make(id, "bash", &["-c", "sleep 2"])
    }
    #[cfg(windows)]
    fn sleep_spec(id: &str) -> SpawnSpec {
        make(id, "cmd", &["/C", "ping -n 3 127.0.0.1 >nul"])
    }

    /// P1 verification: spawn a command through the broker, attach, and see its output — proving the
    /// PTY spawn + scrollback + fan-out path works end to end (on macOS's openpty backend).
    #[tokio::test]
    async fn spawn_attach_sees_output() {
        let broker = Broker::new();
        broker.spawn(print_spec("t1", "hello-broker")).unwrap();

        // Late attach still replays the scrollback (deterministic — no subscribe race).
        let session = broker.get("t1").expect("session registered");
        let mut got = String::new();
        for _ in 0..200 {
            let (sb, _rx) = session.attach();
            got = sb;
            if got.contains("hello-broker") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            got.contains("hello-broker"),
            "attach did not see output; got {got:?}"
        );
    }

    /// `list` reflects the live session + its pid, and reaps it after it exits.
    #[tokio::test]
    async fn list_reports_then_reaps() {
        let broker = Broker::new();
        broker.spawn(quick_spec("t2")).unwrap();
        let listed = broker.list();
        assert!(listed.iter().any(|s| s.session_id == "t2"));

        // After the child exits, list() reaps it. Poll — process exit + reap timing varies (esp. on
        // Windows CI, where a `cmd /C` child takes longer to be observed as exited).
        let mut reaped = false;
        for _ in 0..200 {
            let _ = broker.list(); // observes not-alive and removes
            if broker.get("t2").map(|s| !s.alive()).unwrap_or(true) {
                reaped = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(reaped, "session t2 not reaped after its child exited");
    }

    /// Spawning the same id twice while alive returns the SAME session (idempotent reattach).
    #[tokio::test]
    async fn spawn_is_idempotent_per_id() {
        let broker = Broker::new();
        let a = broker.spawn(sleep_spec("dup")).unwrap();
        let b = broker.spawn(sleep_spec("dup")).unwrap();
        assert_eq!(
            a.child_pid, b.child_pid,
            "second spawn must reuse the live session"
        );
        let _ = broker.kill("dup");
    }

    /// `capture` returns the scrollback tail (replaces tmux capture-pane).
    #[tokio::test]
    async fn capture_returns_scrollback_tail() {
        let broker = Broker::new();
        let session = broker.spawn(lines_spec("cap")).unwrap();
        let mut all = String::new();
        for _ in 0..200 {
            all = session.capture(0);
            if all.contains("LN-d") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            all.contains("LN-a") && all.contains("LN-d"),
            "capture(0) got {all:?}"
        );
        // Strict "last 2 lines only" — unix-only: ConPTY interleaves cursor ANSI with the echoes, so
        // newline-counting isn't clean on Windows. The tail bytes are still verified via capture(0).
        #[cfg(unix)]
        {
            let tail = session.capture(2);
            assert!(
                tail.contains("LN-d") && !tail.contains("LN-a"),
                "capture(2) got {tail:?}"
            );
        }
    }

    /// Write reaches the shell and its echo comes back through attach. Unix-only: relies on `cat`
    /// echoing stdin; the Windows write path is exercised at runtime via the app + a VM (Phase 5).
    #[cfg(unix)]
    #[tokio::test]
    async fn write_roundtrips() {
        let broker = Broker::new();
        let session = broker.spawn(make("io", "bash", &["-c", "cat"])).unwrap(); // cat echoes stdin
        session.write(b"ping\n").unwrap();
        let mut got = String::new();
        for _ in 0..50 {
            let (sb, _rx) = session.attach();
            got = sb;
            if got.contains("ping") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let _ = broker.kill("io");
        assert!(
            got.contains("ping"),
            "cat did not echo the write; got {got:?}"
        );
    }
}
