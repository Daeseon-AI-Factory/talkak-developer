use super::*;
use serde_json::{json, Value};

fn store(temp: &tempfile::TempDir, project: &str) -> MemoryStore {
    let project = temp.path().join(project);
    fs::create_dir_all(&project).unwrap();
    MemoryStore::open(&temp.path().join("memory"), &project).unwrap()
}
fn source() -> MemorySource {
    MemorySource {
        kind: "agent".into(),
        session_id: "session-1".into(),
        reference: None,
    }
}
fn draft(title: &str, body: &str) -> MemoryDraft {
    MemoryDraft {
        title: title.into(),
        body: body.into(),
        supersedes: None,
    }
}
fn initialize(server: &mut mcp::MemoryServer) -> Value {
    server.handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}})).unwrap()
}

#[test]
fn memory_persists_but_never_crosses_projects_or_accepts_paths_as_ids() {
    let temp = tempfile::tempdir().unwrap();
    let a = store(&temp, "프로젝트 A");
    let b = store(&temp, "project B");
    let note = a
        .save(
            draft("입력 결정", "한글 조합 입력을 먼저 검증한다."),
            source(),
        )
        .unwrap();
    assert_eq!(
        store(&temp, "프로젝트 A").read(&note.id).unwrap().body,
        note.body
    );
    assert_eq!(a.search("한글 입력", 8).unwrap().records.len(), 1);
    assert!(b.search("한글", 8).unwrap().records.is_empty());
    assert!(b.read(&note.id).is_err());
    for id in ["../handoff", "/etc/passwd", r"..\handoff", "CON", ""] {
        assert!(a.read(id).is_err());
    }
    assert_eq!(
        a.save(
            draft("입력 결정", "한글 조합 입력을 먼저 검증한다."),
            source()
        )
        .unwrap()
        .id,
        note.id
    );
}

#[test]
fn corrections_remove_old_hits_even_when_replacement_does_not_match_query() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(&temp, "project");
    let old = s.save(draft("Old", "outdated decision"), source()).unwrap();
    let new = s
        .save(
            MemoryDraft {
                supersedes: Some(old.id.clone()),
                ..draft("New", "current decision")
            },
            source(),
        )
        .unwrap();
    assert!(s.search("outdated", 8).unwrap().records.is_empty());
    assert_eq!(s.search("decision", 8).unwrap().records[0].id, new.id);
    assert_eq!(s.read(&old.id).unwrap().body, "outdated decision");
    assert!(s
        .save(
            MemoryDraft {
                supersedes: Some("deadbeef".into()),
                ..draft("Bad", "Missing predecessor")
            },
            source()
        )
        .is_err());
}

#[test]
fn concurrent_sessions_do_not_overwrite_each_others_notes() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(&temp, "project");
    let joins: Vec<_> = (0..12)
        .map(|i| {
            let s = s.clone();
            std::thread::spawn(move || {
                s.save(
                    draft(&format!("Task {i}"), "Distinct completed task"),
                    source(),
                )
                .unwrap()
                .id
            })
        })
        .collect();
    let ids: std::collections::HashSet<_> = joins.into_iter().map(|j| j.join().unwrap()).collect();
    assert_eq!(ids.len(), 12);
    assert_eq!(s.records().unwrap().0.len(), 12);
}

#[test]
fn malformed_records_are_counted_and_partial_files_are_not_read() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(&temp, "project");
    s.save(draft("Good", "Retained"), source()).unwrap();
    fs::write(s.directory.join("a.json"), "{broken").unwrap();
    fs::write(s.directory.join("b.pending"), "{incomplete").unwrap();
    let page = s.search("", 8).unwrap();
    assert_eq!(page.records.len(), 1);
    assert_eq!(page.skipped, 1);
}

#[test]
fn selected_handoff_is_an_id_only_and_requires_explicit_selection() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(&temp, "project");
    let note = s
        .save(
            draft("handoff", "PRIVATE_BODY_MUST_NOT_BE_AUTO_INJECTED"),
            source(),
        )
        .unwrap();
    let plain = initialize(&mut mcp::MemoryServer::new(s.clone(), "a".into())).to_string();
    assert!(!plain.contains(&note.id));
    assert!(!plain.contains(&note.body));
    s.select(Some(&note.id)).unwrap();
    let mut server = mcp::MemoryServer::new(s.clone(), "b".into());
    let selected = initialize(&mut server).to_string();
    assert!(selected.contains(&note.id));
    assert!(!selected.contains(&note.body));
    let listing = server
        .handle(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
        .unwrap()
        .to_string();
    assert!(!listing.contains("Stop when"));
    assert!(!listing.contains(&note.body));
    assert!(listing.len() <= RESPONSE_BYTES);
    let context = server.handle(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"session_context","arguments":{}}})).unwrap().to_string();
    assert!(context.contains(&note.id));
    assert!(!context.contains(&note.body));
    assert!(context.len() <= RESPONSE_BYTES);
    s.select(None).unwrap();
    assert!(s.selected().is_none());
}

