/**
 * Context graph — the persisted relational substrate behind the Context screen (P4).
 *
 * The engine's job is to hold *records*, not opinions: an artifact existed, a memory was
 * recalled, a skill ran, a message was sent, and these are how they relate. What the graph
 * means is decided at draw time. Keeping it that way means the same stored edges can be read
 * as a conversation thread, a provenance chain, or a usage histogram without re-recording.
 *
 * Four node kinds only — artifact, memory, skill, message. That set is deliberately closed:
 * a graph whose node types grow without bound stops being legible, and every new kind would
 * mean new edge semantics to keep honest.
 */
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::core::injection_log::now_ms;
use crate::core::store::Store;

/// Edge weight ceiling. A relation that recurs reads as *stronger*, not as more edges, so
/// repeated recording bumps weight. Without a ceiling one hot relation would eventually
/// out-scale every other edge and the layout would collapse into a single thick bundle.
const MAX_WEIGHT: f64 = 50.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextNode {
    pub id: String,
    pub kind: String,
    pub label: String,
    /// Where this was observed: `ui` (the app itself), `gateway` (an external client),
    /// or `engine` (derived by the helper, not observed directly).
    pub source: String,
    pub session_id: Option<String>,
    pub ts: i64,
    pub meta_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextEdge {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub kind: String,
    pub weight: f64,
    pub ts: i64,
    pub meta_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ContextGraph {
    pub nodes: Vec<ContextNode>,
    pub edges: Vec<ContextEdge>,
}

const NODE_KINDS: [&str; 4] = ["artifact", "memory", "skill", "message"];
const EDGE_KINDS: [&str; 9] = [
    "produced",
    "used",
    "recalled",
    "follows",
    "references",
    "routes_to",
    "served_by",
    "aliases",
    "backed_by",
];

fn valid_node_kind(k: &str) -> bool {
    NODE_KINDS.contains(&k)
}

fn valid_edge_kind(k: &str) -> bool {
    EDGE_KINDS.contains(&k)
}

/// Record nodes and edges together, in one transaction.
///
/// Atomic on purpose: a half-recorded turn is worse than none. An edge whose endpoints were
/// not recorded in the same batch is rejected rather than left dangling — `graph()` would
/// otherwise draw a line to nothing, and SQLite does not enforce foreign keys unless the
/// pragma is on for the connection.
pub fn record(store: &Store, nodes: &[ContextNode], edges: &[ContextEdge]) -> Result<(), String> {
    for n in nodes {
        if !valid_node_kind(&n.kind) {
            return Err(format!("unknown node kind '{}'", n.kind));
        }
    }
    for e in edges {
        if !valid_edge_kind(&e.kind) {
            return Err(format!("unknown edge kind '{}'", e.kind));
        }
    }
    let mut conn = store.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let work = (|| -> Result<(), rusqlite::Error> {
        for n in nodes {
            tx.execute(
                "INSERT INTO context_nodes (id, kind, label, source, session_id, ts, meta_json)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(id) DO UPDATE SET
                   label=excluded.label, source=excluded.source,
                   session_id=excluded.session_id, ts=excluded.ts, meta_json=excluded.meta_json",
                params![n.id, n.kind, n.label, n.source, n.session_id, n.ts, n.meta_json],
            )?;
        }
        for e in edges {
            let known = tx
                .query_row("SELECT 1 FROM context_nodes WHERE id = ?1", params![e.from_id], |_| {
                    Ok(())
                })
                .is_ok()
                && tx
                    .query_row(
                        "SELECT 1 FROM context_nodes WHERE id = ?1",
                        params![e.to_id],
                        |_| Ok(()),
                    )
                    .is_ok();
            if !known {
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(1),
                    Some(format!(
                        "edge {} references a node that is not recorded: {} -> {}",
                        e.id, e.from_id, e.to_id
                    )),
                ));
            }
            tx.execute(
                "INSERT INTO context_edges (id, from_id, to_id, kind, weight, ts, meta_json)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(from_id, to_id, kind) DO UPDATE SET
                   weight = MIN(context_edges.weight + excluded.weight, ?8),
                   ts = excluded.ts, meta_json = excluded.meta_json",
                params![e.id, e.from_id, e.to_id, e.kind, e.weight, e.ts, e.meta_json, MAX_WEIGHT],
            )?;
        }
        Ok(())
    })();
    work.map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// The most recent slice of the graph, newest nodes first.
///
/// Only edges whose *both* endpoints survive the node limit are returned, so the caller never
/// has to reconcile an edge against a node it was not given.
pub fn graph(store: &Store, limit: usize) -> Result<ContextGraph, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, label, source, session_id, ts, meta_json
                  FROM context_nodes ORDER BY ts DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let nodes = stmt
        .query_map([limit as i64], |r| {
            Ok(ContextNode {
                id: r.get(0)?,
                kind: r.get(1)?,
                label: r.get(2)?,
                source: r.get(3)?,
                session_id: r.get(4)?,
                ts: r.get(5)?,
                meta_json: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.from_id, e.to_id, e.kind, e.weight, e.ts, e.meta_json
                  FROM context_edges e
                  JOIN context_nodes nf ON nf.id = e.from_id
                  JOIN context_nodes nt ON nt.id = e.to_id
                  WHERE nf.id IN (SELECT id FROM context_nodes ORDER BY ts DESC LIMIT ?1)
                    AND nt.id IN (SELECT id FROM context_nodes ORDER BY ts DESC LIMIT ?1)
                  ORDER BY e.ts DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let edges = stmt
        .query_map(params![limit as i64, (limit * 8) as i64], |r| {
            Ok(ContextEdge {
                id: r.get(0)?,
                from_id: r.get(1)?,
                to_id: r.get(2)?,
                kind: r.get(3)?,
                weight: r.get(4)?,
                ts: r.get(5)?,
                meta_json: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(ContextGraph { nodes, edges })
}

/// Drop everything. Exposed so the operator can clear a graph that has become noise; there is
/// no partial delete by design — a graph pruned by age would silently sever relations whose
/// other endpoint survived.
pub fn clear(store: &Store) -> Result<(), String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    conn.execute_batch("DELETE FROM context_edges; DELETE FROM context_nodes;")
        .map_err(|e| e.to_string())
}

// ---------- history: sessions and their timelines ----------
//
// A session is whatever `session_id` was stamped on the nodes, so this needs no schema change
// and no separate bookkeeping table — the graph already *is* the transcript. Two readings of
// the same rows: `sessions()` for the index, `timeline()` for one run.
//
// Ordering is the subtle part. Timestamps are not a tiebreaker here: a whole agent run is
// recorded in one batch, so every node in it can share one `ts`. The authoritative order is
// the sequence number baked into the node id (`message:<session>:7`), which is why `seq_of`
// exists and why it is tried before `ts`.

/// One row in the history index. `preview` is the first thing the user said; `title` is a
/// custom label set by the operator (if any), which takes precedence when present.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistorySession {
    pub session_id: String,
    pub started_ts: i64,
    pub ended_ts: i64,
    /// User and assistant messages only. A tool-heavy run has few of these and many tools.
    pub turns: i64,
    pub tool_calls: i64,
    pub preview: String,
    pub title: Option<String>,
    pub model: Option<String>,
}

/// One line of a session timeline. `kind` drives how the UI renders it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimelineEntry {
    /// `user` | `assistant` | `tool`.
    pub kind: String,
    pub ts: i64,
    pub text: String,
    /// For a tool entry, the result the sandbox returned — joined if the call produced several.
    /// For an assistant entry, the `tool_calls` array that the message carried (serialized JSON),
    /// so a resumed session can replay tool invocations with their ids and arguments intact.
    pub detail: Option<String>,
    pub model: Option<String>,
    /// Memories recalled for this turn, collapsed to a count rather than `n` timeline lines.
    pub memories: i64,
    /// `tool_call_id` linking a tool-result entry back to its originating call (assistant entry).
    /// Present only on `tool` entries; `None` otherwise.
    pub tool_call_id: Option<String>,
    /// Serialized `tool_calls` array on assistant message entries, for session resumption.
    /// Present only on `assistant` entries with tool calls; `None` otherwise.
    pub tool_calls: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct HistoryTimeline {
    pub session_id: String,
    pub entries: Vec<TimelineEntry>,
}

/// Sequence number from a node id, e.g. `skill:s-1:12` → 12. Nodes whose id carries no
/// sequence (re-keyed memory nodes are `memory:<memoryId>`) fall back to `ts`, which is
/// correct for them because they are dated at the moment they were learned.
fn seq_of(id: &str) -> Option<i64> {
    id.rsplit(':').next().and_then(|s| s.parse::<i64>().ok())
}

fn sort_key(id: &str, ts: i64) -> (i64, i64) {
    (seq_of(id).unwrap_or(ts), ts)
}

fn meta_text(meta: &Option<String>, key: &str) -> Option<String> {
    let raw = meta.as_deref()?;
    serde_json::from_str::<serde_json::Value>(raw).ok()?.get(key)?.as_str().map(|s| s.to_string())
}

/// Extract an arbitrary JSON value from node metadata, re-serialized as a compact string.
fn meta_json(meta: &Option<String>, key: &str) -> Option<String> {
    let raw = meta.as_deref()?;
    let parsed = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let val = parsed.get(key)?;
    serde_json::to_string(val).ok()
}

/// A session's worth of preview text: the first user message, truncated. Falls back to the
/// first message of any role, then to nothing — a session of only tool calls still deserves
/// a row in the index.
///
/// The cap is in **bytes** — what a `String` and a `TEXT` column both measure — but a
/// byte-indexed slice landing mid-UTF-8 would panic, so the cut walks back to a boundary first.
/// A stored message already clipped to `…` puts that three-byte char exactly across the cap.
fn preview_of(label: &str) -> String {
    const MAX_BYTES: usize = 120;
    let flat = label.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.len() <= MAX_BYTES {
        return flat;
    }
    // `flat.len()` counts bytes, so cutting at MAX_BYTES can land inside a multi-byte character
    // and `&flat[..MAX_BYTES]` panics — which aborts the process, taking the app down rather than
    // costing one preview. Two shapes reach here: a label whose own text is multi-byte, and the
    // far more common one, a label the UI already clipped with `clip(s, 120)` — that appends the
    // three-byte `…` after 119 UTF-16 units, so any opening message over 120 characters puts the
    // ellipsis at bytes 119..122 and byte 120 lands inside it whatever the language. Clamp to a
    // boundary first, exactly as `web.rs` and `js_host.rs` already do before truncating.
    let mut cut = MAX_BYTES;
    while !flat.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &flat[..cut])
}

/// The session index, newest first. Sessions with no `session_id` are excluded rather than
/// bucketed under a null key — an unsessioned node belongs to the graph, not to history.
pub fn sessions(store: &Store, limit: usize) -> Result<Vec<HistorySession>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT c.session_id,
                    MIN(c.ts), MAX(c.ts),
                    SUM(CASE WHEN c.kind='message' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN c.kind='skill'   THEN 1 ELSE 0 END),
                    t.title
             FROM context_nodes c
             LEFT JOIN session_titles t ON t.session_id = c.session_id
             WHERE c.session_id IS NOT NULL
             GROUP BY c.session_id
             ORDER BY MAX(c.ts) DESC
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows: Vec<HistorySession> = stmt
        .query_map([limit as i64], |r| {
            Ok(HistorySession {
                session_id: r.get(0)?,
                started_ts: r.get(1)?,
                ended_ts: r.get(2)?,
                turns: r.get(3)?,
                tool_calls: r.get(4)?,
                preview: String::new(),
                title: r.get(5)?,
                model: None,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    if rows.is_empty() {
        return Ok(rows);
    }

    // Previews come from the earliest *user* message in each session. One query for all listed
    // sessions rather than a query per row: the index is a list, and N+1 here is the difference
    // between instant and perceptible on a few hundred sessions.
    let holes = std::iter::repeat_n("?", rows.len()).collect::<Vec<_>>().join(",");
    let mut stmt = conn
        .prepare(&format!(
            "SELECT session_id, label, meta_json FROM context_nodes
             WHERE kind='message' AND session_id IN ({holes})
             ORDER BY ts ASC"
        ))
        .map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut models: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let found = stmt
        .query_map(rusqlite::params_from_iter(rows.iter().map(|r| r.session_id.clone())), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    for (sid, label, meta) in &found {
        let role = meta_text(meta, "role").unwrap_or_default();
        if let Some(m) = meta_text(meta, "model") {
            models.entry(sid.clone()).or_insert(m);
        }
        // First user message wins; a session that opens with an assistant line keeps the
        // placeholder until a user turn arrives.
        if role == "user" && !seen.contains(sid) {
            seen.insert(sid.clone());
            if let Some(row) = rows.iter_mut().find(|r| &r.session_id == sid) {
                row.preview = preview_of(label);
            }
        }
    }
    for row in rows.iter_mut() {
        if row.preview.is_empty() {
            if let Some((_, label, _)) = found.iter().find(|(sid, _, _)| *sid == row.session_id) {
                row.preview = preview_of(label);
            }
        }
        row.model = models.get(&row.session_id).cloned();
    }
    Ok(rows)
}

/// One session read as a timeline: turns in order, with each assistant turn's tool calls and
/// their results tucked in under it.
///
/// Tool results are reached through edges, not adjacency. A run that issues three calls gets
/// one assistant node followed by three skill nodes and then three artifact nodes — the calls
/// are batched ahead of the results — so "the next node" is not the answer to "what did this
/// call return". The `produced` edge is.
pub fn timeline(store: &Store, session_id: &str) -> Result<HistoryTimeline, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, kind, label, ts, meta_json FROM context_nodes
             WHERE session_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    struct Row {
        id: String,
        kind: String,
        label: String,
        ts: i64,
        meta: Option<String>,
    }
    let mut nodes: Vec<Row> = stmt
        .query_map([session_id], |r| {
            Ok(Row {
                id: r.get(0)?,
                kind: r.get(1)?,
                label: r.get(2)?,
                ts: r.get(3)?,
                meta: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    nodes.sort_by_key(|n| sort_key(&n.id, n.ts));

    let by_id: std::collections::HashMap<&str, &Row> =
        nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    let mut stmt = conn
        .prepare(
            "SELECT e.from_id, e.to_id, e.kind FROM context_edges e
             JOIN context_nodes n ON n.id = e.from_id
             WHERE n.session_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let edges: Vec<(String, String, String)> = stmt
        .query_map([session_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    drop(conn);

    // message -> skill (used), skill -> artifact (produced), message -> memory (recalled).
    let mut tools_of: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
    // `skill -> artifact (produced)`: each result's text **and** the id the request declared for the
    // call that produced it, keyed by the skill node the edge starts from.
    //
    // The id has to be collected here, because a `skill` node is written with no metadata at all
    // (`Assistant.tsx`: `rec.node("skill", toolCallName(c))`) — the `tool_call_id` lives on the
    // artifact. Reading it from the skill instead yields `None` for every replayed call, so a
    // resumed session re-sent the call's `tool_use` with nothing answering it and the provider
    // refused the entire request: "tool_use ids were found without tool_result blocks immediately
    // after". Measured on a live transcript: 0 skill nodes carried the id, 272 artifact nodes did.
    let mut results_of: std::collections::HashMap<&str, (Vec<String>, Option<String>)> =
        std::collections::HashMap::new();
    let mut recalled: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
    for (from, to, kind) in &edges {
        match kind.as_str() {
            "used" => tools_of.entry(from.as_str()).or_default().push(to.as_str()),
            "produced" => {
                if let Some(n) = by_id.get(to.as_str()) {
                    // Prefer the full text stored in meta over the clipped label: artifact labels
                    // are 80-character previews, but a resumed run replays the whole result.
                    let text = meta_text(&n.meta, "text").unwrap_or_else(|| n.label.clone());
                    let entry = results_of.entry(from.as_str()).or_default();
                    entry.0.push(text);
                    // First id wins: a call is answered by one artifact in practice, and an id
                    // arriving later cannot be the one a request already declared.
                    if entry.1.is_none() {
                        entry.1 = meta_text(&n.meta, "tool_call_id");
                    }
                }
            }
            "recalled" => *recalled.entry(from.as_str()).or_insert(0) += 1,
            _ => {}
        }
    }

    let mut entries: Vec<TimelineEntry> = Vec::new();
    for n in &nodes {
        if n.kind != "message" {
            continue;
        }
        let role = meta_text(&n.meta, "role").unwrap_or_else(|| "assistant".to_string());
        let kind = if role == "user" { "user" } else { "assistant" };
        // The label is a 120-character preview for the graph canvas; the full text the turn was
        // recorded with lives in meta (`text`). Nodes written before that field existed fall back
        // to the label — a preview is still better than nothing on old sessions.
        let text = meta_text(&n.meta, "text").unwrap_or_else(|| n.label.clone());
        entries.push(TimelineEntry {
            kind: kind.to_string(),
            ts: n.ts,
            text,
            detail: None,
            model: meta_text(&n.meta, "model"),
            memories: *recalled.get(n.id.as_str()).unwrap_or(&0),
            tool_call_id: None,
            tool_calls: meta_json(&n.meta, "tool_calls"),
        });

        let mut calls = tools_of.remove(n.id.as_str()).unwrap_or_default();
        calls.sort_by_key(|id| sort_key(id, by_id.get(id).map(|r| r.ts).unwrap_or(0)));
        for call in calls {
            let target = by_id.get(call);
            let (result, artifact_id) = results_of.remove(call).unwrap_or_default();
            let detail = result
                .iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            entries.push(TimelineEntry {
                kind: "tool".to_string(),
                ts: target.map(|r| r.ts).unwrap_or(n.ts),
                text: target.map(|r| r.label.clone()).unwrap_or_else(|| call.to_string()),
                detail: if detail.is_empty() { None } else { Some(detail) },
                model: None,
                memories: 0,
                // The id the request declared, taken from the artifact that answered the call. The
                // fallback to the node's own metadata covers any older shape that wrote the id
                // there; the artifact is where the recorder puts it.
                tool_call_id: artifact_id.or_else(|| {
                    meta_text(target.map(|r| &r.meta).unwrap_or(&None), "tool_call_id")
                }),
                tool_calls: None,
            });
        }
    }

    Ok(HistoryTimeline { session_id: session_id.to_string(), entries })
}

/// One transcript search hit: where a phrase was said, with enough context to judge it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionSearchHit {
    pub session_id: String,
    /// Custom title when one is set, else the session's own preview — the same label the
    /// History index shows, so a hit names the conversation the way the user already sees it.
    pub title: Option<String>,
    pub preview: String,
    pub seq: i64,
    /// `user` | `assistant` | `tool`.
    pub role: String,
    pub ts: i64,
    /// The matched region with the match bracketed — FTS5's `snippet()`, so a hit shows the
    /// words around the phrase rather than making the caller re-open the session to judge it.
    pub snippet: String,
}

/// Full-text search across every stored transcript.
///
/// This is the capability nothing else in the app has: the History screen filters titles and
/// previews over one loaded page, while this walks the words of every conversation. The query is
/// sanitized by the same tokenizer memory recall uses (arbitrary model output must not be able to
/// throw a syntax error at SQLite), matches rank by BM25, and each hit carries a snippet with the
/// match bracketed so the caller can see the context without re-reading the session.
///
/// Rows come back newest-first; a query that tokenizes to nothing (punctuation, empty) returns an
/// empty list rather than an error — "nothing was asked" is not a failure.
pub fn search_sessions(
    store: &Store,
    query: &str,
    limit: usize,
) -> Result<Vec<SessionSearchHit>, String> {
    let Some(expr) = crate::core::memory::match_expr(query) else {
        return Ok(Vec::new());
    };
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT m.session_id, m.seq, m.role, m.ts,
                    snippet(session_messages_fts, 0, '[', ']', '…', 18),
                    t.title, s.preview
             FROM session_messages_fts f
             JOIN session_messages m ON m.session_id = f.session_id AND m.seq = f.seq
             LEFT JOIN session_titles t ON t.session_id = m.session_id
             LEFT JOIN (
                 SELECT session_id, preview FROM (
                     SELECT session_id, content AS preview,
                            ROW_NUMBER() OVER (
                                PARTITION BY session_id
                                ORDER BY CASE WHEN role = 'user' THEN 0 ELSE 1 END, seq
                            ) AS rn
                     FROM session_messages
                 ) WHERE rn = 1
             ) s ON s.session_id = m.session_id
             WHERE session_messages_fts MATCH ?1
             ORDER BY m.ts DESC
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![expr, limit as i64], |r| {
            Ok(SessionSearchHit {
                session_id: r.get(0)?,
                seq: r.get(1)?,
                role: r.get(2)?,
                ts: r.get(3)?,
                snippet: r.get(4)?,
                title: {
                    let t: Option<String> = r.get(5)?;
                    t.filter(|s| !s.trim().is_empty())
                },
                preview: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Set or clear a custom title for a session. Passing `None` removes a custom title, so the
/// History index falls back to the first user message as preview.
pub fn set_session_title(
    store: &Store,
    session_id: &str,
    title: Option<&str>,
) -> Result<(), String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    if let Some(t) = title {
        if t.trim().is_empty() {
            conn.execute("DELETE FROM session_titles WHERE session_id = ?1", params![session_id])
                .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "INSERT INTO session_titles (session_id, title, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id) DO UPDATE SET
                   title = excluded.title, updated_at = excluded.updated_at",
                params![session_id, t, now_ms()],
            )
            .map_err(|e| e.to_string())?;
        }
    } else {
        conn.execute("DELETE FROM session_titles WHERE session_id = ?1", params![session_id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Wipe every trace of a session: the context graph, its title metadata, its agent runs (steps
/// follow by FK cascade), and its memories.
///
/// One transaction, and wider than it used to be: `session_id` is a bare TEXT column on
/// `agent_runs` and `memories` with no FK to cascade from, so deleting the graph rows left the
/// run history and captured memories alive — a session the UI said never existed still showed
/// activity and knowledge, which the 2026-10-04 audit measured against the live database. The
/// live-context rows (`router_sessions`/`session_turns`) are deliberately not touched: they are
/// the resume mechanism and are bounded by the retention prune, not by the user's delete.
pub fn delete_session(store: &Store, session_id: &str) -> Result<(), String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM context_nodes WHERE session_id = ?1", params![session_id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM session_titles WHERE session_id = ?1", params![session_id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM agent_runs WHERE session_id = ?1", params![session_id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM memories WHERE session_id = ?1", params![session_id])
        .map_err(|e| e.to_string())?;
    // The transcript goes with the session. Leaving these rows would leak a deleted conversation
    // into the database forever — and, worse, a later session that happened to reuse the id would
    // resume someone else's turns.
    tx.execute("DELETE FROM session_messages WHERE session_id = ?1", params![session_id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// One persisted transcript message — the durable copy of what the transcript rendered.
///
/// Deliberately shaped like the wire rather than like the UI: `tool_calls` and `tool_call_id` are
/// carried verbatim so a resumed session replays a tool round-trip that a provider will accept.
/// Everything optional is `Option`, and a `NULL` means "this turn had none of it" rather than an
/// empty value — `reasoning` on a model that does not think, `model` on a row written before the
/// column existed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessageRow {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub seq: i64,
    /// `user` | `assistant` | `tool`. Checked, not trusted: an unknown role reaches a provider and
    /// comes back as a `400`, so the refusal belongs here rather than in the wire log.
    pub role: String,
    #[serde(default)]
    pub content: String,
    /// Serialized OpenAI `tool_calls` array, exactly as the assistant turn declared it.
    #[serde(default)]
    pub tool_calls: Option<String>,
    /// The `tool_call_id` this result answers. Present only on `tool` rows.
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub reasoning: Option<String>,
    /// Serialized attachment metadata (never bytes: an image's base64 has no business in the
    /// database, and the transcript's own attachment list is what the UI re-renders).
    #[serde(default)]
    pub attachments: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Serialized `RecalledMemory[]` (0028) — the memories this turn's answer drew on, so a
    /// resumed session still shows the recall card. `NULL` on a turn that recalled nothing.
    #[serde(default)]
    pub memory_refs: Option<String>,
    #[serde(default)]
    pub ts: i64,
    /// The project directory this row's transcript lived in. Native sessions leave this `NULL`
    /// (the Assistant spans whatever the user has open); an imported foreign session sets it so
    /// the manifest can scope recall to that root. `NULL` is not global.
    #[serde(default)]
    pub root: Option<String>,
}

fn valid_role(role: &str) -> bool {
    matches!(role, "user" | "assistant" | "tool")
}

/// Append messages to a session's transcript, in one transaction.
///
/// Batched rather than one call per message for the reason the graph recorder is batched: a turn
/// is a unit, and a half-written turn is a transcript that replays a `tool_calls` array with no
/// results — the exact shape a provider rejects. `(session_id, seq)` is the primary key, so
/// appending a turn twice updates those rows instead of duplicating the conversation.
fn validate_session_rows(rows: &[SessionMessageRow]) -> Result<(), String> {
    for r in rows {
        if r.session_id.trim().is_empty() {
            return Err("session_messages: session_id is required".into());
        }
        if !valid_role(&r.role) {
            return Err(format!(
                "session_messages: unknown role {:?} (expected user, assistant or tool)",
                r.role
            ));
        }
    }
    Ok(())
}

fn insert_session_rows(
    tx: &rusqlite::Transaction<'_>,
    rows: &[SessionMessageRow],
) -> Result<(), String> {
    let mut stmt = tx
        .prepare(
            "INSERT INTO session_messages
               (session_id, seq, role, content, tool_calls, tool_call_id, reasoning, attachments, model, memory_refs, ts, root)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(session_id, seq) DO UPDATE SET
               role=excluded.role, content=excluded.content, tool_calls=excluded.tool_calls,
               tool_call_id=excluded.tool_call_id, reasoning=excluded.reasoning,
               attachments=excluded.attachments, model=excluded.model,
               memory_refs=excluded.memory_refs, ts=excluded.ts,
               root=excluded.root",
        )
        .map_err(|e| e.to_string())?;
    for r in rows {
        stmt.execute(params![
            r.session_id,
            r.seq,
            r.role,
            r.content,
            r.tool_calls,
            r.tool_call_id,
            r.reasoning,
            r.attachments,
            r.model,
            r.memory_refs,
            r.ts,
            r.root,
        ])
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn append_session_messages(store: &Store, rows: &[SessionMessageRow]) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    validate_session_rows(rows)?;
    let mut conn = store.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    insert_session_rows(&tx, rows)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Replace a session's durable transcript with exactly `rows`.
///
/// Edit, retry, delete, compaction and fork all change what the conversation *is*, not just what
/// is on screen. Appending could only add rows, so the abandoned tail came back on resume. This is
/// the one write that removes it: delete the session's rows and insert the new view in the same
/// transaction, so a crash cannot leave half a conversation. The FTS triggers fire on both halves.
pub fn replace_session_messages(
    store: &Store,
    session_id: &str,
    rows: &[SessionMessageRow],
) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("session_messages: session_id is required".into());
    }
    validate_session_rows(rows)?;
    if let Some(bad) = rows.iter().find(|r| r.session_id != session_id) {
        return Err(format!(
            "session_messages: row for {:?} cannot be written into session {:?}",
            bad.session_id, session_id
        ));
    }
    let mut conn = store.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM session_messages WHERE session_id = ?1", params![session_id])
        .map_err(|e| e.to_string())?;
    insert_session_rows(&tx, rows)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// A session's transcript, in stored order.
///
/// Ordered by `seq` and never by `ts`: an agent turn's assistant message, its tool results and its
/// closing message can share a millisecond, so a timestamp is not an order. The same rule the
/// timeline follows, for the same reason.
pub fn session_messages(store: &Store, session_id: &str) -> Result<Vec<SessionMessageRow>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT session_id, seq, role, content, tool_calls, tool_call_id, reasoning, attachments, model, memory_refs, ts, root
               FROM session_messages WHERE session_id = ?1 ORDER BY seq ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(SessionMessageRow {
                session_id: row.get(0)?,
                seq: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                tool_calls: row.get(4)?,
                tool_call_id: row.get(5)?,
                reasoning: row.get(6)?,
                attachments: row.get(7)?,
                model: row.get(8)?,
                memory_refs: row.get(9)?,
                ts: row.get(10)?,
                root: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// The highest `seq` already stored for this session, or 0 when there is no transcript.
///
/// Resuming continues in place, so the next append must start past what is stored — restarting at
/// 1 would upsert over the session's own earlier turns and silently rewrite its history. This is
/// the transcript's sibling of [`max_node_seq`], and it exists for the same reason.
pub fn max_message_seq(store: &Store, session_id: &str) -> Result<i64, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let max: Option<i64> = conn
        .query_row(
            "SELECT MAX(seq) FROM session_messages WHERE session_id = ?1",
            params![session_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(max.unwrap_or(0))
}

/// Whether this session already has transcript rows.
///
/// The sources listing uses it to mark a foreign session as imported without loading the rows:
/// an import is a deterministic id, so existence is the whole answer and the content is not
/// needed to render a badge.
pub fn session_exists(store: &Store, session_id: &str) -> Result<bool, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_messages WHERE session_id = ?1)",
        params![session_id],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n != 0)
    .map_err(|e| e.to_string())
}

/// The highest sequence number already used by this session's generated node ids.
///
/// Resuming a session continues it in place, so the recorder must start its sequence past what is
/// already stored — restarting from 1 would generate ids that upsert over the session's existing
/// nodes and silently rewrite its history. Explicit ids (`m-…` memories) carry no numeric tail and
/// are correctly ignored.
pub fn max_node_seq(store: &Store, session_id: &str) -> Result<i64, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id FROM context_nodes WHERE session_id = ?1")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map(params![session_id], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(ids
        .iter()
        .filter_map(|id| id.rsplit(':').next().and_then(|tail| tail.parse::<i64>().ok()))
        .max()
        .unwrap_or(0))
}

#[cfg(test)]
mod context_graph_tests {
    use super::*;

    fn temp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-ctx-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir).unwrap(), dir)
    }

    fn node(id: &str, kind: &str) -> ContextNode {
        ContextNode {
            id: id.into(),
            kind: kind.into(),
            label: id.into(),
            source: "ui".into(),
            session_id: None,
            ts: 1,
            meta_json: None,
        }
    }

    fn edge(id: &str, from: &str, to: &str, kind: &str) -> ContextEdge {
        ContextEdge {
            id: id.into(),
            from_id: from.into(),
            to_id: to.into(),
            kind: kind.into(),
            weight: 1.0,
            ts: 1,
            meta_json: None,
        }
    }

    #[test]
    fn a_recorded_turn_comes_back_as_nodes_and_edges() {
        let (s, d) = temp_store("roundtrip");
        record(
            &s,
            &[node("m1", "message"), node("a1", "artifact")],
            &[edge("e1", "m1", "a1", "produced")],
        )
        .unwrap();
        let g = graph(&s, 100).unwrap();
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.edges[0].kind, "produced");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn max_node_seq_skips_explicit_ids_and_reads_generated_tails() {
        let (s, d) = temp_store("maxseq");
        assert_eq!(max_node_seq(&s, "s-1").unwrap(), 0, "empty session: 0");

        // Generated ids carry the numeric tail; memory nodes are explicit and tail-less.
        let mut m1 = node("message:s-1:1", "message");
        m1.session_id = Some("s-1".into());
        let mut m7 = node("message:s-1:7", "message");
        m7.session_id = Some("s-1".into());
        let mut mem = node("m-L3-1a0b", "memory");
        mem.session_id = Some("s-1".into());
        // A node from ANOTHER session must not count toward this one.
        let mut other = node("message:s-2:99", "message");
        other.session_id = Some("s-2".into());
        record(&s, &[m1, m7, mem, other], &[]).unwrap();

        assert_eq!(max_node_seq(&s, "s-1").unwrap(), 7, "max numeric tail of this session's ids");
        assert_eq!(max_node_seq(&s, "s-2").unwrap(), 99);
        assert_eq!(
            max_node_seq(&s, "s-3").unwrap(),
            0,
            "a session with only tail-less ids reads as empty"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_repeated_relation_strengthens_instead_of_duplicating() {
        let (s, d) = temp_store("weight");
        record(
            &s,
            &[node("m1", "message"), node("s1", "skill")],
            &[edge("e1", "m1", "s1", "used")],
        )
        .unwrap();
        for i in 0..4 {
            record(&s, &[], &[edge(&format!("e{}", i + 2), "m1", "s1", "used")]).unwrap();
        }
        let g = graph(&s, 100).unwrap();
        assert_eq!(g.edges.len(), 1, "same pair and kind is one edge");
        assert_eq!(g.edges[0].weight, 5.0, "re-recording accumulates weight");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_edge_to_an_unrecorded_node_is_rejected_not_left_dangling() {
        let (s, d) = temp_store("dangling");
        let err = record(&s, &[node("m1", "message")], &[edge("e1", "m1", "ghost", "produced")])
            .unwrap_err();
        assert!(err.contains("ghost"), "error names the missing node: {err}");
        let g = graph(&s, 100).unwrap();
        assert!(g.edges.is_empty(), "the whole batch is rejected, not half-applied");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unknown_kinds_are_refused_before_anything_is_written() {
        let (s, d) = temp_store("kinds");
        assert!(record(&s, &[node("m1", "vibe")], &[]).is_err());
        let g = graph(&s, 100).unwrap();
        assert!(g.nodes.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    // ---- history ----

    /// A session shaped like a real one: one user turn, one assistant turn that called two
    /// tools, and the results recorded *after* both calls — the batching that makes adjacency
    /// the wrong way to pair a call with its result.
    fn agent_session(s: &Store, session: &str, ts: i64) {
        let id = |k: &str, n: i64| format!("{k}:{session}:{n}");
        let nd = |k: &str, n: i64, label: &str, meta: Option<&str>| ContextNode {
            id: id(k, n),
            kind: k.into(),
            label: label.into(),
            source: "ui".into(),
            session_id: Some(session.into()),
            ts,
            meta_json: meta.map(|m| m.to_string()),
        };
        let eg = |from: &str, to: &str, kind: &str| ContextEdge {
            id: format!("{from}->{to}:{kind}"),
            from_id: from.into(),
            to_id: to.into(),
            kind: kind.into(),
            weight: 1.0,
            ts,
            meta_json: None,
        };
        let user = id("message", 1);
        let assistant = id("message", 2);
        record(
            s,
            &[
                nd("message", 1, "what files are here", Some(r#"{"role":"user","model":"a/b"}"#)),
                nd("memory", 3, "user is Tushu", Some(r#"{"layer":"L3"}"#)),
                nd("message", 2, "", Some(r#"{"role":"assistant","model":"a/b"}"#)),
                nd("skill", 4, "list_dir", None),
                nd("skill", 5, "read_file", None),
                nd("artifact", 6, "main.rs", Some(r#"{"tool_call_id":"c1"}"#)),
                nd("artifact", 7, "fn main() {}", Some(r#"{"tool_call_id":"c2"}"#)),
            ],
            &[
                eg(&user, &id("memory", 3), "recalled"),
                eg(&user, &assistant, "follows"),
                eg(&assistant, &id("skill", 4), "used"),
                eg(&assistant, &id("skill", 5), "used"),
                eg(&id("skill", 4), &id("artifact", 6), "produced"),
                eg(&id("skill", 5), &id("artifact", 7), "produced"),
            ],
        )
        .unwrap();
    }

    #[test]
    fn a_session_is_indexed_with_its_first_user_message_as_preview() {
        let (s, d) = temp_store("index");
        agent_session(&s, "s-1", 1000);
        let rows = sessions(&s, 50).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "s-1");
        assert_eq!(rows[0].preview, "what files are here");
        assert_eq!(rows[0].turns, 2, "two messages, not seven nodes");
        assert_eq!(rows[0].tool_calls, 2);
        assert_eq!(rows[0].model.as_deref(), Some("a/b"));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Regression: the recorder clips a preview to 119 chars + `…`, which puts that three-byte char
    /// exactly across the 120-byte cap. The old byte-indexed slice panicked there, and with
    /// `panic = "abort"` in the release profile that took the whole app down on every history load.
    #[test]
    fn a_preview_cut_inside_a_multibyte_char_does_not_panic() {
        let clipped = format!("{}…", "a".repeat(119));
        assert_eq!(clipped.len(), 122);
        assert!(!clipped.is_char_boundary(120), "byte 120 lands inside `…`");
        assert_eq!(preview_of(&clipped), clipped, "the cut walks back onto the boundary");

        // A four-byte char straddling the cap walks back three bytes, not zero.
        let emoji = format!("a{}", "😀".repeat(31));
        assert!(!emoji.is_char_boundary(120));
        assert_eq!(preview_of(&emoji).len(), 120);

        // Short labels, and labels exactly at the cap, are returned untouched.
        assert_eq!(preview_of("hi"), "hi");
        assert_eq!(preview_of(&"a".repeat(120)), "a".repeat(120));
    }

    /// A multi-byte character straddling the cut rather than sitting at the end, so the clamp
    /// visibly truncates instead of reconstructing the input.
    #[test]
    fn a_preview_cut_inside_a_multibyte_character_drops_that_character() {
        let label = format!("{}{}", "a".repeat(118), "€".repeat(10));
        assert!(!label.is_char_boundary(120), "byte 120 is a continuation byte of a `€`");

        let out = preview_of(&label);
        assert_eq!(out, format!("{}…", "a".repeat(118)), "clamped back to the last full character");
        assert!(!out.contains('€'), "the split character is dropped, not mangled");
    }

    /// The crash as it actually reached users: not a unit test of the truncation but the IPC
    /// command the Assistant screen calls on mount. This aborted the process, so the assertion
    /// that matters is that the call returns at all.
    #[test]
    fn a_session_whose_preview_straddles_the_cut_is_still_indexed() {
        let (s, d) = temp_store("preview-clamp");
        let mut m = node("message:s-1:1", "message");
        m.label = format!("{}…", "a".repeat(119));
        m.session_id = Some("s-1".into());
        m.meta_json = Some(r#"{"role":"user"}"#.into());
        record(&s, &[m], &[]).unwrap();

        let rows = sessions(&s, 50).unwrap();
        assert_eq!(rows.len(), 1, "the row is indexed rather than aborting the call");
        assert_eq!(rows[0].preview.chars().count(), 120, "119 characters plus the ellipsis");
        assert!(rows[0].preview.ends_with('…'), "preview: {}", rows[0].preview);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The 2026-10-04 audit measured this against the live database: a deleted session's graph
    /// rows went, but its agent runs, agent steps, and memories survived — a session the UI said
    /// never existed, still visible in Activity and Memory. All of it follows the delete now.
    #[test]
    fn deleting_a_session_takes_its_agent_runs_memories_and_graph_rows_with_it() {
        let (s, d) = temp_store("delete-session");

        let mut gone = node("message:s-1:1", "message");
        gone.session_id = Some("s-1".into());
        let mut kept = node("message:s-2:1", "message");
        kept.session_id = Some("s-2".into());
        record(&s, &[gone, kept], &[]).unwrap();

        {
            let conn = s.conn.lock().unwrap();
            for (id, session) in [("run-gone", "s-1"), ("run-kept", "s-2")] {
                conn.execute(
                    "INSERT INTO agent_runs (id, session_id, model, status, started_at)
                     VALUES (?1, ?2, 'm', 'ok', 1)",
                    rusqlite::params![id, session],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO agent_steps (run_id, seq, ts, kind, detail)
                     VALUES (?1, 1, 1, 'tool_call', 'x')",
                    rusqlite::params![id],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO memories (id, layer, text, session_id, created_at, updated_at)
                     VALUES (?1, 'L0', 'remembered', ?2, 1, 1)",
                    rusqlite::params![format!("mem-{id}"), session],
                )
                .unwrap();
            }
        }

        delete_session(&s, "s-1").unwrap();

        let conn = s.conn.lock().unwrap();
        let count = |table: &str, filter: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table} WHERE {filter}"), [], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(count("context_nodes", "session_id = 's-1'"), 0, "graph rows go");
        assert_eq!(count("context_nodes", "session_id = 's-2'"), 1, "other sessions untouched");
        assert_eq!(count("agent_runs", "session_id = 's-1'"), 0, "agent runs go");
        assert_eq!(count("agent_steps", "run_id = 'run-gone'"), 0, "steps follow by cascade");
        assert_eq!(count("agent_steps", "run_id = 'run-kept'"), 1, "other runs' steps untouched");
        assert_eq!(count("memories", "session_id = 's-1'"), 0, "memories go");
        assert_eq!(
            count("memories", "session_id = 's-2'"),
            1,
            "other sessions' memories untouched"
        );
        drop(conn);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_index_is_newest_first_and_honours_the_limit() {
        let (s, d) = temp_store("order");
        agent_session(&s, "s-old", 1000);
        agent_session(&s, "s-new", 5000);
        let rows = sessions(&s, 1).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "s-new");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_timeline_orders_by_sequence_even_when_every_node_shares_one_timestamp() {
        let (s, d) = temp_store("seq");
        agent_session(&s, "s-1", 1000);
        let t = timeline(&s, "s-1").unwrap();
        let kinds: Vec<&str> = t.entries.iter().map(|e| e.kind.as_str()).collect();
        // Every node was written at ts=1000, so only the node-id sequence can produce this.
        assert_eq!(kinds, vec!["user", "assistant", "tool", "tool"]);
        assert_eq!(t.entries[0].text, "what files are here");
        assert_eq!(t.entries[0].memories, 1, "recalled memories collapse to a count");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_tool_result_is_matched_by_edge_not_by_coming_next() {
        let (s, d) = temp_store("pairing");
        agent_session(&s, "s-1", 1000);
        let t = timeline(&s, "s-1").unwrap();
        assert_eq!(t.entries[2].text, "list_dir");
        assert_eq!(t.entries[2].detail.as_deref(), Some("main.rs"));
        assert_eq!(t.entries[3].text, "read_file");
        assert_eq!(t.entries[3].detail.as_deref(), Some("fn main() {}"));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A replayed transcript carries the wire id of every tool result.
    ///
    /// This id is what a resumed session sends back as `tool_result.tool_use_id`, and the artifact
    /// node is the only place it is stored — a `skill` node is written with no metadata at all. The
    /// test above checked a result's text and detail and never its id, which is exactly why a
    /// replayed call could lose it unnoticed. A lost id is not a degraded answer: the provider
    /// refuses the whole request, so the user sees every attempt fail with a schema error.
    #[test]
    fn a_replayed_tool_result_keeps_the_id_the_request_declared() {
        let (s, d) = temp_store("ids");
        agent_session(&s, "s-1", 1000);
        let t = timeline(&s, "s-1").unwrap();
        assert_eq!(t.entries[2].tool_call_id.as_deref(), Some("c1"), "list_dir's result id");
        assert_eq!(t.entries[3].tool_call_id.as_deref(), Some("c2"), "read_file's result id");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The calls an assistant turn made survive the round trip.
    ///
    /// The id test above covers the *result* half of a replayed tool exchange; this covers the
    /// *call* half. Both are load-bearing for a resumed session: with the calls lost, a transcript
    /// rebuilds no tool rows at all — every result degrades to a bare bubble — and a plan's text
    /// (an argument of `exit_plan_mode`) is gone with them, so the card cannot come back.
    #[test]
    fn a_replayed_assistant_turn_keeps_the_calls_it_made() {
        let (s, d) = temp_store("calls");
        // `r##` not `r#`: the plan text inside the arguments contains `"#`, which would close a
        // single-hash raw string mid-literal.
        let calls = r##"[{"id":"c1","type":"function","function":{"name":"exit_plan_mode","arguments":"{\"plan\":\"# Plan\"}"}}]"##;
        let meta = |m: &str| Some(m.to_string());
        let assistant_meta =
            format!(r#"{{"role":"assistant","model":"a/b","tool_calls":{calls}}}"#);
        record(
            &s,
            &[
                ContextNode {
                    id: "m1".into(),
                    kind: "message".into(),
                    label: "plan it".into(),
                    source: "ui".into(),
                    session_id: Some("s-1".into()),
                    ts: 1000,
                    meta_json: meta(r#"{"role":"user","text":"plan it"}"#),
                },
                ContextNode {
                    id: "m2".into(),
                    kind: "message".into(),
                    label: "".into(),
                    source: "ui".into(),
                    session_id: Some("s-1".into()),
                    ts: 1001,
                    meta_json: Some(assistant_meta),
                },
                ContextNode {
                    id: "k1".into(),
                    kind: "skill".into(),
                    label: "exit_plan_mode".into(),
                    source: "ui".into(),
                    session_id: Some("s-1".into()),
                    ts: 1002,
                    meta_json: None,
                },
                ContextNode {
                    id: "a1".into(),
                    kind: "artifact".into(),
                    label: "the plan".into(),
                    source: "ui".into(),
                    session_id: Some("s-1".into()),
                    ts: 1003,
                    meta_json: meta(r#"{"tool_call_id":"c1","text":"the plan"}"#),
                },
            ],
            &[
                ContextEdge {
                    id: "e1".into(),
                    from_id: "m2".into(),
                    to_id: "k1".into(),
                    kind: "used".into(),
                    weight: 1.0,
                    ts: 1002,
                    meta_json: None,
                },
                ContextEdge {
                    id: "e2".into(),
                    from_id: "k1".into(),
                    to_id: "a1".into(),
                    kind: "produced".into(),
                    weight: 1.0,
                    ts: 1003,
                    meta_json: None,
                },
            ],
        )
        .unwrap();
        let t = timeline(&s, "s-1").unwrap();
        // The user turn made no calls and says so rather than omitting the field.
        assert_eq!(t.entries[0].tool_calls, None);
        let raw = t.entries[1].tool_calls.as_deref().expect("the calls are replayed");
        let parsed: serde_json::Value = serde_json::from_str(raw).expect("compact JSON");
        assert_eq!(parsed[0]["id"], "c1");
        assert_eq!(parsed[0]["function"]["name"], "exit_plan_mode");
        assert_eq!(parsed[0]["function"]["arguments"], r##"{"plan":"# Plan"}"##);
        // And the call still pairs with its result by id, which is what rebuilding a row needs.
        assert_eq!(t.entries[2].tool_call_id.as_deref(), Some("c1"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unknown_session_reads_as_an_empty_timeline() {
        let (s, d) = temp_store("empty");
        let t = timeline(&s, "s-nope").unwrap();
        assert_eq!(t.session_id, "s-nope");
        assert!(t.entries.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unsessioned_nodes_are_graph_not_history() {
        let (s, d) = temp_store("nosession");
        record(&s, &[node("m1", "message"), node("m2", "message")], &[]).unwrap();
        assert!(sessions(&s, 50).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn clearing_removes_both_tables() {
        let (s, d) = temp_store("clear");
        record(
            &s,
            &[node("m1", "message"), node("m2", "message")],
            &[edge("e1", "m1", "m2", "follows")],
        )
        .unwrap();
        clear(&s).unwrap();
        let g = graph(&s, 100).unwrap();
        assert!(g.nodes.is_empty() && g.edges.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    // --- the transcript (0027) ---

    fn msg(session: &str, seq: i64, role: &str, content: &str) -> SessionMessageRow {
        SessionMessageRow {
            session_id: session.into(),
            seq,
            role: role.into(),
            content: content.into(),
            tool_calls: None,
            tool_call_id: None,
            reasoning: None,
            attachments: None,
            model: None,
            memory_refs: None,
            ts: 1_000 + seq,
            root: None,
        }
    }

    #[test]
    fn a_transcript_comes_back_in_seq_order_whatever_order_it_was_written() {
        let (s, d) = temp_store("tx-order");
        // Deliberately out of order: an agent turn can finish its tool results after the closing
        // message is buffered, and the ordering authority is `seq`, not arrival.
        append_session_messages(
            &s,
            &[
                msg("s1", 2, "assistant", "third"),
                msg("s1", 0, "user", "first"),
                msg("s1", 1, "tool", "second"),
            ],
        )
        .unwrap();
        let rows = session_messages(&s, "s1").unwrap();
        let content: Vec<&str> = rows.iter().map(|r| r.content.as_str()).collect();
        assert_eq!(content, vec!["first", "second", "third"]);
        assert_eq!(max_message_seq(&s, "s1").unwrap(), 2);
        // Another session's rows are not this session's transcript.
        assert!(session_messages(&s, "s2").unwrap().is_empty());
        assert_eq!(max_message_seq(&s, "s2").unwrap(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn re_appending_a_turn_updates_it_instead_of_duplicating_the_conversation() {
        let (s, d) = temp_store("tx-upsert");
        append_session_messages(&s, &[msg("s1", 0, "user", "hi")]).unwrap();
        // The same turn, re-sent — a retry, or a resume that re-flushes what it already wrote.
        append_session_messages(&s, &[msg("s1", 0, "user", "hi again")]).unwrap();
        let rows = session_messages(&s, "s1").unwrap();
        assert_eq!(rows.len(), 1, "the row is updated, not duplicated");
        assert_eq!(rows[0].content, "hi again");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn replacing_a_transcript_drops_rows_the_new_view_no_longer_holds() {
        let (s, d) = temp_store("tx-replace");
        append_session_messages(
            &s,
            &[
                msg("s1", 0, "user", "q1"),
                msg("s1", 1, "assistant", "a1"),
                msg("s1", 2, "user", "q2"),
            ],
        )
        .unwrap();

        replace_session_messages(&s, "s1", &[msg("s1", 0, "user", "q1 edited")]).unwrap();
        let rows = session_messages(&s, "s1").unwrap();
        assert_eq!(rows.len(), 1, "the abandoned tail is gone, not merely hidden");
        assert_eq!(rows[0].content, "q1 edited");

        // A row from another session is refused rather than written into this one.
        let bad = replace_session_messages(&s, "s1", &[msg("s2", 0, "user", "x")]);
        assert!(bad.is_err(), "the replacement cannot cross session ids");

        // Emptying is a real replacement, and it leaves other sessions alone.
        append_session_messages(&s, &[msg("s2", 0, "user", "other")]).unwrap();
        replace_session_messages(&s, "s1", &[]).unwrap();
        assert!(session_messages(&s, "s1").unwrap().is_empty());
        assert_eq!(session_messages(&s, "s2").unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_tool_round_trip_survives_the_round_trip_exactly() {
        let (s, d) = temp_store("tx-tools");
        let calls = r#"[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.txt\"}"}}]"#;
        let mut assistant = msg("s1", 0, "assistant", "");
        assistant.tool_calls = Some(calls.into());
        assistant.model = Some("openrouter/gpt-4o".into());
        assistant.reasoning = Some("let me look".into());
        assistant.memory_refs = Some(
            r#"[{"id":"m1","layer":"L1","text":"Tushu lives in Dhaka","at":1,"pinned":false}]"#
                .into(),
        );
        let mut result = msg("s1", 1, "tool", "file body");
        result.tool_call_id = Some("call_1".into());
        append_session_messages(&s, &[assistant, result]).unwrap();

        let rows = session_messages(&s, "s1").unwrap();
        // Verbatim, because the pair is what a provider validates: an id that changes between the
        // call and its result is a `400`, and that is the whole reason these columns exist.
        assert_eq!(rows[0].tool_calls.as_deref(), Some(calls));
        assert_eq!(rows[0].model.as_deref(), Some("openrouter/gpt-4o"));
        assert_eq!(rows[0].reasoning.as_deref(), Some("let me look"));
        // The recall record survives verbatim too: the resumed transcript renders its card
        // straight from this JSON.
        assert!(rows[0]
            .memory_refs
            .as_deref()
            .unwrap_or_default()
            .contains("Tushu lives in Dhaka"));
        assert_eq!(rows[1].tool_call_id.as_deref(), Some("call_1"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_unknown_role_is_refused_and_the_batch_is_all_or_nothing() {
        let (s, d) = temp_store("tx-role");
        let bad = append_session_messages(
            &s,
            &[msg("s1", 0, "user", "ok"), msg("s1", 1, "system", "not a transcript role")],
        );
        assert!(bad.is_err(), "a role the wire cannot carry must be refused");
        assert!(bad.unwrap_err().contains("unknown role"));
        // Nothing at all: a half-written turn replays a `tool_calls` array with no results, which
        // is worse than not writing the turn.
        assert!(session_messages(&s, "s1").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_empty_session_id_is_refused() {
        let (s, d) = temp_store("tx-sid");
        let bad = append_session_messages(&s, &[msg("", 0, "user", "hi")]);
        assert!(bad.is_err());
        assert!(bad.unwrap_err().contains("session_id is required"));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The API refuses a bad role, and the **schema** does too. Both matter: the CHECK is what
    /// holds when a row arrives from anywhere but this function.
    #[test]
    fn the_schema_itself_refuses_an_unknown_role() {
        let (s, d) = temp_store("tx-check");
        {
            let conn = s.conn.lock().unwrap();
            let res = conn.execute(
                "INSERT INTO session_messages (session_id, seq, role, content, ts) VALUES ('s1', 0, 'system', '', 1)",
                [],
            );
            assert!(res.is_err(), "the CHECK must refuse a role outside user/assistant/tool");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn deleting_a_session_takes_its_transcript_with_it() {
        let (s, d) = temp_store("tx-delete");
        append_session_messages(&s, &[msg("s1", 0, "user", "hi"), msg("s2", 0, "user", "other")])
            .unwrap();
        delete_session(&s, "s1").unwrap();
        assert!(
            session_messages(&s, "s1").unwrap().is_empty(),
            "a deleted session must not leave its turns behind"
        );
        assert_eq!(
            session_messages(&s, "s2").unwrap().len(),
            1,
            "and must not touch another session's"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    // --- search_sessions (0030) ---

    #[test]
    fn search_finds_words_said_in_past_sessions() {
        let (s, d) = temp_store("search-basic");
        append_session_messages(
            &s,
            &[
                msg("s1", 0, "user", "we moved the agent router off the 500 flap path"),
                msg("s1", 1, "assistant", "done — three-round re-probe is in"),
            ],
        )
        .unwrap();
        let hits = search_sessions(&s, "router flap", 30).unwrap();
        assert_eq!(hits.len(), 1, "both tokens live in one row; porter stems flap/flaps");
        assert_eq!(hits[0].session_id, "s1");
        assert_eq!(hits[0].role, "user");
        assert!(hits[0].snippet.contains('['), "the match must be bracketed in the snippet");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn search_hits_carry_the_title_a_session_was_given() {
        let (s, d) = temp_store("search-title");
        append_session_messages(&s, &[msg("s1", 0, "user", "discussed the axiom suite")]).unwrap();
        set_session_title(&s, "s1", Some("Axiom planning")).unwrap();
        let hits = search_sessions(&s, "axiom", 30).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title.as_deref(), Some("Axiom planning"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn search_backfills_older_transcripts_and_tracks_new_and_updated_rows() {
        let (s, d) = temp_store("search-sync");
        // Un-apply 0030: no index, no triggers, no version row — the shape of a database that
        // predates this migration. A row inserted now is history the backfill has never seen.
        {
            let conn = s.conn.lock().unwrap();
            conn.execute_batch(
                "DROP TRIGGER IF EXISTS session_messages_fts_ai;
                 DROP TRIGGER IF EXISTS session_messages_fts_ad;
                 DROP TRIGGER IF EXISTS session_messages_fts_au;
                 DROP TABLE IF EXISTS session_messages_fts;
                 DELETE FROM schema_version WHERE version >= 30;",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO session_messages (session_id, seq, role, content, ts)
                 VALUES ('old', 0, 'user', 'the very first conversation about quixotic bugs', 1)",
                [],
            )
            .unwrap();
        }
        s.migrate().unwrap();
        let hits = search_sessions(&s, "quixotic", 30).unwrap();
        assert_eq!(hits.len(), 1, "history written before 0030 must be searchable after it");

        // A fresh append is indexed by the trigger, and an upserted row is re-indexed, not doubled.
        append_session_messages(&s, &[msg("new", 0, "user", "quixotic again")]).unwrap();
        append_session_messages(&s, &[msg("new", 0, "user", "quixotic reworded")]).unwrap();
        let hits = search_sessions(&s, "quixotic", 30).unwrap();
        assert_eq!(hits.len(), 2, "the upsert must replace the fts row, not add a second one");

        // And the delete trigger takes the indexed row with the transcript row.
        delete_session(&s, "new").unwrap();
        assert_eq!(search_sessions(&s, "quixotic", 30).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_malformed_or_empty_search_query_returns_hits_nothing_and_never_an_error() {
        let (s, d) = temp_store("search-malformed");
        append_session_messages(&s, &[msg("s1", 0, "user", "plain words here")]).unwrap();
        for q in ["\"", "*", "AND OR", "a\"b(c)", "   ", "!!!"] {
            let hits = search_sessions(&s, q, 30).unwrap();
            assert!(
                hits.is_empty() || hits.iter().all(|h| h.session_id == "s1"),
                "query {q:?} must not throw"
            );
        }
        let _ = std::fs::remove_dir_all(&d);
    }
}
