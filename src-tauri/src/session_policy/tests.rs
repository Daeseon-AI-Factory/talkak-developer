use super::*;
use serde_json::json;

fn request(args: &[&str]) -> SpawnSessionRequest {
    SpawnSessionRequest {
        session_id: "policy-test".into(),
        cwd: Some(std::env::temp_dir().to_string_lossy().into()),
        command: Some("configured-agent".into()),
        args: args.iter().map(|s| s.to_string()).collect(),
        env: vec![],
        cols: 80,
        rows: 24,
        restore: false,
    }
}

#[test]
fn extracts_user_instructions_without_duplicating_builtins_or_prompt_content() {
    let input = json!([
        {"role":"developer","content":[{"text":"permissions"},{"text":"사용자 지침\n$literal `value`"}],
         "internal_chat_message_metadata_passthrough":{"content_item_kinds":["permissions.instructions","generic.developer_instructions"]}},
        {"role":"user","content":[{"text":"Not instructions"}]}
    ]);
    assert_eq!(
        read_developer_instructions(input.to_string().as_bytes()).unwrap(),
        "사용자 지침\n$literal `value`"
    );
    assert!(read_developer_instructions(
        br#"[{"role":"developer","content":[{"text":"untagged user instructions"}]}]"#
    )
    .is_err());
    assert!(read_developer_instructions(br#"[]"#).is_err());
    let no_user = json!([{"role":"developer","content":[{"text":"permissions"}],
        "internal_chat_message_metadata_passthrough":{"content_item_kinds":["permissions.instructions"]}}]);
    assert_eq!(
        read_developer_instructions(no_user.to_string().as_bytes()).unwrap(),
        ""
    );
}

#[test]
fn inspection_keeps_profile_config_and_directory_but_never_runs_the_requested_task() {
    let launch = request(&[
        "exec",
        "--profile",
        "custom",
        "-c",
        "developer_instructions='keep me'",
        "--model",
        "user-model",
        "--cd",
        "nested",
        "DO NOT RUN",
        "--",
        "--config=prompt data",
    ]);
    let (args, cwd) = inspection_args(&launch.args, launch.cwd.as_deref()).unwrap();
    assert_eq!(
        args,
        [
            "--profile",
            "custom",
            "-c",
            "developer_instructions='keep me'",
            "debug",
            "prompt-input"
        ]
    );
    assert_eq!(cwd, PathBuf::from(launch.cwd.unwrap()).join("nested"));
    assert!(inspection_args(&["--ignore-user-config".into()], Some("project")).is_err());
}

#[test]
fn append_adapter_preserves_user_instructions_model_and_literal_prompt() {
    let launch = request(&[
        "--model",
        "chosen-model",
        "--append-system-prompt",
        "my\nrule",
        "--",
        "literal prompt",
    ]);
    let args = add_policy(MemoryAdapter::McpJson, &launch, "APP_DEFAULT").unwrap();
    assert_eq!(&args[..2], &["--model", "chosen-model"]);
    assert_eq!(&args[args.len() - 2..], &["--", "literal prompt"]);
    assert_eq!(
        args.iter()
            .filter(|arg| *arg == "--append-system-prompt")
            .count(),
        1
    );
    assert!(args[3].starts_with("APP_DEFAULT"));
    assert!(args[3].ends_with("my\nrule"));
    assert!(launch.args.contains(&"my\nrule".into()));
}

/// Explicit opt-in, read-only installed-CLI contract test. No model call, personal config edit,
/// auth copy, or hardcoded executable. Normal CI uses the native configurable probe instead.
#[test]
#[ignore = "requires TALKAK_POLICY_SMOKE_COMMAND pointing to an installed compatible CLI"]
fn configured_cli_prompt_contains_defaults_and_original_user_instructions() {
    let command =
        std::env::var("TALKAK_POLICY_SMOKE_COMMAND").expect("Set the configured CLI path");
    let project = tempfile::tempdir().unwrap();
    let mut launch = request(&[
        "-c",
        "developer_instructions='USER_INSTRUCTIONS_MUST_SURVIVE'",
        "-c",
        "model_reasoning_effort='low'",
    ]);
    launch.cwd = Some(project.path().to_string_lossy().into());
    launch.command = Some(command);
    let policy = session_broker::memory::mcp::session_instructions(None);
    let args = add_policy(MemoryAdapter::McpToml, &launch, &policy).unwrap();
    let (probe_args, cwd) = inspection_args(&args, launch.cwd.as_deref()).unwrap();
    let output = process::capture(&launch, &probe_args, &cwd).unwrap();
    let visible = read_developer_instructions(&output).unwrap();
    assert!(
        visible.contains("Stop when the requested outcome and its necessary checks are satisfied.")
    );
    assert!(visible.ends_with("USER_INSTRUCTIONS_MUST_SURVIVE"));
    println!("SESSION_POLICY_PROMPT_OK: defaults and original user instructions are present before any model turn");
}
