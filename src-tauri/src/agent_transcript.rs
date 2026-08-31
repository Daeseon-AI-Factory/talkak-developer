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
//! already separated, unwrapped, and include the edited file names.
//!
//!   Claude Code  ~/.claude/projects/<cwd with every non-alphanumeric turned into '-'>/<id>.jsonl
//!   Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl
//!
//! Codex does not encode the directory in the path, so its first line — `session_meta` — carries
//! `payload.cwd` and that is what a project is matched against.
//!
//! Only the bounded panel projection crosses IPC; one real record already exceeded 16 MB.

use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};

use crate::transcript_line_filter;

pub(crate) const MAX_TRANSCRIPT_ENTRIES: usize = 800;
pub(crate) const MAX_TRANSCRIPT_TURN_CHARS: usize = 60_000;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TranscriptSource {
    Claude,
    Codex,
}

impl TranscriptSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

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

/// A bounded tail of turns plus every file touched, in one pass over the file.
#[derive(Debug, Clone)]
pub(crate) struct Collected {
    entries: VecDeque<TranscriptEntry>,
    total: usize,
    changed: Vec<String>,
    last_at: Option<String>,
    /// The provider-defined group still being folded into, if any.
    open_group: Option<String>,
}

impl Collected {
    pub(crate) fn new() -> Self {
        Self {
            entries: VecDeque::new(),
            total: 0,
            changed: Vec::new(),
            last_at: None,
            open_group: None,
        }
    }

