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
