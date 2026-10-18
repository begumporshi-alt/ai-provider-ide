/**
 * AXIOM's persistence — the four tables 0029 adds, and nothing else.
 *
 * The engine lives in `packages/axiom-core` and runs in the webview, which is why this module is a
 * store and not a supervisor: it holds the version chain, the finding register, the eval results and
 * the promotion decisions, and it enforces the two invariants that a TypeScript caller could get
 * wrong silently. Everything else is the engine's business.
 *
 * The two invariants:
 *
 * **At most one active version.** `set_state` retires the incumbent in the same transaction as it
 * promotes the new one. The unique partial index in 0029 backs this at the schema level, so a
 * hand-edited database cannot leave two rows claiming to be what the agent runs with — but the
 * transaction is what makes the ordinary path work at all, because a bare `UPDATE` to `active` would
 * hit that index and fail.
 *
 * **Versions are immutable.** `put_version` inserts and refuses to overwrite. The only mutable
 * columns are `state` and `decision_id`, and they have their own functions. Immutability is not
 * tidiness here: `axiom_suite_results` is keyed by version, and a result is only reusable forever
 * because the configuration that produced it can never change underneath it.
 *
 * Nested collections that belong to the engine — a suite result's per-task and per-attempt rows, a
 * decision's checks, roles and deltas — are stored as JSON documents and validated as arrays rather
 * than re-declared here. A second transcription of those shapes in Rust would be a rule in two
 * places, and the one that rots is always the copy. The version chain and the finding register *are*
 * typed, because those are the rows a query reads by column.
 */
use serde::{Deserialize, Serialize};

use crate::core::store::Store;

pub const VERSION_STATES: [&str; 4] = ["candidate", "active", "rejected", "retired"];
pub const SEVERITIES: [&str; 4] = ["info", "minor", "major", "critical"];
pub const ROOT_CAUSES: [&str; 6] = ["model", "prompt", "memory", "tool", "orchestration", "infra"];

/// The loop parameters a version carries. Kept flat in the table and nested on the wire so the JSON
/// matches `AgentConfig` in the engine exactly.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoopParams {
    pub max_iterations: i64,
    pub verification_nudge_max: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfig {
    /// Null means "the host's built-in prompt". Never an empty string: an empty override would be a
    /// system turn with nothing in it, which is a different configuration from the built-in one.
    pub prompt_override: Option<String>,
    #[serde(rename = "loop")]
    pub loop_params: LoopParams,
}

/// One piece of evidence: a run, the steps in it that matter, and what they show.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub run_id: String,
    /// Empty only on the row that records *omitted* occurrences, which stands for the ones not
    /// listed and so names no step by design.
    pub steps: Vec<i64>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AxiomVersion {
    pub id: String,
    pub parent_id: Option<String>,
    pub created_at: i64,
    pub config: AgentConfig,
    pub reason: String,
    pub targets_finding_ids: Vec<String>,
    pub evidence: Vec<Evidence>,
    pub state: String,
    pub decision_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AxiomFinding {
    pub id: String,
    pub detector: String,
    pub title: String,
    pub severity: String,
    pub root_cause: String,
    pub rationale: String,
    pub differential: bool,
    pub evidence: Vec<Evidence>,
    pub occurrences: i64,
    pub metric: Option<String>,
    /// When this finding was last observed. Stamped by the host on write and ignored in the payload —
    /// "when did we last see this" is a fact about the database, and the engine's `Finding` type has
    /// no such field because it has no business inventing one.
    #[serde(default)]
    pub recorded_at: i64,
}

/// What the agent runs with right now. Returned by `axiom_active_config` so the Assistant reads one
/// value rather than deriving it from a version list — a derivation in two places is a derivation
/// that disagrees.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveConfig {
    pub config: AgentConfig,
    /// Null when no version is active, which is the state every install is in until AXIOM promotes
    /// something. The agent then runs its built-in configuration.
    pub version_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Cost {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

/// One benchmark result, in exactly the shape `SuiteResult` has in `packages/axiom-core/src/types.ts`.
///
/// The same JSON crosses the wire in both directions — this struct is what a write takes and what
/// `list_suite_results` hands back — so a round trip through the store returns the object it was
/// given. That is what makes a stored baseline safe to reuse: the engine compares two results, and
/// a mapping layer between the two shapes would be a place for them to quietly stop meaning the same
/// thing.
///
/// A struct rather than thirteen positional arguments for the same reason it is a struct on the wire:
/// two `i64`s side by side are transposable and nothing catches the transposition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuiteResult {
    pub id: String,
    pub suite_id: String,
    pub version_id: String,
    pub model: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub repeats: i64,
    /// Engine-owned documents: per-task and per-attempt rows. Validated as arrays and stored as JSON
    /// rather than re-declared here — see the module note on why the copy is the one that rots.
    pub tasks: serde_json::Value,
    pub attempt_summaries: serde_json::Value,
    pub pass_rate: f64,
    pub cost: Cost,
}

/// One promotion decision, in the shape of `PromotionDecision`. The checks, role verdicts and deltas
/// are the reasoning the decision was made from; they are stored so "why did it reject that?" stays
/// answerable after the run that produced it is gone.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Decision {
    pub id: String,
    pub candidate_id: String,
    pub baseline_id: String,
    pub model: String,
    pub decided_at: i64,
    /// `promote` | `reject`. Validated against those two on write, and by a CHECK on the column.
    pub decision: String,
    pub checks: serde_json::Value,
    pub roles: serde_json::Value,
    pub deltas: serde_json::Value,
}

