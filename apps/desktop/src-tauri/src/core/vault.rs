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

/// The service-name constant, kept for any external caller that still names it.
pub const SERVICE: &str = "ai-provider-router";

const SECRETS_FILE: &str = ".secrets.json";

/// The sibling file `put`/`delete` lock across processes. See `lock_writers`.
const LOCK_FILE: &str = ".secrets.lock";

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
    /// The secrets file's **content** as of `map`, or `None` before the first read and while there
    /// is no file. Content rather than metadata — see `reload_if_changed` for why.
    seen: Mutex<Option<Vec<u8>>>,
    /// Serialises whole public operations **within this process**. The file lock in `lock_writers`
    /// excludes other processes; this excludes other threads, and it is not redundant with it.
    ops: Mutex<()>,
}

impl Cache {
    fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()), seen: Mutex::new(None), ops: Mutex::new(()) }
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
    // **A test binary must never reach the user's real data directory.** `DATA_DIR` is a
    // `OnceLock` (reached through `secrets_path` → `get_or_init`), so the *first* caller decides it
    // for the whole process and every later `set_data_dir` is **silently ignored**. The vault's
    // location therefore depends on which test happens to touch it first — and
    // `get_returns_none_for_missing_account` below does exactly that, with a real account name,
    // pinning every other test in the same binary to `~/Library/Application Support/<SERVICE>`. A
    // test that then writes a secret puts it in the user's home, where nothing reads it.
    //
    // Measured 2026-09-27: a stray `{"k1": "v1"}` was found at
    // `~/Library/Application Support/ai-provider-router/.secrets.json` — the `SERVICE` default.
    // No code in the repo calls `vault::put("k1", "v1")`, so the writer was not identified; this
    // is a backstop for the class, not a fix for one call site. A test that needs secrets must
    // still call `set_data_dir` with a temp dir of its own.
    #[cfg(test)]
    {
        std::env::temp_dir().join(format!("aip-vault-default-{}", std::process::id()))
    }
    #[cfg(not(test))]
    {
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
}

fn secrets_path() -> std::path::PathBuf {
    DATA_DIR.get_or_init(default_data_dir).join(SECRETS_FILE)
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
/// file changes fixes both, at one read per call.
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
///
/// **Change is detected by content, not by metadata (audit M4).** The gate used to be a
/// `(mtime, len)` stamp, and that is not a fingerprint: a rewrite of the *same length* landing on
/// the *same timestamp* compares equal, so the early return kept serving the superseded secret —
/// the exact window this reload exists to close. Reproduced deterministically by
/// `a_same_length_rewrite_with_an_identical_timestamp_is_still_seen`, which *constructs* the
/// collision with `set_modified` rather than waiting for one; it also arises on its own wherever
/// file timestamps come from a coarse clock, which is Linux — and Linux is a supported target,
/// because `ci.yml`'s `headless-service` matrix builds this binary on `ubuntu-latest`. Reading the
/// bytes costs one read where the stamp cost one `stat`, and it is exact on every filesystem.
/// `serde_json` still runs only when the bytes differ, so the common path parses nothing.
fn reload_if_changed(c: &Cache, path: &Path) {
    let fresh_bytes = match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        // A *missing* file is a real state: the truth is "no secrets", so the map is cleared.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        // A *transient* failure is not that state, and must not clear the vault on the request
        // path. Leave both the map and the remembered content alone so the next call retries. The
        // stamp gate had a worse version of this: it latched the new stamp *before* reading, so one
        // failed read emptied the cache and then compared equal forever after — it could not
        // recover until the file changed again.
        Err(_) => return,
    };
    {
        let mut seen = c.seen.lock().unwrap();
        if seen.as_deref() == fresh_bytes.as_deref() {
            return;
        }
        // Cloned only on the change path, so the common path stays one read and one compare. The
        // lock is released before the parse: lock order is `seen` then `map`, and `save` takes only
        // `map`, so this cannot deadlock against a writer.
        *seen = fresh_bytes.clone();
    }
    let fresh = fresh_bytes
        .and_then(|bytes| serde_json::from_slice::<HashMap<String, String>>(&bytes).ok())
        .unwrap_or_default();
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

/// The cross-process writer lock.
///
/// **`put` and `delete` are read-modify-write over the whole file, and two processes write it by
/// design.** `bin/aiproviderd.rs` mints `masterkey`; the app writes `gwkey:ak-ui` from
/// `ui_session`/`gateway_admin` and provider keys from `commands`. Nothing excluded them, and the
/// pair failed in two directions at once — both measured 2026-09-27 by
/// `two_processes_writing_different_accounts_lose_nothing`, before this existed:
///
/// 1. **Loudly.** Both processes write the same `.secrets.json.tmp`, so one `rename`d it out from
///    under the other and the loser's `save` failed outright: **26 of the 50** `put`s in that run
///    returned `No such file or directory`.
/// 2. **Silently.** Where neither errored, `save` wrote the *whole* map, so the second writer
///    discarded the first's entry — **25 of the 50** accounts were gone, and both calls returned
///    `Ok`. A vault that drops a credential without saying so is the worse half, and it is the half
///    the API cannot report.
///
/// **`ops` is held as well, and it is not redundant.** The file lock excludes other *processes*;
/// it says nothing about two threads here. `reload_if_changed` replaces the map wholesale
/// (`*map = fresh`) and `get` calls it on the request path, so a `get` landing between a `put`'s
/// mutation and its `save` would replace the map with pre-mutation file contents — and the `put`
/// would then save that. One mutex per public operation closes it, and it also keeps `seen` and
/// `map` a consistent pair, which two threads writing them under separate locks would not be.
///
/// **The lock is the file, not a lockfile protocol.** `File::lock` is `flock(2)` on unix and
/// `LockFileEx` on Windows, so the kernel releases it when the holder dies — there is no stale-lock
/// state to detect, age out, or steal, which is the entire reason not to hand-roll a `create_new`
/// lockfile. It *blocks* rather than failing (measured: a second process's `lock()` returned after
/// 3.0026 s against a holder sleeping 3 s). `File::lock` is stable since Rust 1.89; the gate prints
/// `rustc --version` for exactly this kind of dependency.
///
/// **The lock file is never unlinked, and that is load-bearing.** Measured while probing this
/// primitive: a process that removes the lock file and re-creates it locks a *different inode*, so
/// it takes a lock that excludes nobody — the probe read "not excluded" until the unlink was taken
/// out of its child leg. A lock file that can vanish silently stops being a lock. `save` therefore
/// writes `.secrets.json.tmp` and renames only that, leaving `.secrets.lock` in place.
fn lock_writers() -> std::io::Result<std::fs::File> {
    let path = secrets_path().with_file_name(LOCK_FILE);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // `.truncate(false)` is spelled out because `create(true).write(true)` without it is
    // `clippy::suspicious_open_options` under `-D warnings`, and the honest declaration is that this
    // file is never written to: it exists only to be locked. Truncating it would be harmless today
    // and misleading tomorrow.
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&path)?;
    file.lock()?;
    // Returned rather than dropped: the lock lives exactly as long as this value does.
    Ok(file)
}

