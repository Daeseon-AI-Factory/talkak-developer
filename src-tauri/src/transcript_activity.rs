//! What the agent is doing right now, derived from the record it already writes.
//!
//! The full product learns this from a hook the agent runs; a clean install cannot rely on one, so
//! this state machine is fed by the same record parse that fills the conversation panel. Provider
//! adapters translate their own record shapes into the five neutral events below; nothing here
//! knows what a `tool_use` block or a `task_complete` event looks like.
//!
//!   prompt      -> thinking      the person asked for something
//!   tool start  -> working       a tool is running (or needs-input when the tool asks the person)
//!   tool end    -> working       the agent continues after the result
//!   turn done   -> done          the agent finished answering
//!   aborted     -> idle          the turn was interrupted; nothing is pending

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ActivityState {
    Idle,
    Thinking,
    Working,
    NeedsInput,
    Done,
}

/// The renderer projection: `{ state, lastTool, at }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentActivity {
    pub state: ActivityState,
    pub last_tool: Option<String>,
    /// The record timestamp of the event that produced this state, in the provider's own format.
    pub at: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ActivityTracker {
    activity: AgentActivity,
    /// Tool calls without a result yet: `(call id, asks the person)`.
    pending: Vec<(String, bool)>,
    changes: u64,
}

impl ActivityTracker {
    pub(crate) fn new() -> Self {
        Self {
            activity: AgentActivity {
                state: ActivityState::Idle,
                last_tool: None,
                at: None,
            },
            pending: Vec::new(),
            changes: 0,
        }
    }

    pub(crate) fn snapshot(&self) -> AgentActivity {
        self.activity.clone()
    }

    #[cfg(test)]
    pub(crate) fn state(&self) -> ActivityState {
        self.activity.state
    }

    /// Every event counts, so a bound record's revision moves when only the timestamp did.
    pub(crate) fn changes(&self) -> u64 {
        self.changes
    }

    /// The person asked for something: nothing from an earlier turn can still be pending.
    pub(crate) fn prompt(&mut self, at: Option<&str>) {
        self.pending.clear();
        self.activity.last_tool = None;
        self.set(ActivityState::Thinking, at);
    }

    /// The agent produced text or reasoning. Only a resting state moves; a running tool keeps
    /// "working", and text after a question means the question was answered.
    pub(crate) fn progress(&mut self, at: Option<&str>) {
        let next = match self.activity.state {
            ActivityState::Idle | ActivityState::Done => ActivityState::Thinking,
            ActivityState::NeedsInput => ActivityState::Working,
            current => current,
        };
        self.set(next, at);
    }

    pub(crate) fn tool_started(
        &mut self,
        call_id: Option<&str>,
        name: &str,
        asks_person: bool,
        at: Option<&str>,
    ) {
        if let Some(id) = call_id {
            self.pending.retain(|(pending, _)| pending != id);
            self.pending.push((id.to_string(), asks_person));
        }
        self.activity.last_tool = Some(name.to_string());
        let next = if asks_person {
            ActivityState::NeedsInput
        } else {
            ActivityState::Working
        };
        self.set(next, at);
    }

    /// A result arrived. The wait ends once no question to the person is still open — including
    /// for an id never seen, since a record bound mid-turn has no memory of the question it is
    /// now seeing answered.
    pub(crate) fn tool_finished(&mut self, call_id: &str, at: Option<&str>) {
        self.pending.retain(|(pending, _)| pending != call_id);
        match self.activity.state {
            ActivityState::NeedsInput if !self.pending.iter().any(|(_, asks)| *asks) => {
                self.set(ActivityState::Working, at);
            }
            ActivityState::Working => self.set(ActivityState::Working, at),
            _ => {}
        }
    }

    pub(crate) fn turn_done(&mut self, at: Option<&str>) {
        self.pending.clear();
        self.set(ActivityState::Done, at);
    }

    pub(crate) fn turn_aborted(&mut self, at: Option<&str>) {
        self.pending.clear();
        self.set(ActivityState::Idle, at);
    }

