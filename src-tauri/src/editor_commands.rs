//! Opening a `path:line` reference clicked in a terminal pane.
//!
//! The editor is configuration, not code (AGENTS.md law 1): with no editor command configured
//! the file opens with the OS default app, and a configured command is a per-device setting the
//! renderer stores, never a product default. Either way the path is resolved and checked against
//! the session's working directory and the project root FIRST, so a reference in agent output can
//! never walk this app into opening a file outside the workspace it was pointed at.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum OpenSourceLocationFailureKind {
    NotFound,
    NotAFile,
    OutsideWorkspace,
    EditorNotFound,
    EditorFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct OpenSourceLocationFailure {
    pub(crate) kind: OpenSourceLocationFailureKind,
    pub(crate) detail: String,
}

impl OpenSourceLocationFailure {
    fn new(kind: OpenSourceLocationFailureKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenSourceLocationRequest {
    cwd: String,
    project_root: String,
    path: String,
    line: u32,
    #[serde(default)]
    column: Option<u32>,
    #[serde(default)]
    editor_command: Option<String>,
    #[serde(default)]
    editor_args_template: Option<Vec<String>>,
}

#[tauri::command]
pub(crate) fn open_source_location(
    request: OpenSourceLocationRequest,
) -> Result<(), OpenSourceLocationFailure> {
    let resolved = resolve_within_workspace(&request.cwd, &request.project_root, &request.path)?;
    let command = request
        .editor_command
        .as_deref()
        .map(str::trim)
        .filter(|command| !command.is_empty());
    match command {
        Some(command) => spawn_editor(
            command,
            request.editor_args_template.as_deref(),
            &resolved,
            request.line,
            request.column,
        ),
        None => open_with_os_default(&resolved),
    }
}

/// `path` joined onto `cwd` when relative, then canonicalised and checked to exist inside `cwd`
/// or `project_root` — whichever resolves. A symlink that escapes both is caught because
/// canonicalize resolves it before the `starts_with` check runs.
fn resolve_within_workspace(
    cwd: &str,
    project_root: &str,
    path: &str,
) -> Result<PathBuf, OpenSourceLocationFailure> {
    let raw = Path::new(path);
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        Path::new(cwd).join(raw)
    };
    let resolved = std::fs::canonicalize(&candidate)
        .map_err(|_| OpenSourceLocationFailure::new(NotFound, candidate.display().to_string()))?;
    if !resolved.is_file() {
        return Err(OpenSourceLocationFailure::new(
            NotAFile,
            resolved.display().to_string(),
        ));
    }
    let inside_workspace = [cwd, project_root]
        .iter()
        .filter_map(|boundary| std::fs::canonicalize(boundary).ok())
        .any(|boundary| resolved.starts_with(&boundary));
    if !inside_workspace {
        return Err(OpenSourceLocationFailure::new(
            OutsideWorkspace,
            resolved.display().to_string(),
        ));
    }
    Ok(resolved)
}

use OpenSourceLocationFailureKind::{
    EditorFailed, EditorNotFound, NotAFile, NotFound, OutsideWorkspace,
};

fn spawn_editor(
    command: &str,
    args_template: Option<&[String]>,
    file: &Path,
    line: u32,
    column: Option<u32>,
) -> Result<(), OpenSourceLocationFailure> {
    if !crate::project_commands::validate_launch_command(command).valid {
        return Err(OpenSourceLocationFailure::new(EditorNotFound, command));
    }
    let file_text = file.to_string_lossy().into_owned();
    // An empty or unset template just opens the file, which is what most editors want as their
    // sole argument; a saved template can still add `-g {file}:{line}:{column}` for one that
    // understands a line jump.
    let default_template = ["{file}".to_string()];
    let template: &[String] = match args_template {
        Some(items) if !items.is_empty() => items,
        _ => &default_template,
    };
    let args: Vec<String> = template
        .iter()
        .map(|arg| substitute_editor_args(arg, &file_text, line, column))
        .collect();
    std::process::Command::new(command)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|error| OpenSourceLocationFailure::new(EditorFailed, error.to_string()))
}

