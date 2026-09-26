//! File-backed secret store. Raw secrets live in `<data_dir>/.secrets.json` (mode 600),
//! owned by the user, not the OS keychain. No code-signing dependency, no keychain prompt.
//!
//! Account naming is unchanged: `masterkey` for the gateway master key, `key:<keyId>` for
//! provider keys, `gwkey:<id>` for per-app gateway keys.
//!
//! The keychain was the original backend. Any existing keychain items are left in place but no
//! longer read — the master key will be re-minted on the next `ensure_master_key` call if the
//! file does not have one, and provider keys will need to be re-entered in the UI. This is a
//! one-time migration cost for existing users.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, Once};

/// The service-name constant, kept for any external caller that still names it.
pub const SERVICE: &str = "ai-provider-router";

const SECRETS_FILE: &str = ".secrets.json";

#[derive(thiserror::Error, Debug)]
pub enum VaultError {
    #[error("secrets file error for {account}: {source}")]
    File {
        account: String,
        #[source]
        source: std::io::Error,
    },
}

struct Cache {
    map: Mutex<HashMap<String, String>>,
}

impl Cache {
    fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()) }
    }

    fn get(&self, account: &str) -> Option<String> {
        self.map.lock().unwrap().get(account).cloned()
    }

    fn put(&self, account: &str, secret: &str) {
        self.map.lock().unwrap().insert(account.to_string(), secret.to_string());
    }

    fn remove(&self, account: &str) {
        self.map.lock().unwrap().remove(account);
    }
}

static CACHE: std::sync::OnceLock<Cache> = std::sync::OnceLock::new();
static DATA_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

fn cache() -> &'static Cache {
    CACHE.get_or_init(Cache::new)
}

fn default_data_dir() -> std::path::PathBuf {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("/"));
        home.join("Library/Application Support").join(SERVICE)
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA")
            .map(|p| std::path::PathBuf::from(p).join(SERVICE))
            .unwrap_or_else(|| std::path::PathBuf::from(SERVICE))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(|h| std::path::PathBuf::from(h).join(".local/share").join(SERVICE))
            })
            .unwrap_or_else(|| std::path::PathBuf::from(SERVICE))
    }
}

fn secrets_path() -> std::path::PathBuf {
    DATA_DIR.get_or_init(default_data_dir).join(SECRETS_FILE)
}

/// Load the secrets file into the cache. Runs once per process.
fn load() {
    static LOADED: Once = Once::new();
    LOADED.call_once(|| {
        if let Ok(bytes) = std::fs::read(secrets_path()) {
            if let Ok(map) = serde_json::from_slice::<HashMap<String, String>>(&bytes) {
                let mut cache_map = cache().map.lock().unwrap();
                for (k, v) in map {
                    cache_map.insert(k, v);
                }
            }
        }
    });
}

/// Write the cache to disk with 600 permissions, atomically.
fn save() -> Result<(), std::io::Error> {
    let path = secrets_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let map = cache().map.lock().unwrap();
    let json = serde_json::to_string_pretty(&HashMap::<String, String>::from_iter(
        map.iter().map(|(k, v)| (k.clone(), v.clone())),
    ))
    .map_err(std::io::Error::other)?;

    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }

    std::fs::rename(&tmp, &path)?;
    Ok(())
}

pub fn put(account: &str, secret: &str) -> Result<(), VaultError> {
    load();
    cache().put(account, secret);
    save().map_err(|source| VaultError::File { account: account.into(), source })?;
    Ok(())
}

pub fn get(account: &str) -> Result<Option<String>, VaultError> {
    load();
    Ok(cache().get(account))
}

pub fn delete(account: &str) -> Result<(), VaultError> {
    load();
    cache().remove(account);
    save().map_err(|source| VaultError::File { account: account.into(), source })?;
    Ok(())
}

/// Override the data dir for this process. Must be called before the first `get`/`put`/`delete`.
/// The app calls this at boot with the user's actual data directory (which may be overridden
/// by `AIP_DATA_DIR`).
pub fn set_data_dir(dir: &Path) {
    DATA_DIR.get_or_init(|| dir.to_path_buf());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_put_get() {
        let c = Cache::new();
        c.put("test", "secret");
        assert_eq!(c.get("test").as_deref(), Some("secret"));
    }

    #[test]
    fn cache_delete() {
        let c = Cache::new();
        c.put("test", "secret");
        c.remove("test");
        assert_eq!(c.get("test"), None);
    }

    #[test]
    fn cache_missing() {
        let c = Cache::new();
        assert_eq!(c.get("nonexistent"), None);
    }

    #[test]
    fn get_returns_none_for_missing_account() {
        let result = get("definitely-not-a-real-account");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), None);
    }
}
