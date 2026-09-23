use crate::env_vault::{EnvVault, VaultListing, VaultScope};
use tauri::State;

// All async: the OS credential store can prompt or block, and that must never sit on the IPC thread.

#[tauri::command(async)]
pub(crate) fn env_vault_list(
    vault: State<'_, EnvVault>,
    scope: VaultScope,
    project_path: Option<String>,
) -> Vec<VaultListing> {
    vault.list(scope, project_path.as_deref())
}

#[tauri::command(async)]
pub(crate) fn env_vault_set(
    vault: State<'_, EnvVault>,
    scope: VaultScope,
    project_path: Option<String>,
    key: String,
    value: String,
    secret: bool,
) -> Result<(), String> {
    vault.set(scope, project_path.as_deref(), &key, &value, secret)
}

#[tauri::command(async)]
pub(crate) fn env_vault_delete(
    vault: State<'_, EnvVault>,
    scope: VaultScope,
    project_path: Option<String>,
    key: String,
) -> Result<(), String> {
    vault.delete(scope, project_path.as_deref(), &key)
}

/// Returns how many names were stored.
#[tauri::command(async)]
pub(crate) fn env_vault_import(
    vault: State<'_, EnvVault>,
    scope: VaultScope,
    project_path: Option<String>,
    text: String,
    secret: bool,
) -> Result<usize, String> {
    vault.import_dotenv(scope, project_path.as_deref(), &text, secret)
}
