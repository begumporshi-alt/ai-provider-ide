/**
 * Memory — the producer the context graph's `memory` node kind has been waiting for.
 *
 * The model is four layers, borrowed from TencentDB Agent Memory (MIT):
 *
 *   L0  raw conversation    every turn, verbatim
 *   L1  atoms               facts, preferences, constraints distilled out of L0
 *   L2  scenarios           knowledge blocks grouped around a subject
 *   L3  core                stable long-term profile
 *
 * The point of layering is retrieval granularity. A flat memory store has to guess how much
 * to hand back; a layered one can answer "restore my working context" from L2/L3 and "what
 * exactly did I say" from L0. Concretely: new recall goes to the abstract layers first because
 * they are small and cheap, and falls back to L0/L1 when the question is about specifics.
 *
 * Retrieval is BM25 through SQLite FTS5, not embeddings. That is deliberate and it is the
 * reason this fits a local-first app: no embedding model, no vector index, no second process.
 * FTS5 is compiled into the bundled SQLite (libsqlite3-sys sets -DSQLITE_ENABLE_FTS5), so the
 * whole feature costs one migration and no new dependencies.
 */
use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::store::Store;

pub const LAYERS: [&str; 4] = ["L0", "L1", "L2", "L3"];

/// A memory is a fact, not a document. Longer text is truncated on capture rather than
/// rejected — losing the tail of an overlong turn is better than refusing to remember it.
const MAX_TEXT: usize = 8000;

/// Cap on how many query tokens reach FTS5. Bounds the work a pathological query can ask for.
const MAX_QUERY_TOKENS: usize = 32;

/// Recency half-life, in days. A memory this old counts half as much as one written today, two
/// half-lives a quarter, and so on.
const RECENCY_HALF_LIFE_DAYS: f64 = 30.0;

/// How much worse than the best match still counts as "comparable", as a fraction of the best
/// match's own score. Anything within this of the top hit is treated as an equally good answer,
/// and recency decides between those.
///
/// Measured from the best hit rather than from the spread of the candidate set. A spread-relative
/// band degenerates exactly when the set is small: with two candidates the two extremes are the
/// whole spread, so they always land in different bands and recency never fires. Two or three
/// candidates is the common case for a real recall query.
///
/// A band rather than a blend, deliberately. Blending relevance and recency into one number would
/// stop the displayed bm25 scores being monotonic, so a correctly-ranked list would look like a
/// broken one — the number on each row is the match, and it should stay readable as such.
///
/// This is a tuned default, not a measured optimum — there is no ground truth for "the right
/// memory" to measure against. It is a named constant so it can be moved once there is.
const RELEVANCE_BAND: f64 = 0.15;

/// How many times `limit` candidates to pull from FTS5 before re-ranking. Recency can only
/// reorder what it is shown, so the shortlist has to be wider than the answer.
const CANDIDATE_FACTOR: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Memory {
    pub id: String,
    /// One of `LAYERS`.
    pub layer: String,
    pub text: String,
    pub session_id: Option<String>,
    /// Optional grouping key — for L2 this is the scenario name, for L0 the role.
    pub subject: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub pinned: bool,
    /// Where this memory may be injected. Every row starts `Unscoped`, which is **capture-only and
    /// never injected** — see `ScopeAssignment`.
    #[serde(default)]
    pub scope: MemoryScope,
    /// BM25 score, populated by `recall` only. More negative is a better match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    /// §6.4.3: when this row was superseded by a newer one, or `NULL` while it is live.
    ///
    /// A superseded row is **kept, not deleted** — a reversal is recoverable and the Context graph's
    /// edges stay valid — but it drops out of recall immediately. Only `supersede` sets it, and
    /// only `unsupersede` clears it; pruning never touches it.
    #[serde(default)]
    pub superseded_at: Option<i64>,
}

/// The scope a memory is bound to. Mirrors `context_scope::Scope`, minus `session`: a session is a
/// correlation key, not a boundary, so it never gates injection.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryScope {
    pub user: String,
    pub project: Option<String>,
    pub agent: Option<String>,
    /// Set on purpose, never by default. `true` makes the row visible to every scope.
    pub global: bool,
}

// Whether a row is injectable is decided by one SQL predicate —
// `scope_global = 1 OR scope_project IS NOT NULL` — shared by `recall_scoped` and
// `MemoryStats::injectable`. Deliberately not duplicated as a Rust method: a second source of
// truth for "may this be injected" is exactly the kind of drift this design is guarding against.

/// How a memory gets bound. There is deliberately no variant that means "global by omission" —
/// three independent reviewers flagged nullable-means-global as a contamination engine, because the
/// header-less IDE is the common case and would otherwise degrade to global.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeAssignment {
    /// Injectable inside one project. `agent: None` means project-wide; `Some` narrows it to that
    /// agent only.
    Project { project: String, agent: Option<String> },
    /// Injectable everywhere. A deliberate act, not a default.
    Global,
    /// Not injectable anywhere. Capture-only — the state every row is born in.
    Unscoped,
}

/// A memory as the webview submits it.
///
/// **Field names are snake_case on the wire — there is no `rename_all` here, deliberately.**
/// `MemoryInput` is the write half of a pair whose read half is `Memory` (below), which also carries
/// no `rename_all` and therefore serialises as `session_id`. The webview's own `Memory` type matches
/// that, as do this struct's siblings in the same subsystem — `ContextNode.session_id`,
/// `ContextEdge.from_id`/`to_id`. A DTO and its read struct must agree on one spelling: two spellings
/// for the same `session_id` is a defect waiting for whoever next joins a memory row to a context
/// node. (The `persist::*` registry rows are camelCase and that is fine — they are symmetric
/// read+write rows, which is exactly why passing a webview record through unchanged works there.)
///
/// `deny_unknown_fields` is the other half of the fix and is **not** cosmetic. Serde's default is to
/// *ignore* an unknown key, so a misspelled field does not error — it silently becomes `None`. That is
/// precisely how `memory_capture_batch` dropped `sessionId` for months: every L0 row written through
/// `rememberTurn` landed with `session_id = NULL`, which in turn disabled the per-session ring cap in
/// `prune` (it is guarded by `session_id IS NOT NULL`). With this attribute a wrong spelling is a hard
/// error at the boundary rather than a silent null, and
/// `capture_input_rejects_the_camel_case_spelling` pins that.
///
/// The consumer (`engine.ts`) still swallows a capture failure on purpose — a memory write must never
/// fail a chat — so it *logs* rather than rethrowing. Detection lives here; visibility lives there.
/// Both are required: without this attribute the consumer's catch never even fires.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryInput {
    pub layer: String,
    pub text: String,
    pub session_id: Option<String>,
    pub subject: Option<String>,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct MemoryStats {
    pub l0: i64,
    pub l1: i64,
    pub l2: i64,
    pub l3: i64,
    pub total: i64,
    pub bytes: i64,
    /// How many rows can actually be injected — bound to a project, or explicitly global.
    ///
    /// Everything else is capture-only. This is the number that answers "why didn't the model know
    /// anything": if it is 0, the read path is correctly returning nothing because there is nothing
    /// scoped, not because recall is broken.
    pub injectable: i64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn valid_layer(l: &str) -> bool {
    LAYERS.contains(&l)
}

fn clamp_text(s: &str) -> String {
    if s.chars().count() <= MAX_TEXT {
        s.to_string()
    } else {
        let head: String = s.chars().take(MAX_TEXT - 1).collect();
        format!("{head}…")
    }
}

/**
 * Turn arbitrary user input into an FTS5 MATCH expression that cannot be malformed.
 *
 * FTS5's query syntax is its own language — a stray quote or a bare `*` is a syntax error,
 * and a syntax error surfaces as a failed recall rather than as zero results. So the query is
 * never passed through: it is tokenised on non-alphanumerics, each token is quoted, and the
 * tokens are OR-ed. That loses phrase and proximity operators, which is an acceptable trade
 * for a recall that cannot throw.
 */
fn match_expr(query: &str) -> Option<String> {
    let tokens: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .take(MAX_QUERY_TOKENS)
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" OR "))
    }
}

