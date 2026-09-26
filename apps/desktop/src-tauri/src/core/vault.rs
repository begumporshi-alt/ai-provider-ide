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
use std::sync::Mutex;
use std::time::SystemTime;

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

/// What the secrets file looked like the last time *this* process read it.
///
/// Compared so the file can be re-read when it changes. `None` means "no file", which is a real
/// state and not the same as "never looked".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    modified: Option<SystemTime>,
    len: u64,
}

struct Cache {
    map: Mutex<HashMap<String, String>>,
    /// The stamp as of `map`, or `None` before the first read.
    stamp: Mutex<Option<FileStamp>>,
}

impl Cache {
    fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()), stamp: Mutex::new(None) }
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

/// The secrets file's stamp, or `None` when there is no file to read.
fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some(FileStamp { modified: meta.modified().ok(), len: meta.len() })
}

/// Bring the cache back into agreement with the secrets file.
///
/// **The file is the authority, and more than one process writes it.** It used to be read once per
/// process (`Once`), which in the two-process service (26y) meant a process never saw anything
/// minted after it started: the app mints `gwkey:ak-ui` (D51) while the headless `aiproviderd` is
/// the one serving requests, so the service answered `401 invalid gateway key` to the app's own
/// credential until the service was restarted — and the failed attempts piling up behind that are
/// what turned the next boot into a `429`. It also failed in the opposite direction, which is the
/// worse half: a *revoked* credential went on authenticating in any process that had already
/// loaded it, so `ui_session::revoke` did not do what its own comment claims. Re-reading when the
/// stamp changes fixes both, at one `stat` per call.
///
/// A reload **replaces** rather than merges. `save` writes the whole map, so the file is the
/// complete truth and a merge would resurrect an account another process deleted.
fn load() {
    reload_if_changed(cache(), &secrets_path());
}

/// The reload itself, against an explicit cache and path.
///
/// Split out because `DATA_DIR` is a `OnceLock` that cannot be re-pointed once a test process has
/// read it, so the cross-process behaviour can only be exercised through a path the test owns.
fn reload_if_changed(c: &Cache, path: &Path) {
    let current = file_stamp(path);
    {
        let mut seen = c.stamp.lock().unwrap();
        if *seen == current {
            return;
        }
        *seen = current;
    }
    let fresh = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<HashMap<String, String>>(&bytes).ok())
        .unwrap_or_default();
    // Lock order here is `stamp` then `map`, and `save` takes only `map`, so this cannot deadlock
    // against a writer.
    let mut map = c.map.lock().unwrap();
    *map = fresh;
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

    /// A file the test owns, so "another process wrote it" can be simulated without re-pointing
    /// `DATA_DIR` — that is a `OnceLock` and a test process may already have read it.
    fn scratch_file(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("vault-reload-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".secrets.json");
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn a_secret_minted_by_another_process_is_visible_without_a_restart() {
        let path = scratch_file("mint");
        let c = Cache::new();
        // The service's situation exactly: it read the file when it started, at which point the
        // UI session credential did not exist yet.
        reload_if_changed(&c, &path);
        assert_eq!(c.get("gwkey:ak-ui"), None, "no file, so nothing to see");
        // The app then mints and writes it.
        std::fs::write(&path, "{\"gwkey:ak-ui\":\"secret-B\"}").unwrap();
        reload_if_changed(&c, &path);
        // Before this fix the answer stayed `None` until the process restarted — which is the
        // `401 invalid gateway key` the app got from its own service.
        assert_eq!(
            c.get("gwkey:ak-ui").as_deref(),
            Some("secret-B"),
            "a secret minted by another process must be visible without a restart"
        );
    }

    #[test]
    fn a_secret_revoked_by_another_process_stops_being_returned() {
        let path = scratch_file("revoke");
        std::fs::write(&path, "{\"gwkey:ak-ui\":\"secret-A\"}").unwrap();
        let c = Cache::new();
        reload_if_changed(&c, &path);
        assert_eq!(c.get("gwkey:ak-ui").as_deref(), Some("secret-A"));
        // The other process revokes. The worse half of the old behaviour: a revoked credential
        // went on authenticating in every process that had already loaded it.
        std::fs::write(&path, "{}").unwrap();
        reload_if_changed(&c, &path);
        assert_eq!(c.get("gwkey:ak-ui"), None, "a revoke by another process must take effect");
    }

    #[test]
    fn an_unchanged_file_is_not_reread() {
        let path = scratch_file("stable");
        std::fs::write(&path, "{\"gwkey:ak-ui\":\"secret-A\"}").unwrap();
        let c = Cache::new();
        reload_if_changed(&c, &path);
        // A write this process has not saved yet must survive a reload that does not happen.
        // This is the test that fails if the stamp gate is removed and every call re-reads: the
        // point of the stamp is that the common path costs one `stat` and no clobber.
        c.put("local", "pending");
        reload_if_changed(&c, &path);
        assert_eq!(
            c.get("local").as_deref(),
            Some("pending"),
            "an unchanged file must not clobber a write this process has not saved"
        );
    }
}
