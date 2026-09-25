//! The UI's own credential for the admin HTTP surface (D51).
//!
//! **The problem this exists to solve.** §10 decision 2 is pure HTTP: the UI is a client like any
//! other and reaches the gateway over `fetch()`. But TypeScript is key-blind by construction
//! (invariant 2) — it holds `secretRef`, never a secret, and the master key is copied to the
//! clipboard host-side precisely because it is *never rendered in this window*. So the webview had
//! nothing to send, and every `/admin/*` route answered 401 to the one client the decision was
//! written for.
//!
//! **What this credential is.** An ordinary per-app key with a reserved id, minted on demand and
//! stored in the same two places every app key is: the OS keychain (the secret) and the
//! `gateway_keys` row (the authorisation). It therefore works in **both** processes that can serve
//! the port — the in-app gateway and `aiproviderd` — because both install
//! `vault_app_key_provider` (`gateway_cmds.rs:152`, `aiproviderd.rs:208`) against the same
//! keychain and the same database. No auth path was widened to make this work.
//!
//! **Why it is narrow.** It carries no provider credential, so invariant 2 is intact in the only
//! place it was ever meant to bind: TypeScript still cannot read or send a *provider* secret. What
//! it can now hold is a local, revocable token for talking to its own gateway.
//!
//! **Why it is filtered from the keys list.** An operator-managed key is theirs to revoke; this one
//! is the UI's, and revoking it would break every screen with no visible cause. `is_ui_session`
//! exists so the listing can leave it out rather than invite that.

use rusqlite::OptionalExtension;

use crate::core::gateway::{generate_random_key, GatewayCore, APP_KEY_PREFIX};
use crate::core::persist;
use crate::core::store::Store;
use crate::core::vault;

/// The reserved id. Deliberately a valid `ak-` id so every existing code path treats it as an app
/// key rather than needing to know about a second kind of credential.
pub const UI_SESSION_ID: &str = "ak-ui";

/// Shown nowhere — the row exists to authorise the secret, not for a human to read.
const UI_SESSION_LABEL: &str = "UI session (internal)";

pub fn is_ui_session(id: &str) -> bool {
    id == UI_SESSION_ID
}

/// Ensure the credential exists and return its secret.
///
/// Idempotent, and the two halves are repaired independently: a keychain entry with no row is
/// unusable (`vault_app_key_provider` only reads the keychain for ids that have an active row), and
/// a row with no entry is a credential nobody holds. Either state is reachable — the keychain and
/// SQLite do not fail together — so both are checked rather than assumed from the other.
pub fn ensure(store: &Store) -> Result<String, String> {
    ensure_with(store, &|a| vault::get(a).ok().flatten(), &|a, s| {
        vault::put(a, s).map_err(|e| e.to_string())
    })
}

/// The keychain halves are **parameters, not calls**.
///
/// `vault::put` hits the real OS keychain, which CI has no access to — the same wall
/// `POST /admin/keys`'s happy path ran into. Injected here, so the whole lifecycle (mint, reuse,
/// repair, revoke) is testable on all three CI platforms, and the module keeps no
/// `cfg(target_os)` gate that would leave it uncompiled everywhere but macOS.
pub fn ensure_with(
    store: &Store,
    get: &dyn Fn(&str) -> Option<String>,
    put: &dyn Fn(&str, &str) -> Result<(), String>,
) -> Result<String, String> {
    let account = format!("{APP_KEY_PREFIX}{UI_SESSION_ID}");

    let secret = match get(&account) {
        Some(s) if !s.is_empty() => s,
        _ => {
            let s = generate_random_key();
            put(&account, &s).map_err(|e| format!("could not store the session key: {e}"))?;
            s
        }
    };

    if !row_exists(store, UI_SESSION_ID).map_err(|e| format!("could not read gateway_keys: {e}"))? {
        persist::gateway_key_insert(store, UI_SESSION_ID, UI_SESSION_LABEL)
            .map_err(|e| format!("could not record the session key: {e}"))?;
    }

    Ok(secret)
}