/// Record one memory. Re-recording identical `(layer, text)` refreshes the timestamp instead
/// of inserting — extraction runs repeatedly over overlapping turns and would otherwise
/// accumulate the same atom once per run.
pub fn capture(store: &Store, input: &MemoryInput) -> Result<Memory, String> {
    if !valid_layer(&input.layer) {
        return Err(format!(
            "unknown memory layer '{}' (expected one of {})",
            input.layer,
            LAYERS.join(", ")
        ));
    }
    let text = clamp_text(input.text.trim());
    if text.is_empty() {
        return Err("memory text is empty".into());
    }
    let now = now_ms();
    let mut conn = store.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let existing: Option<(String, i64, i64, bool)> = tx
        .query_row(
            "SELECT id, created_at, updated_at, pinned FROM memories WHERE layer = ?1 AND text = ?2",
            params![input.layer, text],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0)),
        )
        .ok();

    let row = match existing {
        Some((id, created_at, _updated_at, pinned)) => {
            let keep_pinned = pinned || input.pinned;
            tx.execute(
                "UPDATE memories SET updated_at = ?1, pinned = ?2,
                        session_id = COALESCE(?3, session_id), subject = COALESCE(?4, subject)
                 WHERE id = ?5",
                params![now, keep_pinned as i64, input.session_id, input.subject, id],
            )
            .map_err(|e| e.to_string())?;
            // Re-recording refreshes text and timestamp but deliberately leaves scope alone — an
            // operator's decision about where a memory may be injected must survive a re-distill.
            // Read it back rather than assuming the default, or the review surface would show a
            // scoped row as unscoped.
            let scope = tx
                .query_row(
                    "SELECT scope_user, scope_project, scope_agent, scope_global
                     FROM memories WHERE id = ?1",
                    params![id],
                    |r| {
                        Ok(MemoryScope {
                            user: r.get(0)?,
                            project: r.get(1)?,
                            agent: r.get(2)?,
                            global: r.get::<_, i64>(3)? != 0,
                        })
                    },
                )
                .map_err(|e| e.to_string())?;
            Memory {
                id,
                layer: input.layer.clone(),
                text,
                session_id: input.session_id.clone(),
                subject: input.subject.clone(),
                created_at,
                updated_at: now,
                pinned: keep_pinned,
                scope,
                score: None,
                superseded_at: None,
            }
        }
        None => {
            let id = format!("m-{}-{}", input.layer, uuid_like());
            tx.execute(
                "INSERT INTO memories (id, layer, text, session_id, subject, created_at, updated_at, pinned)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    id,
                    input.layer,
                    text,
                    input.session_id,
                    input.subject,
                    now,
                    now,
                    input.pinned as i64
                ],
            )
            .map_err(|e| e.to_string())?;
            Memory {
                id,
                layer: input.layer.clone(),
                text,
                session_id: input.session_id.clone(),
                subject: input.subject.clone(),
                created_at: now,
                updated_at: now,
                pinned: input.pinned,
                // Born unscoped: capture-only, never injected. Scoping is a deliberate act
                // (`assign_scope`), never a default — see `ScopeAssignment`.
                scope: MemoryScope {
                    user: "local".into(),
                    project: None,
                    agent: None,
                    global: false,
                },
                score: None,
                superseded_at: None,
            }
        }
    };
    tx.commit().map_err(|e| e.to_string())?;
    Ok(row)
}

/// Record several memories in one transaction. Returns how many were written (a re-recording
/// counts, since it refreshed).
pub fn capture_batch(store: &Store, items: &[MemoryInput]) -> Result<usize, String> {
    for i in items {
        if !valid_layer(&i.layer) {
            return Err(format!("unknown memory layer '{}'", i.layer));
        }
    }
    let mut n = 0;
    for i in items {
        capture(store, i)?;
        n += 1;
    }
    Ok(n)
}

/// Exponential decay on age, in [0, 1]. Clamped at 0 for the future: a clock that moved backwards
/// should not make a memory rank as if it were written tomorrow.
fn recency(ts: i64, now: i64) -> f64 {
    let age_days = (now - ts).max(0) as f64 / 86_400_000.0;
    0.5f64.powf(age_days / RECENCY_HALF_LIFE_DAYS)
}

/// Distillation level as a sort key: at equal relevance and equal recency, the more distilled
/// layer is the better thing to put in a prompt.
fn layer_rank(layer: &str) -> u8 {
    match layer {
        "L3" => 0,
        "L2" => 1,
        "L1" => 2,
        _ => 3,
    }
}

/// Recency as a total order. Quantised to an integer because `f64` is not `Ord`, and a sort that
/// silently treats two candidates as equal is worse than one that rounds them.
///
/// L3 is exempt and always scores full recency. A core fact is core because the user wrote it
/// down, not because it is recent; decaying it would systematically bury the most stable thing
/// we know, which is the opposite of what the layer is for.
fn recency_key(m: &Memory, now: i64) -> i64 {
    if m.layer == "L3" {
        return 1000;
    }
    (recency(m.updated_at, now) * 1000.0).round() as i64
}

/// Re-rank FTS5 candidates by relevance band, then recency, then distillation level.
///
/// BM25 has no notion of time, so on an equal match a six-month-old atom outranks yesterday's.
/// This is the fix: relevance still decides, recency only breaks matches that are close enough to
/// be a coin toss. A clearly better match cannot be displaced — the bands are ordered first and
/// the worst candidate in a band always beats the best in the one below it.
fn rerank(rows: &mut Vec<Memory>, now: i64) {
    // `bm25()` is negative and more negative is a better match, so flip the sign to make
    // "bigger is better" true throughout.
    let rel: Vec<f64> = rows.iter().map(|m| -m.score.unwrap_or(0.0)).collect();
    let best = rel.iter().copied().fold(f64::NEG_INFINITY, f64::max);

    // Band 0 is "within RELEVANCE_BAND of the best match"; each step up is one band worse.
    let band = |i: usize| -> i64 {
        if best.abs() <= f64::EPSILON {
            // Degenerate scores (all zero): there is nothing to rank on, so let recency decide.
            0
        } else {
            (((best - rel[i]) / best.abs()) / RELEVANCE_BAND).floor() as i64
        }
    };

    let mut order: Vec<usize> = (0..rows.len()).collect();
    order.sort_by(|&a, &b| {
        // Band 0 is the best match, so bands sort ascending; recency and layer descend.
        band(a)
            .cmp(&band(b))
            .then(recency_key(&rows[b], now).cmp(&recency_key(&rows[a], now)))
            .then(layer_rank(&rows[a].layer).cmp(&layer_rank(&rows[b].layer)))
            // §5.5: the order ends on the row id, never on however SQLite happened to return the
            // rows. All three keys above can tie — same band, same quantised recency, same layer —
            // and when they do a stable sort silently defers to the query's own row order, which is
            // not specified and can change with the query plan. The composed block then differs
            // between two identical requests, which invalidates the provider's cached prefix on
            // every call. See `GATEWAY_MEMORY_LAYER.md` §5.5.
            .then(rows[a].id.cmp(&rows[b].id))
    });

    let taken: Vec<Memory> = order.into_iter().map(|i| rows[i].clone()).collect();
    *rows = taken;
}

/**
 * BM25 recall.
 *
 * Relevance decides; recency and distillation level break matches that are close. See `rerank`
 * for why recency is a tie-break rather than a weighted term.
 */
pub fn recall(
    store: &Store,
    query: &str,
    limit: usize,
    layers: Option<&[String]>,
) -> Result<Vec<Memory>, String> {
    recall_inner(store, query, limit, layers, None)
}

/// Which memories may be recalled for a request. Mirrors `context_scope::Scope`.
///
/// **Absence is not global.** Three independent reviewers of the gateway memory design flagged
/// nullable-means-global as a contamination engine: the header-less IDE is the common case, so a
/// missing project would otherwise degrade to "global" and leak one repo's context into another.
/// A row is reachable only through an explicit project match or an explicit `scope_global` mark —
/// and when the project cannot be resolved at all, only pinned global rows survive.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RecallScope {
    pub user: Option<String>,
    pub project: Option<String>,
    pub agent: Option<String>,
}

/// BM25 recall restricted to a scope. The gateway request path uses this; the Assistant's Memory
/// screen keeps using the unscoped `recall`, which sees everything.
pub fn recall_scoped(
    store: &Store,
    query: &str,
    limit: usize,
    layers: Option<&[String]>,
    scope: &RecallScope,
) -> Result<Vec<Memory>, String> {
    recall_inner(store, query, limit, layers, Some(scope))
}

