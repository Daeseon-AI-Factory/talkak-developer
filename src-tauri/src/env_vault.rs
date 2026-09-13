//! The environment vault: the keys and values a person keeps handing to agents.
//!
//! An API token, a registry URL, a deploy target — the same values get typed into a prompt again
//! and again, and an agent that does not see them asks. Here they are entered once, for the whole
//! app or for one project, and every session the app opens carries them in its environment. An
//! agent then reads `$MY_TOKEN` the way any program does, and `TALKAK_ENV_KEYS` tells it which
//! names exist so it does not ask for one that is already there.
//!
//! Values never go through a prompt. Non-secret values live in a JSON file under the app's data
//! directory; secret values live in the operating system's credential store (Keychain on macOS,
//! Credential Manager on Windows) and the file keeps only the name. The renderer sees secret
//! values as present, never as text.

use crate::transcript_paths::normalised_path;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const VAULT_FILE: &str = "env-vault.json";
const KEYRING_SERVICE: &str = "dev.talkak.desktop.env";
/// Name of the variable that lists every vault name a session received, comma separated.
pub(crate) const ENV_KEYS_VARIABLE: &str = "TALKAK_ENV_KEYS";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum VaultScope {
    App,
    Project,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct VaultEntry {
    secret: bool,
    /// Present for non-secret values only; a secret's value is in the credential store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    #[serde(default)]
    app: BTreeMap<String, VaultEntry>,
    /// Keyed by the normalised project path.
    #[serde(default)]
    projects: BTreeMap<String, BTreeMap<String, VaultEntry>>,
}

/// What the settings panel shows for one name.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VaultListing {
    pub key: String,
    pub secret: bool,
    /// The value for a non-secret entry; null for a secret, which is never handed to the renderer.
    pub value: Option<String>,
    pub scope: VaultScope,
}

/// Where secret values are kept. The app uses the OS credential store; tests use memory.
pub(crate) trait SecretStore: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<String>, String>;
    fn set(&self, id: &str, value: &str) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}

pub(crate) struct KeyringStore;

impl SecretStore for KeyringStore {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn set(&self, id: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new(KEYRING_SERVICE, id)
            .and_then(|entry| entry.set_password(value))
            .map_err(|e| e.to_string())
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, id).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

pub(crate) struct EnvVault {
    file: Option<PathBuf>,
    secrets: Box<dyn SecretStore>,
    state: Mutex<VaultFile>,
}

impl EnvVault {
    /// A vault under the app's data directory, secrets in the OS credential store. No data
    /// directory means nothing persists and every list is empty — still a working vault.
    pub(crate) fn open(data_dir: Option<PathBuf>) -> Self {
        Self::with_store(data_dir, Box::new(KeyringStore))
    }

    pub(crate) fn with_store(data_dir: Option<PathBuf>, secrets: Box<dyn SecretStore>) -> Self {
        let file = data_dir.map(|dir| dir.join(VAULT_FILE));
        let state = file
            .as_deref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|raw| serde_json::from_slice::<VaultFile>(&raw).ok())
            .unwrap_or_default();
        Self {
            file,
            secrets,
            state: Mutex::new(state),
        }
    }

