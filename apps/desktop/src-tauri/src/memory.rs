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
use serde::{Deserialize, Serialize};

use crate::store::Store;

pub const LAYERS: [&str; 4] = ["L0", "L1", "L2", "L3"];

/// A memory is a fact, not a document. Longer text is truncated on capture rather than
/// rejected — losing the tail of an overlong turn is better than refusing to remember it.
const MAX_TEXT: usize = 8000;

/// Cap on how many query tokens reach FTS5. Bounds the work a pathological query can ask for.
const MAX_QUERY_TOKENS: usize = 32;

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
    /// BM25 score, populated by `recall` only. More negative is a better match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
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
                params![
                    now,
                    keep_pinned as i64,
                    input.session_id,
                    input.subject,
                    id
                ],
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
                score: None,
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
                score: None,
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

/**
 * BM25 recall.
 *
 * Abstract layers are boosted by ordering ties toward them: L3 > L2 > L1 > L0 at equal
 * relevance, because when two memories match equally well the more distilled one is the
 * better thing to put in a prompt.
 */
pub fn recall(
    store: &Store,
    query: &str,
    limit: usize,
    layers: Option<&[String]>,
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

    let placeholders: Vec<String> = (1..=wanted.len()).map(|i| format!("?{}", i + 2)).collect();
    let sql = format!(
        "SELECT m.id, m.layer, m.text, m.session_id, m.subject, m.created_at, m.updated_at, m.pinned,
                bm25(memories_fts) AS score
         FROM memories_fts
         JOIN memories m ON m.rowid = memories_fts.rowid
         WHERE memories_fts MATCH ?1 AND m.layer IN ({})
         ORDER BY score, CASE m.layer WHEN 'L3' THEN 0 WHEN 'L2' THEN 1 WHEN 'L1' THEN 2 ELSE 3 END
         LIMIT ?2",
        placeholders.join(",")
    );

    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut p: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(expr.clone())];
    p.push(Box::new(limit as i64));
    for l in &wanted {
        p.push(Box::new(l.to_string()));
    }
    let rows = stmt
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
                score: Some(r.get(8)?),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
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
            "SELECT id, layer, text, session_id, subject, created_at, updated_at, pinned
             FROM memories WHERE layer = ?1
             ORDER BY pinned DESC, updated_at DESC LIMIT ?2"
                .into(),
            vec![l.to_string(), limit.to_string()],
        ),
        None => (
            "SELECT id, layer, text, session_id, subject, created_at, updated_at, pinned
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
                score: None,
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

pub fn clear(store: &Store) -> Result<(), String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    conn.execute_batch("DELETE FROM memories;").map_err(|e| e.to_string())
}

pub fn stats(store: &Store) -> Result<MemoryStats, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut s = MemoryStats::default();
    let mut stmt = conn
        .prepare("SELECT layer, COUNT(*), COALESCE(SUM(LENGTH(text)),0) FROM memories GROUP BY layer")
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
    Ok(s)
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
}
