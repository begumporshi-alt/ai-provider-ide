//! Async capture queue — the write path of the memory layer.
//!
//! Design: `GATEWAY_MEMORY_LAYER.md` §3.3 (schema) and §3.5 (what may be captured). Every §3.5 rule
//! is enforced **here, at enqueue**, and nowhere else. That placement is the whole point: the review
//! found that the capture path is a credential-laundering pipeline and a persistent instruction
//! channel, and that scrubbing at injection time is too late — the liability is the stored row.
//!
//! The six rules, and where each is enforced:
//!
//! 1. Never distil tool output → `involves_tools` + `Enqueue::Skipped(SkipCapture::ToolTurn)`.
//! 2. Secret scrubbing at enqueue → `scrub`, applied to both texts before the INSERT.
//! 3. Typed atoms → `classify` writes an immutable `content_class` on the row.
//! 4. Immutable scope binding → scope columns are written once and never updated.
//! 5. Idempotent distillation → `request_id` is UNIQUE; a replay is reported, not duplicated.
//! 6. Internal principal excluded → `Principal::Internal` never reaches the queue.
//!
//! No model call happens in this module. Enqueue is a single INSERT on a thread that has already
//! decided the response, so a slow or broken capture can never slow a request.
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;

use crate::gateway::context_scope::Scope;
use crate::store::Store;

/// Reserved agent label for the router's own distillation traffic. §3.5.6: the drain calls a model
/// through this very gateway, so each distillation would otherwise be captured as a turn, distilled
/// again, and injected into the prompt that is writing memory.
pub const INTERNAL_AGENT: &str = "aip-distiller";

/// Replacement for anything that looks like a credential.
pub const REDACTED: &str = "[REDACTED]";

/// Below this, an exchange is scaffolding rather than substance. Distillation is the dominant cost
/// of this feature and most agent turns are ceremony.
const MIN_PROSE_CHARS: usize = 40;

/// Rows stuck in `processing` longer than this are put back: it means the webview died mid-drain.
const STALE_CLAIM_MS: i64 = 10 * 60 * 1000;

/// How many rows one drain batch may claim.
const CLAIM_LIMIT: usize = 8;

/// §10(2) — who pays for distillation. Every captured turn costs one system-route call, so a queue
/// that drains everything it is given turns "memory is on" into an unbudgeted line item on a
/// provider bill. This caps **spend**, not queue size: at most this many distillations per rolling
/// hour, across all sessions.
///
/// Chosen to match the drain's own cadence — one per minute against a 60s poll — so the queue keeps
/// moving at a predictable rate instead of either stalling or bursting. It is a constant rather than
/// a setting because the failure mode it prevents is a *silent* one; making it tunable invites
/// setting it to something that defeats it. Raise it here if a real workload needs more.
pub const DISTILL_BUDGET_PER_HOUR: usize = 60;

/// The rolling window the budget is spent against.
const DISTILL_WINDOW_MS: i64 = 60 * 60 * 1000;

/// How much of the hourly budget is left, measured by rows **claimed** in the window.
///
/// Claims, not completions: the cost is incurred when the call is made, so a row that is claimed and
/// then fails has still been paid for. Using `claimed_at` needs no migration — it is already written
/// on every claim — and it cannot drift from what the host actually did.
fn budget_left(conn: &rusqlite::Connection) -> usize {
    let used: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM memory_pending
              WHERE claimed_at IS NOT NULL AND claimed_at > ?1",
            params![now_ms() - DISTILL_WINDOW_MS],
            |r| r.get(0),
        )
        .unwrap_or(0);
    DISTILL_BUDGET_PER_HOUR.saturating_sub(used.max(0) as usize)
}

/// The identity of a request in the capture queue.
///
/// The counter behind `request_id` lives on `GatewayCore` and **starts at 1 on every launch**, but
/// `memory_pending.request_id` is UNIQUE for the life of the *database* — finished rows are kept
/// for seven days (retention). So on the first run after a restart, ids repeat, and the
/// idempotency guard (§3.5.5) reads each repeat as a replay of an old request and drops it.
///
/// Measured on the installed build 2026-09-21: after a restart, request `gw-5` collided with a row
/// from the previous session and was silently not captured, while `gw-6` — free — was. Captures are
/// lost after every restart until the counter passes the previous high-water mark, and nothing
/// reports it. The boot marker scopes the id to this process so the two never meet.
pub fn request_id(n: u64) -> String {
    format!("gw-{}-{n}", boot_marker())
}

/// Set once per process. Time alone could collide if two builds started in the same millisecond
/// against the same database; the pid makes that not worth worrying about.
fn boot_marker() -> String {
    use std::sync::OnceLock;
    static BOOT: OnceLock<String> = OnceLock::new();
    BOOT.get_or_init(|| {
        format!(
            "{:x}-{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            std::process::id()
        )
    })
    .clone()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------- §3.5.6 principal ----------

/// Whose traffic this is. The internal principal is excluded from capture and from injection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Principal {
    /// An agent IDE, or anything else the user points at the gateway.
    External,
    /// The router's own distillation calls.
    Internal,
}

