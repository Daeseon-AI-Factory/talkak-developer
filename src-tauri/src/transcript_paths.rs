//! Filesystem naming rules shared by transcript discovery and reading.
//!
//!   Claude Code  ~/.claude/projects/<cwd with every non-alphanumeric turned into '-'>/<id>.jsonl
//!   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl
//!   Antigravity  ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl
//!
//! Codex does not encode the directory in the path, so its first line — `session_meta` — carries
//! `payload.cwd` and that is what a project is matched against. Antigravity records no directory at
//! all, so only launch-time proximity can bind one.

use std::path::{Path, PathBuf};

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

pub(crate) fn modified_at(path: &Path) -> std::time::SystemTime {
    std::fs::metadata(path)
        .and_then(|data| data.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
}

/// Claude Code's directory name for a working directory: every character that is not a letter or a
/// digit becomes '-'. `C:\Sources\talkak-developer` becomes `C--Sources-talkak-developer`, and a
/// UNC path keeps its leading pair as `--`.
///
/// Past 200 characters the name is truncated and a hash of the ORIGINAL path is appended, so two
/// deep paths sharing a long prefix stay apart. The hash is the harness's own `h*31 + charCode`
/// over UTF-16 units, rendered in base 36; `encode_utf16` rather than `chars` matters the moment a
/// path contains Korean or an emoji.
pub(crate) fn claude_project_dir_name(project_path: &str) -> String {
    // Per UTF-16 CODE UNIT, not per char. The harness does this with a JavaScript regex carrying no
    // /u flag, so an astral character — an emoji in a path — is two units and becomes two dashes.
    // Iterating chars would produce one, and the name would not match the directory on disk.
    // (Hangul is in the BMP, so a Korean path is unaffected either way.)
    let sanitised: String = project_path
        .encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() => byte as char,
            _ => '-',
        })
        .collect();
    // Every replacement is ASCII, so the sanitised string is ASCII and a char count is a unit count.
    if sanitised.chars().count() <= 200 {
        return sanitised;
    }
    let head: String = sanitised.chars().take(200).collect();
    format!("{head}-{}", base36(hash32(project_path)))
}

fn hash32(text: &str) -> i32 {
    let mut hash: i32 = 0;
    for unit in text.encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(i32::from(unit));
    }
    hash
}

/// Base 36 of the hash's magnitude, matching `Math.abs(h).toString(36)`.
///
/// Widened to i64 before taking the magnitude: `i32::MIN.wrapping_abs()` is still `i32::MIN`, which
/// is negative, so a `while value > 0` loop produced an EMPTY string and a directory name ending in
/// a bare dash. JavaScript answers "zik0zk" there.
fn base36(value: i32) -> String {
    let mut magnitude = i64::from(value).abs();
    if magnitude == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    while magnitude > 0 {
        out.push(DIGITS[(magnitude % 36) as usize]);
        magnitude /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Paths compared the way a user means them: separators and case do not distinguish two spellings
/// of the same directory on Windows, and a trailing separator never does anywhere.
pub(crate) fn normalised_path(path: &str) -> String {
    let unified = path.replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn collect_rollouts(directory: &Path, found: &mut Vec<PathBuf>, depth: usize) {
    // sessions/YYYY/MM/DD — deeper than that is not this layout, and a symlink loop is not a hazard
    // worth inheriting.
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollouts(&path, found, depth + 1);
        } else if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        {
            found.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_working_directory_becomes_the_name_claude_code_actually_uses() {
        // Verified against the real directory on this machine.
        assert_eq!(
            claude_project_dir_name("C:\\Sources\\talkak-developer"),
            "C--Sources-talkak-developer"
        );
        // A UNC path keeps its leading pair, and dots collapse the same way separators do.
        assert_eq!(
            claude_project_dir_name("\\\\wsl.localhost\\Ubuntu\\home\\daeseony"),
            "--wsl-localhost-Ubuntu-home-daeseony"
        );
    }

    #[test]
    fn two_spellings_of_one_directory_match() {
        assert_eq!(
            normalised_path("C:\\Sources\\talkak-developer\\"),
            normalised_path("C:/Sources/talkak-developer")
        );
        if cfg!(windows) {
            assert_eq!(
                normalised_path("C:/Sources/talkak-developer"),
                normalised_path("c:/sources/talkak-developer")
            );
        } else {
            assert_ne!(
                normalised_path("C:/Sources/talkak-developer"),
                normalised_path("c:/sources/talkak-developer")
            );
        }
        assert_ne!(
            normalised_path("C:/Sources/talkak"),
            normalised_path("C:/Sources/talkak-developer")
        );
    }

    #[test]
    fn base36_matches_javascript_including_the_edge_that_returned_nothing() {
        // Math.abs(-2147483648).toString(36) === "zik0zk". Taking the magnitude in i32 leaves
        // i32::MIN negative, and the loop then produced an empty suffix — a name ending in a dash.
        assert_eq!(base36(i32::MIN), "zik0zk");
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        // The sign is dropped, never carried into the name.
        assert_eq!(base36(-36), "10");
    }

    #[test]
    fn an_astral_character_counts_as_the_two_units_the_harness_sees() {
        // The harness sanitises with a JavaScript regex that has no /u flag, so an emoji is two
        // code units and becomes two dashes. Per char it would be one, and the computed name would
        // not match the directory that actually exists.
        assert_eq!(claude_project_dir_name("a\u{1F600}b"), "a--b");
        // Hangul is in the BMP: one unit, one dash, either way.
        assert_eq!(claude_project_dir_name("a한b"), "a-b");
    }

    #[test]
    fn a_path_past_two_hundred_characters_keeps_a_hash_of_the_original() {
        let deep = format!("C:\\{}", "segment\\".repeat(40));
        let name = claude_project_dir_name(&deep);
        assert!(
            name.chars().count() > 200,
            "the hash suffix is appended, not folded in"
        );
        assert!(name
            .chars()
            .take(200)
            .all(|c| c.is_ascii_alphanumeric() || c == '-'));
        // Two long paths sharing the first 200 characters must not collide.
        let sibling = format!("{deep}other\\");
        assert_ne!(name, claude_project_dir_name(&sibling));
    }
}