/// One attempt to improve the agent, whatever became of it — the record 0031 adds.
///
/// The four tables above record what AXIOM concluded; this one records that a pass *happened*. A
/// completed pass stores its whole `ImproveReport`; a refused, aborted or failed one stores the
/// error it ended with, in the same column. The nullable fields stay null until the pass got far
/// enough to know them, so a row can never imply a decision it did not make.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditPass {
    pub id: String,
    pub started_at: i64,
    pub ended_at: i64,
    /// `completed` | `refused` | `aborted` | `failed`. Validated against those four on write.
    pub status: String,
    pub suite_id: Option<String>,
    pub model: Option<String>,
    pub repeats: Option<i64>,
    pub decision: Option<String>,
    pub candidate_id: Option<String>,
    pub baseline_id: Option<String>,
    /// The engine's own document — an `ImproveReport` for a completed pass, `{error: message}`
    /// otherwise. Stored whole and returned parsed, never re-shaped here.
    pub report: serde_json::Value,
}

pub const AUDIT_STATUSES: [&str; 4] = ["completed", "refused", "aborted", "failed"];

pub const DEFAULT_LOOP: LoopParams = LoopParams { max_iterations: 40, verification_nudge_max: 1 };

fn default_config() -> AgentConfig {
    AgentConfig { prompt_override: None, loop_params: DEFAULT_LOOP }
}

