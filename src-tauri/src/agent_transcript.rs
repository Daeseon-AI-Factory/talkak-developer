//! What the agent in a pane actually said, read from the record it already keeps.
//!
//! The inspector has had a summary view and a conversation-log view since the workspace was
//! extracted, and nothing ever filled them: `conversation` is initialised to `[]` and never
//! appended to, `summary.changedFiles` and `summary.decisions` likewise, and the only writer of
//! either is `demo.ts`. Every real session showed an empty panel under a note promising a
//! transcript adapter.
//!
//! This is that adapter. Both agents this product runs already write a structured JSONL record of
//! their own session, which is a far better source than scraping the terminal: the turns are
//! already separated, the text is not wrapped to the pane width, and the file edits are named
//! rather than inferred from prose.
//!
//!   Claude Code  ~/.claude/projects/<cwd with every non-alphanumeric turned into '-'>/<id>.jsonl
//!   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl
//!
//! Codex does not encode the directory in the path, so its first line — `session_meta` — carries
//! `payload.cwd` and that is what a project is matched against.
//!
//! Only what the panel needs crosses the IPC boundary. One of these files reached 16 MB in a single
//! session; handing that to the renderer to filter would be worse than showing nothing.

use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// One turn, normalised across both agents.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptEntry {
    /// "user" or "assistant" — the two roles a reader cares about.
    pub role: String,
    pub text: String,
    pub at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTranscript {
    /// Which agent wrote this record: "claude" or "codex".
    pub source: String,
    /// The record's own path, so a reader can go find it.
    pub path: String,
    /// Newest last, capped — the tail is what anyone reads.
    pub entries: Vec<TranscriptEntry>,
    /// How many turns the whole record holds, so a truncated tail can say so.
    pub total_entries: usize,
    /// Files the agent edited or wrote, most recently touched last.
    pub changed_files: Vec<String>,
    pub last_activity: Option<String>,
}

/// The newest transcript for a project directory, or None when neither agent has written one.
///
/// `limit` caps the returned turns. Errors are RETURNED: an empty panel that means "no record" and
/// one that means "the record could not be read" are different facts, and this app has shipped the
/// wrong one of those often enough.
#[tauri::command]
pub(crate) fn agent_transcript(
    project_path: String,
    limit: usize,
) -> Result<Option<AgentTranscript>, String> {
    let home = home_dir().ok_or_else(|| "could not resolve the home directory".to_string())?;
    let limit = limit.clamp(1, 2000);

    let claude = newest_claude_record(&home, &project_path);
    let codex = newest_codex_record(&home, &project_path)?;

    // Whichever agent spoke last is the one the pane is showing.
    let chosen = match (claude, codex) {
        (Some(a), Some(b)) => Some(if modified_at(&a) >= modified_at(&b) {
            a
        } else {
            b
        }),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    };
    let Some(path) = chosen else {
        return Ok(None);
    };

    let is_codex = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("rollout-"));
    if is_codex {
        read_codex(&path, limit).map(Some)
    } else {
        read_claude(&path, limit).map(Some)
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn modified_at(path: &Path) -> std::time::SystemTime {
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

fn newest_claude_record(home: &Path, project_path: &str) -> Option<PathBuf> {
    let root = home.join(".claude").join("projects");
    let wanted = claude_project_dir_name(project_path);
    // Enumerated, not built. Windows and a default APFS volume are case-insensitive, so two cwds
    // differing only in drive-letter case produce two different names but land in ONE directory —
    // building the path and reading it would intermittently find nothing. On a case-sensitive
    // volume both spellings can exist, so an exact match wins over a case-insensitive one.
    let entries = std::fs::read_dir(&root).ok()?;
    let mut fallback: Option<PathBuf> = None;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == wanted {
            return newest_jsonl(&entry.path(), |file| file.ends_with(".jsonl"));
        }
        if fallback.is_none() && name.eq_ignore_ascii_case(&wanted) {
            fallback = Some(entry.path());
        }
    }
    newest_jsonl(&fallback?, |file| file.ends_with(".jsonl"))
}

fn newest_jsonl(directory: &Path, accept: impl Fn(&str) -> bool) -> Option<PathBuf> {
    let entries = std::fs::read_dir(directory).ok()?;
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(&accept)
        })
        .max_by_key(|path| modified_at(path))
}

