use crate::project_commands::{
    validate_launch_command, validate_project_path, LaunchCommandIssue, ProjectPathIssue,
};

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

#[test]
fn an_empty_launch_command_stays_valid_because_it_means_the_default_terminal() {
    for value in ["", "   "] {
        let result = validate_launch_command(value);
        assert!(
            result.valid,
            "{value:?} should keep the default-terminal choice"
        );
        assert_eq!(result.reason, None);
    }
}

#[test]
fn a_launch_command_that_resolves_nowhere_is_refused_before_it_reaches_the_process_api() {
    let result = validate_launch_command("talkak-command-that-does-not-exist");
    assert!(!result.valid);
    assert_eq!(result.reason, Some(LaunchCommandIssue::NotFound));
}

#[test]
fn a_bare_command_on_the_search_path_resolves() {
    let bare = if cfg!(windows) { "cmd" } else { "sh" };
    let result = validate_launch_command(bare);
    assert!(result.valid, "{bare} should resolve through PATH");
    assert_eq!(result.reason, None);
}

#[test]
fn an_absolute_path_to_a_directory_is_not_an_executable() {
    let cwd = std::env::current_dir().expect("test working directory should resolve");
    let result = validate_launch_command(cwd.to_string_lossy().as_ref());
    assert!(!result.valid);
    assert_eq!(result.reason, Some(LaunchCommandIssue::NotFound));
}
