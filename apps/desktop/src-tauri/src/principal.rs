/**
 * Per-principal memory policy (§4a).
 *
 * The master switch answers "does this machine learn at all". It cannot answer the question an
 * operator actually has: *which* client gets to benefit. Pointing two IDEs at one gateway is the
 * normal case, and one of them may be a tool the operator does not want reading a project's memory
 * — or writing its turns into it.
 *
 * Precedence, in order, and the ordering is the whole design:
 *
 * 1. **Master switch off → nothing happens**, for every principal. This is the ship-blocking
 *    acceptance criterion and no per-principal row can override it.
 * 2. **No row → inherit.** An unlisted principal is treated as allowed *when the master switch is
 *    on*. A default-deny table would need a row for every IDE that has ever connected before memory
 *    worked for anyone, which is the same absence-as-a-decision trap the scope columns were built
 *    to avoid: silence would mean "no", and silence is what you get by default.
 * 3. **An explicit row wins over the client's own header.** `AIP-Memory: on` from a principal the
 *    operator has disabled must not switch it back on — the client is not the authority.
 *
 * Identity is two strings, either of which may deny: the `AIP-Agent` label a client chooses for
 * itself, and the key that authenticated the request — `key:<id>` for a per-app key, `key:master`
 * for the master key. This module takes them as strings and does not care where they came from;
 * resolving them from a presented secret is the gateway's job.
 */

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::store::Store;

/// One row of the policy table as the UI wants it: what the operator decided, plus when we last
/// saw that principal, so a stale entry is distinguishable from a live one.
#[derive(Debug, Clone, Serialize)]
pub struct PrincipalRow {
    pub principal: String,
    /// `None` = inherit the master switch. `Some(true/false)` = an explicit override.
    pub enabled: Option<bool>,
    /// Last time this principal appeared in a router session. `None` for a policy entered by hand
    /// for an agent that has not connected yet.
    pub last_seen_at: Option<i64>,
}

