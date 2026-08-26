use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProjectPathIssue {
    Empty,
    NotAbsolute,
    NotDirectory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectPathValidation {
    pub(crate) valid: bool,
    pub(crate) reason: Option<ProjectPathIssue>,
}

#[tauri::command]
pub(crate) fn project_validate_path(path: String) -> ProjectPathValidation {
    validate_project_path(&path)
}

pub(crate) fn validate_project_path(value: &str) -> ProjectPathValidation {
    let value = value.trim();
    let issue = if value.is_empty() {
        Some(ProjectPathIssue::Empty)
    } else {
        let path = Path::new(value);
        if !path.is_absolute() {
            Some(ProjectPathIssue::NotAbsolute)
        } else if !path.is_dir() {
            Some(ProjectPathIssue::NotDirectory)
        } else {
            None
        }
    };
    ProjectPathValidation {
        valid: issue.is_none(),
        reason: issue,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LaunchCommandIssue {
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchCommandValidation {
    pub(crate) valid: bool,
    pub(crate) reason: Option<LaunchCommandIssue>,
}

#[tauri::command]
pub(crate) fn project_validate_command(command: String) -> LaunchCommandValidation {
    validate_launch_command(&command)
}

/// A saved launch command is checked the same way the working directory already is, so an
/// unresolvable executable is refused in the dialog instead of reaching `CreateProcessW` and
/// surfacing a raw OS error in a terminal pane.
pub(crate) fn validate_launch_command(value: &str) -> LaunchCommandValidation {
    let value = value.trim();
    // An empty command is the documented "OS default terminal" choice, never a failure.
    let issue = if value.is_empty() || resolves_to_executable(value) {
        None
    } else {
        Some(LaunchCommandIssue::NotFound)
    };
    LaunchCommandValidation {
        valid: issue.is_none(),
        reason: issue,
    }
}

fn resolves_to_executable(value: &str) -> bool {
    let candidate = Path::new(value);
    // Anything carrying a separator is a path the user chose; only a bare name searches PATH.
    if candidate.is_absolute() || candidate.components().count() > 1 {
        return executable_exists(candidate);
    }
    let Some(search_path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&search_path)
        .filter(|directory| !directory.as_os_str().is_empty())
        .any(|directory| executable_exists(&directory.join(value)))
}

#[cfg(windows)]
fn executable_exists(path: &Path) -> bool {
    if path.is_file() {
        return true;
    }
    // A bare `git` resolves through PATHEXT on Windows exactly as the shell would resolve it.
    let Some(extensions) = std::env::var_os("PATHEXT") else {
        return false;
    };
    extensions
        .to_string_lossy()
        .split(';')
        .filter(|extension| !extension.is_empty())
        .any(|extension| {
            let mut candidate = std::ffi::OsString::from(path.as_os_str());
            candidate.push(extension);
            Path::new(&candidate).is_file()
        })
}

#[cfg(not(windows))]
fn executable_exists(path: &Path) -> bool {
    path.is_file()
}
