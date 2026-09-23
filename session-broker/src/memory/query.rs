use super::{clip, MemoryRecord, MemoryStore};
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySummary {
    pub id: String,
    pub title: String,
    pub excerpt: String,
    pub created_at_ms: u64,
    pub source_kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPage {
    pub records: Vec<MemorySummary>,
    pub has_more: bool,
    pub skipped: usize,
    pub selected_id: Option<String>,
}

impl MemoryStore {
    pub fn search(&self, query: &str, limit: usize) -> Result<MemoryPage, String> {
        if query.len() > 512 {
            return Err("Search query is too long".into());
        }
        let (records, skipped) = self.records()?;
        // A replacement remains a replacement even when the new note does not match this query.
        let superseded: HashSet<&str> = records
            .iter()
            .filter_map(|r| r.supersedes.as_deref())
            .collect();
        let terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        let mut matches: Vec<(&MemoryRecord, usize)> = records
            .iter()
            .filter(|r| !superseded.contains(r.id.as_str()))
            .filter_map(|r| {
                let title = r.title.to_lowercase();
                let body = r.body.to_lowercase();
                let score = terms
                    .iter()
                    .map(|t| usize::from(title.contains(t)) * 3 + usize::from(body.contains(t)))
                    .sum();
                (terms.is_empty() || terms.iter().all(|t| title.contains(t) || body.contains(t)))
                    .then_some((r, score))
            })
            .collect();
        matches.sort_by(|(a, sa), (b, sb)| {
            sb.cmp(sa)
                .then(b.created_at_ms.cmp(&a.created_at_ms))
                .then(b.id.cmp(&a.id))
        });
        let count = matches.len();
        let summaries = matches
            .into_iter()
            .take(limit.clamp(1, 8))
            .map(|(r, _)| MemorySummary {
                id: r.id.clone(),
                title: clip(&r.title, 120),
                excerpt: clip(&r.body, 200),
                created_at_ms: r.created_at_ms,
                source_kind: r.source.kind.clone(),
            });
        let mut page = MemoryPage {
            records: vec![],
            has_more: count > 0,
            skipped,
            selected_id: self.selected(),
        };
        // Includes every field, JSON escaping, and non-ASCII UTF-8. Leave room for the MCP envelope.
        for summary in summaries {
            page.records.push(summary);
            if serde_json::to_vec(&page).map_err(|e| e.to_string())?.len() > 3500 {
                page.records.pop();
                break;
            }
        }
        page.has_more = page.records.len() < count;
        Ok(page)
    }
}
