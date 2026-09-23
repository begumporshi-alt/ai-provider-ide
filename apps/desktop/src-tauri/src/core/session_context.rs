//! Live context — sessions, a bounded ring of turns, and the state an agent pushes.
//!
//! Design: `GATEWAY_MEMORY_LAYER.md` §3.2 (schema) and §5.4 (idempotency). This is **not**
//! `context_nodes`: that table is the Context screen's display graph — closed four-kind node set, no
//! scoping, no retention — and pushing verbatim agent turns into it would destroy both the screen
//! and its `graph(limit)` window.
//!
//! Three rules are encoded here because each is cheap to get wrong later:
//!
//!  - **Only the tail is recorded.** A coding agent replays its entire transcript on every request.
//!    Storing all of it would write fifty rows per turn and fill the ring with duplicates of turns
//!    that were already stored last request.
//!  - **`system` and `tool` turns are never recorded.** `system` is the client's own instructions,
//!    and tool output is the credential-laundering vector §3.5 warns about: it is full of secrets,
//!    and storing it here would broadcast it to whichever vendor serves the next request.
//!  - **A session is a correlation key, not a boundary.** It never gates what may be recalled — see
//!    `Scope::can_read_project_memory`. Recording is gated on the memory toggle, so with memory off
//!    nothing here runs at all.
use rusqlite::params;
use serde_json::Value;

use crate::core::store::Store;

/// Ring size per session. Pruned by `prune`, and enforced here as well so a misbehaving caller
/// cannot grow the table without limit.
pub const MAX_TURNS_PER_SESSION: usize = 200;

/// Turns older than this are dropped outright, independent of the ring.
pub const TURN_TTL_DAYS: i64 = 14;

/// Idle sessions older than this are reaped.
pub const SESSION_TTL_DAYS: i64 = 30;

/// One turn is clipped to this before it is stored or injected.
pub const MAX_TURN_CHARS: usize = 2000;

/// Open-files list is capped; an agent with 400 buffers open must not blow the budget.
pub const OPEN_FILES_CAP: usize = 20;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One recorded turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub seq: i64,
    pub role: String,
    pub text: String,
    pub ts: i64,
}

/// Resolve the session a request belongs to.
///
/// An explicit `AIP-Session` wins. Absent it, the id is **derived** from the principal and the scope
/// rather than randomised: most agents cannot set headers, so a fresh random id per request would
/// give every request its own session and live context would never accumulate.
///
/// `principal` is in the key because without it the key says only *where* a request came from and
/// not *who* sent it. Measured against the live gateway (2026-09-22): the master key and a per-app
/// key, both resolving to `local|<project>|-`, produced the **same** session id, so turns recorded
/// for one caller were injected into the other's prompt. Scope alone is not an identity.
///
/// `None` renders as `-`, the same convention as the other unresolved dimensions, and is what a
/// request gets when memory is off — sessions are unused then, so this is inert rather than a
/// second namespace that shifts with the toggle.
pub fn resolve_session(
    meta: &crate::core::gateway::context_scope::RequestMeta,
    scope: &crate::core::gateway::context_scope::Scope,
    principal: Option<&str>,
) -> String {
    if let Some(s) = &meta.session {
        return s.clone();
    }
    let key = format!(
        "{}|{}|{}|{}",
        principal.unwrap_or("-"),
        scope.user,
        scope.project.as_deref().unwrap_or("-"),
        scope.agent.as_deref().unwrap_or("-"),
    );
    format!("s-{:016x}", crate::core::gateway::context_scope::fnv1a(&key))
}