/// §3.5.6. Classified in the gateway rather than left to the drain's good manners: a drain that
/// forgets to identify itself would otherwise feed itself.
///
/// Either signal is sufficient — the explicit `internal` flag, or identifying as the reserved agent.
pub fn classify_principal(scope: &Scope, internal_flag: bool) -> Principal {
    if internal_flag || scope.agent.as_deref() == Some(INTERNAL_AGENT) {
        Principal::Internal
    } else {
        Principal::External
    }
}

// ---------- §3.5.3 typed atoms ----------

/// What kind of thing is being remembered. Facts, preferences and decisions are captured;
/// procedural instructions are flagged so they can never be replayed as instructions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContentClass {
    Fact,
    Preference,
    Decision,
    /// Procedural: "always run X", "never do Y". Recorded with its class so injection can present
    /// it as context about the project rather than as a directive (§3.5.3).
    Instruction,
}

impl ContentClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Preference => "preference",
            Self::Decision => "decision",
            Self::Instruction => "instruction",
        }
    }
}

/// §3.5.3. Imperative phrasing is the signal for the class that matters: an instruction-bearing atom
/// is the one that could later be injected as if it were the operator's own system context.
pub fn classify(text: &str) -> ContentClass {
    let lower = text.to_ascii_lowercase();
    let imperative = [
        "always ",
        "never ",
        "make sure to",
        "you must",
        "be sure to",
        "don't forget to",
        "remember to",
        "run ",
        "execute ",
    ];
    if imperative.iter().any(|p| lower.contains(p)) {
        return ContentClass::Instruction;
    }
    if ["we decided", "decided to", "we chose", "we will use", "let's use", "going with"]
        .iter()
        .any(|p| lower.contains(p))
    {
        return ContentClass::Decision;
    }
    if ["i prefer", "i like", "prefer ", "i'd rather", "my preference"].iter().any(|p| lower.contains(p)) {
        return ContentClass::Preference;
    }
    ContentClass::Fact
}

// ---------- §3.5.1 tool turns ----------

/// True when this exchange touched tools at all. §3.5.1: never distil tool output. Terminal output
/// and tool results are where secrets live, and "prose turns only" removes most of both hazards at
/// once — so the test is deliberately broad and fails closed.
pub fn involves_tools(body: &Value) -> bool {
    if body.get("tools").is_some_and(|v| !v.is_null())
        || body.get("tool_choice").is_some_and(|v| !v.is_null())
        || body.get("functions").is_some_and(|v| !v.is_null())
    {
        return true;
    }
    let Some(ms) = body.get("messages").and_then(Value::as_array) else {
        return false;
    };
    ms.iter().any(|m| {
        if m.get("role").and_then(Value::as_str) == Some("tool") {
            return true;
        }
        m.get("tool_calls").is_some_and(|v| !v.is_null())
            || m.get("tool_call_id").is_some()
            || m.get("name").is_some_and(|n| n.is_string())
                && m.get("content").is_some_and(Value::is_string)
                && m.get("role").and_then(Value::as_str) == Some("function")
    })
}

// ---------- §3.5.2 secret scrubbing ----------

/// Prefixes that are credentials by construction. There is no reason to keep a token that starts
/// with one of these, whatever context it appears in.
const KNOWN_PREFIXES: &[&str] = &[
    "sk-ant-", "sk-proj-", "sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-",
    "xoxb-", "xoxp-", "xoxa-", "xapp-", "AKIA", "AIza", "dop_v1_", "shpat_", "shpss_", "rpa_",
];

/// Key names whose value is a credential. Deliberately broad — `auth` or `token` in prose is rare,
/// and over-redacting costs a slightly less useful memory while under-redacting leaks a key to every
/// vendor that ever serves a request.
const SECRET_KEYS: &[&str] = &[
    "api_key", "apikey", "api-key", "access_key", "secret", "client_secret", "password", "passwd",
    "pwd", "token", "authtoken", "access_token", "refresh_token", "authorization", "auth",
    "bearer", "private_key", "credential",
];

fn is_high_entropy(token: &str) -> bool {
    if token.len() < 32 {
        return false;
    }
    if !token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-')) {
        return false;
    }
    let mut classes = 0u8;
    if token.chars().any(|c| c.is_ascii_lowercase()) {
        classes |= 1;
    }
    if token.chars().any(|c| c.is_ascii_uppercase()) {
        classes |= 2;
    }
    if token.chars().any(|c| c.is_ascii_digit()) {
        classes |= 4;
    }
    if token.chars().any(|c| !c.is_ascii_alphanumeric()) {
        classes |= 8;
    }
    classes.count_ones() >= 3
}

/// `Authorization` / `"api_key"` / `{token` all name the same thing, so the key is reduced to its
/// alphanumeric skeleton before comparison.
fn is_secret_key(raw: &str) -> bool {
    let key: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect::<String>()
        .to_ascii_lowercase();
    !key.is_empty() && SECRET_KEYS.iter().any(|s| key.contains(s))
}

