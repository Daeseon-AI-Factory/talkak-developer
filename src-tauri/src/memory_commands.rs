use serde::Deserialize;
use session_broker::memory::{
    import::{import_file, ImportReport},
    MemoryDraft, MemoryPage, MemoryRecord, MemorySource, MemoryStore,
};
use std::path::{Path, PathBuf};
use tauri::State;

pub(crate) struct ProjectMemory {
    root: Option<PathBuf>,
}

impl ProjectMemory {
    pub(crate) fn new(app_data: Option<PathBuf>) -> Self {
        Self {
            root: app_data.map(|path| path.join("memory")),
        }
    }
    pub(crate) fn root(&self) -> Result<&Path, String> {
        self.root
            .as_deref()
            .ok_or_else(|| "App data directory is unavailable".into())
    }
    fn store(&self, project_path: &str) -> Result<MemoryStore, String> {
        MemoryStore::open(self.root()?, Path::new(project_path))
    }
}

#[tauri::command(async)]
pub(crate) fn memory_search(
    memory: State<'_, ProjectMemory>,
    project_path: String,
    query: String,
) -> Result<MemoryPage, String> {
    memory.store(&project_path)?.search(&query, 8)
}

#[tauri::command(async)]
pub(crate) fn memory_read(
    memory: State<'_, ProjectMemory>,
    project_path: String,
    id: String,
) -> Result<MemoryRecord, String> {
    memory.store(&project_path)?.read(&id)
}

#[tauri::command(async)]
pub(crate) fn memory_save(
    memory: State<'_, ProjectMemory>,
    project_path: String,
    draft: MemoryDraft,
    mut source: MemorySource,
) -> Result<MemoryRecord, String> {
    // This command is the user-reviewed editor. MCP writes are separately stamped agent-authored.
    source.kind = "user".into();
    memory.store(&project_path)?.save(draft, source)
}

#[tauri::command(async)]
pub(crate) fn memory_select(
    memory: State<'_, ProjectMemory>,
    project_path: String,
    id: Option<String>,
) -> Result<(), String> {
    memory.store(&project_path)?.select(id.as_deref())
}

#[tauri::command(async)]
pub(crate) fn memory_import(
    memory: State<'_, ProjectMemory>,
    project_path: String,
    path: String,
    startup_id: String,
) -> Result<ImportReport, String> {
    import_file(&memory.store(&project_path)?, Path::new(&path), &startup_id)
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MemoryAdapter {
    McpJson,
    McpToml,
}

/// Adapter choice is explicit launch configuration, never inferred from an executable's name.
/// Argument contracts: Claude Code --mcp-config (JSON), Codex -c mcp_servers.* (TOML values).
/// Both receive the same local stdio server; no global config, hooks or agent prompt replacement.
pub(crate) fn connection_args(
    adapter: MemoryAdapter,
    binary: &Path,
    root: &Path,
    project: &str,
    session: &str,
    memory_enabled: bool,
) -> Result<Vec<String>, String> {
    let binary = binary
        .to_str()
        .ok_or("Memory executable path is not Unicode")?;
    let root = root.to_str().ok_or("Memory root is not Unicode")?;
    let mut arguments = vec!["--memory-mcp", root, project, session];
    if !memory_enabled {
        arguments.push("--no-memory");
    }
    match adapter {
        MemoryAdapter::McpJson => Ok(vec![
            "--mcp-config".into(),
            serde_json::json!({"mcpServers": {
                "talkak_memory": {"type":"stdio", "command":binary, "args":arguments}
            }})
            .to_string(),
        ]),
        MemoryAdapter::McpToml => Ok(vec![
            "-c".into(),
            format!(
                "mcp_servers.talkak_memory.command={}",
                serde_json::json!(binary)
            ),
            "-c".into(),
            format!(
                "mcp_servers.talkak_memory.args={}",
                serde_json::json!(arguments)
            ),
        ]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapters_preserve_literal_cross_platform_paths_and_share_one_protocol() {
        for binary in [
            r"C:\Program Files\Talkak\broker.exe",
            "/Applications/Talkak Dev.app/Contents/MacOS/broker",
        ] {
            let root = Path::new("folder with spaces");
            let json = connection_args(
                MemoryAdapter::McpJson,
                Path::new(binary),
                root,
                "프로젝트",
                "session-1",
                true,
            )
            .unwrap();
            let config: serde_json::Value = serde_json::from_str(&json[1]).unwrap();
            assert_eq!(config["mcpServers"]["talkak_memory"]["command"], binary);
            let toml = connection_args(
                MemoryAdapter::McpToml,
                Path::new(binary),
                root,
                "프로젝트",
                "session-1",
                true,
            )
            .unwrap();
            let args: serde_json::Value =
                serde_json::from_str(toml[3].split_once('=').unwrap().1).unwrap();
            assert_eq!(args, config["mcpServers"]["talkak_memory"]["args"]);
            assert!(!toml
                .iter()
                .any(|arg| arg.contains("developer_instructions")));
        }
    }
}
