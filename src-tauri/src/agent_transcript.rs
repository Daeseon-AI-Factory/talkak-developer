//! What the agent in a pane actually said, read from the record it already keeps.
//!
//! The inspector has had a summary view and a conversation-log view since the workspace was
//! extracted, and nothing ever filled them: `conversation` is initialised to `[]` and never
//! appended to, `summary.changedFiles` and `summary.decisions` likewise, and the only writer of
//! either is `demo.ts`. Every real session showed an empty panel under a note promising a
//! transcript adapter.
//!
//! This is that adapter. The agents this product runs already write a structured JSONL record of
//! their own session, which is a far better source than scraping the terminal: the turns are
//! already separated, unwrapped, and include the edited file names. Each provider's record shape
//! lives in its own module (`transcript_claude`, `transcript_codex`, `transcript_antigravity`);
//! this module owns the neutral projection they all fold into.
//!
//! Only the bounded panel projection crosses IPC; one real record already exceeded 16 MB.

use serde::Serialize;
use std::collections::VecDeque;
use std::path::Path;

use crate::transcript_activity::{ActivityTracker, AgentActivity};
use crate::transcript_line_filter;
use crate::transcript_usage::{UsageSample, UsageTotals};

pub(crate) const MAX_TRANSCRIPT_ENTRIES: usize = 800;
pub(crate) const MAX_TRANSCRIPT_TURN_CHARS: usize = 60_000;
/// Tool names kept per turn. A long agentic turn runs hundreds of tools; the summary line needs
/// the shape of that, not an unbounded list.
pub(crate) const MAX_TRANSCRIPT_TURN_TOOLS: usize = 400;

/// One turn, normalised across every agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptEntry {
    /// "user" or "assistant" — the two roles a reader cares about.
    pub role: String,
    pub text: String,
    pub at: Option<String>,
    /// Tool names the assistant ran during this turn, in call order.
    pub tools: Vec<String>,
    /// Questions the assistant put to the person during this turn.
    pub decisions: Vec<Decision>,
}

impl TranscriptEntry {
    pub(crate) fn new(role: &str, text: String, at: Option<String>) -> Self {
        Self {
            role: role.to_string(),
            text,
            at,
            tools: Vec::new(),
            decisions: Vec::new(),
        }
    }
}

/// One question the agent asked, with what the person picked once the answer is recorded.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Decision {
    pub question: String,
    pub options: Vec<String>,
    pub selected: Option<String>,
    /// The provider's call id, used to match the later answer record. Never crosses IPC.
    #[serde(skip)]
    pub call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTranscript {
    /// Which agent wrote this record: "claude", "codex" or "antigravity".
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
    /// Changes whenever the projection changed; a reader that already holds it asks for less.
    pub revision: u64,
    /// "exact" when the record provably belongs to this session, "probable" when it was the only
    /// record in the project that advanced after launch.
    pub binding: String,
    pub activity: AgentActivity,
    /// Token totals when the record carries them; absent for an agent that records none.
    pub usage: Option<UsageTotals>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TranscriptSource {
    Claude,
    Codex,
    Antigravity,
}

impl TranscriptSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
        }
    }
}

/// How sure discovery was that a record belongs to the session it was bound to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Binding {
    Exact,
    Probable,
}

impl Binding {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Probable => "probable",
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
    activity: ActivityTracker,
    usage: Option<UsageTotals>,
    /// Counts every visible change so the service can tell an unchanged projection apart.
    mutations: u64,
}

impl Collected {
    pub(crate) fn new() -> Self {
        Self {
            entries: VecDeque::new(),
            total: 0,
            changed: Vec::new(),
            last_at: None,
            open_group: None,
            activity: ActivityTracker::new(),
            usage: None,
            mutations: 0,
        }
    }

    /// Moves whenever any projected field changed, including the activity timestamp.
    pub(crate) fn version(&self) -> u64 {
        self.mutations.wrapping_add(self.activity.changes())
    }

    pub(crate) fn activity(&self) -> AgentActivity {
        self.activity.snapshot()
    }

    pub(crate) fn activity_mut(&mut self) -> &mut ActivityTracker {
        &mut self.activity
    }