fn scrub_token(token: &str) -> String {
    if token.contains("BEGIN") && token.contains("PRIVATE KEY") {
        return REDACTED.to_string();
    }
    // Trailing punctuation is not part of the value: `token:"abc",` should still redact.
    let core = token.trim_matches(|c: char| matches!(c, ',' | ';' | '"' | '\'' | ')' | ']' | '}' | '>'));
    if KNOWN_PREFIXES.iter().any(|p| core.starts_with(p)) {
        return REDACTED.to_string();
    }
    for sep in [':', '='] {
        if let Some((k, v)) = core.split_once(sep) {
            if !v.trim().is_empty() && is_secret_key(k) {
                return REDACTED.to_string();
            }
        }
    }
    if is_high_entropy(core) {
        return REDACTED.to_string();
    }
    token.to_string()
}

/// How many tokens after a secret key are swallowed as its value. `Authorization: Bearer <token>`
/// is two; a cap is needed because "and" after a redacted value is not a secret, and swallowing to
/// end of sentence would make the memory unreadable.
const VALUE_TOKENS: usize = 2;

/// §3.5.2. Applied to both sides of the exchange before the row is written.
///
/// Token-based, with a lookahead, because `Authorization: Bearer abc123` puts the key and its value
/// in different whitespace-separated tokens — a pure per-token pass leaves the value in place.
///
/// Whitespace is normalised as a side effect. That is acceptable — the distiller sees prose, not a
/// transcript — and it makes the redaction far more reliable than trying to preserve formatting.
pub fn scrub(text: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut value_budget = 0usize;
    for token in text.split_whitespace() {
        let trimmed = token.trim_end_matches([',', ';']);
        if let Some(key) = trimmed.strip_suffix(':').or_else(|| trimmed.strip_suffix('=')) {
            if is_secret_key(key) {
                out.push(REDACTED.to_string());
                value_budget = VALUE_TOKENS;
                continue;
            }
        }
        if value_budget > 0 {
            value_budget -= 1;
            out.push(REDACTED.to_string());
            continue;
        }
        out.push(scrub_token(token));
    }
    out.join(" ")
}

// ---------- §3.5 enqueue ----------

/// Why a turn was not queued. Every one of these is the safe direction: a missed memory is a
/// slightly worse answer next time, a wrongly captured one is a leaked secret or a poisoned prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipCapture {
    /// §3.5.6: the router's own distillation traffic.
    InternalPrincipal,
    /// §3.5.1: prose turns only.
    ToolTurn,
    /// Nothing substantive to learn from — scaffolding, or an empty exchange.
    NoProse,
    /// The client turned writes off for this request.
    WritesDisabled,
    /// §3.5.5: already queued for this request id.
    AlreadyQueued,
    /// No store attached, or the write failed. Never fatal.
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Enqueue {
    /// The row id.
    Queued(i64),
    Skipped(SkipCapture),
}

/// One exchange offered to the queue.
pub struct CaptureRequest<'a> {
    pub request_id: &'a str,
    pub session_id: Option<&'a str>,
    pub scope: &'a Scope,
    pub user_text: &'a str,
    pub asst_text: Option<&'a str>,
    pub model: Option<&'a str>,
    pub principal: Principal,
    pub writes_allowed: bool,
    /// §3.5.1. Decided by the caller against the request the client sent, because by the time this
    /// runs the body may have been through dialect translation. `enqueue` is still the single
    /// enforcement point.
    pub had_tools: bool,
}