fn conn(store: &Store) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>, String> {
    store.conn.lock().map_err(|e| e.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Read a JSON document column, refusing anything that is not an array. The engine writes arrays
/// here; a scalar or an object means a writer bug, and returning `[]` for it would hide the loss.
fn read_array(raw: String, column: &str) -> Result<serde_json::Value, String> {
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("{column}: {e}"))?;
    if !v.is_array() {
        return Err(format!("{column} holds a {}, not an array", json_kind(&v)));
    }
    Ok(v)
}

fn json_kind(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

fn write_array(v: &serde_json::Value, column: &str) -> Result<String, String> {
    if !v.is_array() {
        return Err(format!("{column} must be an array, got {}", json_kind(v)));
    }
    serde_json::to_string(v).map_err(|e| e.to_string())
}

/// Refuse to write over a record that already exists. `table` is always a string literal at the call
/// site — it is the one part of these queries that cannot be a bound parameter, so it is the one part
/// that must never come from a caller across the wire.
fn refuse_taken_id(
    c: &rusqlite::Connection,
    table: &str,
    id: &str,
    what: &str,
    why: &str,
) -> Result<(), String> {
    let existing: i64 = c
        .query_row(&format!("SELECT COUNT(*) FROM {table} WHERE id=?1"), [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if existing > 0 {
        return Err(format!("{what} {id} already exists — {why}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The version chain
// ---------------------------------------------------------------------------

pub fn put_version(store: &Store, v: &AxiomVersion) -> Result<(), String> {
    if !VERSION_STATES.contains(&v.state.as_str()) {
        return Err(format!("unknown version state '{}'", v.state));
    }
    let targets = serde_json::to_string(&v.targets_finding_ids).map_err(|e| e.to_string())?;
    let evidence = serde_json::to_string(&v.evidence).map_err(|e| e.to_string())?;
    let c = conn(store)?;
    refuse_taken_id(&c, "axiom_versions", &v.id, "version", "versions are immutable")?;
    c.execute(
        "INSERT INTO axiom_versions
           (id, parent_id, created_at, prompt_override, max_iterations, verification_nudge_max,
            reason, targets_finding_ids, evidence, state, decision_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        rusqlite::params![
            v.id,
            v.parent_id,
            v.created_at,
            v.config.prompt_override,
            v.config.loop_params.max_iterations,
            v.config.loop_params.verification_nudge_max,
            v.reason,
            targets,
            evidence,
            v.state,
            v.decision_id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn row_to_version(r: &rusqlite::Row<'_>) -> rusqlite::Result<AxiomVersion> {
    let targets: String = r.get(7)?;
    let evidence: String = r.get(8)?;
    Ok(AxiomVersion {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        created_at: r.get(2)?,
        config: AgentConfig {
            prompt_override: r.get(3)?,
            loop_params: LoopParams {
                max_iterations: r.get(4)?,
                verification_nudge_max: r.get(5)?,
            },
        },
        reason: r.get(6)?,
        targets_finding_ids: serde_json::from_str(&targets).unwrap_or_default(),
        evidence: serde_json::from_str(&evidence).unwrap_or_default(),
        state: r.get(9)?,
        decision_id: r.get(10)?,
    })
}

const VERSION_COLS: &str = "id, parent_id, created_at, prompt_override, max_iterations, \
     verification_nudge_max, reason, targets_finding_ids, evidence, state, decision_id";

pub fn list_versions(store: &Store) -> Result<Vec<AxiomVersion>, String> {
    let c = conn(store)?;
    let mut stmt = c
        .prepare(&format!(
            "SELECT {VERSION_COLS} FROM axiom_versions ORDER BY created_at ASC, id ASC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], row_to_version).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn get_version(store: &Store, id: &str) -> Result<Option<AxiomVersion>, String> {
    let c = conn(store)?;
    let mut stmt = c
        .prepare(&format!("SELECT {VERSION_COLS} FROM axiom_versions WHERE id=?1"))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query_map([id], row_to_version).map_err(|e| e.to_string())?;
    match rows.next() {
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(e)) => Err(e.to_string()),
        None => Ok(None),
    }
}

pub fn active_version(store: &Store) -> Result<Option<AxiomVersion>, String> {
    let c = conn(store)?;
    let mut stmt = c
        .prepare(&format!("SELECT {VERSION_COLS} FROM axiom_versions WHERE state='active' LIMIT 1"))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query_map([], row_to_version).map_err(|e| e.to_string())?;
    match rows.next() {
        Some(Ok(v)) => Ok(Some(v)),
        Some(Err(e)) => Err(e.to_string()),
        None => Ok(None),
    }
}

/// The configuration the Assistant should run with. Falls back to the built-in defaults when
/// nothing is active, which is the state a fresh install is in.
pub fn active_config(store: &Store) -> Result<ActiveConfig, String> {
    match active_version(store)? {
        Some(v) => Ok(ActiveConfig { config: v.config, version_id: Some(v.id) }),
        None => Ok(ActiveConfig { config: default_config(), version_id: None }),
    }
}

/// Move a version to a new state. Promoting to `active` retires the incumbent **in the same
/// transaction**: the schema forbids two active versions, and a caller that had to remember to
/// retire the old one first would eventually not.
pub fn set_state(store: &Store, id: &str, state: &str) -> Result<(), String> {
    if !VERSION_STATES.contains(&state) {
        return Err(format!("unknown version state '{state}'"));
    }
    let mut c = conn(store)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let known: i64 = tx
        .query_row("SELECT COUNT(*) FROM axiom_versions WHERE id=?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if known == 0 {
        return Err(format!("no version {id}"));
    }
    if state == "active" {
        tx.execute(
            "UPDATE axiom_versions SET state='retired' WHERE state='active' AND id<>?1",
            [id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute("UPDATE axiom_versions SET state=?2 WHERE id=?1", rusqlite::params![id, state])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn link_decision(store: &Store, version_id: &str, decision_id: &str) -> Result<(), String> {
    let c = conn(store)?;
    let n = c
        .execute(
            "UPDATE axiom_versions SET decision_id=?2 WHERE id=?1",
            rusqlite::params![version_id, decision_id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no version {version_id}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The finding register — append-only, never deleted
// ---------------------------------------------------------------------------

pub fn put_findings(store: &Store, findings: &[AxiomFinding]) -> Result<(), String> {
    let mut c = conn(store)?;
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let recorded_at = now_ms();
    for f in findings {
        if !SEVERITIES.contains(&f.severity.as_str()) {
            return Err(format!("unknown severity '{}'", f.severity));
        }
        if !ROOT_CAUSES.contains(&f.root_cause.as_str()) {
            return Err(format!("unknown root cause '{}'", f.root_cause));
        }
        let evidence = serde_json::to_string(&f.evidence).map_err(|e| e.to_string())?;
        // Re-recording a finding is a no-op rather than an error: the engine re-diagnoses the same
        // history on every pass, and a finding that keeps recurring is the same finding. Its
        // `occurrences` count is what moves, and that is carried by the newest row for the id.
        tx.execute(
            "INSERT INTO axiom_findings
               (id, detector, title, severity, root_cause, rationale, differential, evidence,
                occurrences, metric, recorded_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(id) DO UPDATE SET
               occurrences=excluded.occurrences, evidence=excluded.evidence,
               recorded_at=excluded.recorded_at, rationale=excluded.rationale,
               root_cause=excluded.root_cause, differential=excluded.differential",
            rusqlite::params![
                f.id,
                f.detector,
                f.title,
                f.severity,
                f.root_cause,
                f.rationale,
                f.differential as i64,
                evidence,
                f.occurrences,
                f.metric,
                recorded_at
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_findings(store: &Store, limit: usize) -> Result<Vec<AxiomFinding>, String> {
    let c = conn(store)?;
    let mut stmt = c
        .prepare(
            "SELECT id, detector, title, severity, root_cause, rationale, differential, evidence,
                    occurrences, metric, recorded_at
             FROM axiom_findings ORDER BY recorded_at DESC, id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit as i64], |r| {
            let evidence: String = r.get(7)?;
            Ok(AxiomFinding {
                id: r.get(0)?,
                detector: r.get(1)?,
                title: r.get(2)?,
                severity: r.get(3)?,
                root_cause: r.get(4)?,
                rationale: r.get(5)?,
                differential: r.get::<_, i64>(6)? != 0,
                evidence: serde_json::from_str(&evidence).unwrap_or_default(),
                occurrences: r.get(8)?,
                metric: r.get(9)?,
                recorded_at: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Eval results and decisions — documents the engine reads back whole
// ---------------------------------------------------------------------------

/// Store a result, refusing an id that is already taken. Same rule as `put_version` and for the same
/// reason: a measurement is what makes two configurations comparable, so a second one arriving under
/// an existing id is either a duplicate write the caller should not have made or a different number
/// wearing the first one's identity. Both are worth an error rather than a quiet no-op.
pub fn put_suite_result(store: &Store, r: &SuiteResult) -> Result<(), String> {
    let tasks = write_array(&r.tasks, "tasks")?;
    let summaries = write_array(&r.attempt_summaries, "attemptSummaries")?;
    let c = conn(store)?;
    refuse_taken_id(
        &c,
        "axiom_suite_results",
        &r.id,
        "suite result",
        "the stored number is what makes two configurations comparable",
    )?;
    c.execute(
        "INSERT INTO axiom_suite_results
           (id, suite_id, version_id, model, started_at, ended_at, repeats, pass_rate,
            prompt_tokens, completion_tokens, tasks, attempt_summaries)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        rusqlite::params![
            r.id,
            r.suite_id,
            r.version_id,
            r.model,
            r.started_at,
            r.ended_at,
            r.repeats,
            r.pass_rate,
            r.cost.prompt_tokens,
            r.cost.completion_tokens,
            tasks,
            summaries
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// A stored result as a JSON object in the engine's own shape, so the webview can hand it straight
/// to `benchmark` without a mapping layer that could drift from the type it maps to.
pub fn list_suite_results(
    store: &Store,
    suite_id: Option<&str>,
    version_id: Option<&str>,
) -> Result<Vec<serde_json::Value>, String> {
    let c = conn(store)?;
    // `?1 IS NULL OR ...` rather than a WHERE clause assembled from the arguments. Building the SQL
    // out of the options means the placeholder count has to be kept in step with the parameter list
    // by hand, and the two fall apart the moment one filter is absent and the other is not.
    let mut stmt = c
        .prepare(
            "SELECT id, suite_id, version_id, model, started_at, ended_at, repeats, pass_rate,
                    prompt_tokens, completion_tokens, tasks, attempt_summaries
             FROM axiom_suite_results
             WHERE (?1 IS NULL OR suite_id=?1) AND (?2 IS NULL OR version_id=?2)
             ORDER BY started_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![suite_id, version_id], |r| {
            let tasks: String = r.get(10)?;
            let summaries: String = r.get(11)?;
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "suiteId": r.get::<_, String>(1)?,
                "versionId": r.get::<_, String>(2)?,
                "model": r.get::<_, String>(3)?,
                "startedAt": r.get::<_, i64>(4)?,
                "endedAt": r.get::<_, i64>(5)?,
                "repeats": r.get::<_, i64>(6)?,
                "passRate": r.get::<_, f64>(7)?,
                "cost": {
                    "promptTokens": r.get::<_, i64>(8)?,
                    "completionTokens": r.get::<_, i64>(9)?,
                },
                "tasks": tasks,
                "attemptSummaries": summaries,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let mut v = row.map_err(|e| e.to_string())?;
        // The two document columns came back as strings; parse them into the arrays they hold, so
        // the webview receives one JSON tree rather than a tree with JSON embedded in it.
        let obj = v.as_object_mut().ok_or("a suite result row is not an object")?;
        for key in ["tasks", "attemptSummaries"] {
            let raw =
                obj.remove(key).and_then(|x| x.as_str().map(String::from)).unwrap_or_default();
            obj.insert(key.to_string(), read_array(raw, key)?);
        }
        out.push(v);
    }
    Ok(out)
}

pub fn put_decision(store: &Store, d: &Decision) -> Result<(), String> {
    if d.decision != "promote" && d.decision != "reject" {
        return Err(format!("unknown decision '{}'", d.decision));
    }
    let checks = write_array(&d.checks, "checks")?;
    let roles = write_array(&d.roles, "roles")?;
    let deltas = write_array(&d.deltas, "deltas")?;
    let c = conn(store)?;
    refuse_taken_id(
        &c,
        "axiom_decisions",
        &d.id,
        "decision",
        "a version's `decision_id` points at exactly one verdict",
    )?;
    c.execute(
        "INSERT INTO axiom_decisions
           (id, candidate_id, baseline_id, model, decided_at, decision, checks, roles, deltas)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        rusqlite::params![
            d.id,
            d.candidate_id,
            d.baseline_id,
            d.model,
            d.decided_at,
            d.decision,
            checks,
            roles,
            deltas
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_decisions(store: &Store, limit: usize) -> Result<Vec<serde_json::Value>, String> {
    let c = conn(store)?;
    let mut stmt = c
        .prepare(
            "SELECT id, candidate_id, baseline_id, model, decided_at, decision, checks, roles, deltas
             FROM axiom_decisions ORDER BY decided_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit as i64], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "candidateId": r.get::<_, String>(1)?,
                "baselineId": r.get::<_, String>(2)?,
                "model": r.get::<_, String>(3)?,
                "decidedAt": r.get::<_, i64>(4)?,
                "decision": r.get::<_, String>(5)?,
                "checks": r.get::<_, String>(6)?,
                "roles": r.get::<_, String>(7)?,
                "deltas": r.get::<_, String>(8)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let mut v = row.map_err(|e| e.to_string())?;
        let obj = v.as_object_mut().ok_or("a decision row is not an object")?;
        for key in ["checks", "roles", "deltas"] {
            let raw =
                obj.remove(key).and_then(|x| x.as_str().map(String::from)).unwrap_or_default();
            obj.insert(key.to_string(), read_array(raw, key)?);
        }
        out.push(v);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Audit passes — the ledger of attempts, one row each
// ---------------------------------------------------------------------------

/// Append one audit pass. Same refusal as `put_version`: an id already taken is a caller bug worth
/// an error, because a pass that re-ran after a failure is a *new* record, not an edit of the old
/// one — the failed attempt is evidence.
pub fn put_audit(store: &Store, a: &AuditPass) -> Result<(), String> {
    if !AUDIT_STATUSES.contains(&a.status.as_str()) {
        return Err(format!("unknown audit status '{}'", a.status));
    }
    if let Some(d) = &a.decision {
        if d != "promote" && d != "reject" {
            return Err(format!("unknown decision '{}'", d));
        }
    }
    let report = serde_json::to_string(&a.report).map_err(|e| e.to_string())?;
    let c = conn(store)?;
    refuse_taken_id(&c, "axiom_audits", &a.id, "audit pass", "a re-run is a new record, not an edit")?;
    c.execute(
        "INSERT INTO axiom_audits
           (id, started_at, ended_at, status, suite_id, model, repeats, decision,
            candidate_id, baseline_id, report)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        rusqlite::params![
            a.id,
            a.started_at,
            a.ended_at,
            a.status,
            a.suite_id,
            a.model,
            a.repeats,
            a.decision,
            a.candidate_id,
            a.baseline_id,
            report
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_audits(store: &Store, limit: usize) -> Result<Vec<serde_json::Value>, String> {
    let c = conn(store)?;
    let mut stmt = c
        .prepare(
            "SELECT id, started_at, ended_at, status, suite_id, model, repeats, decision,
                    candidate_id, baseline_id, report
             FROM axiom_audits ORDER BY started_at DESC, id DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit as i64], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "startedAt": r.get::<_, i64>(1)?,
                "endedAt": r.get::<_, i64>(2)?,
                "status": r.get::<_, String>(3)?,
                "suiteId": r.get::<_, Option<String>>(4)?,
                "model": r.get::<_, Option<String>>(5)?,
                "repeats": r.get::<_, Option<i64>>(6)?,
                "decision": r.get::<_, Option<String>>(7)?,
                "candidateId": r.get::<_, Option<String>>(8)?,
                "baselineId": r.get::<_, Option<String>>(9)?,
                "report": r.get::<_, String>(10)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let mut v = row.map_err(|e| e.to_string())?;
        let obj = v.as_object_mut().ok_or("an audit row is not an object")?;
        let raw = obj.remove("report").and_then(|x| x.as_str().map(String::from)).unwrap_or_default();
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
        obj.insert("report".to_string(), doc);
        out.push(v);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Traces — the agent's own history, in the shape the engine reads
// ---------------------------------------------------------------------------

/// A run and its steps, assembled into one object. `agent_runs` and `agent_steps` are two tables
/// because a run is written as it happens; the engine wants a transcript, so the join happens here
/// rather than in the webview.
pub fn traces(
    store: &Store,
    limit: usize,
    session_id: Option<&str>,
) -> Result<Vec<serde_json::Value>, String> {
    traces_filtered(store, limit, session_id, None)
}

/// One run by id. Filters in SQL rather than reading every run and picking one out: the autopsy is
/// opened on a single run, and a scan that grows with the history would make the screen slower the
/// longer the app is used.
pub fn trace(store: &Store, run_id: &str) -> Result<Option<serde_json::Value>, String> {
    Ok(traces_filtered(store, 1, None, Some(run_id))?.pop())
}

fn traces_filtered(
    store: &Store,
    limit: usize,
    session_id: Option<&str>,
    run_id: Option<&str>,
) -> Result<Vec<serde_json::Value>, String> {
    let c = conn(store)?;
    // One statement, every shape. The alternative — assembling the WHERE out of the arguments — has
    // to keep each SQL string's placeholder count in step with the parameter list, and the two fall
    // apart the moment one filter is absent and another is not.
    let sql = "SELECT id, session_id, parent_run_id, model, status, prompt, iterations,
                      started_at, ended_at, error, prompt_tokens, completion_tokens
               FROM agent_runs
               WHERE (?2 IS NULL OR session_id=?2) AND (?3 IS NULL OR id=?3)
               ORDER BY started_at DESC LIMIT ?1";
    let mut stmt = c.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![limit as i64, session_id, run_id], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "sessionId": r.get::<_, Option<String>>(1)?,
                "parentRunId": r.get::<_, Option<String>>(2)?,
                "model": r.get::<_, String>(3)?,
                "status": r.get::<_, String>(4)?,
                "prompt": r.get::<_, Option<String>>(5)?,
                "iterations": r.get::<_, i64>(6)?,
                "startedAt": r.get::<_, i64>(7)?,
                "endedAt": r.get::<_, Option<i64>>(8)?,
                "error": r.get::<_, Option<String>>(9)?,
                "promptTokens": r.get::<_, i64>(10)?,
                "completionTokens": r.get::<_, i64>(11)?,
            }))
        })
        .map_err(|e| e.to_string())?;

    let mut step_stmt = c
        .prepare("SELECT seq, kind, label, detail, ok, ts FROM agent_steps WHERE run_id=?1 ORDER BY seq ASC")
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows {
        let mut v = row.map_err(|e| e.to_string())?;
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let steps: Vec<serde_json::Value> = {
            let mapped = step_stmt
                .query_map([&id], |r| {
                    Ok(serde_json::json!({
                        "seq": r.get::<_, i64>(0)?,
                        "kind": r.get::<_, String>(1)?,
                        "label": r.get::<_, Option<String>>(2)?,
                        "detail": r.get::<_, Option<String>>(3)?,
                        "ok": r.get::<_, Option<i64>>(4)?.map(|n| n != 0),
                        "ts": r.get::<_, i64>(5)?,
                    }))
                })
                .map_err(|e| e.to_string())?;
            mapped.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        let obj = v.as_object_mut().ok_or("a run row is not an object")?;
        obj.insert("steps".to_string(), serde_json::Value::Array(steps));
        // `agent_runs` has no version column, so a production run cannot say which configuration
        // produced it. Null is the honest value; the engine reports the gap rather than guessing.
        obj.insert("versionId".to_string(), serde_json::Value::Null);
        out.push(v);
    }
    Ok(out)
}

#[cfg(test)]
mod axiom_tests {
    use super::*;

    fn temp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-axiom-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir).unwrap(), dir)
    }

    fn v(id: &str, parent: Option<&str>, state: &str) -> AxiomVersion {
        AxiomVersion {
            id: id.into(),
            parent_id: parent.map(String::from),
            created_at: 1,
            config: default_config(),
            reason: "because".into(),
            targets_finding_ids: vec!["f1".into()],
            evidence: vec![Evidence {
                run_id: "r1".into(),
                steps: vec![4],
                note: "the claim".into(),
            }],
            state: state.into(),
            decision_id: None,
        }
    }

    #[test]
    fn a_version_round_trips_with_its_config_and_evidence() {
        let (s, d) = temp_store("roundtrip");
        let mut original = v("v1", None, "candidate");
        original.config.prompt_override =
            Some("You are an agent.\n\n[axiom:premature-success]\nCheck first.".into());
        original.config.loop_params.verification_nudge_max = 2;
        put_version(&s, &original).unwrap();
        let back = get_version(&s, "v1").unwrap().expect("stored");
        assert_eq!(back, original);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_version_cannot_be_overwritten_because_a_measurement_is_keyed_to_it() {
        let (s, d) = temp_store("immutable");
        put_version(&s, &v("v1", None, "candidate")).unwrap();
        let mut changed = v("v1", None, "candidate");
        changed.reason = "a different reason".into();
        let err = put_version(&s, &changed).unwrap_err();
        assert!(err.contains("immutable"), "{err}");
        assert_eq!(get_version(&s, "v1").unwrap().unwrap().reason, "because");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn promoting_one_version_retires_the_previous_one_in_the_same_step() {
        let (s, d) = temp_store("oneactive");
        put_version(&s, &v("v1", None, "active")).unwrap();
        put_version(&s, &v("v2", Some("v1"), "candidate")).unwrap();
        set_state(&s, "v2", "active").unwrap();
        assert_eq!(active_version(&s).unwrap().unwrap().id, "v2");
        assert_eq!(get_version(&s, "v1").unwrap().unwrap().state, "retired");
        assert_eq!(list_versions(&s).unwrap().len(), 2, "the retired version is kept, not deleted");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unknown_state_or_id_is_refused_rather_than_stored() {
        let (s, d) = temp_store("vocab");
        assert!(put_version(&s, &v("v1", None, "promoted")).is_err());
        put_version(&s, &v("v1", None, "candidate")).unwrap();
        assert!(set_state(&s, "v1", "promoted").is_err());
        assert!(set_state(&s, "nope", "active").is_err());
        assert!(link_decision(&s, "nope", "d1").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_active_config_falls_back_to_the_built_in_defaults_when_nothing_is_promoted() {
        let (s, d) = temp_store("fallback");
        let a = active_config(&s).unwrap();
        assert_eq!(a.version_id, None);
        assert_eq!(a.config.prompt_override, None);
        assert_eq!(a.config.loop_params, DEFAULT_LOOP);
        put_version(&s, &v("v1", None, "active")).unwrap();
        assert_eq!(active_config(&s).unwrap().version_id.as_deref(), Some("v1"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn re_recording_a_finding_updates_its_count_instead_of_duplicating_it() {
        let (s, d) = temp_store("findings");
        let f = AxiomFinding {
            id: "f1".into(),
            detector: "premature-success".into(),
            title: "Claimed completion with no check".into(),
            severity: "critical".into(),
            root_cause: "prompt".into(),
            rationale: "one model, three runs".into(),
            differential: false,
            evidence: vec![Evidence { run_id: "r1".into(), steps: vec![4], note: "n".into() }],
            occurrences: 3,
            metric: Some("verificationCalls".into()),
            recorded_at: 10,
        };
        put_findings(&s, std::slice::from_ref(&f)).unwrap();
        // `recorded_at: 20` is in the payload and deliberately not in the row: the host stamps the
        // time a finding was observed, because a webview's clock is not a fact about this database.
        let again = AxiomFinding { occurrences: 5, recorded_at: 20, ..f.clone() };
        put_findings(&s, &[again]).unwrap();
        let all = list_findings(&s, 10).unwrap();
        assert_eq!(all.len(), 1, "the same finding is one row, not two");
        assert_eq!(all[0].occurrences, 5);
        assert!(
            all[0].recorded_at > 1_700_000_000_000,
            "stamped on write, got {}",
            all[0].recorded_at
        );
        assert!(put_findings(&s, &[AxiomFinding { severity: "apocalyptic".into(), ..f }]).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_finding_arrives_in_the_engines_own_shape_with_no_timestamp_to_send() {
        // The wire contract, pinned. The engine's `Finding` has no `recordedAt` field and these
        // structs are `deny_unknown_fields`, so a required field the caller cannot supply is a hard
        // failure at the boundary — and the failure lands at runtime in the webview, not at compile
        // time here, which is exactly the kind of drift a test has to hold.
        let (s, d) = temp_store("wire");
        let payload = serde_json::json!([{
            "id": "f1",
            "detector": "premature-success",
            "title": "Claimed completion with no check",
            "severity": "critical",
            "rootCause": "prompt",
            "rationale": "one model, three runs",
            "differential": false,
            "evidence": [{ "runId": "r1", "steps": [4], "note": "n" }],
            "occurrences": 3,
            "metric": "verificationCalls"
        }]);
        let parsed: Vec<AxiomFinding> =
            serde_json::from_value(payload).expect("the engine's Finding deserializes as-is");
        put_findings(&s, &parsed).unwrap();
        let all = list_findings(&s, 10).unwrap();
        assert_eq!(all[0].root_cause, "prompt");
        assert_eq!(all[0].evidence[0].run_id, "r1");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_suite_result_comes_back_as_one_json_tree_the_engine_can_read() {
        let (s, d) = temp_store("results");
        let result = |id: &str, tasks: serde_json::Value| SuiteResult {
            id: id.into(),
            suite_id: "s1".into(),
            version_id: "builtin".into(),
            model: "m".into(),
            started_at: 1,
            ended_at: 2,
            repeats: 3,
            tasks,
            attempt_summaries: serde_json::json!([{ "taskId": "t1", "repeat": 0, "passed": false }]),
            pass_rate: 0.0,
            cost: Cost { prompt_tokens: 100, completion_tokens: 20 },
        };
        put_suite_result(
            &s,
            &result(
                "sr1",
                serde_json::json!([{ "taskId": "t1", "capability": "editing", "passRate": 0.0 }]),
            ),
        )
        .unwrap();
        let all = list_suite_results(&s, Some("s1"), None).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["suiteId"], "s1");
        assert_eq!(all[0]["cost"]["promptTokens"], 100);
        assert!(
            all[0]["tasks"].is_array(),
            "the document column is parsed, not passed through as a string"
        );
        assert_eq!(all[0]["attemptSummaries"][0]["passed"], false);
        assert!(list_suite_results(&s, Some("other"), None).unwrap().is_empty());
        assert!(list_suite_results(&s, None, Some("v9")).unwrap().is_empty());
        // A scalar where an array belongs is a writer bug, and storing it would hide the loss.
        assert!(put_suite_result(&s, &result("sr2", serde_json::json!({}))).is_err());
        // The write shape is the read shape: what came back deserializes into the same struct.
        let back: SuiteResult =
            serde_json::from_value(all[0].clone()).expect("same shape both ways");
        assert_eq!(back.cost.prompt_tokens, 100);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_decision_keeps_the_checks_roles_and_deltas_it_was_made_from() {
        let (s, d) = temp_store("decisions");
        let decision = |id: &str, verdict: &str| Decision {
            id: id.into(),
            candidate_id: "v2".into(),
            baseline_id: "v1".into(),
            model: "m".into(),
            decided_at: 5,
            decision: verdict.into(),
            checks: serde_json::json!([{ "id": "no-task-regression", "passed": false }]),
            roles: serde_json::json!([{ "role": "verifier", "approve": false, "objections": ["x"] }]),
            deltas: serde_json::json!([{ "metric": "passRate", "delta": 0.5 }]),
        };
        put_decision(&s, &decision("d1", "reject")).unwrap();
        let all = list_decisions(&s, 10).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["decision"], "reject");
        assert_eq!(all[0]["checks"][0]["passed"], false);
        assert_eq!(all[0]["roles"][0]["role"], "verifier");
        assert!(put_decision(&s, &decision("d2", "maybe")).is_err());
        let back: Decision = serde_json::from_value(all[0].clone()).expect("same shape both ways");
        assert_eq!(back.candidate_id, "v2");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_trace_is_its_run_and_its_steps_joined() {
        let (s, d) = temp_store("traces");
        crate::core::orchestrator::start(
            &s,
            "r1".into(),
            Some("s1".into()),
            None,
            "m".into(),
            Some("do it".into()),
        )
        .unwrap();
        crate::core::orchestrator::step(
            &s,
            "r1",
            "tool_call".into(),
            Some("read_file".into()),
            None,
            None,
        )
        .unwrap();
        crate::core::orchestrator::step(
            &s,
            "r1",
            "tool_result".into(),
            Some("read_file".into()),
            Some("ok".into()),
            Some(true),
        )
        .unwrap();
        crate::core::orchestrator::finish(&s, "r1", "ok".into(), 2, None, 10, 5).unwrap();

        let all = traces(&s, 10, None).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["status"], "ok");
        assert_eq!(all[0]["promptTokens"], 10);
        assert_eq!(all[0]["steps"].as_array().unwrap().len(), 2);
        assert_eq!(all[0]["steps"][0]["kind"], "tool_call");
        assert_eq!(all[0]["steps"][1]["ok"], true);
        assert!(
            all[0]["versionId"].is_null(),
            "a production run cannot say which configuration produced it"
        );

        assert_eq!(traces(&s, 10, Some("s1")).unwrap().len(), 1);
        assert!(traces(&s, 10, Some("other")).unwrap().is_empty());
        assert!(trace(&s, "r1").unwrap().is_some());
        assert!(trace(&s, "nope").unwrap().is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    fn audit(id: &str, status: &str) -> AuditPass {
        AuditPass {
            id: id.into(),
            started_at: 100,
            ended_at: 200,
            status: status.into(),
            suite_id: Some("suite-1".into()),
            model: Some("m".into()),
            repeats: Some(2),
            decision: None,
            candidate_id: None,
            baseline_id: None,
            report: serde_json::json!({ "runsExamined": 3, "runsClean": 2 }),
        }
    }

    #[test]
    fn an_audit_pass_comes_back_as_one_json_tree_with_its_report_parsed() {
        let (s, d) = temp_store("audits");
        let mut pass = audit("a1", "completed");
        pass.decision = Some("promote".into());
        pass.candidate_id = Some("v2".into());
        pass.baseline_id = Some("v1".into());
        pass.report = serde_json::json!({
            "runsExamined": 6, "totalHits": 2,
            "notDone": ["the candidate did not beat the noise floor"],
        });
        put_audit(&s, &pass).unwrap();

        // A refused pass: the fields it never learned stay null, and its report is the error.
        let refused = audit("a2", "refused");
        put_audit(&s, &refused).unwrap();

        let all = list_audits(&s, 10).unwrap();
        assert_eq!(all.len(), 2);
        // Newest first — the ledger is read top-down.
        assert_eq!(all[0]["id"], "a2");
        assert!(all[0]["decision"].is_null());
        assert_eq!(all[0]["report"], serde_json::json!({ "runsExamined": 3, "runsClean": 2 }));
        assert_eq!(all[1]["id"], "a1");
        assert_eq!(all[1]["decision"], "promote");
        assert_eq!(all[1]["candidateId"], "v2");
        assert_eq!(all[1]["report"]["totalHits"], 2, "the report is parsed, not a JSON string");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_audit_pass_cannot_be_overwritten_and_a_rerun_is_a_second_record() {
        let (s, d) = temp_store("audit-append");
        put_audit(&s, &audit("a1", "failed")).unwrap();
        let err = put_audit(&s, &audit("a1", "completed")).unwrap_err();
        assert!(err.contains("new record"), "{err}");
        assert_eq!(list_audits(&s, 10).unwrap()[0]["status"], "failed");

        put_audit(&s, &audit("a2", "completed")).unwrap();
        assert_eq!(list_audits(&s, 10).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unknown_audit_status_or_decision_is_refused_rather_than_stored() {
        let (s, d) = temp_store("audit-vocab");
        assert!(put_audit(&s, &audit("a1", "promoted")).is_err());
        assert!(put_audit(&s, &audit("a1", "completed")).is_ok());
        let mut bad = audit("a1b", "completed");
        bad.decision = Some("maybe".into());
        assert!(put_audit(&s, &bad).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