    fn set(&mut self, state: ActivityState, at: Option<&str>) {
        self.activity.state = state;
        if let Some(at) = at {
            self.activity.at = Some(at.to_string());
        }
        self.changes += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_turn_runs_prompt_to_done() {
        let mut tracker = ActivityTracker::new();
        assert_eq!(tracker.state(), ActivityState::Idle);
        tracker.prompt(Some("t1"));
        assert_eq!(tracker.state(), ActivityState::Thinking);
        tracker.progress(Some("t2"));
        assert_eq!(tracker.state(), ActivityState::Thinking);
        tracker.tool_started(Some("call-1"), "Read", false, Some("t3"));
        assert_eq!(tracker.state(), ActivityState::Working);
        assert_eq!(tracker.snapshot().last_tool.as_deref(), Some("Read"));
        tracker.tool_finished("call-1", Some("t4"));
        assert_eq!(tracker.state(), ActivityState::Working);
        tracker.turn_done(Some("t5"));
        let done = tracker.snapshot();
        assert_eq!(done.state, ActivityState::Done);
        assert_eq!(done.at.as_deref(), Some("t5"));
        // Text after a finished turn is a new answer starting, not a stale "done".
        tracker.progress(Some("t6"));
        assert_eq!(tracker.state(), ActivityState::Thinking);
    }

    #[test]
    fn a_question_waits_for_the_person_and_then_continues() {
        let mut tracker = ActivityTracker::new();
        tracker.prompt(Some("t1"));
        tracker.tool_started(Some("ask-1"), "AskUserQuestion", true, Some("t2"));
        assert_eq!(tracker.state(), ActivityState::NeedsInput);
        // An unrelated result does not answer the question.
        tracker.tool_started(Some("read-1"), "Read", false, Some("t2"));
        tracker.tool_started(Some("ask-1"), "AskUserQuestion", true, Some("t2"));
        tracker.tool_finished("read-1", Some("t3"));
        assert_eq!(tracker.state(), ActivityState::NeedsInput);
        tracker.tool_finished("ask-1", Some("t4"));
        assert_eq!(tracker.state(), ActivityState::Working);
        assert_eq!(
            tracker.snapshot().last_tool.as_deref(),
            Some("AskUserQuestion")
        );
    }

    #[test]
    fn an_answered_question_seen_without_its_call_still_releases_the_wait() {
        let mut tracker = ActivityTracker::new();
        tracker.tool_started(None, "request_user_input", true, Some("t1"));
        assert_eq!(tracker.state(), ActivityState::NeedsInput);
        tracker.tool_finished("never-seen", Some("t2"));
        assert_eq!(tracker.state(), ActivityState::Working);

        tracker.tool_started(None, "request_user_input", true, Some("t3"));
        tracker.progress(Some("t4"));
        assert_eq!(tracker.state(), ActivityState::Working);
    }

    #[test]
    fn an_interrupted_turn_goes_idle_and_a_prompt_forgets_old_tools() {
        let mut tracker = ActivityTracker::new();
        tracker.prompt(Some("t1"));
        tracker.tool_started(Some("c1"), "Bash", false, Some("t2"));
        tracker.turn_aborted(Some("t3"));
        assert_eq!(tracker.state(), ActivityState::Idle);
        tracker.prompt(Some("t4"));
        let thinking = tracker.snapshot();
        assert_eq!(thinking.state, ActivityState::Thinking);
        assert_eq!(thinking.last_tool, None);
        assert!(tracker.changes() >= 4);
    }

    #[test]
    fn the_projection_serialises_with_the_agreed_names() {
        let mut tracker = ActivityTracker::new();
        tracker.tool_started(Some("c"), "Edit", true, Some("2026-08-31T10:00:00Z"));
        let json = serde_json::to_value(tracker.snapshot()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "state": "needs-input",
                "lastTool": "Edit",
                "at": "2026-08-31T10:00:00Z"
            })
        );
        assert_eq!(
            serde_json::to_value(ActivityTracker::new().snapshot()).unwrap(),
            serde_json::json!({"state": "idle", "lastTool": null, "at": null})
        );
    }
}