fn substitute_editor_args(template: &str, file: &str, line: u32, column: Option<u32>) -> String {
    let column_text = column.map(|value| value.to_string()).unwrap_or_default();
    template
        .replace("{file}", file)
        .replace("{line}", &line.to_string())
        .replace("{column}", &column_text)
}

#[cfg(windows)]
fn open_with_os_default(file: &Path) -> Result<(), OpenSourceLocationFailure> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd.exe")
        .args(["/D", "/S", "/C", "start", ""])
        .arg(file)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|error| OpenSourceLocationFailure::new(EditorFailed, error.to_string()))
}

#[cfg(not(windows))]
fn open_with_os_default(file: &Path) -> Result<(), OpenSourceLocationFailure> {
    std::process::Command::new("open")
        .arg(file)
        .spawn()
        .map(|_| ())
        .map_err(|error| OpenSourceLocationFailure::new(EditorFailed, error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_a_relative_path_inside_the_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("src.rs");
        std::fs::write(&file, "fn main() {}").unwrap();
        let cwd = dir.path().to_string_lossy().into_owned();
        let resolved = resolve_within_workspace(&cwd, &cwd, "src.rs").unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&file).unwrap());
    }

    #[test]
    fn rejects_a_path_that_escapes_both_boundaries() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("secret.txt");
        std::fs::write(&file, "nope").unwrap();
        let cwd = workspace.path().to_string_lossy().into_owned();
        let failure =
            resolve_within_workspace(&cwd, &cwd, file.to_string_lossy().as_ref()).unwrap_err();
        assert_eq!(
            failure.kind,
            OpenSourceLocationFailureKind::OutsideWorkspace
        );
    }

    #[test]
    fn allows_a_path_inside_the_project_root_even_off_the_session_cwd() {
        let project = tempfile::tempdir().unwrap();
        let cwd = tempfile::tempdir().unwrap();
        let file = project.path().join("lib.rs");
        std::fs::write(&file, "").unwrap();
        let resolved = resolve_within_workspace(
            &cwd.path().to_string_lossy(),
            &project.path().to_string_lossy(),
            file.to_string_lossy().as_ref(),
        )
        .unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&file).unwrap());
    }

    #[test]
    fn reports_a_missing_file_as_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_string_lossy().into_owned();
        let failure = resolve_within_workspace(&cwd, &cwd, "missing.rs").unwrap_err();
        assert_eq!(failure.kind, OpenSourceLocationFailureKind::NotFound);
    }

    #[test]
    fn reports_a_directory_as_not_a_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        let cwd = dir.path().to_string_lossy().into_owned();
        let failure = resolve_within_workspace(&cwd, &cwd, "sub").unwrap_err();
        assert_eq!(failure.kind, OpenSourceLocationFailureKind::NotAFile);
    }

    #[test]
    fn substitutes_every_placeholder() {
        let args = substitute_editor_args("-g {file}:{line}:{column}", "/a/b.rs", 12, Some(5));
        assert_eq!(args, "-g /a/b.rs:12:5");
    }

    #[test]
    fn leaves_a_missing_column_blank_rather_than_printing_undefined() {
        let args = substitute_editor_args("{file}:{line}:{column}", "/a/b.rs", 12, None);
        assert_eq!(args, "/a/b.rs:12:");
    }

    #[test]
    fn refuses_an_editor_command_that_does_not_resolve() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.rs");
        std::fs::write(&file, "").unwrap();
        let failure =
            spawn_editor("talkak-editor-that-does-not-exist", None, &file, 1, None).unwrap_err();
        assert_eq!(failure.kind, OpenSourceLocationFailureKind::EditorNotFound);
    }
}