/// Codex records the directory inside the file, so every candidate's first line is read to find the
/// ones belonging to this project. Only the first line — these files reach tens of megabytes.
fn newest_codex_record(home: &Path, project_path: &str) -> Result<Option<PathBuf>, String> {
    let root = home.join(".codex").join("sessions");
    if !root.is_dir() {
        return Ok(None);
    }
    let mut candidates = Vec::new();
    collect_rollouts(&root, &mut candidates, 0);
    let wanted = normalised_path(project_path);
    let mut best: Option<PathBuf> = None;
    for path in candidates {
        let Ok(file) = std::fs::File::open(&path) else {
            continue;
        };
        let mut first = String::new();
        if BufReader::new(file).read_line(&mut first).is_err() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&first) else {
            continue;
        };
        let Some(payload) = value.get("payload") else {
            continue;
        };
        let cwd = payload
            .get("cwd")
            .and_then(|cwd| cwd.as_str())
            .unwrap_or_default();
        if normalised_path(cwd) != wanted {
            continue;
        }
        // A subagent thread records the SAME cwd as the parent that spawned it, and there are far
        // more of them — 91 of 100 rollout files on this machine. Matching on the directory alone
        // picked a subagent's private conversation and showed it as the session's own.
        if payload
            .get("thread_source")
            .and_then(|source| source.as_str())
            != Some("user")
        {
            continue;
        }
        if best
            .as_ref()
            .is_none_or(|current| modified_at(&path) > modified_at(current))
        {
            best = Some(path);
        }
    }
    Ok(best)
}

/// Paths compared the way a user means them: separators and case do not distinguish two spellings
/// of the same directory on Windows, and a trailing separator never does anywhere.
fn normalised_path(path: &str) -> String {
    let unified = path.replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_string()
    }
}