pub fn put(account: &str, secret: &str) -> Result<(), VaultError> {
    let _ops = cache().ops.lock().unwrap();
    let _lock =
        lock_writers().map_err(|source| VaultError::File { account: account.into(), source })?;
    load();
    cache().put(account, secret);
    save().map_err(|source| VaultError::File { account: account.into(), source })?;
    Ok(())
}

pub fn get(account: &str) -> Result<Option<String>, VaultError> {
    let _ops = cache().ops.lock().unwrap();
    load();
    Ok(cache().get(account))
}

pub fn delete(account: &str) -> Result<(), VaultError> {
    let _ops = cache().ops.lock().unwrap();
    let _lock =
        lock_writers().map_err(|source| VaultError::File { account: account.into(), source })?;
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

    /// **M4** — a rewrite whose metadata is byte-for-byte what it was must still be seen.
    ///
    /// The defect this pins: the stamp is `(mtime, len)`, which is not a fingerprint. A rewrite of
    /// the *same length* landing on the *same timestamp* compares equal, `reload_if_changed` returns
    /// early, and the process keeps serving the superseded secret — the exact window this reload
    /// exists to close. The collision is **constructed** here (`set_modified` puts the second write
    /// on the first write's exact timestamp) rather than hoped for, so the test is deterministic on
    /// any filesystem, including one whose timestamps are too fine to collide by accident.
    ///
    /// Expected: **red** against a metadata stamp, **green** against content comparison.
    #[test]
    fn a_same_length_rewrite_with_an_identical_timestamp_is_still_seen() {
        let path = scratch_file("same-stamp");
        let before = "{\"gwkey:ak-ui\":\"secret-A\"}";
        let after = "{\"gwkey:ak-ui\":\"secret-B\"}";
        assert_eq!(before.len(), after.len(), "the test is only meaningful at equal length");

        std::fs::write(&path, before).unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        let (stamp, len) = (meta.modified().unwrap(), meta.len());

        let c = Cache::new();
        reload_if_changed(&c, &path);
        assert_eq!(c.get("gwkey:ak-ui").as_deref(), Some("secret-A"));

        std::fs::write(&path, after).unwrap();
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_modified(stamp).unwrap();

        let meta = std::fs::metadata(&path).unwrap();
        assert_eq!(meta.modified().unwrap(), stamp, "the collision must actually be constructed");
        assert_eq!(meta.len(), len, "the collision must actually be constructed");

        reload_if_changed(&c, &path);
        assert_eq!(
            c.get("gwkey:ak-ui").as_deref(),
            Some("secret-B"),
            "a same-length rewrite with an unchanged timestamp must not be missed"
        );
    }

    /// A *missing* file is a real state — the file is the authority, so "no file" means "no
    /// secrets". This is the half of the old gate's behaviour that is right and is kept.
    #[test]
    fn a_deleted_file_clears_the_cache() {
        let path = scratch_file("deleted");
        std::fs::write(&path, "{\"gwkey:ak-ui\":\"secret-A\"}").unwrap();
        let c = Cache::new();
        reload_if_changed(&c, &path);
        assert_eq!(c.get("gwkey:ak-ui").as_deref(), Some("secret-A"));

        std::fs::remove_file(&path).unwrap();
        reload_if_changed(&c, &path);
        assert_eq!(c.get("gwkey:ak-ui"), None, "a deleted file means no secrets");
    }

    /// A *transient* failure is **not** that state, and must not empty the vault on the request path.
    ///
    /// The old gate could not tell the two apart, and it latched the new stamp *before* reading — so
    /// one failed read cleared the cache and then compared equal forever, and the process could not
    /// recover until the file's metadata changed again. `EISDIR` stands in for any non-`NotFound`
    /// error: it needs no permissions trick, so it behaves identically on macOS and on Linux CI.
    #[test]
    fn a_transient_read_failure_leaves_the_cache_alone_and_does_not_latch() {
        let path = scratch_file("transient");
        // Clear a directory a previously-failed run may have left at this path.
        let _ = std::fs::remove_dir_all(&path);
        std::fs::write(&path, "{\"gwkey:ak-ui\":\"secret-A\"}").unwrap();
        let c = Cache::new();
        reload_if_changed(&c, &path);
        assert_eq!(c.get("gwkey:ak-ui").as_deref(), Some("secret-A"));

        // A directory at the path makes the read fail with something that is not `NotFound`.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        reload_if_changed(&c, &path);
        assert_eq!(
            c.get("gwkey:ak-ui").as_deref(),
            Some("secret-A"),
            "a transient read failure must not clear the vault"
        );

        // And it must not latch: once the file is readable again, the reload works.
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, "{\"gwkey:ak-ui\":\"secret-B\"}").unwrap();
        reload_if_changed(&c, &path);
        assert_eq!(
            c.get("gwkey:ak-ui").as_deref(),
            Some("secret-B"),
            "a transient failure must not latch the gate shut"
        );
    }

    /// How many `put`s each child performs. Enough that two unsynchronised processes collide.
    const CHILD_PUTS: usize = 25;

    /// Set by the parent to make a re-exec of this test binary act as the child leg.
    const CHILD_ENV: &str = "AIP_VAULT_LOCK_CHILD";

    /// **The lost update, across two real processes.**
    ///
    /// `put` and `delete` are read-modify-write over the *whole* file, and two processes write this
    /// file by design — `bin/aiproviderd.rs` mints `masterkey` while the app writes `gwkey:ak-ui`
    /// and provider keys. Two interleaved `put`s each read `{x}`, add their own entry, and then
    /// `save` writes the whole map, so whichever saves second discards the other's entry. Nothing in
    /// the file or the API reports it: both calls return `Ok`.
    ///
    /// The children are **real processes**, not threads and not a simulated interleave, because that
    /// is the claim. A same-process model would pass with no lock at all — `Cache`'s map is shared
    /// between threads, so the two mutations would compose instead of racing.
    ///
    /// **The barrier is load-bearing.** Without it the children can run one after the other and the
    /// test would pass on an unsynchronised vault, which is the "an instrument that cannot fail"
    /// class: a green result that says nothing about the property.
    ///
    /// **The marker is load-bearing too.** The child is spawned with `--exact <this test>`, and a
    /// filter that matches nothing exits **0** — so `success()` alone cannot tell "the child wrote
    /// 25 secrets" from "the child ran no tests at all". Each child writes `<tag>.done` last and the
    /// parent asserts it is there.
    #[test]
    fn two_processes_writing_different_accounts_lose_nothing() {
        if let Ok(spec) = std::env::var(CHILD_ENV) {
            let (dir, tag) = spec.split_once('|').expect("the child spec is <dir>|<tag>");
            let dir = std::path::Path::new(dir);
            // **The child never panics and never asserts: it reports, and the parent judges.** An
            // exit code cannot say which outcome happened, and libtest writes an assertion failure
            // to *stdout* rather than stderr — so a child that panicked here would reach the parent
            // as a bare non-zero status with nothing to read. Measured 2026-09-27: the first run of
            // this test reported `started=true` and an empty stderr, and said nothing else.
            std::fs::write(dir.join(format!("{tag}.started")), b"1")
                .expect("write the start marker");
            set_data_dir(dir);
            // Wait for the parent to release the barrier, so the two children overlap. Without the
            // overlap the test can pass on an unsynchronised vault, because the processes never met.
            let go = dir.join("go");
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            while !go.exists() {
                if std::time::Instant::now() >= deadline {
                    std::fs::write(
                        dir.join(format!("{tag}.errored")),
                        "the barrier was never released",
                    )
                    .unwrap();
                    std::fs::write(dir.join(format!("{tag}.done")), b"1").unwrap();
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            // Both halves of the defect are *collected* rather than asserted on. The loud half is a
            // `save` that fails outright: both processes write the same `.secrets.json.tmp`, so one
            // renames it out from under the other and the loser's rename fails. The silent half is
            // an entry that is simply gone, with both calls returning `Ok`.
            let mut errored = Vec::new();
            for i in 0..CHILD_PUTS {
                if let Err(e) = put(&format!("{tag}:{i}"), "v") {
                    errored.push(format!("{i}: {e}"));
                }
            }
            std::fs::write(dir.join(format!("{tag}.errored")), errored.join("\n")).unwrap();
            std::fs::write(dir.join(format!("{tag}.done")), b"1").expect("write the marker");
            return;
        }

        let dir = std::env::temp_dir().join(format!("vault-lock-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let exe = std::env::current_exe().unwrap();
        let name = "core::vault::tests::two_processes_writing_different_accounts_lose_nothing";
        let mut kids = Vec::new();
        for tag in ["a", "b"] {
            // Both streams go to files: a child that dies for a reason it did not report would
            // otherwise reach the parent as a bare non-zero status.
            let out = std::fs::File::create(dir.join(format!("{tag}.out"))).unwrap();
            let err = std::fs::File::create(dir.join(format!("{tag}.err"))).unwrap();
            kids.push((
                tag,
                std::process::Command::new(&exe)
                    .args(["--exact", name])
                    .env(CHILD_ENV, format!("{}|{tag}", dir.display()))
                    .stdout(out)
                    .stderr(err)
                    .spawn()
                    .expect("spawn the child leg"),
            ));
        }
        std::fs::write(dir.join("go"), b"1").unwrap();
        for (tag, mut kid) in kids {
            let status = kid.wait().unwrap();
            assert!(
                status.success(),
                "the child leg {tag} must exit 0 ({status:?}); stdout:\n{}\nstderr:\n{}",
                std::fs::read_to_string(dir.join(format!("{tag}.out"))).unwrap_or_default(),
                std::fs::read_to_string(dir.join(format!("{tag}.err"))).unwrap_or_default(),
            );
            assert!(
                dir.join(format!("{tag}.done")).exists(),
                "child {tag} must run to completion — a filter that matches no test also exits 0"
            );
        }

        // The file is the authority, and it is what the two processes were fighting over. Both
        // halves of the defect are reported together, because they are one cause: the second run of
        // this test failed on the loud half alone and would otherwise have hidden the silent one.
        let mut problems = Vec::new();
        for tag in ["a", "b"] {
            let errored =
                std::fs::read_to_string(dir.join(format!("{tag}.errored"))).unwrap_or_default();
            if !errored.trim().is_empty() {
                problems.push(format!("child {tag}'s puts failed outright:\n{errored}"));
            }
        }
        let bytes = std::fs::read(dir.join(SECRETS_FILE)).expect("the children wrote the file");
        let map: HashMap<String, String> = serde_json::from_slice(&bytes).unwrap();
        let mut lost = Vec::new();
        for tag in ["a", "b"] {
            for i in 0..CHILD_PUTS {
                let key = format!("{tag}:{i}");
                if !map.contains_key(&key) {
                    lost.push(key);
                }
            }
        }
        if !lost.is_empty() {
            problems.push(format!(
                "the whole-map save clobbered {} of {} accounts, e.g. {:?}",
                lost.len(),
                2 * CHILD_PUTS,
                &lost[..lost.len().min(6)]
            ));
        }
        assert!(
            problems.is_empty(),
            "an unexcluded pair broke the vault:\n{}",
            problems.join("\n")
        );
    }
}
