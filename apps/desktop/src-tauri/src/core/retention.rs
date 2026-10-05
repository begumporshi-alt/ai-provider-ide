//! The memory-layer retention scheduler — the half the webview timer could never be.
//!
//! Memory and live-context retention ran off a timer in the webview
//! (`src/lib/memory/retention.ts`), which works while a webview exists and is exactly nothing
//! where one never does: the headless daemon serves `/admin/memory/prune` and
//! `/admin/context/prune` but nothing ever called them, so both tables grew without limit for
//! as long as the daemon ran (2026-10-04 audit, P2). This module is the fix: one task per core,
//! one interval, two gated jobs.
//!
//! **What runs, and what gates it.** `memory::prune_step` + `session_context::prune_step`, in
//! bounded chunks, gated on the memory master toggle (`core.memory_enabled()`), the same rule
//! the webview's `pruneOnce` applies: with the layer off the request path writes neither table,
//! and the off-by-default guarantee is that the layer performs no writes at all — which has to
//! include deletes. A user's memories are not touched because a feature they never switched on
//! is doing housekeeping.
//!
//! **Why the pass is budgeted.** Every request and every prune share the store's one writer
//! lock, and SQLite has no statement timeout — the thing that bounds a prune is the statement
//! itself. The prunes therefore delete in [`CHUNK_ROWS`] batches under a [`PASS_BUDGET`] of wall
//! clock; a backlog that outlives the budget waits for the next tick instead of holding the
//! lock. On small tables the budget never fires and a pass is a few milliseconds — the
//! insurance exists for the state this module was born from: a daemon that ran for months
//! without anyone pruning, whose first boot pass could otherwise have met a six-figure backlog
//! in one statement. (Shape borrowed from LiteLLM's `spend_log_cleanup`: batch size, run
//! budget, and a stop reason on every run.)
//!
//! Agent runs are **not** this module's business: they are gateway activity records, written
//! regardless of the toggle, and they are already bounded by `persist::retention_job` (boot +
//! daily, both runtimes) — deliberately by *removal* rather than re-marking; see the note in
//! its doc comment before changing that.
//!
//! **Coexistence with the webview timer.** The desktop keeps its timer, and this scheduler runs
//! alongside it: two idempotent bounded DELETEs per half hour, serialized by the store's
//! connection lock, overlap harmlessly. Unifying them would mean threading a command channel
//! from webview to Rust to save one scan per half hour — not worth the surface.
//!
//! **One scheduler per core, not per spawn.** `gateway_enable` can be called repeatedly across
//! a process's life and the daemon spawns once at boot; either way [`interval`] claims the core
//! once (`GatewayCore::claim_retention_scheduler`) and later claimants stand down.
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::core::drift;
use crate::core::gateway::session_context::{self, PruneStats};
use crate::core::gateway::GatewayCore;
use crate::core::memory::{self, MemoryPruneStats};
use crate::core::store::Store;

/// Half an hour, matching the webview's `IDLE_INTERVAL_MS`. A pass is a handful of bounded
/// DELETEs over two small tables; more often buys nothing, less often lets the ring caps drift
/// behind activity.
pub const RETENTION_SECS: u64 = 30 * 60;

/// Rows per DELETE. Small enough that one statement holds the store's single writer lock for
/// milliseconds even against a backlog; large enough that a backlog converges in a handful of
/// batches per pass.
pub const CHUNK_ROWS: i64 = 500;

/// Wall clock one pass may spend before handing the remainder to the next tick. The number is
/// not the point — the *bound* is: housekeeping can be slow, but it can never hold the lock
/// indefinitely.
pub const PASS_BUDGET: Duration = Duration::from_secs(5);

/// The clock a pass runs against. A plain `(started, budget)` pair rather than a deadline check
/// buried in the loop, so tests can hand the pass an already-expired budget and assert, with no
/// sleeps, that it runs nothing and says so.
#[derive(Debug, Clone, Copy)]
pub struct PassBudget {
    started: Instant,
    budget: Duration,
}

impl PassBudget {
    pub fn new(budget: Duration) -> Self {
        Self { started: Instant::now(), budget }
    }

    fn expired(&self) -> bool {
        self.started.elapsed() >= self.budget
    }
}

#[derive(Debug, Default)]
pub struct RetentionPass {
    /// Memory retention, when the layer was on.
    pub memory: Option<MemoryPruneStats>,
    /// Live-context retention, when the layer was on.
    pub context: Option<PruneStats>,
    /// The memory layer's master switch was off: memory and live context were untouched, the
    /// same rule the webview scheduler applies.
    pub memory_layer_skipped: bool,
    /// Drift triggers raised this pass (A1 follow-up: the Rust half of the drift monitor).
    pub drift_triggers: usize,
    /// The pass stopped with work left on the table because the wall-clock budget ran out; the
    /// remainder waits for the next tick. On small tables this is always false — the budget is
    /// insurance for a backlog, not a feature a healthy store ever sees.
    pub budget_exhausted: bool,
}

