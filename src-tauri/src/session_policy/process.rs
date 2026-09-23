use crate::session_runtime::SpawnSessionRequest;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const OUTPUT_LIMIT: u64 = 4 * 1024 * 1024; // MAX diagnostic output, never sent to the model or logs.
const INSPECTION_LIMIT: Duration = Duration::from_secs(8); // MAX wait for the read-only diagnostic.

pub(super) fn capture(
    request: &SpawnSessionRequest,
    args: &[String],
    cwd: &Path,
) -> Result<Vec<u8>, String> {
    let program = request
        .command
        .as_deref()
        .ok_or("Choose an agent command")?;
    let mut command = Command::new(resolve_program(program, request));
    command
        .args(args)
        .current_dir(cwd)
        .envs(request.env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW, paired with ordinary macOS pipes.
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not inspect agent startup instructions; try direct launch")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Missing agent diagnostic output")?;
    let (send, receive) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(OUTPUT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = send.send(result);
    });
    let deadline = Instant::now() + INSPECTION_LIMIT;
    let result = receive.recv_timeout(INSPECTION_LIMIT);
    // Terminate a timed-out/oversized diagnostic; stderr/output may contain private config, so
    // neither is placed in UI errors. A successful diagnostic is reaped as well.
    let oversized = matches!(&result, Ok(Ok(bytes)) if bytes.len() as u64 > OUTPUT_LIMIT);
    if !matches!(&result, Ok(Ok(_))) || oversized {
        let _ = child.kill();
    }
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "Could not finish agent instruction inspection")?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Agent instruction inspection timed out; try direct launch".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let bytes = result
        .map_err(|_| "Agent instruction inspection timed out; try direct launch")?
        .map_err(|_| "Could not read agent startup instructions")?;
    if oversized || !status.success() {
        return Err(
            "Agent instruction inspection failed; try direct launch without the app connection"
                .into(),
        );
    }
    Ok(bytes)
}

#[cfg(not(windows))]
fn resolve_program(program: &str, _request: &SpawnSessionRequest) -> PathBuf {
    program.into()
}

#[cfg(windows)]
fn resolve_program(program: &str, request: &SpawnSessionRequest) -> PathBuf {
    // npm-distributed CLIs can be .cmd files. Resolve PATHEXT before handing the explicit path to
    // Rust's Command, which performs Windows batch-file quoting; never build a shell command string.
    let configured_env = |name: &str| {
        request
            .env
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| std::ffi::OsString::from(value))
            .or_else(|| std::env::var_os(name))
    };
    let path = Path::new(program);
    let candidates: Vec<PathBuf> = if path.components().count() > 1 || path.is_absolute() {
        vec![path.to_path_buf()]
    } else {
        configured_env("PATH")
            .map(|paths| {
                std::env::split_paths(&paths)
                    .map(|dir| dir.join(path))
                    .collect()
            })
            .unwrap_or_default()
    };
    let extensions = configured_env("PATHEXT").unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
    for candidate in candidates {
        if candidate.is_file() {
            return candidate;
        }
        if candidate.extension().is_none() {
            for extension in extensions
                .to_string_lossy()
                .split(';')
                .filter(|ext| ext.starts_with('.'))
            {
                let candidate = candidate.with_extension(&extension[1..]);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    path.to_path_buf()
}