    pub(crate) fn push(&mut self, mut entry: TranscriptEntry, limit: usize) {
        entry.text = cap_turn_text(&entry.text);
        self.total += 1;
        self.mutations += 1;
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
    pub(crate) fn push_merging(
        &mut self,
        entry: TranscriptEntry,
        group: Option<String>,
        limit: usize,
    ) {
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
                    last.tools.extend(entry.tools);
                    last.tools.truncate(MAX_TRANSCRIPT_TURN_TOOLS);
                    last.decisions.extend(entry.decisions);
                    if let Some(at) = entry.at {
                        last.at = Some(at.clone());
                        self.last_at = Some(at);
                    }
                    self.mutations += 1;
                    return;
                }
            }
            self.open_group = Some(id);
        } else {
            self.open_group = None;
        }
        self.push(entry, limit);
    }

    /// Fills the text of a turn that a tool call opened, otherwise starts a new turn that keeps
    /// the group open for later tool calls. Providers whose replies stay separate entries use this.
    pub(crate) fn push_or_fill(&mut self, entry: TranscriptEntry, group: &str, limit: usize) {
        if self.open_group.as_deref() == Some(group) {
            if let Some(last) = self.entries.back_mut() {
                if last.text.is_empty() && last.role == entry.role {
                    last.text = cap_turn_text(&entry.text);
                    if let Some(at) = entry.at {
                        last.at = Some(at.clone());
                        self.last_at = Some(at);
                    }
                    self.mutations += 1;
                    return;
                }
            }
        }
        self.push(entry, limit);
        self.open_group = Some(group.to_string());
    }

    pub(crate) fn close_group(&mut self) {
        self.open_group = None;
    }

    pub(crate) fn touch_open_group_at(&mut self, group: &str, at: Option<String>) {
        if self.open_group.as_deref() != Some(group) {
            return;
        }
        if let (Some(last), Some(at)) = (self.entries.back_mut(), at) {
            last.at = Some(at.clone());
            self.last_at = Some(at);
            self.mutations += 1;
        }
    }

    /// Records a tool call on the open turn, or opens an empty turn for it when the agent started
    /// with a tool before saying anything.
    pub(crate) fn attach_tool(
        &mut self,
        group: &str,
        name: &str,
        decisions: Vec<Decision>,
        at: Option<String>,
        limit: usize,
    ) {
        if self.open_group.as_deref() == Some(group) {
            if let Some(last) = self.entries.back_mut() {
                if last.tools.len() < MAX_TRANSCRIPT_TURN_TOOLS {
                    last.tools.push(name.to_string());
                }
                last.decisions.extend(decisions);
                if let Some(at) = at {
                    last.at = Some(at.clone());
                    self.last_at = Some(at);
                }
                self.mutations += 1;
                return;
            }
        }
        let mut entry = TranscriptEntry::new("assistant", String::new(), at);
        entry.tools.push(name.to_string());
        entry.decisions = decisions;
        self.push_merging(entry, Some(group.to_string()), limit);
    }

    /// The answer to a question arrived: mark the picked option on the turn that asked it. The
    /// result text carries `"question"="label"` pairs, so an option is picked iff `="<label>"`
    /// appears — anchored on the `=` so a label inside the question text is not a false match.
    pub(crate) fn resolve_decisions(&mut self, call_id: &str, result_text: &str) {
        let Some(last) = self.entries.back_mut() else {
            return;
        };
        for decision in last
            .decisions
            .iter_mut()
            .filter(|decision| decision.call_id.as_deref() == Some(call_id))
        {
            let picked: Vec<&str> = decision
                .options
                .iter()
                .filter(|label| result_text.contains(&format!("=\"{label}\"")))
                .map(String::as_str)
                .collect();
            if !picked.is_empty() {
                decision.selected = Some(picked.join(", "));
                self.mutations += 1;
            }
        }
    }

    pub(crate) fn touched(&mut self, file: &str) {
        // Most recently touched last, and named once however many times it was edited.
        self.changed.retain(|existing| existing != file);
        self.changed.push(file.to_string());
        self.mutations += 1;
    }

    pub(crate) fn add_usage(&mut self, sample: UsageSample) {
        self.usage
            .get_or_insert_with(UsageTotals::default)
            .add(sample);
        self.mutations += 1;
    }

    pub(crate) fn replace_usage(&mut self, total: UsageSample) {
        self.usage
            .get_or_insert_with(UsageTotals::default)
            .replace(total);
        self.mutations += 1;
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
            revision: 0,
            binding: Binding::Exact.as_str().to_string(),
            activity: self.activity.snapshot(),
            usage: self.usage.clone(),
        }
    }

    #[cfg(test)]
    pub(crate) fn finish(self, source: &str, path: &Path) -> AgentTranscript {
        AgentTranscript {
            source: source.to_string(),
            path: path.to_string_lossy().into_owned(),
            entries: self.entries.into_iter().collect(),
            total_entries: self.total,
            changed_files: self.changed,
            last_activity: self.last_at,
            revision: 0,
            binding: Binding::Exact.as_str().to_string(),
            activity: self.activity.snapshot(),
            usage: self.usage,
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
        TranscriptSource::Claude => {
            crate::transcript_claude::collect_claude_value(&value, collected, limit)
        }
        TranscriptSource::Codex => {
            crate::transcript_codex::collect_codex_value(&value, collected, limit)
        }
        TranscriptSource::Antigravity => {
            crate::transcript_antigravity::collect_antigravity_value(&value, collected, limit)
        }
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

/// Every harness prepends machine-generated context to a user turn — an `<environment_context>`
/// block for codex, a `<local-command-caveat>` or `<system-reminder>` for Claude Code, and the
/// slash-command envelope Claude Code records for a local command the agent never answers.
/// Showing those as though the person had typed them is worse than showing nothing.
pub(crate) fn strip_harness_wrapper(text: &str) -> String {
    let trimmed = text.trim();
    const WRAPPERS: [&str; 7] = [
        "<environment_context>",
        "<local-command-caveat>",
        "<system-reminder>",
        "<command-message>",
        "<command-name>",
        "<command-args>",
        "<local-command-stdout>",
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
        // A local slash command is an envelope the agent never answers.
        assert_eq!(
            strip_harness_wrapper(
                "<command-name>/model</command-name>\n  <command-message>model</command-message>\n  <command-args></command-args>"
            ),
            ""
        );
        assert_eq!(
            strip_harness_wrapper("<local-command-stdout>Set model to opus</local-command-stdout>"),
            ""
        );
        assert_eq!(strip_harness_wrapper("  plain words  "), "plain words");
    }

    #[test]
    fn the_tail_is_bounded_and_says_how_much_it_dropped() {
        let mut collected = Collected::new();
        for index in 0..10 {
            collected.push(
                TranscriptEntry::new("user", format!("turn {index}"), Some(format!("t{index}"))),
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
        let block = |text: &str| TranscriptEntry::new("assistant", text.into(), Some("t".into()));
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
            TranscriptEntry::new("assistant", "a".into(), None),
            Some("msg_1".into()),
            10,
        );
        collected.push_merging(TranscriptEntry::new("user", "wait".into(), None), None, 10);
        collected.push_merging(
            TranscriptEntry::new("assistant", "b".into(), None),
            Some("msg_1".into()),
            10,
        );
        let transcript = collected.finish("claude", Path::new("x.jsonl"));
        assert_eq!(transcript.entries.len(), 3);
    }

    #[test]
    fn a_tool_before_any_words_opens_the_turn_the_words_then_fill() {
        let mut collected = Collected::new();
        collected.attach_tool("turn", "Read", Vec::new(), Some("t1".into()), 10);
        collected.attach_tool("turn", "Bash", Vec::new(), Some("t2".into()), 10);
        let transcript = collected.clone().finish("codex", Path::new("x.jsonl"));
        assert_eq!(transcript.entries.len(), 1);
        assert_eq!(transcript.entries[0].role, "assistant");
        assert_eq!(transcript.entries[0].text, "");
        assert_eq!(transcript.entries[0].tools, vec!["Read", "Bash"]);
        assert_eq!(transcript.entries[0].at.as_deref(), Some("t2"));

        collected.push_or_fill(
            TranscriptEntry::new("assistant", "done".into(), Some("t3".into())),
            "turn",
            10,
        );
        collected.push_or_fill(
            TranscriptEntry::new("assistant", "and more".into(), Some("t4".into())),
            "turn",
            10,
        );
        let transcript = collected.finish("codex", Path::new("x.jsonl"));
        assert_eq!(transcript.entries.len(), 2);
        assert_eq!(transcript.entries[0].text, "done");
        assert_eq!(transcript.entries[0].tools, vec!["Read", "Bash"]);
        assert_eq!(transcript.entries[1].text, "and more");
        assert_eq!(transcript.total_entries, 2);
    }

    #[test]
    fn a_decision_is_resolved_only_by_its_own_answer() {
        let mut collected = Collected::new();
        let decisions = vec![
            Decision {
                question: "Ship it?".into(),
                options: vec!["Yes".into(), "No".into()],
                selected: None,
                call_id: Some("ask-1".into()),
            },
            Decision {
                question: "Which No?".into(),
                options: vec!["No".into(), "Never".into()],
                selected: None,
                call_id: Some("ask-2".into()),
            },
        ];
        collected.attach_tool("turn", "AskUserQuestion", decisions, None, 10);
        let before = collected.version();
        collected.resolve_decisions(
            "ask-1",
            r#"Your questions have been answered: "Ship it?"="No"."#,
        );
        let transcript = collected.clone().finish("claude", Path::new("x.jsonl"));
        assert_eq!(
            transcript.entries[0].decisions[0].selected.as_deref(),
            Some("No")
        );
        assert_eq!(transcript.entries[0].decisions[1].selected, None);
        assert_ne!(collected.version(), before);
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

    #[test]
    fn the_projection_carries_the_agreed_fields() {
        let mut collected = Collected::new();
        collected.push(TranscriptEntry::new("user", "hi".into(), None), 10);
        let json = serde_json::to_value(collected.snapshot(
            TranscriptSource::Antigravity,
            Path::new("t"),
            10,
        ))
        .unwrap();
        assert_eq!(json["source"], "antigravity");
        assert_eq!(json["binding"], "exact");
        assert_eq!(json["revision"], 0);
        assert_eq!(json["usage"], serde_json::Value::Null);
        assert_eq!(json["activity"]["state"], "idle");
        assert_eq!(json["entries"][0]["tools"], serde_json::json!([]));
        assert_eq!(json["entries"][0]["decisions"], serde_json::json!([]));
    }
}