/// One retention pass. Split from the scheduler so it can be tested without a runtime, and so
/// a host that wants to drive it synchronously can.
pub fn pass(
    store: Option<&Arc<Store>>,
    memory_enabled: bool,
    budget: &PassBudget,
) -> Result<RetentionPass, String> {
    let mut out = RetentionPass::default();
    let Some(store) = store else {
        return Ok(out);
    };

    // Drift detection is gateway activity, not memory-layer state: evaluated **ungated**, the
    // same rule `persist::retention_job` applies to the ledger and agent runs it tends. This is
    // the Rust half of the drift monitor (A1 follow-up): the TS monitor went blind when
    // generation moved to the gateway, and this pass is what keeps the repair flow fed.
    out.drift_triggers = drift::evaluate(store, now_ms())?.len();

    if !memory_enabled {
        out.memory_layer_skipped = true;
        return Ok(out);
    }

    loop {
        // The clock is checked *between* batches, never mid-statement: a batch is one bounded
        // DELETE, and the worst-case lock hold is one batch, not one policy.
        if budget.expired() {
            out.budget_exhausted = true;
            break;
        }
        let mem = memory::prune_step(store, CHUNK_ROWS)?;
        let ctx = session_context::prune_step(store, CHUNK_ROWS)?;
        let maybe_more = memory_capped(&mem) || context_capped(&ctx);
        fold_memory(&mut out.memory, mem);
        fold_context(&mut out.context, ctx);
        if !maybe_more {
            break;
        }
    }
    Ok(out)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn fold_memory(acc: &mut Option<MemoryPruneStats>, step: MemoryPruneStats) {
    match acc {
        Some(a) => {
            a.l0_expired += step.l0_expired;
            a.l0_ring += step.l0_ring;
            a.decayed += step.decayed;
        }
        None => *acc = Some(step),
    }
}

fn fold_context(acc: &mut Option<PruneStats>, step: PruneStats) {
    match acc {
        Some(a) => {
            a.turns_by_count += step.turns_by_count;
            a.turns_by_age += step.turns_by_age;
            a.sessions_reaped += step.sessions_reaped;
        }
        None => *acc = Some(step),
    }
}

/// A policy that returned a full chunk may have more where that came from — the loop's
/// keep-going signal. `>=` rather than `==` because a count can only reach the cap by the cap.
fn memory_capped(s: &MemoryPruneStats) -> bool {
    let cap = CHUNK_ROWS as usize;
    s.l0_expired >= cap || s.l0_ring >= cap || s.decayed >= cap
}

fn context_capped(s: &PruneStats) -> bool {
    let cap = CHUNK_ROWS as usize;
    s.turns_by_count >= cap || s.turns_by_age >= cap || s.sessions_reaped >= cap
}

/// The scheduler itself: a boot pass (so a freshly started daemon trims before its first idle
/// window — the webview does the same "one pass at start"), then a pass every
/// [`RETENTION_SECS`]. Errors are logged and non-fatal; a failed prune must never take the
/// gateway down with it.
pub async fn interval(core: Arc<GatewayCore>) {
    if !core.claim_retention_scheduler() {
        return;
    }

    run_pass(&core);
    let mut ticker = tokio::time::interval(Duration::from_secs(RETENTION_SECS));
    ticker.tick().await; // an interval fires immediately; the boot pass above already ran
    loop {
        ticker.tick().await;
        run_pass(&core);
    }
}

fn run_pass(core: &GatewayCore) {
    let budget = PassBudget::new(PASS_BUDGET);
    match pass(core.store(), core.memory_enabled(), &budget) {
        Ok(p) => {
            tracing::debug!(?p, "memory retention pass ran");
            if something_removed(&p) || p.budget_exhausted {
                tracing::info!(memory = ?p.memory, context = ?p.context,
                    budget_exhausted = p.budget_exhausted,
                    "memory retention pass removed rows");
            }
        }
        Err(e) => tracing::warn!("memory retention pass failed (non-fatal): {e}"),
    }
}

/// Silent passes are the norm (nothing to remove); a pass that removed something — or ran out
/// of budget — is the event an operator watching the log wants to see. The audit's complaint
/// was precisely that this job was invisible.
fn something_removed(p: &RetentionPass) -> bool {
    p.memory.is_some_and(|m| m.l0_expired + m.l0_ring + m.decayed > 0)
        || p.context.is_some_and(|c| c.turns_by_count + c.turns_by_age + c.sessions_reaped > 0)
}

#[cfg(test)]
mod retention_tests {
    use super::*;

    fn temp_store(tag: &str) -> (Arc<Store>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("aip-retain-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (Arc::new(Store::open(&dir).unwrap()), dir)
    }

    /// `n` unowned L0 memories with epoch timestamps: expired by TTL, below every ring, and old
    /// enough that any policy in the module wants them gone.
    fn seed_stale_memories(store: &Store, n: usize) {
        let conn = store.conn.lock().unwrap();
        for i in 0..n {
            conn.execute(
                "INSERT INTO memories (id, layer, text, session_id, created_at, updated_at, pinned)
                 VALUES (?1, 'L0', ?2, 'seed-session', 1, 1, 0)",
                rusqlite::params![format!("seed-{i}"), format!("stale fact {i}")],
            )
            .unwrap();
        }
    }

    fn memory_total(p: &RetentionPass) -> usize {
        p.memory.as_ref().map(|m| m.l0_expired + m.l0_ring + m.decayed).unwrap_or(0)
    }

    #[test]
    fn with_the_layer_off_the_pass_takes_nothing_and_skips() {
        let (store, d) = temp_store("off");
        let budget = PassBudget::new(Duration::from_secs(60));
        let p = pass(Some(&store), false, &budget).unwrap();
        assert!(p.memory_layer_skipped);
        assert!(p.memory.is_none());
        assert!(p.context.is_none());
        assert!(!something_removed(&p));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn with_the_layer_on_the_pass_runs_both_jobs() {
        let (store, d) = temp_store("on");
        // No rows anywhere: a pass over an empty store removed nothing, which is neither an
        // error nor a skip.
        let budget = PassBudget::new(Duration::from_secs(60));
        let p = pass(Some(&store), true, &budget).unwrap();
        assert!(!p.memory_layer_skipped);
        assert!(p.memory.is_some());
        assert!(p.context.is_some());
        assert!(!something_removed(&p));
        assert!(!p.budget_exhausted);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_pass_without_a_store_removes_nothing_and_fails_nothing() {
        let budget = PassBudget::new(Duration::from_secs(60));
        let p = pass(None, true, &budget).unwrap();
        assert!(!p.memory_layer_skipped);
        assert!(p.memory.is_none());
        assert!(p.context.is_none());
    }

    #[test]
    fn an_expired_budget_runs_nothing_and_says_so() {
        let (store, d) = temp_store("expired");
        seed_stale_memories(&store, 5);
        let budget = PassBudget::new(Duration::ZERO);
        let p = pass(Some(&store), true, &budget).unwrap();
        // The clock is checked before the first batch, so an expired budget runs zero batches —
        // and reports the fact instead of a silent no-op.
        assert!(p.budget_exhausted);
        assert_eq!(memory_total(&p), 0);
        let conn = store.conn.lock().unwrap();
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0)).unwrap();
        drop(conn);
        assert_eq!(left, 5, "an expired budget deletes nothing: rows wait for the next tick");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_chunked_step_takes_at_most_the_chunk_and_leaves_the_rest() {
        let (store, d) = temp_store("chunk");
        seed_stale_memories(&store, 5);
        // The batch primitive the budget leans on: one statement, at most `chunk` victims, the
        // remainder untouched for the next batch (or the next tick).
        assert_eq!(memory::prune_step(&store, 2).unwrap().l0_expired, 2);
        assert_eq!(memory::prune_step(&store, 2).unwrap().l0_expired, 2);
        assert_eq!(
            memory::prune_step(&store, 2).unwrap().l0_expired,
            1,
            "the remainder, not a padded batch"
        );
        let conn = store.conn.lock().unwrap();
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0)).unwrap();
        drop(conn);
        assert_eq!(left, 0, "drained exactly across the batches");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_backlog_outliving_the_budget_is_picked_up_by_the_next_pass() {
        let (store, d) = temp_store("resume");
        seed_stale_memories(&store, 5);

        // Tick one: no budget to spend. Tick two: a real budget — the same rows, now drained.
        let empty = PassBudget::new(Duration::ZERO);
        pass(Some(&store), true, &empty).unwrap();
        let next = PassBudget::new(Duration::from_secs(60));
        let p = pass(Some(&store), true, &next).unwrap();
        assert!(!p.budget_exhausted);
        assert_eq!(memory_total(&p), 5, "the second pass drains what the first deferred");
        let conn = store.conn.lock().unwrap();
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0)).unwrap();
        drop(conn);
        assert_eq!(left, 0);
        let _ = std::fs::remove_dir_all(&d);
    }
}
