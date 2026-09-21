//! Rolling record of what the memory layer did, for the Control screen.
//!
//! The `AIP-Memory` header is built on every response and then dropped — it goes to the client and
//! nowhere else. That left the operator with no way to answer "why didn't the model know X" without
//! attaching a proxy. This module keeps a bounded, in-memory copy.
//!
//! Two properties matter, and both are load-bearing:
//!
//! - **No database write.** The memory path is built never to block a request (`MEMORY_DEADLINE`,
//!   15 ms). Telemetry must not either, so this is deliberately in-memory: one uncontended mutex per
//!   request is the entire cost. A per-request row in SQLite would contradict the design it observes.
//! - **Counters outlive the ring.** The ring holds the last [`RING`] events; the counts are
//!   lifetime-of-process. So "is this mostly working?" still has an answer after the detail that
//!   produced it has scrolled away.
//!
//! The cost of the in-memory choice is that everything here dies with the process. That is accepted:
//! the question this answers is "what is happening now", and a restart is a clean slate anyway.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;

/// How many recent events the ring holds.
///
/// Bounded because the queue is written once per request — without a cap a long-lived gateway
/// accumulates one entry per request for ever.
pub const RING: usize = 100;

/// One request's memory outcome.
///
/// **Carries scope and counts, never memory text.** The injected block is already in the prompt;
/// duplicating it into a diagnostic buffer would add exposure for no diagnostic gain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectionEvent {
    pub ts_ms: i64,
    /// The client-visible request id (`gw-{n}`), so a row here can be matched against the Activity
    /// ledger. Not the capture id — that one is `gw-{millis}-{pid}-{n}` and means something else.
    pub id: String,
    pub model: String,
    /// `user=local;project=…;agent=…`, exactly as reported on the response header.
    pub scope: String,
    pub injected: bool,
    pub items: usize,
    /// Live-context turns injected alongside the memory block. Reported separately because the two
    /// come from different stores and "memory was empty but context was not" is a real case.
    pub context: usize,
    pub tokens: usize,
    /// `SkipReason::as_str()`. `"injected"` on success, so one map covers both outcomes.
    pub reason: String,
}

/// A snapshot for the UI. `recent` is newest-first, which is the order it renders.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectionStats {
    /// Every request recorded since the process started — **not** the ring length.
    pub total: u64,
    /// Counts by reason, including `injected`. Survives ring eviction.
    pub counts: HashMap<String, u64>,
    pub recent: Vec<InjectionEvent>,
}

/// The ring plus its counters. Behind one mutex so a reader gets a consistent pair — a snapshot
/// taken across two locks could show a count that disagrees with the list beside it.
#[derive(Debug, Default)]
pub struct InjectionLog {
    recent: VecDeque<InjectionEvent>,
    counts: HashMap<String, u64>,
    total: u64,
}

impl InjectionLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one request. Evicts the oldest event once the ring is full; the count is kept.
    pub fn record(&mut self, ev: InjectionEvent) {
        *self.counts.entry(ev.reason.clone()).or_insert(0) += 1;
        self.total += 1;
        // `>=`, not `==`: the invariant is "never exceeds RING", and expressing it that way keeps it
        // true if a future caller ever pushes more than one event per call.
        while self.recent.len() >= RING {
            self.recent.pop_front();
        }
        self.recent.push_back(ev);
    }

    pub fn snapshot(&self) -> InjectionStats {
        InjectionStats {
            total: self.total,
            counts: self.counts.clone(),
            recent: self.recent.iter().rev().cloned().collect(),
        }
    }

    /// Events currently held — the ring length, capped at [`RING`].
    ///
    /// Test-only on purpose: the UI reads `snapshot().recent.len()`, which is the same number and
    /// arrives with the events it describes, so a separate accessor would be a second lock taken to
    /// learn nothing new.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.recent.len()
    }
}

