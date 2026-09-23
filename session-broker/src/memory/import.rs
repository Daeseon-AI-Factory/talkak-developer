//! Explicit import of a single selected Dalkkak project. Original ids remain source references.
use super::{clip, MemoryDraft, MemorySource, MemoryStore, BODY_LIMIT, TITLE_LIMIT};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::io::{BufRead, Read};
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: usize,
    pub skipped: usize,
    pub corrections_checked: bool,
}

pub fn import_file(
    store: &MemoryStore,
    path: &Path,
    startup_id: &str,
) -> Result<ImportReport, String> {
    if startup_id.is_empty()
        || startup_id.len() > 100
        || !startup_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Choose the source project id before importing".into());
    }
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > 16 * 1024 * 1024 {
        return Err("Import file exceeds the 16 MiB budget".into());
    }
    let mut reader = std::io::BufReader::new(file);
    // Dalkkak stores correction edges alongside <startup>.jsonl in edges/<startup>.jsonl.
    // Read these first: raw node records alone do not contain the synthesized invalidation.
    let corrections = correction_targets(path, startup_id)?;
    let (existing, _) = store.records()?;
    let mut seen: HashSet<String> = existing
        .into_iter()
        .filter_map(|r| r.source.reference)
        .collect();
    let mut report = ImportReport {
        imported: 0,
        skipped: 0,
        corrections_checked: corrections.is_some(),
    };
    let prefix = format!("{startup_id}/");
    loop {
        let mut bytes = Vec::new();
        let read = reader
            .by_ref()
            .take(128 * 1024 + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        if bytes.len() > 128 * 1024 {
            return Err("Import line exceeds budget; earlier imported notes are retained".into());
        }
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => {
                report.skipped += 1;
                continue;
            }
        };
        let id = value["node_id"].as_str().unwrap_or("");
        let kind = value["node_type"].as_str().unwrap_or("");
        let body = value["body"].as_str().unwrap_or("");
        let title = value["title"].as_str().unwrap_or("");
        if !id.starts_with(&prefix)
            || seen.contains(id)
            || id.len() > 2048
            || !matches!(
                kind,
                "issue" | "decision" | "structure" | "identity" | "flow"
            )
            || title.trim().is_empty()
            || body.trim().is_empty()
            || !value["invalid_at"].is_null()
            || !value["superseded_by"].is_null()
            || corrections.as_ref().is_some_and(|ids| ids.contains(id))
        {
            report.skipped += 1;
            continue;
        }
        store.save(
            MemoryDraft {
                title: clip(title.trim(), TITLE_LIMIT),
                body: clip(body.trim(), BODY_LIMIT),
                supersedes: None,
            },
            MemorySource {
                kind: "imported".into(),
                session_id: String::new(),
                reference: Some(id.into()),
            },
        )?;
        seen.insert(id.into());
        report.imported += 1;
    }
    Ok(report)
}

fn correction_targets(path: &Path, startup_id: &str) -> Result<Option<HashSet<String>>, String> {
    let edges = path
        .parent()
        .ok_or("Import file has no parent folder")?
        .join("edges")
        .join(format!("{startup_id}.jsonl"));
    let file = match std::fs::File::open(edges) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if file.metadata().map_err(|e| e.to_string())?.len() > 16 * 1024 * 1024 {
        return Err("Correction file exceeds the 16 MiB budget".into());
    }
    let prefix = format!("{startup_id}/");
    let mut targets = HashSet::new();
    let mut reader = std::io::BufReader::new(file);
    loop {
        let mut bytes = Vec::new();
        if reader
            .by_ref()
            .take(128 * 1024 + 1)
            .read_until(b'\n', &mut bytes)
            .map_err(|e| e.to_string())?
            == 0
        {
            break;
        }
        if bytes.len() > 128 * 1024 {
            return Err("Correction line exceeds budget".into());
        }
        let edge: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Cannot verify correction history: invalid edge JSON")?;
        let from = edge["from"].as_str().unwrap_or("");
        let to = edge["to"].as_str().unwrap_or("");
        if edge["kind"] == "supersedes" && from.starts_with(&prefix) && to.starts_with(&prefix) {
            targets.insert(to.to_string());
        }
    }
    Ok(Some(targets))
}
