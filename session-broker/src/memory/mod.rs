//! Small, project-scoped operating memory, shared by the desktop and its stdio tool server.
//! The scope/search/supersedes approach is adapted from Dalkkak's memory.rs. No graph UI,
//! embedding service, agent SDK, network call, or development-checkout dependency is needed.
pub mod import;
pub mod mcp;
mod query;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub use query::{MemoryPage, MemorySummary};
// MAX limits, in Unicode scalars for authored text and UTF-8 bytes for complete tool responses.
// These are implementation budgets, NOT model token counts or quality guarantees.
pub const TITLE_LIMIT: usize = 120;
pub const BODY_LIMIT: usize = 1600;
pub const RESPONSE_BYTES: usize = 8192;
const RECORD_BYTES: u64 = 24 * 1024;
const RECORD_LIMIT: usize = 2000;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemorySource {
    /// User-reviewed note, agent-authored note, or imported historical data. Never proof of truth.
    pub kind: String,
    pub session_id: String,
    pub reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub project: String,
    pub title: String,
    pub body: String,
    pub created_at_ms: u64,
    pub source: MemorySource,
    pub supersedes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryDraft {
    pub title: String,
    pub body: String,
    pub supersedes: Option<String>,
}

#[derive(Clone)]
pub struct MemoryStore {
    directory: PathBuf,
    project: String,
}

pub fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

pub fn key(text: &str) -> String {
    // Stable filename, not an authority boundary. Every loaded record also checks the full scope.
    let hash = text.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    format!("{hash:016x}")
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

impl MemoryStore {
    pub fn open(root: &Path, project: &Path) -> Result<Self, String> {
        if !root.is_absolute() || !project.is_absolute() || !project.is_dir() {
            return Err(
                "Memory requires an absolute storage root and an existing project folder".into(),
            );
        }
        let canonical = fs::canonicalize(project).map_err(|e| e.to_string())?;
        let project = canonical
            .to_str()
            .ok_or("Project path is not Unicode")?
            .to_string();
        Ok(Self {
            directory: root.join(key(&project)),
            project,
        })
    }

    pub fn save(&self, draft: MemoryDraft, source: MemorySource) -> Result<MemoryRecord, String> {
        let title = draft.title.trim();
        let body = draft.body.trim();
        if title.is_empty()
            || body.is_empty()
            || title.chars().count() > TITLE_LIMIT
            || body.chars().count() > BODY_LIMIT
        {
            return Err(
                "A note needs a title (up to 120 characters) and body (up to 1600 characters)"
                    .into(),
            );
        }
        if !matches!(source.kind.as_str(), "user" | "agent" | "imported")
            || source.session_id.len() > 200
            || source.reference.as_ref().is_some_and(|s| s.len() > 2048)
        {
            return Err("Invalid memory source".into());
        }
        if let Some(id) = &draft.supersedes {
            self.read(id)?;
        }
        let (existing, _) = self.records()?;
        if let Some(same) = existing.iter().find(|note| {
            note.title == title
                && note.body == body
                && note.source == source
                && note.supersedes == draft.supersedes
        }) {
            return Ok(same.clone());
        }
        if existing.len() >= RECORD_LIMIT {
            return Err("Project memory is full; export or archive it before saving more".into());
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?;
        let id = format!(
            "{:x}-{:x}-{:x}",
            now.as_nanos(),
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let record = MemoryRecord {
            id,
            project: self.project.clone(),
            title: title.into(),
            body: body.into(),
            created_at_ms: now.as_millis() as u64,
            source,
            supersedes: draft.supersedes,
        };
        fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > RECORD_BYTES {
            return Err("Memory record exceeds storage budget".into());
        }
        let final_path = self.directory.join(format!("{}.json", record.id));
        let pending = final_path.with_extension("pending");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(pending, final_path).map_err(|e| e.to_string())?;
        Ok(record)
    }

    pub fn read(&self, id: &str) -> Result<MemoryRecord, String> {
        if !valid_id(id) {
            return Err("Invalid memory id".into());
        }
        let path = self.directory.join(format!("{id}.json"));
        let metadata = fs::symlink_metadata(&path).map_err(|_| "Memory record unavailable")?;
        if !metadata.is_file() || metadata.len() > RECORD_BYTES {
            return Err("Invalid memory record file".into());
        }
        let mut bytes = Vec::new();
        fs::File::open(path)
            .map_err(|e| e.to_string())?
            .take(RECORD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > RECORD_BYTES {
            return Err("Memory record exceeds storage budget".into());
        }
        let record: MemoryRecord =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid memory record")?;
        if record.project != self.project || record.id != id {
            return Err("Memory record belongs to a different project".into());
        }
        Ok(record)
    }

    pub(super) fn records(&self) -> Result<(Vec<MemoryRecord>, usize), String> {
        let entries = match fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((vec![], 0)),
            Err(e) => return Err(e.to_string()),
        };
        let mut records = Vec::new();
        let mut skipped = 0;
        for (index, entry) in entries.enumerate() {
            if index > RECORD_LIMIT * 2 {
                return Err("Project memory scan limit reached".into());
            }
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            match self.read(id) {
                Ok(record) => records.push(record),
                Err(_) => skipped += 1,
            }
        }
        Ok((records, skipped))
    }

    /// User selection only. The agent tools cannot change the next-session handoff.
    pub fn select(&self, id: Option<&str>) -> Result<(), String> {
        if let Some(id) = id {
            self.read(id)?;
        }
        fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        fs::write(self.directory.join("handoff"), id.unwrap_or("")).map_err(|e| e.to_string())
    }

    pub fn selected(&self) -> Option<String> {
        let path = self.directory.join("handoff");
        if fs::metadata(&path).ok()?.len() > 80 {
            return None;
        }
        let id = fs::read_to_string(path).ok()?;
        self.read(&id).ok().map(|_| id)
    }
}