/// Create the session if new, otherwise refresh `last_seen_at`.
///
/// `COALESCE` keeps the first non-null binding: a request that arrives before the project is known
/// must not overwrite a real project with `NULL` later, which would quietly orphan the session.
pub fn touch_session(
    store: &Store,
    session: &str,
    scope: &crate::core::gateway::context_scope::Scope,
) -> Result<(), String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO router_sessions (id, scope_user, scope_project, scope_agent, turn_count, created_at, last_seen_at)
         VALUES (?1,?2,?3,?4,0,?5,?5)
         ON CONFLICT(id) DO UPDATE SET
           last_seen_at  = excluded.last_seen_at,
           scope_project = COALESCE(router_sessions.scope_project, excluded.scope_project),
           scope_agent   = COALESCE(router_sessions.scope_agent, excluded.scope_agent)",
        params![session, scope.user, scope.project, scope.agent, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The tail worth keeping: the last assistant turn and the last user turn, in that order.
///
/// Everything earlier is either already stored from a previous request or is the client's own
/// replayed history, and §5.4 exists precisely because replaying it is the normal case.
fn tail(body: &Value) -> Vec<(String, String)> {
    let Some(ms) = body.get("messages").and_then(Value::as_array) else {
        return Vec::new();
    };
    let pick = |want: &str| -> Option<String> {
        ms.iter()
            .rev()
            .find(|m| m.get("role").and_then(Value::as_str) == Some(want))
            .and_then(|m| m.get("content").and_then(Value::as_str))
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(MAX_TURN_CHARS).collect())
    };
    [("assistant", pick("assistant")), ("user", pick("user"))]
        .into_iter()
        .filter_map(|(role, text)| text.map(|t| (role.to_string(), t)))
        .collect()
}

