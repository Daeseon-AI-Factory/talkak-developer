//! Small, provider-owned selection rules that keep transcript discovery deterministic.

use crate::transcript_paths::normalised_path;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClaudeRecordIntent {
    ResumeExact(String),
    CurrentProjectExact(String),
    ExistingTargetUnbound,
    ForkNew,
}

/// Reads Claude CLI resume intent from the broker's persisted launch arguments.
pub(crate) fn claude_record_intent(args: &[String]) -> Option<ClaudeRecordIntent> {
    let args = args
        .split(|argument| argument == "--")
        .next()
        .unwrap_or(args);
    // A fork with a destination id writes that exact new file; it outranks the source resume id.
    for (index, argument) in args.iter().enumerate() {
        let value = argument.strip_prefix("--session-id=").or_else(|| {
            (argument == "--session-id")
                .then(|| args.get(index + 1))
                .flatten()
                .map(String::as_str)
        });
        if let Some(value) = value.filter(|value| is_uuid(value)) {
            return Some(ClaudeRecordIntent::CurrentProjectExact(
                value.to_ascii_lowercase(),
            ));
        }
    }
    if args.iter().any(|argument| argument == "--fork-session") {
        return Some(ClaudeRecordIntent::ForkNew);
    }

    let mut unbound_requested = false;
    for (index, argument) in args.iter().enumerate() {
        if matches!(argument.as_str(), "--continue" | "-c") {
            unbound_requested = true;
            continue;
        }
        let inline = ["--resume=", "-r="]
            .into_iter()
            .find_map(|prefix| argument.strip_prefix(prefix));
        if let Some(value) = inline {
            unbound_requested = true;
            if is_uuid(value) {
                return Some(ClaudeRecordIntent::ResumeExact(value.to_ascii_lowercase()));
            }
            continue;
        }
        if matches!(argument.as_str(), "--resume" | "-r") {
            unbound_requested = true;
            if let Some(value) = args.get(index + 1).filter(|value| is_uuid(value)) {
                return Some(ClaudeRecordIntent::ResumeExact(value.to_ascii_lowercase()));
            }
        }
    }

    if unbound_requested {
        Some(ClaudeRecordIntent::ExistingTargetUnbound)
    } else {
        None
    }
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

const MAX_CLAUDE_PROJECT_DIRS: usize = 512;

/// Finds one UUID-named Claude record across worktrees. Exceeding the directory bound or finding
/// the same UUID in more than one project is ambiguous and therefore returns no path.
pub(crate) fn unique_claude_resume_path(home: &Path, session_id: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(home.join(".claude/projects")).ok()?;
    let mut project_count = 0;
    let mut found = None;
    for entry in entries.flatten() {
        if !entry.file_type().ok().is_some_and(|kind| kind.is_dir()) {
            continue;
        }
        project_count += 1;
        if project_count > MAX_CLAUDE_PROJECT_DIRS {
            return None;
        }
        let path = entry.path().join(format!("{session_id}.jsonl"));
        if path.is_file() {
            if found.is_some() {
                return None;
            }
            found = Some(path);
        }
    }
    found
}

/// Canonical identity handles macOS symlinks and existing path spellings. Discovery still works
/// before a path exists by retaining the previous separator/case normalization fallback.
pub(crate) fn project_paths_match(left: &str, right: &str) -> bool {
    if normalised_path(left) == normalised_path(right) {
        return true;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn only_explicit_safe_claude_resume_targets_bind_an_existing_record() {
        for values in [
            vec!["--resume", ID],
            vec!["-r", ID],
            vec!["--resume=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
        ] {
            assert_eq!(
                claude_record_intent(&args(&values)),
                Some(ClaudeRecordIntent::ResumeExact(ID.into()))
            );
        }
        assert_eq!(
            claude_record_intent(&args(&["--session-id", ID])),
            Some(ClaudeRecordIntent::CurrentProjectExact(ID.into()))
        );
    }

    #[test]
    fn non_exact_existing_targets_are_explicitly_unbound() {
        assert_eq!(
            claude_record_intent(&args(&["--resume"])),
            Some(ClaudeRecordIntent::ExistingTargetUnbound)
        );
        assert_eq!(
            claude_record_intent(&args(&["--resume", "search term"])),
            Some(ClaudeRecordIntent::ExistingTargetUnbound)
        );
        assert_eq!(
            claude_record_intent(&args(&["-c"])),
            Some(ClaudeRecordIntent::ExistingTargetUnbound)
        );
        assert_eq!(
            claude_record_intent(&args(&["--continue"])),
            Some(ClaudeRecordIntent::ExistingTargetUnbound)
        );
        assert_eq!(
            claude_record_intent(&args(&["--resume", ID, "--fork-session"])),
            Some(ClaudeRecordIntent::ForkNew)
        );
        assert_eq!(claude_record_intent(&args(&["--", "--continue"])), None);
    }

    #[test]
    fn destination_session_id_wins_over_fork_source() {
        let destination = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        assert_eq!(
            claude_record_intent(&args(&[
                "--session-id",
                destination,
                "--fork-session",
                "--resume",
                ID,
            ])),
            Some(ClaudeRecordIntent::CurrentProjectExact(destination.into()))
        );
    }

    #[test]
    fn exact_resume_scan_requires_one_bounded_worktree_match() {
        let temp = tempfile::TempDir::new().unwrap();
        let first = temp.path().join(".claude/projects/first");
        let second = temp.path().join(".claude/projects/second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let expected = first.join(format!("{ID}.jsonl"));
        std::fs::write(&expected, "").unwrap();
        assert_eq!(unique_claude_resume_path(temp.path(), ID), Some(expected));

        std::fs::write(second.join(format!("{ID}.jsonl")), "").unwrap();
        assert_eq!(unique_claude_resume_path(temp.path(), ID), None);
    }

    #[test]
    fn existing_paths_compare_by_canonical_identity() {
        let temp = tempfile::TempDir::new().unwrap();
        let directory = temp.path().join("project");
        std::fs::create_dir_all(directory.join("child")).unwrap();
        assert!(project_paths_match(
            &directory.to_string_lossy(),
            &directory.join("child/..").to_string_lossy(),
        ));
        assert!(project_paths_match("missing/project/", "missing/project"));
    }
}
