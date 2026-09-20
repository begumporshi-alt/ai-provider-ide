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

use crate::store::Store;

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
    "produced", "used", "recalled", "follows", "references",
    "routes_to", "served_by", "aliases", "backed_by",
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
                .query_row(
                    "SELECT 1 FROM context_nodes WHERE id = ?1",
                    params![e.from_id],
                    |_| Ok(()),
                )
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
        .prepare("SELECT id, kind, label, source, session_id, ts, meta_json
                  FROM context_nodes ORDER BY ts DESC LIMIT ?1")
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
        .prepare("SELECT e.id, e.from_id, e.to_id, e.kind, e.weight, e.ts, e.meta_json
                  FROM context_edges e
                  JOIN context_nodes nf ON nf.id = e.from_id
                  JOIN context_nodes nt ON nt.id = e.to_id
                  WHERE nf.id IN (SELECT id FROM context_nodes ORDER BY ts DESC LIMIT ?1)
                    AND nt.id IN (SELECT id FROM context_nodes ORDER BY ts DESC LIMIT ?1)
                  ORDER BY e.ts DESC LIMIT ?2")
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

/// One row in the history index. `preview` is the first thing the user said, which is the only
/// useful label a session has — there is no title anywhere in the schema.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HistorySession {
    pub session_id: String,
    pub started_ts: i64,
    pub ended_ts: i64,
    /// User and assistant messages only. A tool-heavy run has few of these and many tools.
    pub turns: i64,
    pub tool_calls: i64,
    pub preview: String,
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
    pub detail: Option<String>,
    pub model: Option<String>,
    /// Memories recalled for this turn, collapsed to a count rather than `n` timeline lines.
    pub memories: i64,
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
    serde_json::from_str::<serde_json::Value>(raw).ok()?
        .get(key)?.as_str().map(|s| s.to_string())
}

/// A session's worth of preview text: the first user message, truncated. Falls back to the
/// first message of any role, then to nothing — a session of only tool calls still deserves
/// a row in the index.
fn preview_of(label: &str) -> String {
    let flat = label.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.len() <= 120 {
        flat
    } else {
        format!("{}…", &flat[..120])
    }
}

/// The session index, newest first. Sessions with no `session_id` are excluded rather than
/// bucketed under a null key — an unsessioned node belongs to the graph, not to history.
pub fn sessions(store: &Store, limit: usize) -> Result<Vec<HistorySession>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT session_id,
                    MIN(ts), MAX(ts),
                    SUM(CASE WHEN kind='message' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN kind='skill'   THEN 1 ELSE 0 END)
             FROM context_nodes
             WHERE session_id IS NOT NULL
             GROUP BY session_id
             ORDER BY MAX(ts) DESC
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
    let holes = std::iter::repeat("?").take(rows.len()).collect::<Vec<_>>().join(",");
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
        .query_map(
            rusqlite::params_from_iter(rows.iter().map(|r| r.session_id.clone())),
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )
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

    let by_id: std::collections::HashMap<&str, &Row> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();

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
    let mut results_of: std::collections::HashMap<&str, Vec<String>> = std::collections::HashMap::new();
    let mut recalled: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
    for (from, to, kind) in &edges {
        match kind.as_str() {
            "used" => tools_of.entry(from.as_str()).or_default().push(to.as_str()),
            "produced" => {
                if let Some(n) = by_id.get(to.as_str()) {
                    results_of.entry(from.as_str()).or_default().push(n.label.clone());
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
        entries.push(TimelineEntry {
            kind: kind.to_string(),
            ts: n.ts,
            text: n.label.clone(),
            detail: None,
            model: meta_text(&n.meta, "model"),
            memories: *recalled.get(n.id.as_str()).unwrap_or(&0),
        });

        let mut calls = tools_of.remove(n.id.as_str()).unwrap_or_default();
        calls.sort_by_key(|id| sort_key(id, by_id.get(id).map(|r| r.ts).unwrap_or(0)));
        for call in calls {
            let target = by_id.get(call);
            let result = results_of.remove(call).unwrap_or_default();
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
            });
        }
    }

    Ok(HistoryTimeline { session_id: session_id.to_string(), entries })
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
        record(&s, &[node("m1", "message"), node("a1", "artifact")], &[edge("e1", "m1", "a1", "produced")]).unwrap();
        let g = graph(&s, 100).unwrap();
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.edges.len(), 1);
        assert_eq!(g.edges[0].kind, "produced");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_repeated_relation_strengthens_instead_of_duplicating() {
        let (s, d) = temp_store("weight");
        record(&s, &[node("m1", "message"), node("s1", "skill")], &[edge("e1", "m1", "s1", "used")]).unwrap();
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
        let err = record(&s, &[node("m1", "message")], &[edge("e1", "m1", "ghost", "produced")]).unwrap_err();
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
        record(&s, &[node("m1", "message"), node("m2", "message")], &[edge("e1", "m1", "m2", "follows")]).unwrap();
        clear(&s).unwrap();
        let g = graph(&s, 100).unwrap();
        assert!(g.nodes.is_empty() && g.edges.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }
}
