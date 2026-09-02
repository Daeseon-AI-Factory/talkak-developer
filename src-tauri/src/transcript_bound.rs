//! One session's bound record: its path, the cached projection, and the byte offset after the
//! last complete line, so a poll costs one stat and parses only what the agent appended.

use crate::agent_transcript::{
    collect_line, AgentTranscript, Binding, Collected, TranscriptSource, MAX_TRANSCRIPT_ENTRIES,
};
use crate::transcript_activity::AgentActivity;
use crate::transcript_discovery::{system_time_ms, Candidate};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

/// Process-wide so a rebind or rewrite can never hand a reader a number it already holds.
static NEXT_REVISION: AtomicU64 = AtomicU64::new(1);

fn next_revision() -> u64 {
    NEXT_REVISION.fetch_add(1, Ordering::Relaxed)
}

pub(crate) struct BoundTranscript {
    pub(crate) project_key: String,
    pub(crate) run_id: Option<u64>,
    pub(crate) source: TranscriptSource,
    pub(crate) path: PathBuf,
    pub(crate) binding: Binding,
    /// Moves whenever the projection changed: a rebind, a rewrite, or an append that mattered.
    pub(crate) revision: u64,
    collected: Collected,
    offset: u64,
    observed_len: u64,
    observed_modified: Option<SystemTime>,
    #[cfg(test)]
    pub(crate) parsed_lines: usize,
}

impl BoundTranscript {
    pub(crate) fn open(
        project_key: String,
        run_id: Option<u64>,
        candidate: Candidate,
    ) -> Result<Self, String> {
        let mut bound = Self {
            project_key,
            run_id,
            source: candidate.source,
            path: candidate.path,
            binding: candidate.binding,
            revision: 0,
            collected: Collected::new(),
            offset: 0,
            observed_len: 0,
            observed_modified: None,
            #[cfg(test)]
            parsed_lines: 0,
        };
        bound.reset_and_parse()?;
        Ok(bound)
    }

    pub(crate) fn changed_since(&self, since_ms: i64) -> bool {
        let Ok(metadata) = std::fs::metadata(&self.path) else {
            return false;
        };
        let advanced = metadata.len() > self.observed_len
            || (metadata.len() == self.observed_len
                && metadata.modified().ok() != self.observed_modified);
        let modified_after_launch = metadata
            .modified()
            .ok()
            .is_some_and(|value| system_time_ms(value) >= since_ms.saturating_sub(1_000));
        advanced && modified_after_launch
    }

    pub(crate) fn refresh(&mut self) -> Result<(), String> {
        let metadata = std::fs::metadata(&self.path)
            .map_err(|error| format!("could not inspect the agent record: {error}"))?;
        let modified = metadata.modified().ok();
        if metadata.len() < self.observed_len
            || self.offset > metadata.len()
            || (metadata.len() == self.observed_len && modified != self.observed_modified)
        {
            return self.reset_and_parse();
        }
        if metadata.len() == self.observed_len {
            return Ok(());
        }
        self.parse_through(metadata.len())?;
        self.observed_len = metadata.len();
        self.observed_modified = modified;
        Ok(())
    }

    fn reset_and_parse(&mut self) -> Result<(), String> {
        let metadata = std::fs::metadata(&self.path)
            .map_err(|error| format!("could not inspect the agent record: {error}"))?;
        self.collected = Collected::new();
        self.offset = 0;
        self.parse_through(metadata.len())?;
        self.observed_len = metadata.len();
        self.observed_modified = metadata.modified().ok();
        // A rewrite is a new projection even when it happens to read the same.
        self.revision = next_revision();
        Ok(())
    }

    fn parse_through(&mut self, target_len: u64) -> Result<(), String> {
        let mut file = std::fs::File::open(&self.path)
            .map_err(|error| format!("could not open the agent record: {error}"))?;
        file.seek(SeekFrom::Start(self.offset))
            .map_err(|error| format!("could not seek in the agent record: {error}"))?;
        let remaining = target_len.saturating_sub(self.offset);
        let mut reader = BufReader::new(file.take(remaining));
        let mut line = Vec::new();
        let before = self.collected.version();
        loop {
            line.clear();
            let read = reader
                .read_until(b'\n', &mut line)
                .map_err(|error| format!("could not read the agent record: {error}"))?;
            if read == 0 || line.last() != Some(&b'\n') {
                break;
            }
            self.offset += read as u64;
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if let Ok(text) = std::str::from_utf8(&line) {
                collect_line(
                    self.source,
                    text,
                    &mut self.collected,
                    MAX_TRANSCRIPT_ENTRIES,
                );
            }
            #[cfg(test)]
            {
                self.parsed_lines += 1;
            }
        }
        // Appended telemetry the projection ignores must not make a reader refetch the tail.
        if self.collected.version() != before {
            self.revision = next_revision();
        }
        Ok(())
    }

    pub(crate) fn snapshot(&self, limit: usize) -> AgentTranscript {
        let mut transcript = self.collected.snapshot(
            self.source,
            &self.path,
            limit.clamp(1, MAX_TRANSCRIPT_ENTRIES),
        );
        transcript.revision = self.revision;
        transcript.binding = self.binding.as_str().to_string();
        transcript
    }

    pub(crate) fn activity(&self) -> AgentActivity {
        self.collected.activity()
    }
}