    pub(crate) fn list(&self, scope: VaultScope, project_path: Option<&str>) -> Vec<VaultListing> {
        let state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        let entries: Option<&BTreeMap<String, VaultEntry>> = match scope {
            VaultScope::App => Some(&state.app),
            VaultScope::Project => project_path
                .map(normalised_path)
                .and_then(|key| state.projects.get(&key)),
        };
        entries
            .map(|entries| {
                entries
                    .iter()
                    .map(|(key, entry)| VaultListing {
                        key: key.clone(),
                        secret: entry.secret,
                        value: if entry.secret {
                            None
                        } else {
                            entry.value.clone()
                        },
                        scope,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn set(
        &self,
        scope: VaultScope,
        project_path: Option<&str>,
        key: &str,
        value: &str,
        secret: bool,
    ) -> Result<(), String> {
        validate_name(key)?;
        if value.contains('\0') {
            return Err("a value cannot contain NUL".into());
        }
        let id = secret_id(scope, project_path, key)?;
        let mut state = self.lock()?;
        // A name switching between secret and plain must not leave a stale value in either place.
        self.secrets.delete(&id)?;
        if secret {
            self.secrets.set(&id, value)?;
        }
        let entry = VaultEntry {
            secret,
            value: (!secret).then(|| value.to_string()),
        };
        Self::entries_mut(&mut state, scope, project_path)?.insert(key.to_string(), entry);
        self.persist(&state)
    }

    pub(crate) fn delete(
        &self,
        scope: VaultScope,
        project_path: Option<&str>,
        key: &str,
    ) -> Result<(), String> {
        let id = secret_id(scope, project_path, key)?;
        let mut state = self.lock()?;
        self.secrets.delete(&id)?;
        if let Ok(entries) = Self::entries_mut(&mut state, scope, project_path) {
            entries.remove(key);
        }
        self.persist(&state)
    }

    /// Import `KEY=VALUE` lines. Comments, blanks and quoted values are handled the way a shell
    /// would read a `.env`; a malformed line stops the import before anything is stored.
    pub(crate) fn import_dotenv(
        &self,
        scope: VaultScope,
        project_path: Option<&str>,
        text: &str,
        secret: bool,
    ) -> Result<usize, String> {
        let pairs = parse_dotenv(text)?;
        for (key, value) in &pairs {
            self.set(scope, project_path, key, value, secret)?;
        }
        Ok(pairs.len())
    }

    /// The environment a session in `project_path` receives: every app-wide entry, then the
    /// project's entries over them, then the list of names. Secrets are read from the credential
    /// store here and nowhere else.
    pub(crate) fn session_env(&self, project_path: Option<&str>) -> Vec<(String, String)> {
        let state = match self.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        let mut merged: BTreeMap<String, String> = BTreeMap::new();
        for (key, entry) in &state.app {
            if let Some(value) = self.resolve(VaultScope::App, None, key, entry) {
                merged.insert(key.clone(), value);
            }
        }
        if let Some(project) = project_path {
            if let Some(entries) = state.projects.get(&normalised_path(project)) {
                for (key, entry) in entries {
                    if let Some(value) =
                        self.resolve(VaultScope::Project, Some(project), key, entry)
                    {
                        merged.insert(key.clone(), value);
                    }
                }
            }
        }
        let names = merged.keys().cloned().collect::<Vec<_>>().join(",");
        let mut env: Vec<(String, String)> = merged.into_iter().collect();
        if !names.is_empty() {
            env.push((ENV_KEYS_VARIABLE.to_string(), names));
        }
        env
    }

    fn resolve(
        &self,
        scope: VaultScope,
        project_path: Option<&str>,
        key: &str,
        entry: &VaultEntry,
    ) -> Option<String> {
        if !entry.secret {
            return entry.value.clone();
        }
        let id = secret_id(scope, project_path, key).ok()?;
        // A secret the store no longer holds is left out rather than handed over empty.
        self.secrets.get(&id).ok().flatten()
    }

    fn entries_mut<'a>(
        state: &'a mut VaultFile,
        scope: VaultScope,
        project_path: Option<&str>,
    ) -> Result<&'a mut BTreeMap<String, VaultEntry>, String> {
        match scope {
            VaultScope::App => Ok(&mut state.app),
            VaultScope::Project => {
                let project = project_path.ok_or("a project scope needs a project path")?;
                Ok(state.projects.entry(normalised_path(project)).or_default())
            }
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, VaultFile>, String> {
        self.state
            .lock()
            .map_err(|_| "the vault is locked by a failed operation".to_string())
    }

    fn persist(&self, state: &VaultFile) -> Result<(), String> {
        let Some(path) = self.file.as_deref() else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let encoded = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
        write_private(path, &encoded)
    }
}

/// `.env` files are read by many tools; this one is owner-only where the platform can say so.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600));
    }
    // Windows: the app data directory is already per-user; NTFS inherits the profile's ACL.
    let _ = std::fs::remove_file(path);
    std::fs::rename(&temporary, path).map_err(|e| e.to_string())
}

fn secret_id(scope: VaultScope, project_path: Option<&str>, key: &str) -> Result<String, String> {
    Ok(match scope {
        VaultScope::App => format!("app:{key}"),
        VaultScope::Project => {
            let project = project_path.ok_or("a project scope needs a project path")?;
            format!("project:{}:{key}", normalised_path(project))
        }
    })
}

/// A POSIX-portable variable name — what every shell on both platforms accepts unquoted.
pub(crate) fn validate_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let valid = match chars.next() {
        Some(first) if first == '_' || first.is_ascii_alphabetic() => {
            chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
        }
        _ => false,
    };
    if !valid {
        return Err(format!(
            "'{name}' is not a variable name: letters, digits and underscores, not starting with a digit"
        ));
    }
    if name == ENV_KEYS_VARIABLE {
        return Err(format!("{ENV_KEYS_VARIABLE} is written by Talkak itself"));
    }
    Ok(())
}

/// `KEY=VALUE` per line; `export KEY=VALUE` accepted; `#` comments; single or double quotes
/// around a value are removed, and `\n`/`\t` unescaped inside double quotes only.
pub(crate) fn parse_dotenv(text: &str) -> Result<Vec<(String, String)>, String> {
    let mut pairs = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some((key, value)) = line.split_once('=') else {
            return Err(format!("line {}: expected KEY=VALUE", index + 1));
        };
        let key = key.trim();
        validate_name(key).map_err(|error| format!("line {}: {error}", index + 1))?;
        let value = value.trim();
        let value = if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
            value[1..value.len() - 1]
                .replace("\\n", "\n")
                .replace("\\t", "\t")
                .replace("\\\"", "\"")
        } else if value.len() >= 2 && value.starts_with('\'') && value.ends_with('\'') {
            value[1..value.len() - 1].to_string()
        } else {
            // An unquoted value ends at a trailing comment.
            value
                .split_once(" #")
                .map(|(head, _)| head.trim_end())
                .unwrap_or(value)
                .to_string()
        };
        pairs.push((key.to_string(), value));
    }
    Ok(pairs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct MemoryStore(StdMutex<HashMap<String, String>>);

    impl SecretStore for MemoryStore {
        fn get(&self, id: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(id).cloned())
        }
        fn set(&self, id: &str, value: &str) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(id.to_string(), value.to_string());
            Ok(())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn vault(dir: &Path) -> EnvVault {
        EnvVault::with_store(Some(dir.to_path_buf()), Box::new(MemoryStore::default()))
    }

    #[test]
    fn project_values_override_app_values_and_the_names_are_listed() {
        let temp = tempfile::tempdir().unwrap();
        let vault = vault(temp.path());
        vault
            .set(VaultScope::App, None, "REGISTRY", "https://a", false)
            .unwrap();
        vault
            .set(VaultScope::App, None, "TOKEN", "app-token", true)
            .unwrap();
        vault
            .set(
                VaultScope::Project,
                Some("/work/app/"),
                "TOKEN",
                "project-token",
                true,
            )
            .unwrap();

        let env = vault.session_env(Some("/work/app"));
        assert_eq!(
            env,
            vec![
                ("REGISTRY".to_string(), "https://a".to_string()),
                ("TOKEN".to_string(), "project-token".to_string()),
                (ENV_KEYS_VARIABLE.to_string(), "REGISTRY,TOKEN".to_string()),
            ]
        );
        let elsewhere = vault.session_env(Some("/work/other"));
        assert_eq!(elsewhere[1].1, "app-token");
        assert!(vault.session_env(None).len() == 3);
    }

    #[test]
    fn secrets_are_never_listed_as_text_but_plain_values_are() {
        let temp = tempfile::tempdir().unwrap();
        let vault = vault(temp.path());
        vault
            .set(VaultScope::App, None, "PLAIN", "shown", false)
            .unwrap();
        vault
            .set(VaultScope::App, None, "SECRET", "hidden", true)
            .unwrap();
        let listing = vault.list(VaultScope::App, None);
        assert_eq!(listing.len(), 2);
        assert_eq!(listing[0].value.as_deref(), Some("shown"));
        assert!(listing[1].secret);
        assert_eq!(listing[1].value, None);
        let file = std::fs::read_to_string(temp.path().join(VAULT_FILE)).unwrap();
        assert!(!file.contains("hidden"), "the secret leaked into the file");
    }

    #[test]
    fn switching_a_name_between_secret_and_plain_leaves_no_stale_copy() {
        let temp = tempfile::tempdir().unwrap();
        let vault = vault(temp.path());
        vault.set(VaultScope::App, None, "K", "one", true).unwrap();
        vault.set(VaultScope::App, None, "K", "two", false).unwrap();
        assert_eq!(vault.session_env(None)[0].1, "two");
        vault.delete(VaultScope::App, None, "K").unwrap();
        assert!(vault.session_env(None).is_empty());
        assert!(vault.list(VaultScope::App, None).is_empty());
    }

    #[test]
    fn a_vault_survives_a_new_instance_over_the_same_directory() {
        let temp = tempfile::tempdir().unwrap();
        vault(temp.path())
            .set(VaultScope::App, None, "A", "1", false)
            .unwrap();
        let reopened = vault(temp.path());
        assert_eq!(
            reopened.list(VaultScope::App, None)[0].value.as_deref(),
            Some("1")
        );
    }

    #[test]
    fn names_are_validated_and_the_reserved_one_refused() {
        assert!(validate_name("OK_1").is_ok());
        assert!(validate_name("1BAD").is_err());
        assert!(validate_name("with-dash").is_err());
        assert!(validate_name("").is_err());
        assert!(validate_name(ENV_KEYS_VARIABLE).is_err());
    }

    #[test]
    fn dotenv_import_reads_what_a_shell_would() {
        let text = "# comment\nexport A=1\nB=\"two words\\nnext\"\nC='raw $x'\nD=plain # note\n\n";
        let pairs = parse_dotenv(text).unwrap();
        assert_eq!(
            pairs,
            vec![
                ("A".to_string(), "1".to_string()),
                ("B".to_string(), "two words\nnext".to_string()),
                ("C".to_string(), "raw $x".to_string()),
                ("D".to_string(), "plain".to_string()),
            ]
        );
        assert!(parse_dotenv("NOEQUALS").is_err());
        assert!(parse_dotenv("1X=1").is_err());
        let temp = tempfile::tempdir().unwrap();
        let vault = vault(temp.path());
        assert_eq!(
            vault
                .import_dotenv(VaultScope::App, None, text, true)
                .unwrap(),
            4
        );
        assert!(vault.list(VaultScope::App, None).iter().all(|e| e.secret));
    }
}