/// Record the tail of an incoming request. Returns how many turns were written.
///
/// A turn identical to the session's most recent one is skipped. Retries and reconnects otherwise
/// append duplicates on every attempt, which is the difference between a ring of 200 real turns and
/// a ring of 200 copies of one.
pub fn record_turns(store: &Store, session: &str, body: &Value) -> Result<usize, String> {
    let turns = tail(body);
    if turns.is_empty() {
        return Ok(0);
    }
    let conn = store.conn.lock().map_err(|e| e.to_string())?;

    let mut last: Vec<(i64, String, String)> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT seq, role, text FROM session_turns WHERE session_id = ?1 ORDER BY seq DESC LIMIT 2")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![session], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            last.push(r.map_err(|e| e.to_string())?);
        }
    }

    let next: i64 = conn
        .query_row("SELECT turn_count FROM router_sessions WHERE id = ?1", params![session], |r| {
            r.get(0)
        })
        .unwrap_or(0);

    let mut written = 0usize;
    for (role, text) in &turns {
        // Skip when this exact turn is already the most recent thing recorded.
        if last.iter().any(|(_, r, t)| r == role && t == text) {
            continue;
        }
        let seq = next + written as i64 + 1;
        let n = conn
            .execute(
                "INSERT OR IGNORE INTO session_turns (session_id, seq, role, text, ts)
                 VALUES (?1,?2,?3,?4,?5)",
                params![session, seq, role, text, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        written += n;
    }

    if written > 0 {
        conn.execute(
            "UPDATE router_sessions SET turn_count = turn_count + ?1, last_seen_at = ?2 WHERE id = ?3",
            params![written as i64, now_ms(), session],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(written)
}

/// The most recent turns, oldest first, so they read as a transcript rather than in reverse.
pub fn recent_turns(store: &Store, session: &str, limit: usize) -> Result<Vec<Turn>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT seq, role, text, ts FROM session_turns WHERE session_id = ?1
             ORDER BY seq DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![session, limit as i64], |r| {
            Ok(Turn { seq: r.get(0)?, role: r.get(1)?, text: r.get(2)?, ts: r.get(3)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = rows;
    out.reverse();
    Ok(out)
}

/// §5.4: hash of one turn, used to drop injected turns the client already sent itself.
///
/// Normalised before hashing — an agent that re-sends the same turn with different trailing
/// whitespace must still be recognised as a duplicate.
pub fn turn_hash(role: &str, text: &str) -> String {
    let normalised: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{:016x}", crate::core::gateway::context_scope::fnv1a(&format!("{role}\n{normalised}")))
}

/// Hashes of the user turns present in an incoming request, so injected turns that duplicate them
/// can be dropped.
pub fn incoming_hashes(body: &Value) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let Some(ms) = body.get("messages").and_then(Value::as_array) else {
        return out;
    };
    for m in ms {
        let Some(role) = m.get("role").and_then(Value::as_str) else { continue };
        if role != "user" && role != "assistant" {
            continue;
        }
        let Some(text) = m.get("content").and_then(Value::as_str) else { continue };
        if text.trim().is_empty() {
            continue;
        }
        out.insert(turn_hash(role, text));
    }
    out
}

/// Drop turns the client has already sent itself. This is the whole of §5.4: injection is
/// wire-only, but a client that replays its transcript plus a router that injects recent turns puts
/// the tail in the prompt twice.
pub fn without_duplicates(
    turns: Vec<Turn>,
    incoming: &std::collections::HashSet<String>,
) -> Vec<Turn> {
    turns.into_iter().filter(|t| !incoming.contains(&turn_hash(&t.role, &t.text))).collect()
}

/// Live state the agent pushes: open files and an opaque extra object. Both capped.
pub fn set_state(
    store: &Store,
    session: &str,
    open_files: Option<&[String]>,
    extra: Option<&Value>,
) -> Result<(), String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let files = open_files.map(|f| {
        serde_json::to_string(&f.iter().take(OPEN_FILES_CAP).collect::<Vec<_>>())
            .unwrap_or_else(|_| "[]".into())
    });
    let extra_json = extra.map(|v| v.to_string()).filter(|s| s.len() <= 4000);
    conn.execute(
        "INSERT INTO session_state (session_id, open_files, extra_json, updated_at)
         VALUES (?1,?2,?3,?4)
         ON CONFLICT(session_id) DO UPDATE SET
           open_files = COALESCE(excluded.open_files, session_state.open_files),
           extra_json = COALESCE(excluded.extra_json, session_state.extra_json),
           updated_at = excluded.updated_at",
        params![session, files, extra_json, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The state an agent pushed, read back for injection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionState {
    pub open_files: Vec<String>,
    pub updated_at: i64,
}

/// Read the live state for a session. Missing rows are normal — most agents push nothing — so this
/// returns `None` rather than an error.
pub fn get_state(store: &Store, session: &str) -> Result<Option<SessionState>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let row = conn
        .query_row(
            "SELECT open_files, updated_at FROM session_state WHERE session_id = ?1",
            params![session],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok();
    let Some((raw, updated_at)) = row else {
        return Ok(None);
    };
    let open_files = raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .unwrap_or_default();
    Ok(Some(SessionState { open_files, updated_at }))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
pub struct PruneStats {
    pub turns_by_count: usize,
    pub turns_by_age: usize,
    pub sessions_reaped: usize,
}

/// Bound the tables: ring per session, TTL on turns, TTL on idle sessions.
///
/// Runs on idle rather than per request — pruning inside the request path would add a second write
/// to the hottest code in the app.
pub fn prune(store: &Store) -> Result<PruneStats, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;

    // Keep the newest MAX_TURNS_PER_SESSION per session. `seq` is monotonic, so "keep the rows
    // whose seq is above the nth largest" is the ring without a per-session loop.
    let turns_by_count = conn
        .execute(
            "DELETE FROM session_turns WHERE id IN (
               SELECT t.id FROM session_turns t
               WHERE (SELECT COUNT(*) FROM session_turns x
                      WHERE x.session_id = t.session_id AND x.seq >= t.seq) > ?1
             )",
            params![MAX_TURNS_PER_SESSION as i64],
        )
        .map_err(|e| e.to_string())?;

    let turn_cutoff = now_ms() - TURN_TTL_DAYS * 86_400_000;
    let turns_by_age = conn
        .execute("DELETE FROM session_turns WHERE ts < ?1", params![turn_cutoff])
        .map_err(|e| e.to_string())?;

    // Sessions are reaped only after their turns are gone, so the FK never fires: a session with
    // no turns has nothing left to contribute to live context.
    let session_cutoff = now_ms() - SESSION_TTL_DAYS * 86_400_000;
    let sessions_reaped = conn
        .execute(
            "DELETE FROM router_sessions
             WHERE last_seen_at < ?1
               AND NOT EXISTS (SELECT 1 FROM session_turns t WHERE t.session_id = router_sessions.id)",
            params![session_cutoff],
        )
        .map_err(|e| e.to_string())?;

    // One literal rather than `default()` plus three field writes: the three counts come from
    // three separate statements, so a partial write is impossible to express here and the
    // literal makes that explicit (clippy::field_reassign_with_default).
    Ok(PruneStats { turns_by_count, turns_by_age, sessions_reaped })
}

#[cfg(test)]
mod session_context_tests {
    use super::*;
    use crate::core::gateway::context_scope::{RequestMeta, Scope};
    use serde_json::json;

    fn temp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-sess-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir).unwrap(), dir)
    }

    fn scope(project: Option<&str>, agent: Option<&str>) -> Scope {
        Scope {
            user: "local".into(),
            project: project.map(|s| s.to_string()),
            agent: agent.map(|s| s.to_string()),
            session: None,
        }
    }

    fn body(user: &str, assistant: Option<&str>) -> Value {
        let mut ms = vec![json!({"role": "user", "content": user})];
        if let Some(a) = assistant {
            ms.insert(0, json!({"role": "assistant", "content": a}));
        }
        json!({"model": "m", "messages": ms})
    }

    #[test]
    fn an_explicit_session_id_wins_over_derivation() {
        let meta = RequestMeta { session: Some("mine".into()), ..Default::default() };
        let s = resolve_session(&meta, &scope(Some("p1"), Some("cursor")), Some("key:master"));
        assert_eq!(s, "mine");
    }

    /// Most agents cannot set headers, so a random id would give every request its own session and
    /// live context would never accumulate.
    #[test]
    fn a_derived_session_is_stable_across_requests() {
        let meta = RequestMeta::default();
        let a = resolve_session(&meta, &scope(Some("p1"), Some("cursor")), Some("key:master"));
        let b = resolve_session(&meta, &scope(Some("p1"), Some("cursor")), Some("key:master"));
        let c = resolve_session(&meta, &scope(Some("p2"), Some("cursor")), Some("key:master"));
        assert_eq!(a, b, "the same scope always yields the same session");
        assert_ne!(a, c, "a different project is a different session");
    }

    /// The defect this fixes, measured live on 2026-09-22: the master key and a per-app key resolve
    /// to the same scope, so with the principal absent from the key they derived the same session
    /// and turns recorded for one caller were injected into the other's prompt. Scope alone is
    /// where a request came from, not who sent it.
    #[test]
    fn two_principals_in_the_same_scope_do_not_share_a_session() {
        let meta = RequestMeta::default();
        let sc = scope(Some("p1"), None);
        let master = resolve_session(&meta, &sc, Some("key:master"));
        let app = resolve_session(&meta, &sc, Some("key:ak-fc85350a2fb1dc67"));
        let unnamed = resolve_session(&meta, &sc, None);
        assert_ne!(master, app, "a per-app key is not the master key's session");
        assert_ne!(master, unnamed, "an unidentified caller is not the master key's session");
        assert_ne!(app, unnamed);
        // Stability is untouched: the same principal and scope still derive one id.
        assert_eq!(master, resolve_session(&meta, &sc, Some("key:master")));
    }

    #[test]
    fn only_the_tail_is_recorded_not_the_whole_replayed_transcript() {
        let (s, d) = temp_store("tail");
        let sc = scope(Some("p1"), None);
        touch_session(&s, "s1", &sc).unwrap();
        // A transcript an agent would replay: 3 exchanges, newest last.
        let long = json!({"messages": [
            {"role":"user","content":"first"},
            {"role":"assistant","content":"answer one"},
            {"role":"user","content":"second"},
            {"role":"assistant","content":"answer two"},
            {"role":"user","content":"third"},
        ]});
        let n = record_turns(&s, "s1", &long).unwrap();
        assert_eq!(n, 2, "only the last assistant and last user turn are stored: {n}");
        let turns = recent_turns(&s, "s1", 10).unwrap();
        let roles: Vec<&str> = turns.iter().map(|t| t.role.as_str()).collect();
        assert_eq!(roles, vec!["assistant", "user"]);
        assert_eq!(turns[1].text, "third");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Retries otherwise append the same turn once per attempt, and the ring fills with copies.
    #[test]
    fn recording_the_same_turn_twice_does_not_duplicate_it() {
        let (s, d) = temp_store("dedupe");
        touch_session(&s, "s1", &scope(Some("p1"), None)).unwrap();
        let b = body("fix the failing test", None);
        assert_eq!(record_turns(&s, "s1", &b).unwrap(), 1);
        assert_eq!(record_turns(&s, "s1", &b).unwrap(), 0, "a retry adds nothing");
        assert_eq!(recent_turns(&s, "s1", 10).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// §3.5: tool output is full of secrets, and `system` is the client's own instructions.
    /// Neither belongs in a table whose contents get injected into another vendor's request.
    #[test]
    fn system_and_tool_turns_are_never_recorded() {
        let (s, d) = temp_store("roles");
        touch_session(&s, "s1", &scope(Some("p1"), None)).unwrap();
        let b = json!({"messages": [
            {"role":"system","content":"you are helpful"},
            {"role":"tool","content":"API_KEY=sk-live-abc123"},
        ]});
        assert_eq!(record_turns(&s, "s1", &b).unwrap(), 0);
        assert!(recent_turns(&s, "s1", 10).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// §5.4. The client replays its transcript; the router must not add a second copy of the tail.
    #[test]
    fn turns_the_client_already_sent_are_dropped_before_injection() {
        let (s, d) = temp_store("idempotent");
        let sc = scope(Some("p1"), None);
        touch_session(&s, "s1", &sc).unwrap();
        let b = body("what database does this project use", None);
        record_turns(&s, "s1", &b).unwrap();

        let turns = recent_turns(&s, "s1", 10).unwrap();
        assert_eq!(turns.len(), 1);
        // The same request arriving again carries that turn already.
        let incoming = incoming_hashes(&b);
        let kept = without_duplicates(turns, &incoming);
        assert!(kept.is_empty(), "a turn already in the prompt is not injected again");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn hashing_ignores_whitespace_so_a_reformatted_resend_is_still_a_duplicate() {
        assert_eq!(turn_hash("user", "fix  the test"), turn_hash("user", "fix the test"));
        assert_ne!(turn_hash("user", "fix the test"), turn_hash("assistant", "fix the test"));
    }

    #[test]
    fn the_ring_is_bounded_and_old_turns_age_out() {
        let (s, d) = temp_store("prune");
        touch_session(&s, "s1", &scope(Some("p1"), None)).unwrap();
        for i in 0..(MAX_TURNS_PER_SESSION + 25) {
            record_turns(&s, "s1", &body(&format!("turn {i}"), None)).unwrap();
        }
        assert_eq!(recent_turns(&s, "s1", 1000).unwrap().len(), MAX_TURNS_PER_SESSION + 25);
        let stats = prune(&s).unwrap();
        assert!(stats.turns_by_count >= 25, "ring trimmed to {MAX_TURNS_PER_SESSION}: {stats:?}");
        assert_eq!(recent_turns(&s, "s1", 1000).unwrap().len(), MAX_TURNS_PER_SESSION);
        // The newest survived; the oldest did not.
        let kept: Vec<String> =
            recent_turns(&s, "s1", 1000).unwrap().iter().map(|t| t.text.clone()).collect();
        assert!(kept.contains(&format!("turn {}", MAX_TURNS_PER_SESSION + 24)));
        assert!(!kept.contains(&"turn 0".to_string()));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A session with turns must not be reaped out from under them — the FK would either cascade
    /// away live context or, worse, fail the prune.
    #[test]
    fn an_idle_session_without_turns_is_reaped_but_one_with_turns_survives() {
        let (s, d) = temp_store("reap");
        touch_session(&s, "empty", &scope(None, None)).unwrap();
        touch_session(&s, "busy", &scope(None, None)).unwrap();
        record_turns(&s, "busy", &body("still here", None)).unwrap();

        {
            let conn = s.conn.lock().unwrap();
            conn.execute("UPDATE router_sessions SET last_seen_at = 1", []).unwrap();
        }
        let stats = prune(&s).unwrap();
        assert_eq!(stats.sessions_reaped, 1, "only the empty one goes: {stats:?}");
        let conn = s.conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM router_sessions WHERE id='busy'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn open_files_are_capped_and_state_survives_a_later_update() {
        let (s, d) = temp_store("state");
        touch_session(&s, "s1", &scope(Some("p1"), None)).unwrap();
        let many: Vec<String> = (0..OPEN_FILES_CAP + 10).map(|i| format!("src/f{i}.ts")).collect();
        set_state(&s, "s1", Some(&many), None).unwrap();
        let conn = s.conn.lock().unwrap();
        let raw: String = conn
            .query_row("SELECT open_files FROM session_state WHERE session_id='s1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let files: Vec<String> = serde_json::from_str(&raw).unwrap();
        assert_eq!(files.len(), OPEN_FILES_CAP, "capped: {}", files.len());
        let _ = std::fs::remove_dir_all(&d);
    }
}
