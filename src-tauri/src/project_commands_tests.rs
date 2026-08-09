use crate::project_commands::{validate_project_path, ProjectPathIssue};

#[test]
fn project_path_validation_rejects_empty_and_relative_paths() {
    assert_eq!(
        validate_project_path(" ").reason,
        Some(ProjectPathIssue::Empty)
    );
    assert_eq!(
        validate_project_path("relative/path").reason,
        Some(ProjectPathIssue::NotAbsolute)
    );
}

#[test]
fn project_path_validation_accepts_an_existing_absolute_directory() {
    let cwd = std::env::current_dir().expect("test working directory should resolve");
    let result = validate_project_path(cwd.to_string_lossy().as_ref());
    assert!(result.valid);
    assert_eq!(result.reason, None);
}