/// Every principal we know about: ones observed in traffic, unioned with ones the operator has
/// configured by hand. Both halves matter — an operator needs to be able to pre-disable an agent
/// before it ever connects, and to see the ones that already have.
pub fn list(store: &Store) -> Result<Vec<PrincipalRow>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT k.principal,
                    pol.enabled,
                    (SELECT MAX(s.last_seen_at) FROM router_sessions s
                      WHERE s.scope_agent = k.principal)
             FROM (
               SELECT DISTINCT scope_agent AS principal FROM router_sessions
                WHERE scope_agent IS NOT NULL AND scope_agent <> ''
               UNION
               SELECT principal FROM memory_principal_policy
               UNION
               -- App keys, so the operator can find the name to write policy against. Without
               -- this the feature is unusable: `key:<id>` is not guessable and appears nowhere
               -- else. Revoked keys are excluded — a revoked key authenticates nobody.
               SELECT 'key:' || id FROM gateway_keys WHERE revoked_at IS NULL
               UNION
               -- The master key, for the same reason: `key:master` is not guessable either, and
               -- it is the key most operators actually hand out.
               SELECT 'key:master'
             ) k
             LEFT JOIN memory_principal_policy pol ON pol.principal = k.principal
             ORDER BY k.principal",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PrincipalRow {
                principal: r.get(0)?,
                enabled: r.get::<_, Option<i64>>(1)?.map(|v| v != 0),
                last_seen_at: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub fn set(store: &Store, principal: &str, enabled: bool) -> Result<bool, String> {
    let name = principal.trim();
    if name.is_empty() {
        return Ok(false);
    }
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "INSERT INTO memory_principal_policy (principal, enabled, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(principal) DO UPDATE SET enabled = excluded.enabled,
                                                  updated_at = excluded.updated_at",
            params![name, if enabled { 1 } else { 0 }, now_ms()],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Return a principal to "inherit". Distinct from setting it `true`: an inherited principal follows
/// the master switch, an explicitly-enabled one does not become visible in the UI as unmanaged.
pub fn clear(store: &Store, principal: &str) -> Result<bool, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "DELETE FROM memory_principal_policy WHERE principal = ?1",
            params![principal.trim()],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// The name an operator writes policy against for a per-app key: `key:<id>`.
///
/// Namespaced because the two identity spaces are different in kind. An `AIP-Agent` value is a
/// free-text string a client chooses for itself; a key id is assigned by this app. Without the
/// prefix a key id could collide with — or be deliberately forged as — an agent label.
pub fn key_principal(id: &str) -> String {
    format!("key:{id}")
}

/// The name an operator writes policy against for the **master key** itself.
///
/// The master key is the one most operators actually use, so leaving it unnameable would mean the
/// busiest caller could never be governed: traffic presenting it with no `AIP-Agent` label would
/// have no identity at all, and absence inherits — so it would always be allowed whatever else the
/// operator had decided. Naming it costs nothing and closes that hole.
///
/// It sits in the same `key:` namespace as app keys because it *is* a key identity rather than an
/// agent label, and it cannot collide with one: key ids are `ak-<hex>`, so `master` is not a key id
/// any client can be issued.
pub fn master_principal() -> String {
    key_principal("master")
}

/// The decision the request path needs: may this principal use memory at all?
///
/// `host_enabled` is the master switch. Everything is refused when it is off, whatever the table
/// says. A missing store (a harness, or a core built before the store was managed) degrades to the
/// master switch alone rather than refusing — the policy is a refinement, not a precondition.
///
/// Two identities are offered, not one, and **either can deny**: an `AIP-Agent` label and the key
/// that authenticated the request — `key:<id>` for a per-app key, `key:master` for the master key.
/// A single "winner" would be a hole either way. Pick
/// the label only and a client that presents a denied key still gets memory by sending a label
/// with no row; pick the key only and a client drops its label to escape a denial on it.
/// Absence still inherits, so an unlisted second identity adds nothing.
pub fn allows(
    host_enabled: bool,
    store: Option<&Store>,
    agent: Option<&str>,
    app_key: Option<&str>,
) -> bool {
    if !host_enabled {
        return false;
    }
    let Some(store) = store else { return true };
    [agent, app_key]
        .iter()
        .filter_map(|v| *v)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        // No identity at all means nothing to look up: `true` for the empty case. Scoping still
        // applies downstream, so an unidentified client is not thereby given access to anything
        // scoped.
        .all(|p| read(store, p).unwrap_or(true))
}

/// One lookup. `Err` degrades to "inherit" — a policy read must never fail a request, and failing
/// open here only means the master switch still governs.
fn read(store: &Store, agent: &str) -> Result<bool, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let v: Option<i64> = conn
        .query_row(
            "SELECT enabled FROM memory_principal_policy WHERE principal = ?1",
            params![agent],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(v.map(|n| n != 0).unwrap_or(true))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod principal_tests {
    use super::*;

    fn temp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-principal-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir).unwrap(), dir)
    }

    #[test]
    fn the_master_switch_beats_every_principal_row() {
        let (s, d) = temp_store("master");
        assert!(set(&s, "cursor", true).unwrap());
        // An explicit allow cannot switch memory on for a machine whose master switch is off.
        assert!(!allows(false, Some(&s), Some("cursor"), None));
        assert!(allows(true, Some(&s), Some("cursor"), None));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unlisted_principal_inherits_and_an_explicit_row_overrides() {
        let (s, d) = temp_store("inherit");
        assert!(allows(true, Some(&s), Some("claude-code"), None), "no row means inherit");
        assert!(set(&s, "claude-code", false).unwrap());
        assert!(!allows(true, Some(&s), Some("claude-code"), None));
        assert!(allows(true, Some(&s), Some("cursor"), None), "one refusal is not a global refusal");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn clearing_returns_a_principal_to_inherit() {
        let (s, d) = temp_store("clear");
        assert!(set(&s, "zed", false).unwrap());
        assert!(!allows(true, Some(&s), Some("zed"), None));
        assert!(clear(&s, "zed").unwrap());
        assert!(allows(true, Some(&s), Some("zed"), None));
        assert!(!clear(&s, "zed").unwrap(), "clearing twice is a no-op");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unnamed_principal_is_refused_rather_than_stored() {
        let (s, d) = temp_store("blank");
        assert!(!set(&s, "   ", true).unwrap());
        // And an empty agent on the request path is not a policy lookup at all.
        assert!(allows(true, Some(&s), Some(""), None));
        assert!(allows(true, Some(&s), None, None));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A harness builds a core with no store. The policy is a refinement, so that degrades to the
    /// master switch rather than refusing everything.
    #[test]
    fn a_missing_store_falls_back_to_the_master_switch() {
        assert!(allows(true, None, Some("cursor"), Some("key:ak-1")));
        assert!(!allows(false, None, Some("cursor"), Some("key:ak-1")));
    }

    /// The load-bearing rule for the app-key principal: two identities, either can deny.
    ///
    /// A single "winner" is a hole in both directions, and this test is what stops either version
    /// from being written. If the label alone decided, a client holding a denied key would get
    /// memory back by sending an unlisted label; if the key alone decided, a client would escape
    /// a denial on its label by dropping the header.
    #[test]
    fn either_identity_can_deny_and_neither_overrides_the_other() {
        let (s, d) = temp_store("two");
        let key = key_principal("ak-1");
        // Neither listed: both inherit.
        assert!(allows(true, Some(&s), Some("cursor"), Some(&key)));

        // Denied by label only — the key must not rescue it.
        assert!(set(&s, "cursor", false).unwrap());
        assert!(!allows(true, Some(&s), Some("cursor"), Some(&key)), "label denial stands");

        // Denied by key only — the label must not rescue it.
        assert!(clear(&s, "cursor").unwrap());
        assert!(set(&s, &key, false).unwrap());
        assert!(!allows(true, Some(&s), Some("cursor"), Some(&key)), "key denial stands");
        // And with no label at all, which is the case the app-key principal exists for.
        assert!(!allows(true, Some(&s), None, Some(&key)), "key denial stands alone");
        assert!(allows(true, Some(&s), None, Some("key:ak-2")), "one key's denial is not global");

        // An unlisted second identity adds nothing to an allowed pair.
        assert!(clear(&s, &key).unwrap());
        assert!(allows(true, Some(&s), Some("cursor"), Some(&key)));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn key_principal_is_namespaced_away_from_agent_labels() {
        // `ak-...` on its own would be a plausible agent label; the prefix is what keeps the two
        // identity spaces from colliding in one table.
        assert_eq!(key_principal("ak-1"), "key:ak-1");
        assert_ne!(key_principal("ak-1"), "ak-1");
    }

    #[test]
    fn observed_principals_and_hand_entered_ones_are_both_listed() {
        let (s, d) = temp_store("list");
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO router_sessions (id, scope_user, scope_project, scope_agent, created_at, last_seen_at)
                 VALUES ('s1','local','p1','cursor',1,42)",
                [],
            )
            .unwrap();
        }
        // Pre-configured for an agent that has not connected yet.
        assert!(set(&s, "windsurf", false).unwrap());
        let rows = list(&s).unwrap();
        // Three, not two: `key:master` is always offered, so an operator can write policy against
        // the master key without having to guess its name.
        assert_eq!(rows.len(), 3);
        let names: Vec<&str> = rows.iter().map(|r| r.principal.as_str()).collect();
        assert!(names.contains(&master_principal().as_str()), "{names:?}");
        let cursor = rows.iter().find(|r| r.principal == "cursor").unwrap();
        assert_eq!(cursor.enabled, None, "seen in traffic, never configured");
        assert_eq!(cursor.last_seen_at, Some(42));
        let windsurf = rows.iter().find(|r| r.principal == "windsurf").unwrap();
        assert_eq!(windsurf.enabled, Some(false));
        assert_eq!(windsurf.last_seen_at, None, "configured before it ever connected");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// App keys have to be discoverable. `key:<id>` is not guessable and appears nowhere else, so
    /// without this the operator has no way to learn the name to write policy against.
    #[test]
    fn active_app_keys_are_offered_as_principals_and_revoked_ones_are_not() {
        let (s, d) = temp_store("keys");
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO gateway_keys (id, label, created_at) VALUES ('ak-1','cursor',1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO gateway_keys (id, label, created_at, revoked_at)
                 VALUES ('ak-2','retired',2,9)",
                [],
            )
            .unwrap();
        }
        let rows = list(&s).unwrap();
        let names: Vec<&str> = rows.iter().map(|r| r.principal.as_str()).collect();
        assert!(names.contains(&"key:ak-1"), "{names:?}");
        assert!(!names.contains(&"key:ak-2"), "a revoked key authenticates nobody: {names:?}");
        // So is the master key, which is the one most operators actually hand out.
        assert!(names.contains(&master_principal().as_str()), "{names:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The master key is a caller like any other — the busiest one, in fact. Leaving it unnameable
    /// would mean no row could ever govern it, and absence inherits, so an operator disabling every
    /// other caller would still be learning from the master key.
    #[test]
    fn the_master_key_is_governable_by_a_policy_on_its_own_name() {
        let (s, d) = temp_store("masterkey");
        let mk = master_principal();
        assert_eq!(mk, "key:master");
        assert!(allows(true, Some(&s), None, Some(&mk)), "no row means inherit");

        assert!(set(&s, &mk, false).unwrap());
        assert!(!allows(true, Some(&s), None, Some(&mk)), "the master key can be denied");
        // One refusal is still not a global one.
        assert!(allows(true, Some(&s), None, Some(&key_principal("ak-1"))));
        // And an agent label cannot rescue it, any more than it can rescue a denied app key.
        assert!(!allows(true, Some(&s), Some("cursor"), Some(&mk)));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// `master` is not a key id any client can be issued — ids are `ak-<hex>` — so the master
    /// principal cannot be forged by, or collide with, a per-app key.
    #[test]
    fn the_master_principal_cannot_collide_with_an_app_key() {
        assert_ne!(key_principal("ak-1"), master_principal());
        assert_ne!(key_principal(""), master_principal());
        assert!(master_principal().starts_with("key:"), "a key identity, not an agent label");
    }
}
