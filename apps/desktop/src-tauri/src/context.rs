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
