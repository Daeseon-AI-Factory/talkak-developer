//! Session-only startup instructions. Never edits agent config, hooks, or repository files.
use crate::memory_commands::MemoryAdapter;
use crate::session_runtime::SpawnSessionRequest;
use serde_json::Value;
use std::path::{Path, PathBuf};

mod process;
#[cfg(test)]
mod tests;

pub(crate) fn add_policy(
    adapter: MemoryAdapter,
    request: &SpawnSessionRequest,
    policy: &str,
) -> Result<Vec<String>, String> {
    let mut args = request.args.clone();
    let extra = match adapter {
        MemoryAdapter::McpJson => {
            let existing = take_append_prompt(&mut args)?;
            vec!["--append-system-prompt".into(), combine(policy, &existing)]
        }
        MemoryAdapter::McpToml => {
            let (probe_args, cwd) = inspection_args(&args, request.cwd.as_deref())?;
            let output = process::capture(request, &probe_args, &cwd)?;
            let existing = read_developer_instructions(&output)?;
            vec![
                "-c".into(),
                format!(
                    "developer_instructions={}",
                    serde_json::json!(combine(policy, &existing))
                ),
            ]
        }
    };
    // Last option wins, but never append flags after a user's explicit option terminator.
    let before_prompt = args
        .iter()
        .position(|arg| arg == "--")
        .unwrap_or(args.len());
    args.splice(before_prompt..before_prompt, extra);
    Ok(args)
}

fn combine(policy: &str, existing: &str) -> String {
    if existing.is_empty() {
        policy.to_owned()
    } else {
        format!("{policy}\n\nThe following user instructions take precedence over Talkak defaults:\n{existing}")
    }
}

fn take_append_prompt(args: &mut Vec<String>) -> Result<String, String> {
    let mut existing = String::new();
    let mut index = 0;
    while index < args.len() && args[index] != "--" {
        if args[index] == "--append-system-prompt" {
            if index + 1 == args.len() {
                return Err("Missing value for --append-system-prompt".into());
            }
            args.remove(index);
            existing = args.remove(index);
        } else if let Some(value) = args[index].strip_prefix("--append-system-prompt=") {
            existing = value.to_owned();
            args.remove(index);
        } else if args[index].starts_with("--append-system-prompt-file") {
            // A file option's precedence differs across CLI versions. Do not silently replace it.
            return Err("Use --append-system-prompt text with this connection, or choose direct launch to retain the prompt file option".into());
        } else {
            index += 1;
        }
    }
    Ok(existing)
}

/// Forward only configuration inputs to a read-only diagnostic, never a user's prompt or command.
/// Verified CLI contract: Codex 0.155.1 `debug prompt-input`, including global --profile.
fn inspection_args(
    args: &[String],
    project: Option<&str>,
) -> Result<(Vec<String>, PathBuf), String> {
    let mut probe = Vec::new();
    let mut cwd = PathBuf::from(project.ok_or("Startup instructions need a project folder")?);
    let mut index = 0;
    while index < args.len() && args[index] != "--" {
        let arg = &args[index];
        if matches!(
            arg.as_str(),
            "--ignore-user-config" | "--remote" | "--worktree"
        ) || arg.starts_with("--remote=")
        {
            return Err("This launch changes the configuration environment; use direct launch to preserve it".into());
        }
        if matches!(
            arg.as_str(),
            "-c" | "--config" | "-p" | "--profile" | "--enable" | "--disable"
        ) {
            let value = args
                .get(index + 1)
                .ok_or("Missing agent configuration value")?;
            probe.extend([arg.clone(), value.clone()]);
            index += 2;
            continue;
        }
        if matches!(arg.as_str(), "-C" | "--cd") {
            let value = args
                .get(index + 1)
                .ok_or("Missing agent working directory")?;
            cwd = Path::new(project.unwrap_or_default()).join(value);
            index += 2;
            continue;
        }
        if let Some(value) = arg
            .strip_prefix("--cd=")
            .or_else(|| arg.strip_prefix("-C").filter(|s| !s.is_empty()))
        {
            cwd = Path::new(project.unwrap_or_default()).join(value);
        } else if ["--config=", "--profile=", "--enable=", "--disable="]
            .iter()
            .any(|prefix| arg.starts_with(prefix))
            || (arg.starts_with("-c") && arg.len() > 2 && !arg.starts_with("--"))
            || (arg.starts_with("-p") && arg.len() > 2 && !arg.starts_with("--"))
        {
            probe.push(arg.clone());
        }
        index += 1;
    }
    probe.extend(["debug".into(), "prompt-input".into()]);
    Ok((probe, cwd))
}

/// Extract only the explicitly tagged user-configured developer text. Copying all developer
/// messages would duplicate the agent's own permissions, skills, and other built-in instructions.
fn read_developer_instructions(bytes: &[u8]) -> Result<String, String> {
    let failure = "The agent did not expose identifiable startup instructions. Use direct launch or a CLI supporting tagged debug prompt-input output";
    let messages: Value = serde_json::from_slice(bytes).map_err(|_| failure)?;
    let messages = messages.as_array().ok_or(failure)?;
    let mut texts = Vec::new();
    let mut tagged = false;
    for message in messages.iter().filter(|item| item["role"] == "developer") {
        let content = message["content"].as_array().ok_or(failure)?;
        let kinds = message["internal_chat_message_metadata_passthrough"]["content_item_kinds"]
            .as_array()
            .ok_or(failure)?;
        if content.len() != kinds.len() {
            return Err(failure.into());
        }
        tagged = true;
        for (part, kind) in content.iter().zip(kinds) {
            if kind == "generic.developer_instructions" {
                texts.push(part["text"].as_str().ok_or(failure)?);
            }
        }
    }
    if !tagged {
        return Err(failure.into());
    }
    Ok(texts.join("\n\n"))
}
