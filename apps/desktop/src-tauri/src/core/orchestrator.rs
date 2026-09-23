/**
 * Agent run ledger (P6).
 *
 * The Assistant runs an agent and throws the run away: when the turn ends, the only trace is
 * whatever the model said. That is fine for chatting and useless for operating — you cannot
 * answer "what did it actually do?" or "how many runs failed this afternoon?" after the fact.
 *
 * So a run is recorded as it happens, not reconstructed at the end. Steps are appended one at a
 * time rather than written in one blob on completion, because a run that dies midway is exactly
 * the run you most want to inspect, and a final-write design would have nothing to show for it.
 *
 * This is a record, not a scheduler. It does not decide what runs; it remembers what ran.
 */
use serde::{Deserialize, Serialize};

use crate::core::store::Store;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentRun {
    pub id: String,
    pub session_id: Option<String>,
    pub model: String,
    /// `running` until the run ends one way or another. A run left `running` by a crash is
    /// reported as running rather than silently marked failed — a status we did not observe is
    /// unknown, and calling it failure would be inventing a fact.
    pub status: String,
    pub prompt: Option<String>,
    pub iterations: i64,
    pub tool_calls: i64,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentStep {
    pub seq: i64,
    pub kind: String,
    pub label: Option<String>,
    pub detail: Option<String>,
    pub ok: Option<bool>,
    pub ts: i64,
}

const RUN_STATUSES: [&str; 4] = ["running", "ok", "error", "stopped"];
const STEP_KINDS: [&str; 5] = ["assistant", "tool_call", "tool_result", "done", "denied"];

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn start(
    store: &Store,
    id: String,
    session_id: Option<String>,
    model: String,
    prompt: Option<String>,
) -> Result<(), String> {
    if !RUN_STATUSES.contains(&"running") {
        return Err("status vocabulary is broken".into());
    }
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO agent_runs (id, session_id, model, status, prompt, iterations, tool_calls, started_at)
         VALUES (?1,?2,?3,'running',?4,0,0,?5)
         ON CONFLICT(id) DO UPDATE SET model=excluded.model, prompt=excluded.prompt",
        rusqlite::params![id, session_id, model, prompt, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Append one step. Sequence numbers are assigned per run so a step list is ordered even when
/// two steps land in the same millisecond, which they routinely do.
pub fn step(
    store: &Store,
    run_id: &str,
    kind: String,
    label: Option<String>,
    detail: Option<String>,
    ok: Option<bool>,
) -> Result<(), String> {
    if !STEP_KINDS.contains(&kind.as_str()) {
        return Err(format!("unknown step kind '{kind}'"));
    }
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let next: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(seq),0) + 1 FROM agent_steps WHERE run_id = ?1",
            rusqlite::params![run_id],
            |r| r.get(0),
        )
        .unwrap_or(1);
    conn.execute(
        "INSERT INTO agent_steps (run_id, seq, kind, label, detail, ok, ts) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        rusqlite::params![run_id, next, kind, label, detail, ok, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    if kind == "tool_call" {
        conn.execute(
            "UPDATE agent_runs SET tool_calls = tool_calls + 1 WHERE id = ?1",
            rusqlite::params![run_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn finish(
    store: &Store,
    run_id: &str,
    status: String,
    iterations: i64,
    error: Option<String>,
) -> Result<(), String> {
    if !RUN_STATUSES.contains(&status.as_str()) {
        return Err(format!("unknown run status '{status}'"));
    }
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE agent_runs SET status=?2, iterations=?3, error=?4, ended_at=?5 WHERE id=?1",
        rusqlite::params![run_id, status, iterations, error, now_ms()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn runs(store: &Store, limit: usize) -> Result<Vec<AgentRun>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, session_id, model, status, prompt, iterations, tool_calls, started_at, ended_at, error
             FROM agent_runs ORDER BY started_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit as i64], |r| {
            Ok(AgentRun {
                id: r.get(0)?,
                session_id: r.get(1)?,
                model: r.get(2)?,
                status: r.get(3)?,
                prompt: r.get(4)?,
                iterations: r.get(5)?,
                tool_calls: r.get(6)?,
                started_at: r.get(7)?,
                ended_at: r.get(8)?,
                error: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let out = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn steps(store: &Store, run_id: &str) -> Result<Vec<AgentStep>, String> {
    let conn = store.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT seq, kind, label, detail, ok, ts FROM agent_steps WHERE run_id=?1 ORDER BY seq ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![run_id], |r| {
            Ok(AgentStep {
                seq: r.get(0)?,
                kind: r.get(1)?,
                label: r.get(2)?,
                detail: r.get(3)?,
                ok: r.get::<_, Option<i64>>(4)?.map(|v| v != 0),
                ts: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let out = rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod orchestrator_tests {
    use super::*;

    fn temp_store(tag: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-orch-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::open(&dir).unwrap(), dir)
    }

    #[test]
    fn a_run_is_recorded_as_it_happens_not_at_the_end() {
        let (s, d) = temp_store("record");
        start(&s, "r1".into(), Some("s1".into()), "m".into(), Some("do it".into())).unwrap();
        step(&s, "r1", "tool_call".into(), Some("read_file".into()), None, None).unwrap();
        step(
            &s,
            "r1",
            "tool_result".into(),
            Some("read_file".into()),
            Some("ok".into()),
            Some(true),
        )
        .unwrap();
        // Readable mid-run, before any finish call.
        let all = runs(&s, 10).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].status, "running");
        assert_eq!(all[0].tool_calls, 1, "tool calls counted as they land");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn steps_come_back_in_order_even_within_one_millisecond() {
        let (s, d) = temp_store("order");
        start(&s, "r1".into(), None, "m".into(), None).unwrap();
        for i in 0..5 {
            step(&s, "r1", "tool_call".into(), Some(format!("t{i}")), None, None).unwrap();
        }
        let st = steps(&s, "r1").unwrap();
        let seqs: Vec<i64> = st.iter().map(|x| x.seq).collect();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5]);
        let labels: Vec<String> = st.into_iter().map(|x| x.label.unwrap()).collect();
        assert_eq!(labels, vec!["t0", "t1", "t2", "t3", "t4"]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn finishing_records_the_outcome_and_the_duration_is_derivable() {
        let (s, d) = temp_store("finish");
        start(&s, "r1".into(), None, "m".into(), None).unwrap();
        finish(&s, "r1", "ok".into(), 3, None).unwrap();
        let all = runs(&s, 10).unwrap();
        assert_eq!(all[0].status, "ok");
        assert_eq!(all[0].iterations, 3);
        assert!(all[0].ended_at.is_some());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_crashed_run_stays_running_because_we_did_not_observe_otherwise() {
        let (s, d) = temp_store("crash");
        start(&s, "r1".into(), None, "m".into(), None).unwrap();
        assert_eq!(runs(&s, 10).unwrap()[0].status, "running");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unknown_vocabularies_are_refused() {
        let (s, d) = temp_store("vocab");
        start(&s, "r1".into(), None, "m".into(), None).unwrap();
        assert!(step(&s, "r1", "telepathy".into(), None, None, None).is_err());
        assert!(finish(&s, "r1", "maybe".into(), 0, None).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn deleting_a_run_takes_its_steps_with_it() {
        let (s, d) = temp_store("cascade");
        start(&s, "r1".into(), None, "m".into(), None).unwrap();
        step(&s, "r1", "tool_call".into(), Some("t".into()), None, None).unwrap();
        {
            let conn = s.conn.lock().unwrap();
            conn.execute("PRAGMA foreign_keys = ON", []).unwrap();
            conn.execute("DELETE FROM agent_runs WHERE id='r1'", []).unwrap();
        }
        assert!(steps(&s, "r1").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }
}