    fn push(&mut self, mut entry: TranscriptEntry, limit: usize) {
        entry.text = cap_turn_text(&entry.text);
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
                    let remaining =
                        MAX_TRANSCRIPT_TURN_CHARS.saturating_sub(last.text.chars().count());
                    if remaining > 0 {
                        let separator = if last.text.is_empty() { "" } else { "\n\n" };
                        let separator_chars = separator.chars().count();
                        if remaining > separator_chars {
                            last.text.push_str(separator);
                            last.text.extend(
                                entry
                                    .text
                                    .chars()
                                    .take(remaining.saturating_sub(separator_chars)),
                            );
                        }
                    }
                    if let Some(at) = entry.at {
                        last.at = Some(at.clone());
                        self.last_at = Some(at);
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

    fn touch_open_group_at(&mut self, group: &str, at: Option<String>) {
        if self.open_group.as_deref() != Some(group) {
            return;
        }
        if let (Some(last), Some(at)) = (self.entries.back_mut(), at) {
            last.at = Some(at.clone());
            self.last_at = Some(at);
        }
    }

    fn touched(&mut self, file: &str) {
        // Most recently touched last, and named once however many times it was edited.
        self.changed.retain(|existing| existing != file);
        self.changed.push(file.to_string());
    }

    pub(crate) fn snapshot(
        &self,
        source: TranscriptSource,
        path: &Path,
        limit: usize,
    ) -> AgentTranscript {
        let kept = limit.clamp(1, MAX_TRANSCRIPT_ENTRIES);
        let skip = self.entries.len().saturating_sub(kept);
        AgentTranscript {
            source: source.as_str().to_string(),
            path: path.to_string_lossy().into_owned(),
            entries: self.entries.iter().skip(skip).cloned().collect(),
            total_entries: self.total,
            changed_files: self.changed.clone(),
            last_activity: self.last_at.clone(),
        }
    }

    #[cfg(test)]
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

fn cap_turn_text(text: &str) -> String {
    if text.chars().count() <= MAX_TRANSCRIPT_TURN_CHARS {
        return text.to_string();
    }
    text.chars().take(MAX_TRANSCRIPT_TURN_CHARS).collect()
}

/// Fold one complete JSONL record into the cached projection. The service deliberately calls this
/// only after seeing a newline, so a writer's partially flushed final JSON object is retried later.
pub(crate) fn collect_line(
    source: TranscriptSource,
    line: &str,
    collected: &mut Collected,
    limit: usize,
) {
    if !transcript_line_filter::is_relevant(source, line) {
        return;
    }
    collect_line_unfiltered(source, line, collected, limit);
}

fn collect_line_unfiltered(
    source: TranscriptSource,
    line: &str,
    collected: &mut Collected,
    limit: usize,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    match source {
        TranscriptSource::Claude => collect_claude_value(&value, collected, limit),
        TranscriptSource::Codex => collect_codex_value(&value, collected, limit),
    }
}

#[cfg(test)]
pub(crate) fn collect_line_without_filter_for_test(
    source: TranscriptSource,
    line: &str,
    collected: &mut Collected,
    limit: usize,
) {
    collect_line_unfiltered(source, line, collected, limit);
}

fn collect_claude_value(value: &serde_json::Value, collected: &mut Collected, limit: usize) {
    // A sidechain is a subagent's separate conversation and never affects the visible turn.
    if value.get("isSidechain").and_then(|flag| flag.as_bool()) == Some(true) {
        return;
    }
    let role = match value.get("type").and_then(|kind| kind.as_str()) {
        Some("user") => "user",
        Some("assistant") => "assistant",
        _ => return,
    };
    // TALKAK uses every real user-prompt record as the assistant-turn boundary, even when the
    // prompt is image-only and therefore has no text to render. Tool-result records are also typed
    // as `user`, but remain inside the current turn.
    let is_user_prompt = role == "user"
        && match value
            .get("message")
            .and_then(|message| message.get("content"))
        {
            Some(serde_json::Value::String(_)) => true,
            Some(serde_json::Value::Array(blocks)) => !blocks.iter().any(|block| {
                block.get("type").and_then(|kind| kind.as_str()) == Some("tool_result")
            }),
            _ => false,
        };
    if value.get("isMeta").and_then(|flag| flag.as_bool()) == Some(true) {
        if is_user_prompt {
            collected.open_group = None;
        }
        return;
    }
    let at = value
        .get("timestamp")
        .and_then(|timestamp| timestamp.as_str())
        .map(str::to_string);
    let content = value
        .get("message")
        .and_then(|message| message.get("content"));
    let mut text = String::new();
    match content {
        Some(serde_json::Value::String(plain)) => text.push_str(plain),
        Some(serde_json::Value::Array(blocks)) => {
            for block in blocks {
                match block.get("type").and_then(|kind| kind.as_str()) {
                    Some("text") => {
                        if let Some(value) = block.get("text").and_then(|text| text.as_str()) {
                            if !text.is_empty() {
                                text.push_str("\n\n");
                            }
                            text.push_str(value);
                        }
                    }
                    Some("tool_use") => {
                        let name = block
                            .get("name")
                            .and_then(|name| name.as_str())
                            .unwrap_or("");
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
        if is_user_prompt {
            collected.open_group = None;
        } else if role == "assistant" {
            // A tool-only record still advances its visible assistant turn's timestamp.
            collected.touch_open_group_at("claude-assistant-turn", at);
        }
        return;
    }
    // Claude can emit several API messages while answering one human prompt (for example around
    // tool calls), and those messages have different ids. TALKAK's conversation reader groups the
    // whole assistant side of that human turn; using message.id here split it into needless bubbles.
    // A non-empty human user record clears this group, while tool-result records contain no visible
    // text and deliberately leave it open.
    let turn_group = (role == "assistant").then(|| "claude-assistant-turn".to_string());
    collected.push_merging(
        TranscriptEntry {
            role: role.to_string(),
            text,
            at,
        },
        turn_group,
        limit,
    );
}

fn collect_codex_value(value: &serde_json::Value, collected: &mut Collected, limit: usize) {
    if value.get("type").and_then(|kind| kind.as_str()) != Some("response_item") {
        return;
    }
    let Some(payload) = value.get("payload") else {
        return;
    };
    if payload.get("type").and_then(|kind| kind.as_str()) != Some("message") {
        return;
    }
    let role = match payload.get("role").and_then(|role| role.as_str()) {
        Some(role @ ("user" | "assistant")) => role,
        _ => return,
    };
    let mut text = String::new();
    if let Some(blocks) = payload
        .get("content")
        .and_then(|content| content.as_array())
    {
        for block in blocks {
            if matches!(
                block.get("type").and_then(|kind| kind.as_str()),
                Some("input_text") | Some("output_text") | Some("text")
            ) {
                if let Some(value) = block.get("text").and_then(|text| text.as_str()) {
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
        return;
    }
    collected.push(
        TranscriptEntry {
            role: role.to_string(),
            text,
            at: value
                .get("timestamp")
                .and_then(|timestamp| timestamp.as_str())
                .map(str::to_string),
        },
        limit,
    );
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
        // Claude may write one assistant turn across several records. The service-level tests also
        // cover the different-message-id case that occurs around tool calls.
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