/// Milliseconds since the epoch, for event timestamps.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod injection_log_tests {
    use super::*;

    fn ev(reason: &str) -> InjectionEvent {
        InjectionEvent {
            ts_ms: now_ms(),
            id: "gw-1".into(),
            model: "m".into(),
            scope: "user=local;project=-;agent=-".into(),
            injected: reason == "injected",
            items: 0,
            context: 0,
            tokens: 0,
            reason: reason.into(),
        }
    }

    #[test]
    fn the_ring_evicts_the_oldest_and_keeps_the_newest() {
        let mut log = InjectionLog::new();
        for i in 0..RING + 5 {
            let mut e = ev("no_candidates");
            e.id = format!("gw-{i}");
            log.record(e);
        }
        assert_eq!(log.len(), RING, "the ring is capped");
        let snap = log.snapshot();
        assert_eq!(snap.recent.len(), RING);
        // Newest first, so the head is the last one recorded.
        assert_eq!(snap.recent[0].id, format!("gw-{}", RING + 4));
        // And the first five are gone.
        assert_eq!(snap.recent[RING - 1].id, "gw-5");
    }

    /// The property the whole in-memory choice rests on: detail is bounded, the aggregate is not.
    /// A counter that reset with the ring would make "mostly working?" unanswerable after 100
    /// requests, which is exactly when it becomes interesting.
    #[test]
    fn counters_survive_ring_eviction() {
        let mut log = InjectionLog::new();
        for _ in 0..RING * 3 {
            log.record(ev("no_candidates"));
        }
        let snap = log.snapshot();
        assert_eq!(snap.recent.len(), RING, "detail is capped");
        assert_eq!(snap.total, (RING * 3) as u64, "the total is not");
        assert_eq!(snap.counts.get("no_candidates"), Some(&((RING * 3) as u64)));
    }

    #[test]
    fn reasons_are_counted_separately_and_injected_is_one_of_them() {
        let mut log = InjectionLog::new();
        log.record(ev("injected"));
        log.record(ev("no_candidates"));
        log.record(ev("no_candidates"));
        log.record(ev("deadline"));
        let snap = log.snapshot();
        assert_eq!(snap.total, 4);
        assert_eq!(snap.counts.get("injected"), Some(&1));
        assert_eq!(snap.counts.get("no_candidates"), Some(&2));
        assert_eq!(snap.counts.get("deadline"), Some(&1));
        // A reason that never happened is absent, not zero — the UI shows what occurred.
        assert_eq!(snap.counts.get("below_floor"), None);
    }

    #[test]
    fn an_empty_log_snapshots_cleanly() {
        let snap = InjectionLog::new().snapshot();
        assert_eq!(snap.total, 0);
        assert!(snap.counts.is_empty());
        assert!(snap.recent.is_empty());
    }

    /// The ring must not carry content. This pins the privacy note on `InjectionEvent`: if someone
    /// later adds a text field, this test is where the decision gets re-examined.
    #[test]
    fn an_event_carries_no_memory_text() {
        let mut log = InjectionLog::new();
        let mut e = ev("injected");
        e.items = 3;
        e.tokens = 96;
        e.context = 1;
        log.record(e);
        let snap = log.snapshot();
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("items"));
        // The scope is present; nothing resembling an atom body is.
        assert!(json.contains("project"));
        assert!(!json.contains("memory"), "no injected block, and no field named for it");
    }

    /// The wire names are a contract with the webview: every DTO returned from `gateway_cmds` is
    /// camelCase, and the Control screen reads these fields by name. Dropping `rename_all` would
    /// break the screen at runtime with no compile error anywhere to warn about it.
    #[test]
    fn the_wire_names_are_camel_case() {
        let mut log = InjectionLog::new();
        log.record(ev("injected"));
        let json = serde_json::to_string(&log.snapshot()).unwrap();
        for key in ["tsMs", "total", "counts", "recent", "reason", "injected"] {
            assert!(json.contains(key), "missing `{key}` in {json}");
        }
        assert!(!json.contains("ts_ms"), "snake_case leaked onto the wire: {json}");
    }
}