fn collect_rollouts(directory: &Path, found: &mut Vec<PathBuf>, depth: usize) {
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

/// A bounded tail of turns plus every file touched, in one pass over the file.
struct Collected {
    entries: VecDeque<TranscriptEntry>,
    total: usize,
    changed: Vec<String>,
    last_at: Option<String>,
    /// The message id of the turn still being folded into, if any.
    open_group: Option<String>,
}

impl Collected {
    fn new() -> Self {
        Self {
            entries: VecDeque::new(),
            total: 0,
            changed: Vec::new(),
            last_at: None,
            open_group: None,
        }
    }

    fn push(&mut self, entry: TranscriptEntry, limit: usize) {
        self.total += 1;
        if entry.at.is_some() {
            self.last_at = entry.at.clone();
        }
        self.entries.push_back(entry);
        while self.entries.len() > limit {
            self.entries.pop_front();
        }
    }

    /// Appends, or folds into the turn already open under the same id. A merged block joins the
    /// text it continues rather than starting a new turn, and does not count as another turn.
    fn push_merging(&mut self, entry: TranscriptEntry, group: Option<String>, limit: usize) {
        if let Some(id) = group {
            if self.open_group.as_deref() == Some(id.as_str()) {
                if let Some(last) = self.entries.back_mut() {
                    last.text.push_str("\n\n");
                    last.text.push_str(&entry.text);
                    if entry.at.is_some() {
                        self.last_at = entry.at;
                    }
                    return;
                }
            }
            self.open_group = Some(id);
        } else {
            self.open_group = None;
        }
        self.push(entry, limit);
    }

    fn touched(&mut self, file: &str) {
        // Most recently touched last, and named once however many times it was edited.
        self.changed.retain(|existing| existing != file);
        self.changed.push(file.to_string());
    }

    fn finish(self, source: &str, path: &Path) -> AgentTranscript {
        AgentTranscript {
            source: source.to_string(),
            path: path.to_string_lossy().into_owned(),
            entries: self.entries.into_iter().collect(),
            total_entries: self.total,
            changed_files: self.changed,
            last_activity: self.last_at,
        }
    }
}

fn lines_of(path: &Path) -> Result<impl Iterator<Item = String>, String> {
    let file = std::fs::File::open(path)
        .map_err(|error| format!("could not open the agent record: {error}"))?;
    Ok(BufReader::new(file).lines().map_while(Result::ok))
}

fn read_claude(path: &Path, limit: usize) -> Result<AgentTranscript, String> {
    let mut collected = Collected::new();
    for line in lines_of(path)? {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        // Sidechain entries are a subagent's own conversation, and meta entries are the harness
        // talking to itself. Neither is what the person in front of the pane was doing.
        if value.get("isSidechain").and_then(|f| f.as_bool()) == Some(true)
            || value.get("isMeta").and_then(|f| f.as_bool()) == Some(true)
        {
            continue;
        }
        let role = match value.get("type").and_then(|t| t.as_str()) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let at = value
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(str::to_string);
        let content = value
            .get("message")
            .and_then(|message| message.get("content"));
        let mut text = String::new();
        match content {
            Some(serde_json::Value::String(plain)) => text.push_str(plain),
            Some(serde_json::Value::Array(blocks)) => {
                for block in blocks {
                    match block.get("type").and_then(|t| t.as_str()) {
                        // Thinking is the model's private reasoning, not part of the conversation.
                        Some("text") => {
                            if let Some(value) = block.get("text").and_then(|t| t.as_str()) {
                                if !text.is_empty() {
                                    text.push_str("\n\n");
                                }
                                text.push_str(value);
                            }
                        }
                        Some("tool_use") => {
                            let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                            if matches!(name, "Edit" | "Write" | "NotebookEdit") {
                                if let Some(file) = block
                                    .get("input")
                                    .and_then(|input| input.get("file_path"))
                                    .and_then(|file| file.as_str())
                                {
                                    collected.touched(file);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        let text = strip_harness_wrapper(&text);
        if text.is_empty() {
            continue;
        }
        // One assistant answer is written as several lines — one per content block — all carrying
        // the same message.id. Most of them are: 483 of 895 in one file here span more than one
        // line, up to five. Rendered per line, a single reply appeared as five separate bubbles.
        let message_id = value
            .get("message")
            .and_then(|message| message.get("id"))
            .and_then(|id| id.as_str())
            .map(str::to_string);
        collected.push_merging(
            TranscriptEntry {
                role: role.to_string(),
                text,
                at,
            },
            message_id.filter(|_| role == "assistant"),
            limit,
        );
    }
    Ok(collected.finish("claude", path))
}

fn read_codex(path: &Path, limit: usize) -> Result<AgentTranscript, String> {
    let mut collected = Collected::new();
    for line in lines_of(path)? {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("response_item") {
            continue;
        }
        let Some(payload) = value.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let role = match payload.get("role").and_then(|r| r.as_str()) {
            Some(role @ ("user" | "assistant")) => role,
            _ => continue,
        };
        let mut text = String::new();
        if let Some(blocks) = payload.get("content").and_then(|c| c.as_array()) {
            for block in blocks {
                // input_text is what the person typed; output_text is what the agent answered.
                if matches!(
                    block.get("type").and_then(|t| t.as_str()),
                    Some("input_text") | Some("output_text") | Some("text")
                ) {
                    if let Some(value) = block.get("text").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            text.push_str("\n\n");
                        }
                        text.push_str(value);
                    }
                }
            }
        }
        let text = strip_harness_wrapper(&text);
        if text.is_empty() {
            continue;
        }
        collected.push(
            TranscriptEntry {
                role: role.to_string(),
                text,
                at: value
                    .get("timestamp")
                    .and_then(|t| t.as_str())
                    .map(str::to_string),
            },
            limit,
        );
    }
    Ok(collected.finish("codex", path))
}

/// Both harnesses prepend machine-generated context to the first user turn — an
/// `<environment_context>` block for codex, a `<local-command-caveat>` or `<system-reminder>` for
/// Claude Code. Showing those as though the person had typed them is worse than showing nothing.
pub(crate) fn strip_harness_wrapper(text: &str) -> String {
    let trimmed = text.trim();
    const WRAPPERS: [&str; 4] = [
        "<environment_context>",
        "<local-command-caveat>",
        "<system-reminder>",
        "<command-message>",
    ];
    for wrapper in WRAPPERS {
        if trimmed.starts_with(wrapper) {
            let closing = wrapper.replacen('<', "</", 1);
            if let Some(end) = trimmed.find(&closing) {
                let rest = &trimmed[end + closing.len()..];
                return strip_harness_wrapper(rest);
            }
            return String::new();
        }
    }
    trimmed.to_string()
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
            normalised_path("c:/sources/talkak-developer")
        );
        assert_ne!(
            normalised_path("C:/Sources/talkak"),
            normalised_path("C:/Sources/talkak-developer")
        );
    }

    #[test]
    fn harness_preamble_never_reaches_the_reader() {
        assert_eq!(
            strip_harness_wrapper(
                "<environment_context>\n  <cwd>x</cwd>\n</environment_context>\nfix the build"
            ),
            "fix the build"
        );
        // Nested wrappers are peeled until real text is left.
        assert_eq!(
            strip_harness_wrapper("<system-reminder>a</system-reminder><local-command-caveat>b</local-command-caveat>hello"),
            "hello"
        );
        // A wrapper with nothing after it is not a turn at all.
        assert_eq!(
            strip_harness_wrapper("<system-reminder>only</system-reminder>"),
            ""
        );
        assert_eq!(strip_harness_wrapper("  plain words  "), "plain words");
    }

    #[test]
    fn the_tail_is_bounded_and_says_how_much_it_dropped() {
        let mut collected = Collected::new();
        for index in 0..10 {
            collected.push(
                TranscriptEntry {
                    role: "user".into(),
                    text: format!("turn {index}"),
                    at: Some(format!("t{index}")),
                },
                3,
            );
        }
        let transcript = collected.finish("claude", Path::new("x.jsonl"));
        assert_eq!(transcript.total_entries, 10);
        assert_eq!(transcript.entries.len(), 3);
        assert_eq!(transcript.entries[0].text, "turn 7");
        assert_eq!(transcript.entries[2].text, "turn 9");
        assert_eq!(transcript.last_activity.as_deref(), Some("t9"));
    }

    #[test]
    fn one_answer_written_as_several_blocks_is_one_turn() {
        // An assistant reply is written a line per content block, all sharing message.id — 483 of
        // 895 in one real file here span more than one line. Per line, a single reply rendered as
        // up to five separate bubbles.
        let mut collected = Collected::new();
        let block = |text: &str| TranscriptEntry {
            role: "assistant".into(),
            text: text.into(),
            at: Some("t".into()),
        };
        collected.push_merging(block("first"), Some("msg_1".into()), 10);
        collected.push_merging(block("second"), Some("msg_1".into()), 10);
        collected.push_merging(block("a new reply"), Some("msg_2".into()), 10);

        let transcript = collected.finish("claude", Path::new("x.jsonl"));
        assert_eq!(transcript.entries.len(), 2);
        assert_eq!(transcript.entries[0].text, "first\n\nsecond");
        assert_eq!(transcript.entries[1].text, "a new reply");
        // A folded block is not another turn.
        assert_eq!(transcript.total_entries, 2);
    }

    #[test]
    fn a_user_turn_between_two_blocks_of_one_answer_breaks_the_group() {
        let mut collected = Collected::new();
        collected.push_merging(
            TranscriptEntry {
                role: "assistant".into(),
                text: "a".into(),
                at: None,
            },
            Some("msg_1".into()),
            10,
        );
        collected.push_merging(
            TranscriptEntry {
                role: "user".into(),
                text: "wait".into(),
                at: None,
            },
            None,
            10,
        );
        collected.push_merging(
            TranscriptEntry {
                role: "assistant".into(),
                text: "b".into(),
                at: None,
            },
            Some("msg_1".into()),
            10,
        );
        let transcript = collected.finish("claude", Path::new("x.jsonl"));
        assert_eq!(transcript.entries.len(), 3);
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

    #[test]
    fn a_file_edited_twice_is_named_once_and_moves_to_the_end() {
        let mut collected = Collected::new();
        collected.touched("a.rs");
        collected.touched("b.rs");
        collected.touched("a.rs");
        let transcript = collected.finish("claude", Path::new("x.jsonl"));
        assert_eq!(transcript.changed_files, vec!["b.rs", "a.rs"]);
    }
}

#[cfg(test)]
mod live_probe {
    use super::*;

    /// Not a unit test of logic — a check that the two real formats on this machine actually parse.
    /// Skips silently where no record exists, so it never fails CI on a clean runner.
    #[test]
    fn the_real_records_on_this_machine_parse() {
        let Some(home) = home_dir() else { return };
        let project = r"C:\Sources\talkak-developer";

        if let Some(path) = newest_claude_record(&home, project) {
            let transcript = read_claude(&path, 5).expect("the claude record should parse");
            println!(
                "claude: {} turns total, {} kept, {} files touched, last {:?}",
                transcript.total_entries,
                transcript.entries.len(),
                transcript.changed_files.len(),
                transcript.last_activity
            );
            for entry in &transcript.entries {
                let text: String = entry.text.chars().take(90).collect();
                println!("  [{}] {}", entry.role, text.replace('\n', " "));
            }
            assert!(
                transcript.total_entries > 0,
                "a real record should hold turns"
            );
        } else {
            println!("claude: no record for {project}");
        }

        match newest_codex_record(&home, project) {
            Ok(Some(path)) => {
                let transcript = read_codex(&path, 5).expect("the codex record should parse");
                println!(
                    "codex: {} turns total, {} kept, last {:?}",
                    transcript.total_entries,
                    transcript.entries.len(),
                    transcript.last_activity
                );
                for entry in &transcript.entries {
                    let text: String = entry.text.chars().take(90).collect();
                    println!("  [{}] {}", entry.role, text.replace('\n', " "));
                }
            }
            Ok(None) => println!("codex: no record for {project}"),
            Err(error) => panic!("codex scan failed: {error}"),
        }
    }
}
