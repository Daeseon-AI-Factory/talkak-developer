//! Local-only performance probes for cold/warm transcript reads, split out of the behavior
//! tests so both files stay under the readable-source line limit. These are `#[ignore]`d and
//! only meaningful against a developer's own Codex/Claude history.

use super::*;
use crate::agent_transcript::{collect_line_without_filter_for_test, Collected};
use crate::transcript_line_filter::{codex_session_header, compact_record_relevance};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::Instant;

#[test]
#[ignore = "local transcript cold/warm performance probe"]
fn local_cold_and_warm_cache_probe() {
    let project = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let Some(home) = home_dir() else {
        println!("no local home directory; skipped");
        return;
    };
    let discovery_started = Instant::now();
    let selected = discover_record(
        &home,
        &project,
        None,
        Some(TranscriptSource::Codex),
        None,
        None,
    )
    .unwrap();
    let discovery_elapsed = discovery_started.elapsed();
    let Some(selected) = selected else {
        println!("no local Codex record; skipped");
        return;
    };
    let selected_path = selected.path.clone();
    let mut first_line = String::new();
    BufReader::new(std::fs::File::open(&selected_path).unwrap())
        .read_line(&mut first_line)
        .unwrap();
    let selected_header = codex_session_header(&first_line).unwrap();
    let selected_started_ms = selected_header
        .timestamp
        .as_deref()
        .and_then(parse_rfc3339_ms)
        .unwrap();
    let targeted_discovery_started = Instant::now();
    let targeted = discover_record(
        &home,
        &project,
        Some(selected_started_ms),
        Some(TranscriptSource::Codex),
        None,
        None,
    )
    .unwrap()
    .unwrap();
    let targeted_discovery_elapsed = targeted_discovery_started.elapsed();
    assert_eq!(targeted.path, selected_path);
    let parse_started = Instant::now();
    let parsed = BoundTranscript::open("local-performance-probe".into(), None, selected).unwrap();
    let parse_elapsed = parse_started.elapsed();
    let legacy_started = Instant::now();
    let (legacy, fast_relevant, fast_rejected, fallback) = legacy_codex_projection(&selected_path);
    let legacy_elapsed = legacy_started.elapsed();
    let service = TranscriptService::new(None);
    let cold_started = Instant::now();
    let Some(cold) = service
        .read(
            "local-performance-probe".into(),
            None,
            project,
            None,
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
    else {
        println!("no local Codex record; skipped");
        return;
    };
    let cold_elapsed = cold_started.elapsed();
    let warm_started = Instant::now();
    let warm = service
        .read(
            "local-performance-probe".into(),
            None,
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            None,
            Some("codex".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();
    let warm_elapsed = warm_started.elapsed();

    assert_eq!(warm.total_entries, cold.total_entries);
    assert_eq!(
        parsed.snapshot(MAX_TRANSCRIPT_ENTRIES).total_entries,
        cold.total_entries
    );
    assert_eq!(legacy.total_entries, cold.total_entries);
    println!(
        "discovery={}ms targeted_discovery={}ms parse={}ms legacy_parse={}ms cold={}ms warm={}us turns={} fast_relevant={} fast_rejected={} fallback={} path={}",
        discovery_elapsed.as_millis(),
        targeted_discovery_elapsed.as_millis(),
        parse_elapsed.as_millis(),
        legacy_elapsed.as_millis(),
        cold_elapsed.as_millis(),
        warm_elapsed.as_micros(),
        warm.total_entries,
        fast_relevant,
        fast_rejected,
        fallback,
        warm.path
    );
}

#[test]
#[ignore = "local Claude transcript cold/warm performance probe"]
fn local_claude_cold_and_warm_cache_probe() {
    let project = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let Some(home) = home_dir() else {
        println!("no local home directory; skipped");
        return;
    };
    let discovery_started = Instant::now();
    let selected = discover_record(
        &home,
        &project,
        None,
        Some(TranscriptSource::Claude),
        None,
        None,
    )
    .unwrap();
    let discovery_elapsed = discovery_started.elapsed();
    let Some(selected) = selected else {
        println!("no local Claude record; skipped");
        return;
    };
    let bytes = std::fs::metadata(&selected.path).unwrap().len();
    let parse_started = Instant::now();
    let parsed = BoundTranscript::open("local-claude-parse-probe".into(), None, selected).unwrap();
    let parse_elapsed = parse_started.elapsed();
    let parsed_lines = parsed.parsed_lines;

    let service = TranscriptService::new(None);
    let cold_started = Instant::now();
    let cold = service
        .read(
            "local-claude-cache-probe".into(),
            None,
            project.clone(),
            None,
            Some("claude".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();
    let cold_elapsed = cold_started.elapsed();
    let warm_started = Instant::now();
    let warm = service
        .read(
            "local-claude-cache-probe".into(),
            None,
            project,
            None,
            Some("claude".into()),
            MAX_TRANSCRIPT_ENTRIES,
        )
        .unwrap()
        .unwrap();
    let warm_elapsed = warm_started.elapsed();

    assert_eq!(warm.total_entries, cold.total_entries);
    assert_eq!(
        parsed.snapshot(MAX_TRANSCRIPT_ENTRIES).total_entries,
        cold.total_entries
    );
    println!(
        "claude discovery={}ms parse={}ms cold={}ms warm={}us bytes={} lines={} turns={}",
        discovery_elapsed.as_millis(),
        parse_elapsed.as_millis(),
        cold_elapsed.as_millis(),
        warm_elapsed.as_micros(),
        bytes,
        parsed_lines,
        warm.total_entries,
    );
}

fn legacy_codex_projection(path: &Path) -> (AgentTranscript, usize, usize, usize) {
    let file = std::fs::File::open(path).unwrap();
    let mut collected = Collected::new();
    let (mut relevant, mut rejected, mut fallback) = (0, 0, 0);
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        match compact_record_relevance(TranscriptSource::Codex, &line) {
            Some(true) => relevant += 1,
            Some(false) => rejected += 1,
            None => fallback += 1,
        }
        collect_line_without_filter_for_test(
            TranscriptSource::Codex,
            &line,
            &mut collected,
            MAX_TRANSCRIPT_ENTRIES,
        );
    }
    (
        collected.snapshot(TranscriptSource::Codex, path, MAX_TRANSCRIPT_ENTRIES),
        relevant,
        rejected,
        fallback,
    )
}