#[test]
fn complete_mcp_responses_fit_budget_with_korean_emoji_quotes_and_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(&temp, "project");
    let mut ids = vec![];
    for i in 0..16 {
        ids.push(
            s.save(
                draft(
                    &format!("{i} {}", "한😀\"\\".repeat(20)),
                    &"한😀\"\\".repeat(390),
                ),
                MemorySource {
                    reference: Some("\\\"".repeat(1000)),
                    ..source()
                },
            )
            .unwrap()
            .id,
        );
    }
    let mut server = mcp::MemoryServer::new(s, "a".into());
    initialize(&mut server);
    for (name, args) in [
        ("memory_search", json!({"query":"","limit":8})),
        ("memory_read", json!({"id":ids[0]})),
    ] {
        let response = server.handle(json!({"jsonrpc":"2.0","id":"request","method":"tools/call","params":{"name":name,"arguments":args}})).unwrap();
        assert!(response.to_string().len() <= RESPONSE_BYTES);
        assert!(response.get("error").is_none(), "{response}");
        let data: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        if name == "memory_read" {
            assert_eq!(data["sourceTruncated"], true);
            assert!(!data["body"].as_str().unwrap().is_empty());
        } else {
            assert_eq!(data["hasMore"], true);
        }
    }
}

#[test]
fn paged_read_recovers_the_entire_note_under_the_wire_budget() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(&temp, "project");
    let body = "\u{0001}".repeat(1600);
    let note = s.save(draft("Escaped data", &body), source()).unwrap();
    let mut server = mcp::MemoryServer::new(s, "session".into());
    initialize(&mut server);
    let mut offset = 0;
    let mut recovered = String::new();
    loop {
        let response = server
            .handle(json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
            "params":{"name":"memory_read","arguments":{"id":note.id,"offset":offset}}}))
            .unwrap();
        assert!(response.to_string().len() <= RESPONSE_BYTES);
        let data: Value =
            serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap();
        recovered.push_str(data["body"].as_str().unwrap());
        let Some(next) = data["nextOffset"].as_u64() else {
            break;
        };
        assert!(next > offset);
        offset = next;
    }
    assert_eq!(recovered, body);
}

#[test]
fn import_filters_scope_preserves_source_and_is_idempotent() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(&temp, "project");
    let file = temp.path().join("records.jsonl");
    let rows = [
        json!({"node_id":"startup-a/issue/one","node_type":"issue","title":"Known issue","body":"Check input"}),
        json!({"node_id":"startup-b/issue/two","node_type":"issue","title":"Other project","body":"Must not import"}),
        json!({"node_id":"startup-a/change/three","node_type":"change","title":"Raw commit","body":"Large diff"}),
        json!({"node_id":"startup-a/issue/four","node_type":"issue","title":"Invalidated","body":"Old","invalid_at":"yesterday"}),
    ];
    fs::write(
        &file,
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    let report = import::import_file(&s, &file, "startup-a").unwrap();
    assert_eq!(report.imported, 1);
    assert_eq!(report.skipped, 3);
    assert!(!report.corrections_checked);
    assert_eq!(
        import::import_file(&s, &file, "startup-a")
            .unwrap()
            .imported,
        0
    );
    let notes = s.records().unwrap().0;
    assert_eq!(
        notes[0].source.reference.as_deref(),
        Some("startup-a/issue/one")
    );
    assert_eq!(notes[0].source.kind, "imported");
}

#[test]
fn import_checks_dalkkak_correction_edges_before_loading_raw_nodes() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(&temp, "project");
    let file = temp.path().join("startup-a.jsonl");
    let rows = [
        json!({"node_id":"startup-a/issue/old","node_type":"issue","title":"Old","body":"outdated"}),
        json!({"node_id":"startup-a/issue/new","node_type":"issue","title":"New","body":"current"}),
    ];
    fs::write(
        &file,
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    fs::create_dir(temp.path().join("edges")).unwrap();
    fs::write(temp.path().join("edges/startup-a.jsonl"), [
        json!({"kind":"supersedes","from":"startup-a/issue/new","to":"startup-a/issue/old"}).to_string(),
        json!({"kind":"supersedes","from":"startup-b/issue/foreign","to":"startup-a/issue/new"}).to_string(),
    ].join("\n")).unwrap();
    let report = import::import_file(&s, &file, "startup-a").unwrap();
    assert!(report.corrections_checked);
    assert_eq!(report.imported, 1);
    assert_eq!(report.skipped, 1);
    assert!(s.search("outdated", 8).unwrap().records.is_empty());
    assert_eq!(s.search("current", 8).unwrap().records.len(), 1);
}

#[test]
fn transport_rejects_oversized_input_and_does_not_answer_notifications() {
    let temp = tempfile::tempdir().unwrap();
    let s = store(&temp, "project");
    let mut server = mcp::MemoryServer::new(s.clone(), "a".into());
    assert!(server
        .handle(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
        .is_none());
    let oversized = vec![b'x'; 33 * 1024];
    assert!(mcp::serve(
        &oversized[..],
        vec![],
        mcp::MemoryServer::new(s, "b".into())
    )
    .is_err());
}
