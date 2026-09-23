//! Exercises the packaged executable's memory mode outside the checkout, without a model or PTY.
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn standalone_memory_server_round_trip_survives_restart() {
    let temp = tempfile::tempdir().unwrap();
    let binary = temp
        .path()
        .join(format!("memory runtime{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(env!("CARGO_BIN_EXE_talkak-dev-broker"), &binary).unwrap();
    let project = temp.path().join("프로젝트 with spaces");
    std::fs::create_dir(&project).unwrap();
    let root = temp.path().join("app data");
    let exchange = |requests: Vec<Value>| {
        let mut child = Command::new(&binary)
            .current_dir(temp.path())
            .arg("--memory-mcp")
            .arg(&root)
            .arg(&project)
            .arg("session-a")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        for request in requests {
            writeln!(input, "{request}").unwrap();
        }
        drop(input);
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>()
    };
    let init = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}});
    let first = exchange(vec![
        init.clone(),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
        "params":{"name":"memory_save","arguments":{"title":"입력 인수인계","body":"실제 키 입력 테스트를 이어간다."}}}),
    ]);
    // The copied executable must carry the same bounded policy without reading a checkout or
    // personal instruction file. This tests the real wire response, not just the source constant.
    let policy = first[0]["result"]["instructions"].as_str().unwrap();
    assert!(policy.starts_with("Talkak session defaults."));
    assert!(first[0].to_string().len() <= session_broker::memory::RESPONSE_BYTES);
    let saved: Value =
        serde_json::from_str(first[1]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    let second = exchange(vec![
        init,
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
        "params":{"name":"memory_search","arguments":{"query":"입력"}}}),
    ]);
    assert_eq!(second[0]["result"]["instructions"], policy);
    let found: Value =
        serde_json::from_str(second[1]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(found["records"][0]["id"], saved["id"]);
}

#[test]
fn policy_only_mode_never_opens_a_memory_store_or_exposes_memory_tools() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("must-not-be-created");
    let mut child = Command::new(env!("CARGO_BIN_EXE_talkak-dev-broker"))
        .current_dir(temp.path())
        .arg("--memory-mcp")
        .arg(&root)
        .arg(temp.path().join("project-does-not-exist"))
        .arg("session-policy-only")
        .arg("--no-memory")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for request in [
        json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"memory_save","arguments":{"title":"No","body":"Must not save"}}}),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memory_search","arguments":{"query":""}}}),
        json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"memory_read","arguments":{"id":"a"}}}),
        json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"session_context","arguments":{}}}),
    ] {
        writeln!(input, "{request}").unwrap();
    }
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let replies: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 6);
    assert!(replies[0]["result"]["instructions"]
        .as_str()
        .unwrap()
        .starts_with("Talkak session defaults."));
    let tools = replies[1]["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "session_context");
    assert!(!tools[0]["description"]
        .as_str()
        .unwrap()
        .contains("Stop when"));
    for reply in &replies[2..5] {
        assert_eq!(reply["result"]["isError"], true);
    }
    let context: Value =
        serde_json::from_str(replies[5]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(context["memoryEnabled"], false);
    assert_eq!(
        context["instructions"],
        replies[0]["result"]["instructions"]
    );
    assert!(!root.exists());
}