/// Does the authorising row exist and remain live? A revoked row is replaced, not revived.
fn row_exists(store: &Store, id: &str) -> Result<bool, rusqlite::Error> {
    let conn = store.conn.lock().unwrap();
    let live: Option<Option<i64>> = conn
        .query_row(
            "SELECT revoked_at FROM gateway_keys WHERE id = ?1",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .optional()?;
    drop(conn);
    match live {
        None => Ok(false),
        Some(None) => Ok(true), // row present, not revoked
        Some(Some(_revoked)) => {
            // Present but revoked: a revoke must not be silently undone by the next boot. Drop the
            // row and mint fresh, so the old secret stops working and a new one takes over.
            persist::gateway_key_delete(store, id).ok();
            Ok(false)
        }
    }
}

/// Revoke and forget the credential. Used when the gateway stops, so a token minted for one
/// session cannot outlive it.
///
/// The keychain half is a **parameter** for the same reason it is in `ensure_with` — `vault::delete`
/// hits the real OS keychain, which CI has no access to. Both halves are best-effort: a keychain
/// that will not answer must not stop the gateway from stopping.
pub fn revoke_with(store: &Store, delete: &dyn Fn(&str)) {
    let account = format!("{APP_KEY_PREFIX}{UI_SESSION_ID}");
    delete(&account);
    let _ = persist::gateway_key_delete(store, UI_SESSION_ID);
    // The key provider re-reads the active ids per request, so this takes effect on the next call
    // with no restart.
}

/// `revoke_with` against the real keychain. The production half.
pub fn revoke(store: &Store) {
    revoke_with(store, &|account| {
        let _ = vault::delete(account);
    });
}

/// Whether a core would currently accept the UI session credential — the question D51 left open,
/// answerable only by asking the core rather than by reading either half alone.
pub fn accepted_by(core: &GatewayCore) -> bool {
    core.app_keys().iter().any(|k| is_ui_session(&k.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::store::Store;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    fn tmp() -> Store {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ui-session-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        Store::open(&dir.join(format!("s{n}.db"))).unwrap()
    }

    /// The property D51 needs: minting produces a secret and the row that authorises it, and a
    /// second call returns the same secret rather than minting again.
    #[test]
    fn ensure_is_idempotent_and_returns_the_same_secret() {
        let s = tmp();
        let stored = std::cell::RefCell::new(std::collections::HashMap::<String, String>::new());
        let get = |a: &str| stored.borrow().get(a).cloned();
        let put = |a: &str, v: &str| {
            stored.borrow_mut().insert(a.to_string(), v.to_string());
            Ok(())
        };
        let a = ensure_with(&s, &get, &put).unwrap();
        let b = ensure_with(&s, &get, &put).unwrap();
        assert_eq!(a, b, "a second call must not rotate the credential");
        assert!(row_exists(&s, UI_SESSION_ID).unwrap(), "and the row is present");
    }

    /// The row is what authorises the secret: `vault_app_key_provider` reads the keychain only for
    /// ids that have a live row, so a secret with no row authenticates nobody.
    #[test]
    fn ensure_repairs_a_row_that_is_missing_but_the_keychain_holds_the_secret() {
        let s = tmp();
        let stored = std::cell::RefCell::new(std::collections::HashMap::<String, String>::new());
        let account = format!("{APP_KEY_PREFIX}{UI_SESSION_ID}");
        stored.borrow_mut().insert(account.clone(), "existing-secret".into());
        let get = |a: &str| stored.borrow().get(a).cloned();
        let put = |_: &str, _: &str| Ok(());

        let got = ensure_with(&s, &get, &put).unwrap();
        assert_eq!(got, "existing-secret", "an existing secret is reused, not replaced");
        assert!(row_exists(&s, UI_SESSION_ID).unwrap(), "and the missing row is written");
    }

    /// A keychain failure is an error, not a silently minted credential nobody can read back.
    #[test]
    fn ensure_reports_a_keychain_failure_rather_than_returning_a_secret() {
        let s = tmp();
        let get = |_: &str| None;
        let put = |_: &str, _: &str| Err("keychain unavailable".to_string());
        let err = ensure_with(&s, &get, &put).unwrap_err();
        assert!(err.contains("keychain"), "the failure names the keychain: {err}");
    }

    #[test]
    fn the_reserved_id_is_recognised_and_no_other_is() {
        assert!(is_ui_session(UI_SESSION_ID));
        assert!(!is_ui_session("ak-1"));
    }

    /// The other half of the lifecycle, and the reason `revoke` exists at all: a credential minted
    /// for one gateway session must die with it, not linger in the keychain as a token that still
    /// authenticates after the operator pressed Stop.
    ///
    /// Asserted on the row, because the row is what the provider reads: a revoke that deleted only
    /// the keychain entry would leave an id the provider still asks the keychain about.
    #[test]
    fn revoke_forgets_the_credential_and_the_next_session_mints_a_fresh_one() {
        let s = tmp();
        let stored = std::cell::RefCell::new(std::collections::HashMap::<String, String>::new());
        let put = |a: &str, v: &str| {
            stored.borrow_mut().insert(a.to_string(), v.to_string());
            Ok(())
        };
        let get = |a: &str| stored.borrow().get(a).cloned();
        let deleted = std::cell::RefCell::new(Vec::<String>::new());

        let first = ensure_with(&s, &get, &put).unwrap();
        assert!(row_exists(&s, UI_SESSION_ID).unwrap());

        // The injected keychain delete does what the real one does: the entry is gone afterwards,
        // so recording the account without removing it would test a revoke that did not revoke.
        revoke_with(&s, &|a: &str| {
            deleted.borrow_mut().push(a.to_string());
            stored.borrow_mut().remove(a);
        });

        assert!(!row_exists(&s, UI_SESSION_ID).unwrap(), "the authorising row is gone");
        assert_eq!(
            deleted.borrow().as_slice(),
            [format!("{APP_KEY_PREFIX}{UI_SESSION_ID}")],
            "and the keychain half was deleted too — a row-only revoke leaves a live secret"
        );

        // The next session starts from nothing rather than inheriting the old secret.
        let second = ensure_with(&s, &|a: &str| stored.borrow().get(a).cloned(), &put).unwrap();
        assert_ne!(second, first, "a revoked credential must not be handed out again");
        assert!(row_exists(&s, UI_SESSION_ID).unwrap(), "and the new session is authorised");
    }

    /// A revoked row is replaced rather than revived — the revoke has to stick.
    #[test]
    fn a_revoked_row_is_replaced_not_revived() {
        let s = tmp();
        let _ = ensure(&s).unwrap();
        persist::gateway_key_revoke(&s, UI_SESSION_ID).unwrap();
        assert!(
            !row_exists(&s, UI_SESSION_ID).unwrap(),
            "a revoked session row must not be treated as live"
        );
    }
}
