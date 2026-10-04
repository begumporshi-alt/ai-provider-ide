//! The memory-layer retention scheduler — the half the webview timer could never be.
//!
//! Memory and live-context retention ran off a timer in the webview
//! (`src/lib/memory/retention.ts`), which works while a webview exists and is exactly nothing
//! where one never does: the headless daemon serves `/admin/memory/prune` and
//! `/admin/context/prune` but nothing ever called them, so both tables grew without limit for
//! as long as the daemon ran (2026-10-04 audit, P2). This module is the fix: one task per core,
//! one interval, two gated jobs.
//!
//! **What runs, and what gates it.** `memory::prune` + `session_context::prune`, gated on the
//! memory master toggle (`core.memory_enabled()`), the same rule the webview's `pruneOnce`
//! applies: with the layer off the request path writes neither table, and the off-by-default
//! guarantee is that the layer performs no writes at all — which has to include deletes. A
//! user's memories are not touched because a feature they never switched on is doing
//! housekeeping.
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
use std::time::Duration;

use crate::core::gateway::session_context::{self, PruneStats};
use crate::core::gateway::GatewayCore;
use crate::core::memory::{self, MemoryPruneStats};
use crate::core::store::Store;

/// Half an hour, matching the webview's `IDLE_INTERVAL_MS`. A pass is a handful of bounded
/// DELETEs over two small tables; more often buys nothing, less often lets the ring caps drift
/// behind activity.
pub const RETENTION_SECS: u64 = 30 * 60;

#[derive(Debug, Default)]
pub struct RetentionPass {
    /// Memory retention, when the layer was on.
    pub memory: Option<MemoryPruneStats>,
    /// Live-context retention, when the layer was on.
    pub context: Option<PruneStats>,
    /// The memory layer's master switch was off: memory and live context were untouched, the
    /// same rule the webview scheduler applies.
    pub memory_layer_skipped: bool,
}

/// One retention pass. Split from the scheduler so it can be tested without a runtime, and so
/// a host that wants to drive it synchronously can.
pub fn pass(store: Option<&Arc<Store>>, memory_enabled: bool) -> Result<RetentionPass, String> {
    let mut out = RetentionPass::default();
    let Some(store) = store else {
        return Ok(out);
    };

    if memory_enabled {
        out.memory = Some(memory::prune(store)?);
        out.context = Some(session_context::prune(store)?);
    } else {
        out.memory_layer_skipped = true;
    }
    Ok(out)
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
    match pass(core.store(), core.memory_enabled()) {
        Ok(p) => {
            tracing::debug!(?p, "memory retention pass ran");
            if something_removed(&p) {
                tracing::info!(memory = ?p.memory, context = ?p.context,
                    "memory retention pass removed rows");
            }
        }
        Err(e) => tracing::warn!("memory retention pass failed (non-fatal): {e}"),
    }
}

/// Silent passes are the norm (nothing to remove); a pass that removed something is the event
/// an operator watching the log wants to see — the audit's complaint was precisely that this
/// job was invisible.
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

    #[test]
    fn with_the_layer_off_the_pass_takes_nothing_and_skips() {
        let (store, d) = temp_store("off");
        let p = pass(Some(&store), false).unwrap();
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
        let p = pass(Some(&store), true).unwrap();
        assert!(!p.memory_layer_skipped);
        assert!(p.memory.is_some());
        assert!(p.context.is_some());
        assert!(!something_removed(&p));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_pass_without_a_store_removes_nothing_and_fails_nothing() {
        let p = pass(None, true).unwrap();
        assert!(!p.memory_layer_skipped);
        assert!(p.memory.is_none());
        assert!(p.context.is_none());
    }
}