fn recall_inner(
    store: &Store,
    query: &str,
    limit: usize,
    layers: Option<&[String]>,
    scope: Option<&RecallScope>,
) -> Result<Vec<Memory>, String> {
    let Some(expr) = match_expr(query) else {
        return Ok(Vec::new());
    };
    let wanted: Vec<&str> = match layers {
        Some(ls) => {
            for l in ls {
                if !valid_layer(l) {
                    return Err(format!("unknown memory layer '{l}'"));
                }
            }
            ls.iter().map(|s| s.as_str()).collect()
        }
        None => LAYERS.to_vec(),
    };

    // Scope predicates are appended after the layer placeholders, so their indices continue from
    // however many layers the caller asked for.
    let mut next_param = 3 + wanted.len();
    let mut scope_sql = String::new();
    let mut scope_args: Vec<String> = Vec::new();
    if let Some(sc) = scope {
        if let Some(u) = &sc.user {
            scope_sql.push_str(&format!(" AND m.scope_user = ?{next_param}"));
            scope_args.push(u.clone());
            next_param += 1;
        }
        match &sc.project {
            Some(p) => {
                // An agent-scoped row also matches when the agent is NULL (a project-wide fact),
                // and an explicitly global row always matches.
                scope_sql.push_str(&format!(
                    " AND (m.scope_global = 1 OR (m.scope_project = ?{next_param}"
                ));
                scope_args.push(p.clone());
                next_param += 1;
                if let Some(a) = &sc.agent {
                    scope_sql.push_str(&format!(
                        " AND (m.scope_agent IS NULL OR m.scope_agent = ?{next_param}))"
                    ));
                    scope_args.push(a.clone());
                    next_param += 1;
                } else {
                    scope_sql.push(')');
                }
                scope_sql.push(')');
            }
            // Unresolvable project: pinned global rows only. A client that cannot identify itself
            // gets its hard constraints and nothing else.
            None => scope_sql.push_str(" AND m.scope_global = 1 AND m.pinned = 1"),
        }
        let _ = next_param;
    }

    let placeholders: Vec<String> = (1..=wanted.len()).map(|i| format!("?{}", i + 2)).collect();
    // Fetch a wider shortlist than we intend to return: recency can only reorder what it is
    // shown, so pulling exactly `limit` would let the band logic reorder a set that was already
    // truncated on relevance alone. SQL order still decides *which* candidates those are.
    let fetch = limit.saturating_mul(CANDIDATE_FACTOR).max(limit);
    let sql = format!(
        "SELECT m.id, m.layer, m.text, m.session_id, m.subject, m.created_at, m.updated_at, m.pinned,
                m.scope_user, m.scope_project, m.scope_agent, m.scope_global,
                bm25(memories_fts) AS score
         FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ?1 AND m.layer IN ({}){scope_sql}
           -- §6.4.3: a superseded row is out of the live set the moment it is superseded. It is
           -- kept for audit and for a reversal, but injecting it would put a fact the operator has
           -- already replaced back into every prompt.
           AND m.superseded_at IS NULL
         -- §5.5: `m.id` is the last key for the same reason it is the last key in `rerank`, and
         -- matters more here — LIMIT truncates the shortlist, so without it *which* rows survive
         -- to be ranked at all would depend on the query plan.
         ORDER BY score, CASE m.layer WHEN 'L3' THEN 0 WHEN 'L2' THEN 1 WHEN 'L1' THEN 2 ELSE 3 END,
                  m.id
         LIMIT ?2",
        placeholders.join(",")
    );

    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut p: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(expr.clone())];
    p.push(Box::new(fetch as i64));
    for l in &wanted {
        p.push(Box::new(l.to_string()));
    }
    for a in &scope_args {
        p.push(Box::new(a.clone()));
    }
    let mut rows = stmt
        .query_map(rusqlite::params_from_iter(p.iter().map(|b| b.as_ref())), |r| {
            Ok(Memory {
                id: r.get(0)?,
                layer: r.get(1)?,
                text: r.get(2)?,
                session_id: r.get(3)?,
                subject: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                pinned: r.get::<_, i64>(7)? != 0,
                scope: MemoryScope {
                    user: r.get(8)?,
                    project: r.get(9)?,
                    agent: r.get(10)?,
                    global: r.get::<_, i64>(11)? != 0,
                },
                score: Some(r.get(12)?),
                superseded_at: None, // the WHERE clause already excluded them
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    drop(conn);

    rerank(&mut rows, now_ms());
    rows.truncate(limit);
    Ok(rows)
}

/// Newest first, no scoring. Pinned memories lead — they are the ones the operator said must
/// always be visible.
pub fn list(store: &Store, layer: Option<&str>, limit: usize) -> Result<Vec<Memory>, String> {
    if let Some(l) = layer {
        if !valid_layer(l) {
            return Err(format!("unknown memory layer '{l}'"));
        }
    }
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let (sql, args): (String, Vec<String>) = match layer {
        Some(l) => (
            "SELECT id, layer, text, session_id, subject, created_at, updated_at, pinned,
                    scope_user, scope_project, scope_agent, scope_global, superseded_at
             FROM memories WHERE layer = ?1
             ORDER BY pinned DESC, updated_at DESC LIMIT ?2"
                .into(),
            vec![l.to_string(), limit.to_string()],
        ),
        None => (
            "SELECT id, layer, text, session_id, subject, created_at, updated_at, pinned,
                    scope_user, scope_project, scope_agent, scope_global, superseded_at
             FROM memories
             ORDER BY pinned DESC, updated_at DESC LIMIT ?1"
                .into(),
            vec![limit.to_string()],
        ),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), |r| {
            Ok(Memory {
                id: r.get(0)?,
                layer: r.get(1)?,
                text: r.get(2)?,
                session_id: r.get(3)?,
                subject: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                pinned: r.get::<_, i64>(7)? != 0,
                scope: MemoryScope {
                    user: r.get(8)?,
                    project: r.get(9)?,
                    agent: r.get(10)?,
                    global: r.get::<_, i64>(11)? != 0,
                },
                score: None,
                superseded_at: r.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Drop one memory. Returns false when there was nothing to drop.
pub fn forget(store: &Store, id: &str) -> Result<bool, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute("DELETE FROM memories WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

// ---------- §6.2 retention ----------

/// L0 is verbatim conversation. Keeping it for ever is a size problem and a privacy one.
pub const L0_TTL_DAYS: i64 = 30;

/// Ring cap on L0 rows **per session**. The newest 200 turns survive; a single long conversation
/// cannot crowd out every other one.
pub const L0_RING_PER_SESSION: usize = 200;

/// Recency below which an L1/L2 atom is pruned. With the 30-day half-life this is ~4.3 half-lives:
/// an atom has to go roughly four months without being re-confirmed before it is dropped.
pub const PRUNE_FLOOR: f64 = 0.05;

/// Age in ms at which `recency()` has decayed to `PRUNE_FLOOR`. Derived from the two constants
/// rather than written down, so moving the half-life moves the cutoff with it.
fn prune_cutoff_ms() -> i64 {
    let half_lives = (1.0f64 / PRUNE_FLOOR).log2();
    (half_lives * RECENCY_HALF_LIFE_DAYS * 86_400_000.0) as i64
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct MemoryPruneStats {
    /// L0 rows past `L0_TTL_DAYS`.
    pub l0_expired: usize,
    /// L0 rows dropped by the per-session ring.
    pub l0_ring: usize,
    /// L1/L2 atoms whose recency had decayed below `PRUNE_FLOOR`.
    pub decayed: usize,
}

/// §6.2 retention for the `memories` table. Called on idle, never from the request path.
///
/// Two absolute exemptions, because both survive on the operator's say-so rather than on recency:
/// **pinned** and **L3**. Everything else is data this layer produced by itself and can unproduce —
/// an atom nobody has re-confirmed in four months is not a fact, it is a guess with a timestamp.
///
/// `DELETE` is safe against the FTS index: `memories_ad` fires per row.
pub fn prune(store: &Store) -> Result<MemoryPruneStats, String> {
    let mut stats = MemoryPruneStats::default();
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let now = now_ms();

    stats.l0_expired = conn
        .execute(
            "DELETE FROM memories WHERE layer = 'L0' AND pinned = 0 AND updated_at < ?1",
            params![now - L0_TTL_DAYS * 86_400_000],
        )
        .map_err(|e| e.to_string())?;

    // Newest N per session survive. A window function is the only readable way to express "per
    // session" — the correlated-subquery form is quadratic over every L0 row in the table.
    stats.l0_ring = conn
        .execute(
            "DELETE FROM memories
              WHERE layer = 'L0' AND pinned = 0 AND session_id IS NOT NULL
                AND rowid NOT IN (
                  SELECT rowid FROM (
                    SELECT rowid, ROW_NUMBER() OVER (
                      PARTITION BY session_id ORDER BY updated_at DESC, id
                    ) AS rn
                    FROM memories WHERE layer = 'L0' AND pinned = 0 AND session_id IS NOT NULL
                  ) WHERE rn <= ?1
                )",
            params![L0_RING_PER_SESSION as i64],
        )
        .map_err(|e| e.to_string())?;

    stats.decayed = conn
        .execute(
            "DELETE FROM memories WHERE layer IN ('L1','L2') AND pinned = 0 AND updated_at < ?1",
            params![now - prune_cutoff_ms()],
        )
        .map_err(|e| e.to_string())?;

    Ok(stats)
}

pub fn set_pinned(store: &Store, id: &str, pinned: bool) -> Result<bool, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE memories SET pinned = ?1, updated_at = ?2 WHERE id = ?3",
            params![pinned as i64, now_ms(), id],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Bind a memory to a scope. **This is the only way a row becomes injectable.**
///
/// Returns false when there is no such memory. Every assignment writes all three columns, so a row
/// can never keep a stale binding from the state it is leaving: promoting `Project` → `Global` or
/// demoting it to `Unscoped` both clear `scope_project` / `scope_agent`.
///
/// `scope_user` is not assignable — this is a single-user desktop app and every row is `local`.
pub fn assign_scope(store: &Store, id: &str, a: ScopeAssignment) -> Result<bool, String> {
    let (project, agent, global): (Option<String>, Option<String>, i64) = match a {
        ScopeAssignment::Project { project, agent } => {
            let project = project.trim();
            if project.is_empty() {
                return Err("project scope is empty".into());
            }
            let agent = agent.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            (Some(project.to_string()), agent, 0)
        }
        ScopeAssignment::Global => (None, None, 1),
        ScopeAssignment::Unscoped => (None, None, 0),
    };
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE memories SET scope_project = ?1, scope_agent = ?2, scope_global = ?3,
                    updated_at = ?4
             WHERE id = ?5",
            params![project, agent, global, now_ms(), id],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Rewrite the text of one memory. Layer is left alone — promotion is the caller's call, not
/// the store's. Used by the L3 core-profile editor in the Memory screen.
pub fn update(store: &Store, id: &str, text: &str) -> Result<bool, String> {
    let text = clamp_text(text.trim());
    if text.is_empty() {
        return Err("memory text is empty".into());
    }
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE memories SET text = ?1, updated_at = ?2 WHERE id = ?3",
            params![text, now_ms(), id],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Count and fetch atoms for one session — used by `distilScenarios` to decide when the next
/// scenario pass should fire and what to feed it. Sorted oldest-first so the model's window is
/// chronological.
pub fn session_atoms(
    store: &Store,
    session_id: &str,
    layer: &str,
    limit: usize,
) -> Result<Vec<Memory>, String> {
    if !valid_layer(layer) {
        return Err(format!("unknown memory layer '{layer}'"));
    }
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, layer, text, session_id, subject, created_at, updated_at, pinned,
                    scope_user, scope_project, scope_agent, scope_global, superseded_at
             FROM memories
             WHERE session_id = ?1 AND layer = ?2 AND superseded_at IS NULL
             ORDER BY created_at ASC LIMIT ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![session_id, layer, limit as i64], |r| {
            Ok(Memory {
                id: r.get(0)?,
                layer: r.get(1)?,
                text: r.get(2)?,
                session_id: r.get(3)?,
                subject: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                pinned: r.get::<_, i64>(7)? != 0,
                scope: MemoryScope {
                    user: r.get(8)?,
                    project: r.get(9)?,
                    agent: r.get(10)?,
                    global: r.get::<_, i64>(11)? != 0,
                },
                score: None,
                superseded_at: r.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

pub fn clear(store: &Store) -> Result<(), String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    conn.execute_batch("DELETE FROM memories;").map_err(|e| e.to_string())
}

pub fn stats(store: &Store) -> Result<MemoryStats, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut s = MemoryStats::default();
    let mut stmt = conn
        .prepare(
            "SELECT layer, COUNT(*), COALESCE(SUM(LENGTH(text)),0) FROM memories GROUP BY layer",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
        .map_err(|e| e.to_string())?;
    for r in rows {
        let (layer, n, bytes) = r.map_err(|e| e.to_string())?;
        s.total += n;
        s.bytes += bytes;
        match layer.as_str() {
            "L0" => s.l0 = n,
            "L1" => s.l1 = n,
            "L2" => s.l2 = n,
            "L3" => s.l3 = n,
            _ => {}
        }
    }
    drop(stmt);
    // Same predicate `recall_scoped` gates on, so the count and the recall path can never disagree.
    // §6.4.3: a superseded row is scoped but no longer reachable, so counting it would report rows
    // as injectable that recall will never return.
    s.injectable = conn
        .query_row(
            "SELECT COUNT(*) FROM memories
              WHERE superseded_at IS NULL
                AND (scope_global = 1 OR scope_project IS NOT NULL)",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(s)
}

// ---------- §6.4 conflict resolution ----------

/// §6.4.5: one thing a human has to decide. Deliberately narrow — see `conflicts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Conflict {
    /// The row that survives on the operator's say-so rather than on recency: pinned, or L3.
    pub held: Memory,
    /// A newer live row on the same subject, in the same project, saying something different.
    pub newer: Memory,
}

/// Read one `Memory` starting at column `off`, so a join can carry two of them in one row.
fn row_at(r: &rusqlite::Row<'_>, off: usize) -> rusqlite::Result<Memory> {
    Ok(Memory {
        id: r.get(off)?,
        layer: r.get(off + 1)?,
        text: r.get(off + 2)?,
        session_id: r.get(off + 3)?,
        subject: r.get(off + 4)?,
        created_at: r.get(off + 5)?,
        updated_at: r.get(off + 6)?,
        pinned: r.get::<_, i64>(off + 7)? != 0,
        scope: MemoryScope {
            user: r.get(off + 8)?,
            project: r.get(off + 9)?,
            agent: r.get(off + 10)?,
            global: r.get::<_, i64>(off + 11)? != 0,
        },
        score: None,
        superseded_at: r.get(off + 12)?,
    })
}

/// The 13 `memories` columns `row_at` reads, in order, qualified by an alias so a self-join can
/// carry two memories in one row without ambiguity.
fn memory_columns(alias: &str) -> String {
    [
        "id",
        "layer",
        "text",
        "session_id",
        "subject",
        "created_at",
        "updated_at",
        "pinned",
        "scope_user",
        "scope_project",
        "scope_agent",
        "scope_global",
        "superseded_at",
    ]
    .iter()
    .map(|c| format!("{alias}.{c}"))
    .collect::<Vec<_>>()
    .join(", ")
}

/// §6.4.3: mark `old` as superseded by `new`. The old row is **kept** — a reversal is recoverable
/// and the Context graph's edges stay valid — but it leaves recall immediately.
///
/// `Ok(false)` when there is nothing to do (no such row, already superseded, or the same id).
/// `Err` when §6.4.5 refuses: a pinned or L3 row is never quietly replaced. That is the case the
/// Memory screen exists for — the contradiction is surfaced, not resolved.
pub fn supersede(store: &Store, old: &str, new: &str) -> Result<bool, String> {
    if old == new {
        return Ok(false);
    }
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let held: Option<(i64, String)> = conn
        .query_row(
            "SELECT pinned, layer FROM memories WHERE id = ?1 AND superseded_at IS NULL",
            params![old],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((pinned, layer)) = held else {
        return Ok(false);
    };
    if pinned != 0 {
        return Err(
            "this memory is pinned — unpin it first if the newer one should replace it".into()
        );
    }
    if layer == "L3" {
        return Err(
            "this is a core fact (L3) — it is replaced deliberately, never by a newer atom".into(),
        );
    }
    let n = conn
        .execute(
            "UPDATE memories SET superseded_at = ?1 WHERE id = ?2 AND superseded_at IS NULL",
            params![now_ms(), old],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// §6.4.3: undo a supersession. The row is already intact — this only makes it reachable again.
pub fn unsupersede(store: &Store, id: &str) -> Result<bool, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE memories SET superseded_at = NULL WHERE id = ?1 AND superseded_at IS NOT NULL",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// §6.4.5: what a human has to look at. Deliberately **narrow**, because a broad "these two atoms
/// might disagree" list is noise nobody will read and a model call to detect real contradiction is
/// exactly the auto-resolution the rule forbids.
///
/// The one case worth surfacing is the one §6.4.1 exists to prevent: a pinned or L3 row that still
/// wins *survival* while a newer, ordinary atom on the same subject says something different. That
/// is a stale pin quietly poisoning retrieval, and only a person can settle it.
pub fn conflicts(store: &Store) -> Result<Vec<Conflict>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let sql = format!(
        "SELECT {}, {}
           FROM memories h
           JOIN memories n
             ON n.subject IS NOT NULL
            AND n.subject = h.subject
            AND n.scope_project IS h.scope_project   -- NULL-safe: same project, or both unscoped
           WHERE h.superseded_at IS NULL AND n.superseded_at IS NULL
             AND (h.pinned = 1 OR h.layer = 'L3')
             AND n.id <> h.id
             AND n.text <> h.text
             AND n.updated_at > h.updated_at
           ORDER BY h.updated_at DESC, n.updated_at DESC",
        memory_columns("h"),
        memory_columns("n")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok(Conflict { held: row_at(r, 0)?, newer: row_at(r, 13)? }))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Ids do not need to be cryptographic — they only need to not collide inside one table.
fn uuid_like() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    format!("{:x}{:x}", now_ms(), n)
}

#[cfg(test)]
mod memory_tests {
    use super::*;

    fn temp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-mem-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir).unwrap(), dir)
    }

    fn input(layer: &str, text: &str) -> MemoryInput {
        MemoryInput {
            layer: layer.into(),
            text: text.into(),
            session_id: Some("s1".into()),
            subject: None,
            pinned: false,
        }
    }

    /// Insert a memory with explicit scope columns. Goes through SQL rather than `capture` because
    /// `capture` has no scope parameters yet — that is Phase 4 (the capture path).
    ///
    /// Eight positional arguments, one per column under test. Bundling them into a struct would
    /// push the names out to every call site to save nothing here — this helper exists precisely to
    /// spell a column set out once.
    #[allow(clippy::too_many_arguments)]
    fn scoped(
        s: &Store,
        id: &str,
        layer: &str,
        text: &str,
        project: Option<&str>,
        agent: Option<&str>,
        global: i64,
        pinned: i64,
    ) {
        s.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO memories (id, layer, text, created_at, updated_at, pinned,
                                       scope_user, scope_project, scope_agent, scope_global)
                 VALUES (?1,?2,?3,1,1,?4,'local',?5,?6,?7)",
                rusqlite::params![id, layer, text, pinned, project, agent, global],
            )
            .unwrap();
    }

    fn scope_of(project: Option<&str>, agent: Option<&str>) -> RecallScope {
        RecallScope {
            user: Some("local".into()),
            project: project.map(|p| p.to_string()),
            agent: agent.map(|a| a.to_string()),
        }
    }

    fn to_project(project: &str, agent: Option<&str>) -> ScopeAssignment {
        ScopeAssignment::Project { project: project.into(), agent: agent.map(|a| a.into()) }
    }

    /// The rule the whole scoped-recall design rests on: a memory is born capture-only and stays
    /// invisible to every scope until someone deliberately binds it.
    #[test]
    fn a_captured_memory_is_born_unscoped_and_invisible_to_every_scope() {
        let (s, d) = temp_store("born-unscoped");
        let m = capture(&s, &input("L1", "this repo uses Postgres")).unwrap();
        assert_eq!(m.scope.project, None, "born with no project binding");
        assert!(!m.scope.global, "born not global");
        assert_eq!(stats(&s).unwrap().injectable, 0, "nothing is injectable yet");
        for p in [Some("alpha"), Some("beta"), None] {
            assert!(
                recall_scoped(&s, "Postgres", 10, None, &scope_of(p, None)).unwrap().is_empty(),
                "an unscoped row is invisible to scope {p:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    /// §5.5.1: the recall order has to be **total**, not merely "sorted by the interesting keys".
    ///
    /// Three atoms that tie on every real key — identical text so identical BM25 and identical band,
    /// the same layer, and the same `updated_at` so the same quantised recency — used to fall
    /// through to whatever order SQLite returned the rows in, which is not specified and can change
    /// with the query plan. The composed block would then differ between two identical requests,
    /// and every difference invalidates the provider's cached prefix.
    ///
    /// Inserted out of id order on purpose: an ascending result is a tie-break doing the work, not
    /// insertion order leaking through. Note that either of the two §5.5 fixes (the `m.id` key in
    /// the SQL `ORDER BY`, or the one in `rerank`) is sufficient *for this data* — the test pins the
    /// property, and `rerank_breaks_ties_on_id` below is what isolates `rerank` itself.
    #[test]
    fn atoms_that_tie_on_every_real_key_come_back_in_id_order() {
        let (s, d) = temp_store("tie-order");
        for id in ["m-3", "m-1", "m-2"] {
            scoped(&s, id, "L1", "the database is postgres", Some("p1"), None, 0, 0);
        }
        let first = recall_scoped(&s, "database", 20, None, &scope_of(Some("p1"), None)).unwrap();
        let ids: Vec<&str> = first.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["m-1", "m-2", "m-3"], "ties break on id, never on row order");

        // The property §5.5 actually needs: the same query against the same rows returns the same
        // order every time.
        let again = recall_scoped(&s, "database", 20, None, &scope_of(Some("p1"), None)).unwrap();
        let ids2: Vec<&str> = again.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ids2, "recall is deterministic, so the composed bytes are too");
        let _ = std::fs::remove_dir_all(&d);
    }

    // ---------- §6.4 conflict resolution ----------

    /// A superseded atom is out of the live set immediately — injecting it would put a fact the
    /// operator already replaced back into every prompt.
    #[test]
    fn a_superseded_atom_drops_out_of_recall_but_not_out_of_the_table() {
        let (s, d) = temp_store("supersede");
        let old = capture(&s, &input("L1", "the database is MySQL")).unwrap();
        let new = capture(&s, &input("L1", "the database is Postgres")).unwrap();
        for id in [&old.id, &new.id] {
            assign_scope(&s, id, to_project("p1", None)).unwrap();
        }
        assert!(
            recall_scoped(&s, "database", 10, None, &scope_of(Some("p1"), None))
                .unwrap()
                .iter()
                .any(|m| m.id == old.id),
            "both atoms are live to start with"
        );

        assert!(supersede(&s, &old.id, &new.id).unwrap());

        let got = recall_scoped(&s, "database", 10, None, &scope_of(Some("p1"), None)).unwrap();
        assert!(!got.iter().any(|m| m.id == old.id), "the superseded atom is gone from recall");
        assert!(got.iter().any(|m| m.id == new.id), "the replacement is still there");
        assert!(
            list(&s, None, 100).unwrap().iter().any(|m| m.id == old.id),
            "but it is still in the table — retained for audit and for a reversal"
        );

        // And the reversal is one call, because the row was never deleted.
        assert!(unsupersede(&s, &old.id).unwrap());
        assert!(
            recall_scoped(&s, "database", 10, None, &scope_of(Some("p1"), None))
                .unwrap()
                .iter()
                .any(|m| m.id == old.id),
            "a supersession is reversible"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// §6.4.5: a pinned or L3 row is never quietly replaced. This is the refusal that makes the
    /// conflict surface meaningful rather than decorative.
    #[test]
    fn superseding_a_pinned_or_core_row_is_refused() {
        let (s, d) = temp_store("supersede-refuse");
        let pinned =
            capture(&s, &MemoryInput { pinned: true, ..input("L1", "the db is MySQL") }).unwrap();
        let core = capture(&s, &input("L3", "the db is MySQL and always was")).unwrap();
        let new = capture(&s, &input("L1", "the db is Postgres")).unwrap();

        let e = supersede(&s, &pinned.id, &new.id).unwrap_err();
        assert!(e.contains("pinned"), "a refusal says why: {e}");
        let e = supersede(&s, &core.id, &new.id).unwrap_err();
        assert!(e.contains("L3"), "a refusal says why: {e}");

        // Still live, which is the point: a stale pin is surfaced, never silently displaced.
        let ids: Vec<String> = list(&s, None, 100).unwrap().iter().map(|m| m.id.clone()).collect();
        assert!(ids.contains(&pinned.id) && ids.contains(&core.id));
        assert!(
            !supersede(&s, "no-such-row", &new.id).unwrap(),
            "a missing row is a no-op, not an error"
        );
        assert!(!supersede(&s, &new.id, &new.id).unwrap(), "a row cannot supersede itself");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// §6.4.5: the one case worth surfacing — a pinned or L3 row still winning *survival* while a
    /// newer ordinary atom on the same subject says something different.
    #[test]
    fn a_pinned_row_with_a_newer_atom_on_the_same_subject_is_a_conflict() {
        let (s, d) = temp_store("conflict");
        let mut pinned_input = input("L1", "the database is MySQL");
        pinned_input.subject = Some("database".into());
        pinned_input.pinned = true;
        let held = capture(&s, &pinned_input).unwrap();
        assign_scope(&s, &held.id, to_project("p1", None)).unwrap();

        // Same subject, newer, different text — and in the same project.
        let mut newer_input = input("L1", "the database is Postgres now");
        newer_input.subject = Some("database".into());
        let newer = capture(&s, &newer_input).unwrap();
        assign_scope(&s, &newer.id, to_project("p1", None)).unwrap();

        // "Newer" is what the query matches on, and two captures land in the same millisecond more
        // often than not — which made this test pass alone and fail in the full suite. Force the
        // ordering rather than relying on the clock.
        let base = now_ms() - 10_000;
        let set_ts = |id: &str, ts: i64| {
            s.conn
                .lock()
                .unwrap()
                .execute("UPDATE memories SET updated_at = ?1 WHERE id = ?2", params![ts, id])
                .unwrap();
        };
        set_ts(&held.id, base);
        set_ts(&newer.id, base + 5_000);

        let cs = conflicts(&s).unwrap();
        assert_eq!(cs.len(), 1, "{cs:?}");
        assert_eq!(cs[0].held.id, held.id);
        assert_eq!(cs[0].newer.id, newer.id);

        // A different project is not a conflict — the two never meet in a prompt.
        let mut other = input("L1", "the database is SQLite over here");
        other.subject = Some("database".into());
        let far = capture(&s, &other).unwrap();
        assign_scope(&s, &far.id, to_project("p2", None)).unwrap();
        assert_eq!(conflicts(&s).unwrap().len(), 1, "scope is part of the match");

        // Resolving it by superseding the pinned row is refused, so it stays surfaced.
        assert!(supersede(&s, &held.id, &newer.id).is_err());
        assert_eq!(conflicts(&s).unwrap().len(), 1, "a refusal does not hide the conflict");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// §6.4.3: `stats` counts what recall can actually return. A superseded row is still scoped, so
    /// without the predicate the two would disagree — and "3 injectable" over "2 that will ever
    /// come back" is exactly the kind of drift that makes a stats panel untrustworthy.
    #[test]
    fn a_superseded_row_is_not_counted_as_injectable() {
        let (s, d) = temp_store("supersede-stats");
        let a = capture(&s, &input("L1", "the database is MySQL")).unwrap();
        let b = capture(&s, &input("L1", "the database is Postgres")).unwrap();
        for id in [&a.id, &b.id] {
            assign_scope(&s, id, to_project("p1", None)).unwrap();
        }
        assert_eq!(stats(&s).unwrap().injectable, 2);
        supersede(&s, &a.id, &b.id).unwrap();
        assert_eq!(stats(&s).unwrap().injectable, 1, "a superseded row is out of the live set");
        let _ = std::fs::remove_dir_all(&d);
    }

    // ---------- §6.2 retention ----------

    #[test]
    fn pruning_drops_l0_past_its_ttl_and_spares_pinned_and_l3() {
        let (s, d) = temp_store("prune-l0");
        // `scoped` writes updated_at = 1, i.e. long past every cutoff.
        scoped(&s, "old-l0", "L0", "an old turn", Some("p1"), None, 0, 0);
        scoped(&s, "old-l0-pinned", "L0", "an old pinned turn", Some("p1"), None, 0, 1);
        scoped(&s, "old-l3", "L3", "a core fact", None, None, 1, 0);
        let st = prune(&s).unwrap();
        assert_eq!(st.l0_expired, 1, "{st:?}");
        let ids: Vec<String> = list(&s, None, 100).unwrap().iter().map(|m| m.id.clone()).collect();
        assert!(!ids.iter().any(|i| i == "old-l0"), "the stale turn went: {ids:?}");
        assert!(ids.iter().any(|i| i == "old-l0-pinned"), "pinned is exempt: {ids:?}");
        assert!(ids.iter().any(|i| i == "old-l3"), "L3 is never auto-pruned: {ids:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The ring is per session, not global — otherwise one long conversation would evict every
    /// other session's turns.
    #[test]
    fn the_l0_ring_keeps_only_the_newest_turns_per_session() {
        let (s, d) = temp_store("prune-ring");
        let base = now_ms() - 1_000; // recent, so the TTL pass leaves them alone
        let ins = |id: &str, sess: &str, i: i64| {
            s.conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO memories (id, layer, text, session_id, created_at, updated_at, pinned)
                     VALUES (?1,'L0',?2,?3,?4,?4,0)",
                    rusqlite::params![id, format!("turn {id}"), sess, base + i],
                )
                .unwrap();
        };
        for i in 0..205 {
            ins(&format!("t{i:03}"), "sess", i);
        }
        for i in 0..3 {
            ins(&format!("o{i}"), "other", i);
        }

        let st = prune(&s).unwrap();
        assert_eq!(st.l0_ring, 5, "205 - 200, and the other session is untouched: {st:?}");

        let left = list(&s, Some("L0"), 500).unwrap();
        let sess: Vec<&str> = left
            .iter()
            .filter(|m| m.session_id.as_deref() == Some("sess"))
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(sess.len(), 200, "{sess:?}");
        assert!(!sess.contains(&"t000"), "the oldest went");
        assert!(sess.contains(&"t204"), "the newest stayed");
        assert_eq!(
            left.iter().filter(|m| m.session_id.as_deref() == Some("other")).count(),
            3,
            "the cap is per session"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn pruning_drops_atoms_that_have_decayed_below_the_floor() {
        let (s, d) = temp_store("prune-decay");
        scoped(&s, "old-l1", "L1", "an old atom", Some("p1"), None, 0, 0);
        scoped(&s, "old-l1-pinned", "L1", "an old pinned atom", Some("p1"), None, 0, 1);
        scoped(&s, "old-l2", "L2", "an old scenario", Some("p1"), None, 0, 0);
        let fresh = capture(&s, &input("L1", "a fresh atom")).unwrap();

        let st = prune(&s).unwrap();
        assert_eq!(st.decayed, 2, "L1 and L2, not the pinned one: {st:?}");
        let ids: Vec<String> = list(&s, None, 100).unwrap().iter().map(|m| m.id.clone()).collect();
        assert!(ids.contains(&fresh.id), "a fresh atom has not decayed: {ids:?}");
        assert!(ids.iter().any(|i| i == "old-l1-pinned"), "pinned is exempt: {ids:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A prune is only correct if the FTS index went with it. A row deleted from `memories` but
    /// still indexed is returned by recall and then read back as nothing — and the next prune's
    /// `rowid` arithmetic silently drifts.
    #[test]
    fn pruned_rows_leave_the_fts_index_too() {
        let (s, d) = temp_store("prune-fts");
        scoped(&s, "gone", "L1", "zebrafish database fact", Some("p1"), None, 0, 0);
        assert_eq!(
            recall_scoped(&s, "zebrafish", 10, None, &scope_of(Some("p1"), None)).unwrap().len(),
            1,
            "seeded and findable"
        );
        prune(&s).unwrap();
        assert!(
            recall_scoped(&s, "zebrafish", 10, None, &scope_of(Some("p1"), None))
                .unwrap()
                .is_empty(),
            "a pruned row is not recallable"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// §5.5.1, isolated: `rerank` sorts rows it is handed in *some* order, and when every real key
    /// ties the leftover order is whatever SQLite produced. This drives it directly with a shuffled
    /// input — which is exactly the unpinned situation — so the tie-break is proved without relying
    /// on what the query happened to return.
    #[test]
    fn rerank_breaks_ties_on_id() {
        let mk = |id: &str| Memory {
            id: id.into(),
            layer: "L1".into(),
            text: "the database is postgres".into(),
            session_id: None,
            subject: None,
            created_at: 1,
            updated_at: 1,
            pinned: false,
            scope: MemoryScope {
                user: "local".into(),
                project: Some("p1".into()),
                agent: None,
                global: false,
            },
            score: Some(-1.0),
            superseded_at: None,
        };
        let mut rows = vec![mk("m-3"), mk("m-1"), mk("m-2")];
        rerank(&mut rows, 1_000_000);
        let ids: Vec<&str> = rows.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["m-1", "m-2", "m-3"], "a total order, not a partial one");
    }

    /// The shortlist is truncated by `LIMIT`, so determinism has to hold *before* ranking too —
    /// which rows survive to be ranked at all would otherwise depend on the query plan. `m.id` is
    /// the last `ORDER BY` key for exactly this reason.
    ///
    /// Honest caveat: verified **not** to fail when that key is removed — this SQLite build returns
    /// tied rows in a stable order for this query. So this pins the property rather than proving the
    /// key is load-bearing today; the key is defensive against an unspecified guarantee plus a
    /// `LIMIT`, both of which are free to change with the planner.
    #[test]
    fn a_truncated_shortlist_is_the_same_rows_every_time() {
        let (s, d) = temp_store("tie-limit");
        for i in 0..12 {
            scoped(
                &s,
                &format!("m-{i:02}"),
                "L1",
                "the database is postgres",
                Some("p1"),
                None,
                0,
                0,
            );
        }
        // A limit of 3 pulls CANDIDATE_FACTOR * 3 = 12 rows, so this is a real truncation.
        let ids: Vec<String> = (0..5)
            .map(|_| {
                recall_scoped(&s, "database", 3, None, &scope_of(Some("p1"), None))
                    .unwrap()
                    .iter()
                    .map(|m| m.id.clone())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .collect();
        assert!(ids.windows(2).all(|w| w[0] == w[1]), "every call picks the same rows: {ids:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn assigning_a_project_makes_a_memory_injectable_only_there() {
        let (s, d) = temp_store("assign-project");
        let m = capture(&s, &input("L1", "this repo uses Postgres")).unwrap();
        assert!(assign_scope(&s, &m.id, to_project("alpha", None)).unwrap());
        assert_eq!(stats(&s).unwrap().injectable, 1, "scoping it makes it injectable");
        assert_eq!(
            recall_scoped(&s, "Postgres", 10, None, &scope_of(Some("alpha"), None)).unwrap().len(),
            1,
            "visible inside its own project"
        );
        assert!(
            recall_scoped(&s, "Postgres", 10, None, &scope_of(Some("beta"), None))
                .unwrap()
                .is_empty(),
            "invisible in another project"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_agent_narrowed_memory_is_invisible_to_a_different_agent() {
        let (s, d) = temp_store("assign-agent");
        let m = capture(&s, &input("L1", "this repo uses Postgres")).unwrap();
        assign_scope(&s, &m.id, to_project("alpha", Some("cursor"))).unwrap();
        assert_eq!(
            recall_scoped(&s, "Postgres", 10, None, &scope_of(Some("alpha"), Some("cursor")))
                .unwrap()
                .len(),
            1
        );
        assert!(
            recall_scoped(&s, "Postgres", 10, None, &scope_of(Some("alpha"), Some("aider")))
                .unwrap()
                .is_empty(),
            "an agent-scoped row does not leak to another agent in the same project"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn marking_a_memory_global_makes_it_visible_in_every_project() {
        let (s, d) = temp_store("assign-global");
        let m = capture(&s, &input("L3", "prefers terse replies")).unwrap();
        assert!(assign_scope(&s, &m.id, ScopeAssignment::Global).unwrap());
        for p in [Some("alpha"), Some("beta")] {
            assert_eq!(
                recall_scoped(&s, "terse", 10, None, &scope_of(p, None)).unwrap().len(),
                1,
                "global rows are not project-bound"
            );
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Demotion has to actually demote: leaving a stale `scope_project` behind would keep the row
    /// visible after the operator took it out of that project.
    #[test]
    fn unscoping_a_memory_hides_it_again() {
        let (s, d) = temp_store("assign-unscope");
        let m = capture(&s, &input("L1", "this repo uses Postgres")).unwrap();
        assign_scope(&s, &m.id, to_project("alpha", None)).unwrap();
        assert_eq!(
            recall_scoped(&s, "Postgres", 10, None, &scope_of(Some("alpha"), None)).unwrap().len(),
            1
        );
        assert!(assign_scope(&s, &m.id, ScopeAssignment::Unscoped).unwrap());
        assert!(
            recall_scoped(&s, "Postgres", 10, None, &scope_of(Some("alpha"), None))
                .unwrap()
                .is_empty(),
            "unscoping clears the project binding rather than leaving it behind"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn promoting_to_global_clears_the_project_binding() {
        let (s, d) = temp_store("assign-promote");
        let m = capture(&s, &input("L1", "this repo uses Postgres")).unwrap();
        assign_scope(&s, &m.id, to_project("alpha", None)).unwrap();
        assign_scope(&s, &m.id, ScopeAssignment::Global).unwrap();
        let listed = list(&s, None, 10).unwrap();
        let row = listed.iter().find(|r| r.id == m.id).unwrap();
        assert!(row.scope.global);
        assert_eq!(row.scope.project, None, "no stale project survives promotion");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A re-distill refreshes text and timestamp; it must not silently unscope a row the operator
    /// already placed.
    #[test]
    fn re_recording_a_memory_preserves_its_scope() {
        let (s, d) = temp_store("assign-rerecord");
        let m = capture(&s, &input("L1", "this repo uses Postgres")).unwrap();
        assign_scope(&s, &m.id, to_project("alpha", None)).unwrap();
        let again = capture(&s, &input("L1", "this repo uses Postgres")).unwrap();
        assert_eq!(again.scope.project.as_deref(), Some("alpha"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn assigning_scope_to_a_missing_memory_reports_false() {
        let (s, d) = temp_store("assign-missing");
        assert!(!assign_scope(&s, "nope", ScopeAssignment::Global).unwrap());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_empty_project_scope_is_refused() {
        let (s, d) = temp_store("assign-empty");
        let m = capture(&s, &input("L1", "this repo uses Postgres")).unwrap();
        assert!(assign_scope(&s, &m.id, to_project("   ", None)).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_project_scoped_memory_is_invisible_to_another_project() {
        let (s, d) = temp_store("scope-iso");
        scoped(&s, "a", "L1", "this repo uses Postgres", Some("alpha"), None, 0, 0);
        let mine = recall_scoped(&s, "Postgres", 10, None, &scope_of(Some("alpha"), None)).unwrap();
        assert_eq!(mine.len(), 1, "visible inside its own project");
        let theirs =
            recall_scoped(&s, "Postgres", 10, None, &scope_of(Some("beta"), None)).unwrap();
        assert!(theirs.is_empty(), "invisible in another project");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_explicitly_global_memory_is_visible_everywhere() {
        let (s, d) = temp_store("scope-global");
        scoped(&s, "g", "L3", "prefers terse replies", None, None, 1, 0);
        for p in [Some("alpha"), Some("beta")] {
            assert_eq!(
                recall_scoped(&s, "terse", 10, None, &scope_of(p, None)).unwrap().len(),
                1,
                "global rows are not project-bound"
            );
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The rule the external review was unanimous about: a missing project is unresolved, and
    /// unresolved must not silently widen to global.
    #[test]
    fn an_unresolved_project_sees_only_pinned_global_rows() {
        let (s, d) = temp_store("scope-unresolved");
        scoped(&s, "pinned", "L3", "never run migrations by hand", None, None, 1, 1);
        scoped(&s, "plain", "L1", "some passing detail", None, None, 1, 0);
        scoped(&s, "proj", "L1", "alpha uses Postgres", Some("alpha"), None, 0, 0);

        let got = recall_scoped(&s, "migrations detail Postgres", 10, None, &scope_of(None, None))
            .unwrap();
        let ids: Vec<&str> = got.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["pinned"], "only the pinned global row survives: {ids:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_agent_scoped_row_is_visible_to_that_agent_and_to_project_wide_facts() {
        let (s, d) = temp_store("scope-agent");
        scoped(
            &s,
            "cursor-only",
            "L1",
            "cursor specific fact",
            Some("alpha"),
            Some("cursor"),
            0,
            0,
        );
        scoped(&s, "any-agent", "L1", "project wide fact", Some("alpha"), None, 0, 0);

        let for_cursor =
            recall_scoped(&s, "fact", 10, None, &scope_of(Some("alpha"), Some("cursor"))).unwrap();
        assert_eq!(for_cursor.len(), 2, "both are visible to cursor");

        let for_claude =
            recall_scoped(&s, "fact", 10, None, &scope_of(Some("alpha"), Some("claude"))).unwrap();
        let ids: Vec<&str> = for_claude.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec!["any-agent"], "an agent-scoped row is not visible to another agent");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unscoped_recall_still_sees_everything() {
        let (s, d) = temp_store("scope-unscoped");
        scoped(&s, "a", "L1", "alpha uses Postgres", Some("alpha"), None, 0, 0);
        scoped(&s, "b", "L1", "beta uses Sqlite", Some("beta"), None, 0, 0);
        // The Assistant's Memory screen must keep working unchanged.
        assert_eq!(recall(&s, "Postgres Sqlite", 10, None).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_captured_memory_comes_back() {
        let (s, d) = temp_store("roundtrip");
        let m = capture(&s, &input("L1", "Tushu prefers concise answers")).unwrap();
        assert_eq!(m.layer, "L1");
        assert_eq!(m.text, "Tushu prefers concise answers");
        let all = list(&s, None, 10).unwrap();
        assert_eq!(all.len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unknown_layer_is_refused() {
        let (s, d) = temp_store("layer");
        assert!(capture(&s, &input("L9", "nope")).is_err());
        assert!(list(&s, Some("L9"), 10).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn re_recording_the_same_fact_refreshes_rather_than_duplicates() {
        let (s, d) = temp_store("dedupe");
        let a = capture(&s, &input("L1", "Dhaka is GMT+6")).unwrap();
        let b = capture(&s, &input("L1", "Dhaka is GMT+6")).unwrap();
        assert_eq!(a.id, b.id, "same layer and text is the same memory");
        assert_eq!(list(&s, None, 10).unwrap().len(), 1);
        assert!(b.updated_at >= a.updated_at);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The webview sends `session_id` — the snake spelling, matching the `Memory` read struct and the
    /// webview's own `Memory` type.
    ///
    /// This asserts the *deserialised struct*, not the database, because the serde boundary is where
    /// the field was historically lost; a store round-trip would have been satisfied by the `input()`
    /// helper, which builds the struct by literal and so never goes through serde at all.
    #[test]
    fn capture_input_reads_the_snake_case_session_id_the_webview_sends() {
        let parsed: MemoryInput = serde_json::from_str(
            r#"{"layer":"L0","text":"hello","session_id":"s-1","subject":"user","pinned":false}"#,
        )
        .unwrap();
        assert_eq!(
            parsed.session_id.as_deref(),
            Some("s-1"),
            "the webview's `session_id` must reach `session_id`"
        );
        assert_eq!(parsed.subject.as_deref(), Some("user"));
        assert_eq!(parsed.layer, "L0");
    }

    /// The guard that makes the spelling *enforceable* rather than merely conventional.
    ///
    /// Serde ignores unknown fields by default, so before `deny_unknown_fields` a camelCase key was
    /// not an error — it was silently absent. That is how `memory_capture_batch` dropped every session
    /// id for months with no failing test anywhere in the suite. This test would have caught it.
    #[test]
    fn capture_input_rejects_the_camel_case_spelling() {
        let err = serde_json::from_str::<MemoryInput>(
            r#"{"layer":"L0","text":"hello","sessionId":"s-1","subject":"user","pinned":false}"#,
        )
        .expect_err("a camelCase key must be a hard error, not a silent null");
        let msg = err.to_string();
        assert!(
            msg.contains("sessionId"),
            "the error must name the offending key so the fix is obvious; got: {msg}"
        );
    }

    /// The other half of the claim: a payload with no session must still deserialize. Otherwise the
    /// snake_case switch would have traded a silent drop for a hard failure on session-less writes.
    #[test]
    fn capture_input_still_accepts_a_missing_session_id() {
        let parsed: MemoryInput =
            serde_json::from_str(r#"{"layer":"L1","text":"no session here"}"#).unwrap();
        assert_eq!(parsed.session_id, None);
        assert!(!parsed.pinned);
    }

    #[test]
    fn recall_ranks_the_relevant_memory_first() {
        let (s, d) = temp_store("bm25");
        capture(&s, &input("L1", "The workspace root must be set before agent mode runs")).unwrap();
        capture(&s, &input("L1", "Agnes publishes wrong modality for image models")).unwrap();
        capture(&s, &input("L1", "Tushu lives in Dhaka")).unwrap();
        let hits = recall(&s, "workspace root agent mode", 10, None).unwrap();
        assert!(!hits.is_empty(), "a plain query must match");
        assert!(
            hits[0].text.contains("workspace root"),
            "the on-topic memory ranks first, got: {:?}",
            hits[0].text
        );
        assert!(hits[0].score.unwrap() < 0.0, "bm25 scores are negative");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn recall_respects_a_layer_filter() {
        let (s, d) = temp_store("filter");
        capture(&s, &input("L0", "the assistant said the build failed")).unwrap();
        capture(&s, &input("L3", "the build is fragile")).unwrap();
        let all = recall(&s, "build", 10, None).unwrap();
        assert_eq!(all.len(), 2);
        let only_l3 = recall(&s, "build", 10, Some(&["L3".to_string()])).unwrap();
        assert_eq!(only_l3.len(), 1);
        assert_eq!(only_l3[0].layer, "L3");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_query_with_no_alphanumerics_matches_nothing_instead_of_throwing() {
        let (s, d) = temp_store("empty");
        capture(&s, &input("L1", "something")).unwrap();
        assert_eq!(recall(&s, "\"'*()", 10, None).unwrap().len(), 0);
        assert_eq!(recall(&s, "   ", 10, None).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_malformed_fts_query_cannot_throw() {
        let (s, d) = temp_store("malformed");
        capture(&s, &input("L1", "the gateway listens on 8787")).unwrap();
        // Every one of these is invalid or dangerous FTS5 syntax on its own.
        for q in ["gateway AND (", "*", "NEAR(x y)", "text:", "\"unbalanced", "a* OR", "^"] {
            let r = recall(&s, q, 10, None);
            assert!(r.is_ok(), "query {q:?} must not error: {:?}", r.err());
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn porter_stemming_matches_across_inflections() {
        let (s, d) = temp_store("stem");
        capture(&s, &input("L1", "Routing falls back to the next provider")).unwrap();
        let hits = recall(&s, "routed provider", 10, None).unwrap();
        assert!(!hits.is_empty(), "stemming should bridge routed/routing");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn at_equal_relevance_the_more_distilled_layer_wins() {
        let (s, d) = temp_store("tiebreak");
        capture(&s, &input("L0", "zebra")).unwrap();
        capture(&s, &input("L1", "zebra")).unwrap();
        capture(&s, &input("L2", "zebra")).unwrap();
        capture(&s, &input("L3", "zebra")).unwrap();
        let hits = recall(&s, "zebra", 10, None).unwrap();
        assert_eq!(hits[0].layer, "L3", "identical text, identical score, L3 first");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn forgetting_removes_the_row_and_its_fts_entry() {
        let (s, d) = temp_store("forget");
        let m = capture(&s, &input("L1", "ephemeral detail")).unwrap();
        assert!(forget(&s, &m.id).unwrap());
        assert!(!forget(&s, &m.id).unwrap(), "second delete reports false");
        assert_eq!(recall(&s, "ephemeral", 10, None).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn overlong_text_is_truncated_not_rejected() {
        let (s, d) = temp_store("long");
        let long = "x".repeat(MAX_TEXT + 500);
        let m = capture(&s, &input("L0", &long)).unwrap();
        assert_eq!(m.text.chars().count(), MAX_TEXT);
        assert!(m.text.ends_with('…'));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn stats_count_per_layer() {
        let (s, d) = temp_store("stats");
        capture(&s, &input("L0", "raw one")).unwrap();
        capture(&s, &input("L1", "atom one")).unwrap();
        capture(&s, &input("L1", "atom two")).unwrap();
        let st = stats(&s).unwrap();
        assert_eq!((st.l0, st.l1, st.l2, st.l3, st.total), (1, 2, 0, 0, 3));
        clear(&s).unwrap();
        assert_eq!(stats(&s).unwrap().total, 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn batch_capture_writes_every_item() {
        let (s, d) = temp_store("batch");
        let items = vec![input("L1", "one"), input("L1", "two"), input("L2", "three")];
        assert_eq!(capture_batch(&s, &items).unwrap(), 3);
        assert_eq!(stats(&s).unwrap().l1, 2);
        assert_eq!(stats(&s).unwrap().l2, 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn update_rewrites_text_and_refreshes_timestamp() {
        let (s, d) = temp_store("update");
        let m = capture(&s, &input("L3", "old core fact")).unwrap();
        assert!(update(&s, &m.id, "new core fact").unwrap());
        let all = list(&s, None, 10).unwrap();
        assert_eq!(all[0].text, "new core fact");
        assert!(all[0].updated_at >= m.updated_at);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn update_with_empty_text_is_an_error_not_a_silent_delete() {
        let (s, d) = temp_store("update-empty");
        let m = capture(&s, &input("L3", "keep me")).unwrap();
        assert!(update(&s, &m.id, "   ").is_err());
        assert_eq!(list(&s, None, 10).unwrap()[0].text, "keep me");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn session_atoms_returns_only_that_session_in_that_layer_oldest_first() {
        let (s, d) = temp_store("session");
        capture(&s, &MemoryInput { session_id: Some("A".into()), ..input("L1", "a1") }).unwrap();
        capture(&s, &MemoryInput { session_id: Some("A".into()), ..input("L1", "a2") }).unwrap();
        capture(&s, &MemoryInput { session_id: Some("B".into()), ..input("L1", "b1") }).unwrap();
        capture(&s, &MemoryInput { session_id: Some("A".into()), ..input("L2", "scn") }).unwrap();
        let a = session_atoms(&s, "A", "L1", 100).unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].text, "a1");
        assert_eq!(a[1].text, "a2");
        let _ = std::fs::remove_dir_all(&d);
    }

    // ---- recency in ranking --------------------------------------------------------------

    /// A candidate as `rerank` sees it: no store needed, because ranking is a pure function of
    /// the rows. `days_old` backdates it, `bm25` is the raw score FTS5 would have produced.
    fn candidate(layer: &str, text: &str, days_old: i64, bm25: f64) -> Memory {
        let ts = now_ms() - days_old * 86_400_000;
        Memory {
            id: format!("{layer}:{text}"),
            layer: layer.into(),
            text: text.into(),
            session_id: None,
            subject: None,
            created_at: ts,
            updated_at: ts,
            pinned: false,
            scope: MemoryScope { user: "local".into(), project: None, agent: None, global: false },
            score: Some(bm25),
            superseded_at: None,
        }
    }

    /// Backdate a stored memory so recency can be exercised without waiting a month.
    fn age(store: &Store, id: &str, days: i64) {
        let ts = now_ms() - days * 86_400_000;
        store
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE memories SET created_at = ?1, updated_at = ?1 WHERE id = ?2",
                params![ts, id],
            )
            .unwrap();
    }

    #[test]
    fn recency_halves_every_half_life() {
        let now = now_ms();
        let day = 86_400_000;
        assert!((recency(now, now) - 1.0).abs() < 0.001);
        assert!((recency(now - 30 * day, now) - 0.5).abs() < 0.01);
        assert!((recency(now - 60 * day, now) - 0.25).abs() < 0.01);
        // A clock that moved backwards must not read as a memory from the future.
        assert!((recency(now + day, now) - 1.0).abs() < 0.001);
    }

    #[test]
    fn at_comparable_relevance_the_more_recent_memory_wins() {
        let mut rows = vec![
            candidate("L1", "old", 180, -3.00),
            candidate("L1", "new", 0, -3.05), // a marginally worse match, written today
        ];
        rerank(&mut rows, now_ms());
        assert_eq!(rows[0].text, "new", "within a band, recency decides");
    }

    #[test]
    fn a_clearly_better_match_is_not_displaced_by_a_recent_weak_one() {
        let mut rows = vec![
            candidate("L1", "strong but old", 365, -8.00),
            candidate("L1", "weak but new", 0, -2.00),
        ];
        rerank(&mut rows, now_ms());
        assert_eq!(rows[0].text, "strong but old", "recency must not rescue a bad match");
    }

    #[test]
    fn an_old_core_fact_keeps_full_recency() {
        let now = now_ms();
        // A core fact is core because the user wrote it down, not because it is recent.
        assert_eq!(recency_key(&candidate("L3", "core", 3650, -3.0), now), 1000);
        assert!(recency_key(&candidate("L1", "atom", 3650, -3.0), now) < 100);
    }

    #[test]
    fn at_equal_band_and_recency_the_more_distilled_layer_still_wins() {
        let mut rows =
            vec![candidate("L0", "raw", 0, -3.00), candidate("L2", "scenario", 0, -3.05)];
        rerank(&mut rows, now_ms());
        assert_eq!(rows[0].text, "scenario", "layer remains the final tiebreak");
    }

    #[test]
    fn recall_prefers_the_recent_memory_when_two_match_comparably() {
        let (s, d) = temp_store("recency");
        // Same shape, same length, differing only in the port — so BM25 cannot separate them and
        // recency is the only signal left.
        let old = capture(&s, &input("L1", "The staging gateway port is 8787")).unwrap();
        let new = capture(&s, &input("L1", "The staging gateway port is 9090")).unwrap();
        age(&s, &old.id, 365);
        age(&s, &new.id, 0);

        let hits = recall(&s, "staging gateway port", 10, None).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, new.id, "the newer of two equal matches is the better answer");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn recall_still_returns_the_relevant_memory_when_the_others_are_newer() {
        let (s, d) = temp_store("recency-relevance");
        let wanted =
            capture(&s, &input("L1", "The workspace root must be set before agent mode runs"))
                .unwrap();
        // The distractor has to share a query token, or it is not a candidate at all and the
        // test passes without exercising anything.
        let noise =
            capture(&s, &input("L1", "Agent mode is one of the Playground toggles")).unwrap();
        // Make the on-topic memory old and the off-topic one fresh: relevance must still win.
        age(&s, &wanted.id, 365);
        age(&s, &noise.id, 0);

        let hits = recall(&s, "workspace root agent mode", 10, None).unwrap();
        assert_eq!(hits.len(), 2, "both must be candidates for this test to mean anything");
        assert_eq!(
            hits[0].id, wanted.id,
            "recency is a tiebreak, not a signal that outranks match"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn recall_fetches_a_wider_shortlist_than_it_returns() {
        let (s, d) = temp_store("shortlist");
        for i in 0..12 {
            let m = capture(&s, &input("L1", &format!("gateway note number {i}"))).unwrap();
            // Newest first in capture order, so the oldest is the one recency should demote.
            age(&s, &m.id, (12 - i) as i64 * 10);
        }
        let hits = recall(&s, "gateway note", 3, None).unwrap();
        assert_eq!(hits.len(), 3);
        // All twelve match equally well, so with a wider shortlist the three most recent win.
        assert_eq!(hits[0].text, "gateway note number 11");
        assert_eq!(hits[1].text, "gateway note number 10");
        assert_eq!(hits[2].text, "gateway note number 9");
        let _ = std::fs::remove_dir_all(&d);
    }
}