/// Offer an exchange to the queue. Never fails the caller: every refusal is a `Skipped`.
pub fn enqueue(store: &Store, req: &CaptureRequest<'_>) -> Enqueue {
    // §3.5.6 first — an internal turn must not be recorded even in passing.
    if req.principal == Principal::Internal {
        return Enqueue::Skipped(SkipCapture::InternalPrincipal);
    }
    if !req.writes_allowed {
        return Enqueue::Skipped(SkipCapture::WritesDisabled);
    }
    // §3.5.1 — prose turns only.
    if req.had_tools {
        return Enqueue::Skipped(SkipCapture::ToolTurn);
    }

    // §3.5.2. Both sides, before anything is stored.
    let user_text = scrub(req.user_text);
    let asst_text = req.asst_text.map(scrub).filter(|s| !s.trim().is_empty());
    let prose_len = user_text.chars().count() + asst_text.as_ref().map(|s| s.chars().count()).unwrap_or(0);
    if prose_len < MIN_PROSE_CHARS {
        return Enqueue::Skipped(SkipCapture::NoProse);
    }

    let Ok(conn) = store.conn.lock() else {
        return Enqueue::Skipped(SkipCapture::Unavailable);
    };
    // §3.5.5. The UNIQUE constraint is the real guard; this is just the friendly path.
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM memory_pending WHERE request_id = ?1",
            params![req.request_id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    if exists {
        return Enqueue::Skipped(SkipCapture::AlreadyQueued);
    }

    // §3.5.3 and §3.5.4: class and scope are written here and never updated.
    let class = classify(&format!("{} {}", user_text, asst_text.as_deref().unwrap_or("")));
    let now = now_ms();
    let res = conn.execute(
        "INSERT INTO memory_pending
           (request_id, session_id, scope_user, scope_project, scope_agent, content_class,
            user_text, asst_text, model, status, attempts, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'queued',0,?10)",
        params![
            req.request_id,
            req.session_id,
            req.scope.user,
            req.scope.project,
            req.scope.agent,
            class.as_str(),
            user_text,
            asst_text,
            req.model,
            now,
        ],
    );
    match res {
        Ok(_) => Enqueue::Queued(conn.last_insert_rowid()),
        Err(_) => Enqueue::Skipped(SkipCapture::Unavailable),
    }
}

// ---------- drain ----------

/// One queued exchange, handed to the webview for distillation.
#[derive(Debug, Clone, Serialize)]
pub struct PendingRow {
    pub id: i64,
    pub session_id: Option<String>,
    pub scope_user: String,
    pub scope_project: Option<String>,
    pub scope_agent: Option<String>,
    pub content_class: String,
    pub user_text: String,
    pub asst_text: Option<String>,
    pub model: Option<String>,
    pub attempts: i64,
}

/// Claim a batch for distillation. Marked `processing` so a second drain cannot take the same rows,
/// and so a crash mid-batch can be recovered by `requeue_stale`.
pub fn claim(store: &Store) -> Result<Vec<PendingRow>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    // §10(2): a claim takes at most what the hourly budget has left. When it is exhausted nothing
    // is marked and no attempt is spent — the rows simply wait for the window to roll, which is the
    // whole point. Claiming and then declining to call would burn their three attempts on calls
    // that were never going to happen.
    let budget = budget_left(&conn);
    if budget == 0 {
        return Ok(Vec::new());
    }
    let limit = CLAIM_LIMIT.min(budget);
    let mut ids: Vec<i64> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT id FROM memory_pending WHERE status='queued' ORDER BY id LIMIT ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit as i64], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        for r in rows {
            ids.push(r.map_err(|e| e.to_string())?);
        }
    }
    let now = now_ms();
    let mut out = Vec::new();
    for id in ids {
        conn.execute(
            "UPDATE memory_pending SET status='processing', attempts = attempts + 1, claimed_at = ?1
             WHERE id = ?2 AND status='queued'",
            params![now, id],
        )
        .map_err(|e| e.to_string())?;
        let row = conn
            .query_row(
                "SELECT id, session_id, scope_user, scope_project, scope_agent, content_class,
                        user_text, asst_text, model, attempts
                 FROM memory_pending WHERE id = ?1 AND status='processing'",
                params![id],
                |r| {
                    Ok(PendingRow {
                        id: r.get(0)?,
                        session_id: r.get(1)?,
                        scope_user: r.get(2)?,
                        scope_project: r.get(3)?,
                        scope_agent: r.get(4)?,
                        content_class: r.get(5)?,
                        user_text: r.get(6)?,
                        asst_text: r.get(7)?,
                        model: r.get(8)?,
                        attempts: r.get(9)?,
                    })
                },
            )
            .ok();
        if let Some(r) = row {
            out.push(r);
        }
    }
    Ok(out)
}

/// Mark a row distilled.
pub fn complete(store: &Store, id: i64) -> Result<bool, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE memory_pending SET status='done' WHERE id = ?1 AND status='processing'",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Give a row back. A row that has failed repeatedly is retired rather than retried forever —
/// a turn that will not distil is not going to start.
pub fn release(store: &Store, id: i64) -> Result<bool, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE memory_pending
             SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END
             WHERE id = ?1 AND status='processing'",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Put back rows whose claim went stale — the webview was closed or crashed mid-batch. Without this
/// a single crash would strand those turns in `processing` forever.
pub fn requeue_stale(store: &Store) -> Result<usize, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let cutoff = now_ms() - STALE_CLAIM_MS;
    let n = conn
        .execute(
            "UPDATE memory_pending SET status='queued', claimed_at = NULL
             WHERE status='processing' AND COALESCE(claimed_at, 0) < ?1",
            params![cutoff],
        )
        .map_err(|e| e.to_string())?;
    Ok(n)
}

// ---------- retention ----------

/// Finished rows are dropped after this long. `done` and `failed` are only useful as an audit
/// trail, and the queue is written once per request — without a sweep it grows forever.
const RETENTION_DAYS: i64 = 7;

/// How many rows the queue currently holds in each state. The Memory screen shows `queued` as
/// "turns awaiting distillation"; the rest is there so a stuck queue is visible rather than
/// inferred from a growing database.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct QueueStatus {
    pub queued: usize,
    pub processing: usize,
    pub done: usize,
    pub failed: usize,
    /// Rows the drain has not finished with. Computed host-side so the UI cannot get it wrong by
    /// adding the wrong two fields together.
    pub outstanding: usize,
    /// Distillations still available in this hour (§10(2)). Zero means the queue is holding rows
    /// deliberately, not that anything is stuck — without it, "5 awaiting distillation" that never
    /// moves looks like a bug rather than a budget doing its job.
    pub budget_left: usize,
}

pub fn queue_status(store: &Store) -> Result<QueueStatus, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut out = QueueStatus {
        queued: 0, processing: 0, done: 0, failed: 0, outstanding: 0, budget_left: 0,
    };
    let mut stmt = conn
        .prepare("SELECT status, COUNT(*) FROM memory_pending GROUP BY status")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    for r in rows {
        let (status, n) = r.map_err(|e| e.to_string())?;
        match status.as_str() {
            "queued" => out.queued = n as usize,
            "processing" => out.processing = n as usize,
            "done" => out.done = n as usize,
            "failed" => out.failed = n as usize,
            _ => {}
        }
    }
    out.outstanding = out.queued + out.processing;
    out.budget_left = budget_left(&conn);
    Ok(out)
}

/// Drop finished rows past retention (§9: `done` after 7 days; `failed` was already retried 3×).
/// Never touches `queued` or `processing` — a purge must not be able to lose work.
pub fn purge_finished(store: &Store) -> Result<usize, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let cutoff = now_ms() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    conn.execute(
        "DELETE FROM memory_pending WHERE status IN ('done','failed') AND created_at < ?1",
        params![cutoff],
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod capture_tests {
    use super::*;
    use serde_json::json;

    fn scope(project: Option<&str>, agent: Option<&str>) -> Scope {
        Scope {
            user: "local".into(),
            project: project.map(|s| s.to_string()),
            agent: agent.map(|s| s.to_string()),
            session: None,
        }
    }

    fn req<'a>(body: &Value, scope: &'a Scope, user: &'a str, asst: Option<&'a str>) -> CaptureRequest<'a> {
        CaptureRequest {
            request_id: "gw-1",
            session_id: Some("s1"),
            scope,
            user_text: user,
            asst_text: asst,
            model: Some("openrouter/gpt-4o"),
            principal: Principal::External,
            writes_allowed: true,
            had_tools: involves_tools(body),
        }
    }

    fn temp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-cap-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir).unwrap(), dir)
    }

    /// Spend `n` of the hourly budget on rows that were claimed at `at` (default: now). This is
    /// what the host would have left behind by actually making `n` calls; faking it keeps the test
    /// about the budget rather than about the drain.
    fn spend_budget(s: &Store, tag: &str, n: usize, at: Option<i64>) {
        let conn = s.conn.lock().unwrap();
        let at = at.unwrap_or_else(now_ms);
        for i in 0..n {
            conn.execute(
                "INSERT INTO memory_pending
                   (request_id, scope_user, content_class, user_text, status, created_at, claimed_at)
                 VALUES (?1, 'local', 'fact', 'spent', 'processing', ?2, ?2)",
                params![format!("spend-{tag}-{i}"), at],
            )
            .unwrap();
        }
    }

    // ---------- §3.5.1 ----------

    #[test]
    fn a_request_that_declared_tools_is_never_captured() {
        let (s, d) = temp_store("tools");
        let sc = scope(Some("p1"), None);
        let body = json!({"tools": [{"type":"function"}], "messages": [{"role":"user","content":"x"}]});
        assert_eq!(
            enqueue(&s, &req(&body, &sc, "this is a long enough piece of prose to capture", None)),
            Enqueue::Skipped(SkipCapture::ToolTurn)
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_transcript_carrying_tool_results_is_never_captured() {
        let (s, d) = temp_store("toolrole");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages": [
            {"role":"user","content":"run the tests"},
            {"role":"tool","content":"API_KEY=sk-live-abc123"}
        ]});
        assert_eq!(
            enqueue(&s, &req(&body, &sc, "a long enough piece of user prose to be captured", None)),
            Enqueue::Skipped(SkipCapture::ToolTurn),
            "tool output is refused before it can be stored"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    // ---------- §3.5.2 ----------

    #[test]
    fn known_credential_prefixes_are_redacted_before_the_row_is_written() {
        for bad in [
            "the key is sk-proj-abcdefghijklmnop",
            "use ghp_abcdefghijklmnopqrstuvwxyz0123",
            "AKIAIOSFODNN7EXAMPLE was leaked",
        ] {
            assert!(scrub(bad).contains(REDACTED), "{bad} -> {}", scrub(bad));
            assert!(!scrub(bad).contains("abcdefgh"), "{bad} -> {}", scrub(bad));
        }
    }

    #[test]
    fn an_assigned_secret_is_redacted_whatever_the_key_is_called() {
        let text = "config: Authorization: Bearer abcdef123456, password=hunter2, and token: zzz";
        let out = scrub(text);
        assert!(!out.contains("hunter2"), "{out}");
        assert!(!out.contains("abcdef123456"), "{out}");
        assert!(out.matches(REDACTED).count() >= 2, "{out}");
    }

    #[test]
    fn a_high_entropy_string_is_redacted() {
        let out = scrub("blob aB3dEf9hIjKlMnOpQrStUvWxYz0123456789abcd done");
        assert!(out.contains(REDACTED), "{out}");
    }

    #[test]
    fn ordinary_prose_survives_scrubbing() {
        let text = "this project uses Postgres for the database and pnpm for the workspace";
        assert_eq!(scrub(text), text, "over-redaction would make memory useless");
    }

    /// The liability is the stored row, so scrubbing has to happen before the INSERT, not on the
    /// way out. This asserts the row on disk, not the function's return value.
    #[test]
    fn the_stored_row_is_already_scrubbed() {
        let (s, d) = temp_store("stored");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        let r = req(&body, &sc, "the deploy token is ghp_zzzzzzzzzzzzzzzzzzzzzzzz please remember it", None);
        let Enqueue::Queued(id) = enqueue(&s, &r) else {
            panic!("expected a queued row");
        };
        let conn = s.conn.lock().unwrap();
        let stored: String = conn
            .query_row("SELECT user_text FROM memory_pending WHERE id=?1", params![id], |r| r.get(0))
            .unwrap();
        assert!(!stored.contains("ghp_"), "the secret never reaches disk: {stored}");
        assert!(stored.contains(REDACTED));
        let _ = std::fs::remove_dir_all(&d);
    }

    // ---------- §3.5.3 ----------

    #[test]
    fn content_is_classified_so_instructions_are_flagged() {
        assert_eq!(classify("always run the migrations before deploying"), ContentClass::Instruction);
        assert_eq!(classify("never commit the .env file"), ContentClass::Instruction);
        assert_eq!(classify("we decided to use Postgres"), ContentClass::Decision);
        assert_eq!(classify("I prefer terse replies"), ContentClass::Preference);
        assert_eq!(classify("the repo has four crates"), ContentClass::Fact);
    }

    // ---------- §3.5.4 ----------

    #[test]
    fn scope_is_frozen_on_the_row_at_enqueue() {
        let (s, d) = temp_store("frozen");
        let sc = scope(Some("p-alpha"), Some("cursor"));
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        let Enqueue::Queued(id) = enqueue(&s, &req(&body, &sc, "a sufficiently long piece of conversational prose to be worth capturing", None))
        else {
            panic!("expected a queued row");
        };
        let conn = s.conn.lock().unwrap();
        let (project, agent, class): (Option<String>, Option<String>, String) = conn
            .query_row(
                "SELECT scope_project, scope_agent, content_class FROM memory_pending WHERE id=?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(project.as_deref(), Some("p-alpha"));
        assert_eq!(agent.as_deref(), Some("cursor"));
        assert!(!class.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    // ---------- §3.5.5 ----------

    #[test]
    fn the_same_request_id_is_never_queued_twice() {
        let (s, d) = temp_store("idem");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        let r = req(&body, &sc, "a sufficiently long piece of conversational prose to be worth capturing", None);
        assert!(matches!(enqueue(&s, &r), Enqueue::Queued(_)));
        assert_eq!(enqueue(&s, &r), Enqueue::Skipped(SkipCapture::AlreadyQueued));
        let conn = s.conn.lock().unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_pending", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    // ---------- §3.5.6 ----------

    #[test]
    fn the_routers_own_traffic_is_never_captured() {
        let (s, d) = temp_store("internal");
        let sc = scope(Some("p1"), Some(INTERNAL_AGENT));
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        let mut r = req(&body, &sc, "a sufficiently long piece of conversational prose to be worth capturing", None);
        r.principal = classify_principal(&sc, false);
        assert_eq!(
            enqueue(&s, &r),
            Enqueue::Skipped(SkipCapture::InternalPrincipal),
            "a distillation call is not itself a turn"
        );
        // And the explicit flag, for a drain that does not use the reserved label.
        let external = scope(Some("p1"), Some("cursor"));
        assert_eq!(classify_principal(&external, true), Principal::Internal);
        assert_eq!(classify_principal(&external, false), Principal::External);
        let _ = std::fs::remove_dir_all(&d);
    }

    // ---------- general ----------

    #[test]
    fn scaffolding_is_not_worth_distilling() {
        let (s, d) = temp_store("short");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        assert_eq!(enqueue(&s, &req(&body, &sc, "ok", None)), Enqueue::Skipped(SkipCapture::NoProse));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_client_that_turned_writes_off_is_not_captured() {
        let (s, d) = temp_store("off");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        let mut r = req(&body, &sc, "a sufficiently long piece of conversational prose to be worth capturing", None);
        r.writes_allowed = false;
        assert_eq!(enqueue(&s, &r), Enqueue::Skipped(SkipCapture::WritesDisabled));
        let _ = std::fs::remove_dir_all(&d);
    }

    // ---------- drain ----------

    #[test]
    fn claiming_a_batch_marks_it_processing_and_a_second_claim_gets_nothing() {
        let (s, d) = temp_store("claim");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        for i in 0..3 {
            let text = format!("a sufficiently long piece of prose number {i}");
            let rid = format!("gw-{i}");
            let mut r = req(&body, &sc, &text, None);
            r.request_id = &rid;
            assert!(matches!(enqueue(&s, &r), Enqueue::Queued(_)));
        }
        let first = claim(&s).unwrap();
        assert_eq!(first.len(), 3);
        assert!(claim(&s).unwrap().is_empty(), "a claimed row is not handed out twice");
        assert!(complete(&s, first[0].id).unwrap());
        assert!(!complete(&s, first[0].id).unwrap(), "completing twice is a no-op");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn releasing_a_row_returns_it_and_retires_it_after_repeated_failures() {
        let (s, d) = temp_store("release");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        enqueue(&s, &req(&body, &sc, "a sufficiently long piece of conversational prose to be worth capturing", None));

        for attempt in 1..=3 {
            let batch = claim(&s).unwrap();
            assert_eq!(batch.len(), 1, "attempt {attempt}");
            assert!(release(&s, batch[0].id).unwrap());
        }
        // Third failure retires it rather than retrying forever.
        let conn = s.conn.lock().unwrap();
        let status: String = conn
            .query_row("SELECT status FROM memory_pending WHERE id=1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(status, "failed", "a turn that will not distil is not retried indefinitely");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A webview that dies mid-batch would otherwise strand those rows in `processing` forever.
    #[test]
    fn a_stale_claim_is_put_back() {
        let (s, d) = temp_store("stale");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        enqueue(&s, &req(&body, &sc, "a sufficiently long piece of conversational prose to be worth capturing", None));
        claim(&s).unwrap();
        {
            let conn = s.conn.lock().unwrap();
            conn.execute("UPDATE memory_pending SET claimed_at = 1 WHERE id = 1", []).unwrap();
        }
        assert_eq!(requeue_stale(&s).unwrap(), 1);
        assert_eq!(claim(&s).unwrap().len(), 1, "the row is drainable again");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A restart is the case that matters: the drain died with rows claimed. Nothing may be lost
    /// and nothing may be distilled twice.
    #[test]
    fn a_restart_requeues_the_batch_that_was_in_flight() {
        let (s, d) = temp_store("restart");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        for i in 0..2 {
            let text = format!("a sufficiently long piece of prose number {i}");
            let rid = format!("gw-{i}");
            let mut r = req(&body, &sc, &text, None);
            r.request_id = &rid;
            assert!(matches!(enqueue(&s, &r), Enqueue::Queued(_)));
        }
        // Drain starts, claims both, and is killed before reporting back.
        let in_flight = claim(&s).unwrap();
        assert_eq!(in_flight.len(), 2);
        // Simulated restart: the claims are old, so they are put back.
        {
            let conn = s.conn.lock().unwrap();
            conn.execute("UPDATE memory_pending SET claimed_at = 1", []).unwrap();
        }
        assert_eq!(requeue_stale(&s).unwrap(), 2);
        let again = claim(&s).unwrap();
        assert_eq!(again.len(), 2, "no row was lost");
        let ids: Vec<i64> = again.iter().map(|r| r.id).collect();
        assert_eq!(ids, in_flight.iter().map(|r| r.id).collect::<Vec<_>>());
        for id in ids {
            assert!(complete(&s, id).unwrap());
        }
        let st = queue_status(&s).unwrap();
        assert_eq!((st.done, st.queued, st.processing), (2, 0, 0));
        assert_eq!(st.outstanding, 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    // ---------- §10(2): distillation spend is capped ----------

    const PROSE: &str = "a sufficiently long piece of conversational prose to be worth capturing";

    /// The point of the cap: a queue that is full but over budget must hold, not drain.
    #[test]
    fn an_exhausted_budget_claims_nothing() {
        let (s, d) = temp_store("budget-out");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        enqueue(&s, &req(&body, &sc, PROSE, None));
        spend_budget(&s, "out", DISTILL_BUDGET_PER_HOUR, None);

        assert!(claim(&s).unwrap().is_empty(), "an hour's worth of calls is enough");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The failure this guards against is quiet and permanent: a claimed row that is never called
    /// would still be counted as an attempt, and three of those retire the turn as `failed` — so a
    /// budget cap that burns attempts would delete the work it is meant only to delay.
    #[test]
    fn a_capped_claim_burns_no_attempts_and_loses_no_rows() {
        let (s, d) = temp_store("budget-attempts");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        enqueue(&s, &req(&body, &sc, PROSE, None));
        spend_budget(&s, "attempts", DISTILL_BUDGET_PER_HOUR, None);

        for _ in 0..DISTILL_BUDGET_PER_HOUR {
            assert!(claim(&s).unwrap().is_empty());
        }

        let conn = s.conn.lock().unwrap();
        let (status, attempts): (String, i64) = conn
            .query_row("SELECT status, attempts FROM memory_pending WHERE id = 1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(status, "queued", "the row is waiting, not retired");
        assert_eq!(attempts, 0, "a call that never happened spent nothing");
        drop(conn);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_partially_spent_budget_claims_the_remainder_not_the_batch_limit() {
        let (s, d) = temp_store("budget-partial");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        // Three left: fewer than a full batch, so the cap is what binds, not `CLAIM_LIMIT`.
        spend_budget(&s, "partial", DISTILL_BUDGET_PER_HOUR - 3, None);
        for i in 0..CLAIM_LIMIT {
            let text = format!("a sufficiently long piece of prose number {i}");
            let rid = format!("gw-{i}");
            let mut r = req(&body, &sc, &text, None);
            r.request_id = &rid;
            assert!(matches!(enqueue(&s, &r), Enqueue::Queued(_)));
        }

        assert_eq!(claim(&s).unwrap().len(), 3, "the cap is a remainder, not an all-or-nothing");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A cap that never releases would make the memory feature silently dead rather than merely
    /// rate-limited.
    #[test]
    fn the_budget_recovers_as_the_window_rolls() {
        let (s, d) = temp_store("budget-rolls");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        enqueue(&s, &req(&body, &sc, PROSE, None));
        spend_budget(&s, "rolls", DISTILL_BUDGET_PER_HOUR, None);
        assert!(claim(&s).unwrap().is_empty());

        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "UPDATE memory_pending SET claimed_at = ?1",
                params![now_ms() - DISTILL_WINDOW_MS - 1],
            )
            .unwrap();
        }
        assert_eq!(claim(&s).unwrap().len(), 1, "an hour later the row is drainable again");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The counter behind `request_id` restarts at 1 on every launch, but the UNIQUE constraint on
    /// `memory_pending.request_id` spans the life of the database. Without the boot marker the two
    /// meet on the first run after a restart and the idempotency guard eats the capture.
    ///
    /// This asserts the property rather than the format: any id this process produces must not
    /// collide with one a previous process left behind, whatever the marker happens to be.
    #[test]
    fn a_fresh_processs_request_ids_do_not_collide_with_a_previous_runs() {
        let (s, d) = temp_store("reqid");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});

        // What a previous run left behind: ids 1..3, already distilled.
        for n in 1..=3 {
            let old = format!("gw-{n}");
            let mut r = req(&body, &sc, PROSE, None);
            r.request_id = &old;
            assert!(matches!(enqueue(&s, &r), Enqueue::Queued(_)));
        }

        // This process starts its counter at 1 again. Every one of those must still be captured —
        // a bare `gw-{n}` would report AlreadyQueued for all three.
        for n in 1..=3 {
            let mut r = req(&body, &sc, PROSE, None);
            let id = request_id(n);
            r.request_id = &id;
            assert!(
                matches!(enqueue(&s, &r), Enqueue::Queued(_)),
                "gw-{n} from this process collided with the previous run's: {id}"
            );
        }

        // The reverse: the same id twice in one process is still a replay and is still refused.
        let mut r = req(&body, &sc, PROSE, None);
        let id = request_id(1);
        r.request_id = &id;
        assert_eq!(enqueue(&s, &r), Enqueue::Skipped(SkipCapture::AlreadyQueued));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The Memory screen needs this or a queue that is holding on purpose reads as a stuck queue.
    #[test]
    fn the_queue_reports_the_budget_that_is_left() {
        let (s, d) = temp_store("budget-status");
        assert_eq!(
            queue_status(&s).unwrap().budget_left,
            DISTILL_BUDGET_PER_HOUR,
            "nothing spent yet"
        );
        spend_budget(&s, "recent", 4, None);
        assert_eq!(queue_status(&s).unwrap().budget_left, DISTILL_BUDGET_PER_HOUR - 4);
        spend_budget(&s, "old", DISTILL_BUDGET_PER_HOUR, Some(now_ms() - DISTILL_WINDOW_MS - 1));
        assert_eq!(
            queue_status(&s).unwrap().budget_left,
            DISTILL_BUDGET_PER_HOUR - 4,
            "claims older than the window are not still being paid for"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn finished_rows_are_purged_after_retention_but_live_ones_never_are() {
        let (s, d) = temp_store("purge");
        let sc = scope(Some("p1"), None);
        let body = json!({"messages":[{"role":"user","content":"x"}]});
        let mut r = req(&body, &sc, "a sufficiently long piece of conversational prose to be worth capturing", None);
        assert!(matches!(enqueue(&s, &r), Enqueue::Queued(_)));
        let rid_done = "gw-done";
        r.request_id = rid_done;
        assert!(matches!(enqueue(&s, &r), Enqueue::Queued(_)));
        {
            let conn = s.conn.lock().unwrap();
            let old = now_ms() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
            conn.execute(
                "UPDATE memory_pending SET status='done', created_at=?1 WHERE request_id='gw-1'",
                params![old],
            )
            .unwrap();
            conn.execute("UPDATE memory_pending SET status='done' WHERE request_id='gw-done'", [])
                .unwrap();
        }
        assert_eq!(purge_finished(&s).unwrap(), 1, "only the row past retention");
        let conn = s.conn.lock().unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_pending", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        drop(conn);
        // A queued row is never purged, however old it is — otherwise a slow drain could delete
        // the very turn it was about to distil.
        {
            let conn = s.conn.lock().unwrap();
            let old = now_ms() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
            conn.execute(
                "UPDATE memory_pending SET status='queued', created_at=?1",
                params![old],
            )
            .unwrap();
        }
        assert_eq!(purge_finished(&s).unwrap(), 0, "a purge must not be able to lose work");
        let _ = std::fs::remove_dir_all(&d);
    }
}
