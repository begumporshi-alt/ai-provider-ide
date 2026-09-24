//! The usage ledger (L3): in-memory ring buffer + optional persistence sink.
//!
//! The port of `usage-ledger.ts` (115 lines), which is what `model-router.ts` calls to record every
//! request — success, failure, and no-route. It is the blocker for the model router: without it,
//! `generateText`, `generateImage` and `complete` would all be stubbed at their ledger append.
//!
//! **Two pieces, and one already exists.** `LedgerRow` is `persist::LedgerRow` (`persist.rs:459`)
//! — the wire shape the webview sends and the SQL INSERT receives. This module adds the *buffer* and
//! the *query* surface that the router reads.
//!
//! **The sink is a trait, not a struct of callbacks — the same lesson as `PlanContext`.** A struct
//! holding `&'a dyn Fn(..)` cannot be built from inline closures in tests; a trait lets the fixture
//! be the sink. The trait has one method: `append`, which returns a `Result` so a full disk or a
//! locked database can be observed rather than silently swallowed.
//!
//! **The in-memory buffer is a `VecDeque`, not a `Vec`.** The TypeScript `splice(0, over)` on an
//! array is `O(n)` because every element shifts down; `VecDeque::pop_front` is `O(1)`. The
//! observable behaviour is identical — oldest entries drop first — and the performance difference
//! matters only at the 50,000-entry bound, but `VecDeque` is the right shape for a ring buffer and
//! costs nothing to use.
//!
//! **Query returns owned rows, not references.** The TypeScript `query` returns `LedgerEntry[]`,
//! which is a copy of the filtered subset; the Rust port clones each matching row. This is
//! deliberate: the caller may hold the result longer than the next `append`, and a reference would
//! pin the buffer's lifetime to the caller's.
//!
//! **Sorting is newest-first (`b.ts - a.ts`), and the TypeScript spells it the same way.** A stable
//! sort is not needed because `ts` is a millisecond timestamp and collisions are rare; when they
//! happen, the order is arbitrary and that is fine.
//!
//! **`evicted_count` and `oldest_ts` are the honesty mechanism.** A query with `since` before
//! `oldest_ts` is incomplete, and the caller must know that rather than assuming silence means no
//! traffic. The TypeScript exposes `evictedCount` and `oldestTs()` for the same reason.

use std::collections::VecDeque;
use std::sync::Arc;

use crate::core::error::ui_db_error;
use crate::core::persist::{ledger_insert, LedgerRow};
use crate::core::store::Store;

/// How many entries the in-memory mirror keeps. The database is the record — every entry still
/// goes to the sink — so this bounds only the window the Usage screen can answer without re-reading
/// it. Left unbounded, the array grew for the lifetime of the process: a gateway left running holds
/// every request it ever served in RAM, forever, and `ledger_rollup_run` prunes the database without
/// ever touching this copy.
pub const DEFAULT_MAX_MEM_ENTRIES: usize = 50_000;

/// Something that can persist a ledger row. The port of `LedgerSink` (`usage-ledger.ts:54-56`).
///
/// A trait rather than a struct of `&dyn Fn` fields — see the module note. The one method returns
/// `Result` so a full disk or a locked database is observable rather than silently swallowed.
pub trait LedgerSink {
    fn append(&self, entry: &LedgerRow) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
}

/// A [`LedgerSink`] that writes through the store — the desktop's sink, in Rust. Increment 25d.
///
/// The port of `store.ts:98-100`, where the webview's `UsageLedger` is built with a sink whose whole
/// body is `await invoke("ledger_append", { e })`. **The Rust sink needs no command**: it calls
/// [`ledger_insert`] on the store's own connection, which is exactly what the command calls. The
/// command stays, because the webview has no other way in.
///
/// **The error is sanitised, because this one reaches a client.** `UsageLedger::append` returns the
/// sink's error, the router turns it into `RouterError::Ledger`, and `router_bridge.rs:602` answers
/// that with **502** — so *"ledger write failed: {detail}"* is a client-visible string. The rusqlite
/// detail is therefore logged host-side and the boundary returns the stable sentence
/// [`ui_db_error`] gives, exactly as a `#[tauri::command]` does. A sink that returned
/// `e.to_string()` here would put SQL text and absolute paths on the wire.
///
/// **It holds an `Arc<Store>`, not a `&Store`,** because the ledger outlives any borrow: it is
/// installed once into `SharedRouterState`, which is `'static` and cloned per request.
///
/// **The write is synchronous and runs while the caller holds the ledger's lock** — `append` is a
/// `&mut self` method reached through `SharedRouterState::ledger()`, a `MutexGuard`. So concurrent
/// requests serialise their ledger writes, which is the same shape the reference has (an awaited
/// sink call inside the ledger's own critical section) and costs one local INSERT. The lock order is
/// always `ledger → conn` and never the reverse, so this cannot deadlock: nothing in `persist`
/// reaches back for the ledger.
#[derive(Clone)]
pub struct StoreLedgerSink {
    store: Arc<Store>,
}

impl StoreLedgerSink {
    /// A sink over one store. The `Arc` is shared rather than owned so the same handle can be given
    /// to the ledger and kept by the launch that built it.
    pub fn new(store: Arc<Store>) -> Self {
        Self { store }
    }
}

impl LedgerSink for StoreLedgerSink {
    fn append(&self, entry: &LedgerRow) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // `panic = "abort"` is set, so a poisoned lock is not a state this can reach.
        let conn = self.store.conn.lock().unwrap();
        ledger_insert(&conn, entry).map_err(|e| ui_db_error(&e).into())
    }
}

/// In-memory ring buffer of ledger entries, with an optional persistence sink.
///
/// The port of `UsageLedger` (`usage-ledger.ts:68-114`).
pub struct UsageLedger {
    mem: VecDeque<LedgerRow>,
    evicted: u64,
    sink: Option<Box<dyn LedgerSink + Send + Sync>>,
    max_entries: usize,
}

impl Default for UsageLedger {
    fn default() -> Self {
        Self::with_capacity(DEFAULT_MAX_MEM_ENTRIES)
    }
}

impl UsageLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(max_entries: usize) -> Self {
        Self { mem: VecDeque::new(), evicted: 0, sink: None, max_entries }
    }

    /// Attach a persistence sink. The TypeScript constructor takes it at build time; the port
    /// separates construction from wiring so the router can build the ledger before it knows
    /// whether a sink is available (headless service may not have one).
    pub fn with_sink(mut self, sink: Box<dyn LedgerSink + Send + Sync>) -> Self {
        self.sink = Some(sink);
        self
    }

    /// Record one entry. The port of `UsageLedger.append` (`:76-86`).
    ///
    /// **The sink is called before the trim**, so a full disk does not lose the in-memory copy
    /// either: the entry is in `mem` regardless of whether the sink succeeded. The TypeScript does
    /// the same — `this.mem.push(e)` before `await this.sink.append(e)` — and the reason is that
    /// a failed sink must not make the query lie about what the router saw.
    ///
    /// **The sink error is returned, not logged and swallowed.** The TypeScript `await` would throw
    /// and the caller would see it; the port keeps that contract. A router that wants to ignore it
    /// can `let _ = ledger.append(e).await`.
    pub fn append(
        &mut self,
        entry: LedgerRow,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.mem.push_back(entry);
        if let Some(ref sink) = self.sink {
            // The entry is already in `mem`, so a sink failure does not lose data.
            sink.append(self.mem.back().unwrap())?;
        }
        // Trim after the append, not before: the newest entry survives even at max_entries=1, and
        // the sink has already seen every entry, so dropping one from memory loses no data.
        let over = self.mem.len().saturating_sub(self.max_entries.max(1));
        if over > 0 {
            for _ in 0..over {
                self.mem.pop_front();
            }
            self.evicted += over as u64;
        }
        Ok(())
    }

    /// How many entries have fallen out of the in-memory window.
    ///
    /// Non-zero means `query({ since })` cannot answer about the oldest traffic: those rows are in
    /// the database, not here. Reporting the count is the point — a silently truncated result looks
    /// like "there was no traffic then", which is exactly the kind of blank the ledger exists to
    /// explain rather than produce.
    pub fn evicted_count(&self) -> u64 {
        self.evicted
    }

    /// Oldest timestamp still in memory — `query({ since })` before this is incomplete.
    pub fn oldest_ts(&self) -> Option<i64> {
        self.mem.iter().map(|e| e.ts).min()
    }

    /// Filtered, sorted newest-first. The port of `UsageLedger.query` (`:107-113`).
    ///
    /// **Cloned rows, not references** — see the module note. The sort is `b.ts.cmp(&a.ts)`,
    /// newest-first, matching the TypeScript's `b.ts - a.ts`.
    pub fn query(&self, filter: &LedgerFilter) -> Vec<LedgerRow> {
        let mut out: Vec<LedgerRow> = self
            .mem
            .iter()
            .filter(|e| filter.since.is_none_or(|s| e.ts >= s))
            .filter(|e| filter.source.as_ref().is_none_or(|s| &e.source == s))
            .filter(|e| {
                filter.provider_id.as_ref().is_none_or(|p| e.provider_id.as_ref() == Some(p))
            })
            .cloned()
            .collect();
        out.sort_by_key(|a| std::cmp::Reverse(a.ts));
        out
    }
}

/// What `query` filters by. The port of the anonymous object `filter: { since?, source?, providerId? }`.
#[derive(Default, Debug, Clone)]
pub struct LedgerFilter {
    pub since: Option<i64>,
    pub source: Option<String>,
    pub provider_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    fn row(ts: i64, source: &str, provider_id: Option<&str>) -> LedgerRow {
        LedgerRow {
            ts,
            modality: "text".to_string(),
            source: source.to_string(),
            provider_id: provider_id.map(|s| s.to_string()),
            key_id: None,
            app_key_id: None,
            requested_model: None,
            model: "m1".to_string(),
            status: "ok".to_string(),
            http_status: None,
            error_class: None,
            latency_ms: None,
            tokens_in: 0,
            tokens_out: 0,
            cost_estimate_micros: 0,
            cached_tokens: None,
            fallback_chain_json: None,
        }
    }

    // ---- append and basic shape -----------------------------------------------------------

    #[test]
    fn an_append_is_immediately_queryable() {
        let mut ledger = UsageLedger::with_capacity(10);
        let e = row(1000, "ui", Some("pA"));
        ledger.append(e.clone()).unwrap();
        let q = ledger.query(&LedgerFilter::default());
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].ts, 1000);
    }

    #[test]
    fn query_returns_newest_first() {
        let mut ledger = UsageLedger::with_capacity(10);
        ledger.append(row(100, "ui", None)).unwrap();
        ledger.append(row(300, "ui", None)).unwrap();
        ledger.append(row(200, "ui", None)).unwrap();
        let q = ledger.query(&LedgerFilter::default());
        assert_eq!(q.iter().map(|e| e.ts).collect::<Vec<_>>(), vec![300, 200, 100]);
    }

    // ---- eviction --------------------------------------------------------------------------

    #[test]
    fn entries_beyond_capacity_are_evicted_oldest_first() {
        let mut ledger = UsageLedger::with_capacity(3);
        for ts in 1..=5 {
            ledger.append(row(ts, "ui", None)).unwrap();
        }
        let q = ledger.query(&LedgerFilter::default());
        assert_eq!(q.len(), 3);
        // Oldest two (1, 2) dropped; newest three (3, 4, 5) remain.
        assert_eq!(q.iter().map(|e| e.ts).collect::<Vec<_>>(), vec![5, 4, 3]);
        assert_eq!(ledger.evicted_count(), 2);
    }

    #[test]
    fn eviction_is_cumulative() {
        let mut ledger = UsageLedger::with_capacity(2);
        for ts in 1..=4 {
            ledger.append(row(ts, "ui", None)).unwrap();
        }
        assert_eq!(ledger.evicted_count(), 2);
        for ts in 5..=6 {
            ledger.append(row(ts, "ui", None)).unwrap();
        }
        assert_eq!(ledger.evicted_count(), 4);
    }

    #[test]
    fn a_capacity_of_zero_is_treated_as_one() {
        // `max_entries.max(1)` is the guard. A capacity of zero would otherwise evict every entry
        // immediately, which is not a useful buffer.
        let mut ledger = UsageLedger::with_capacity(0);
        ledger.append(row(1, "ui", None)).unwrap();
        assert_eq!(ledger.query(&LedgerFilter::default()).len(), 1);
    }

    #[test]
    fn oldest_ts_is_the_minimum_of_what_remains() {
        let mut ledger = UsageLedger::with_capacity(3);
        for ts in [10, 20, 30, 40] {
            ledger.append(row(ts, "ui", None)).unwrap();
        }
        assert_eq!(ledger.oldest_ts(), Some(20), "10 was evicted, 20 is the oldest remaining");
    }

    #[test]
    fn oldest_ts_is_none_when_empty() {
        let ledger = UsageLedger::with_capacity(3);
        assert_eq!(ledger.oldest_ts(), None);
    }

    // ---- filters ---------------------------------------------------------------------------

    #[test]
    fn filter_since_excludes_older_entries() {
        let mut ledger = UsageLedger::with_capacity(10);
        ledger.append(row(100, "ui", None)).unwrap();
        ledger.append(row(200, "ui", None)).unwrap();
        ledger.append(row(300, "ui", None)).unwrap();
        let q = ledger.query(&LedgerFilter { since: Some(200), ..Default::default() });
        assert_eq!(q.len(), 2);
        assert!(q.iter().all(|e| e.ts >= 200));
    }

    #[test]
    fn filter_source_matches_exactly() {
        let mut ledger = UsageLedger::with_capacity(10);
        ledger.append(row(100, "ui", None)).unwrap();
        ledger.append(row(200, "gateway", None)).unwrap();
        ledger.append(row(300, "generator", None)).unwrap();
        // A source that contains the filter string as a substring must NOT match — `contains`
        // would include it and the test would pass for the wrong reason.
        ledger.append(row(400, "gateway-proxy", None)).unwrap();
        let q = ledger
            .query(&LedgerFilter { source: Some("gateway".to_string()), ..Default::default() });
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].ts, 200);
    }

    #[test]
    fn filter_provider_id_matches_exactly() {
        let mut ledger = UsageLedger::with_capacity(10);
        ledger.append(row(100, "ui", Some("pA"))).unwrap();
        ledger.append(row(200, "ui", Some("pB"))).unwrap();
        ledger.append(row(300, "ui", None)).unwrap();
        let q = ledger
            .query(&LedgerFilter { provider_id: Some("pA".to_string()), ..Default::default() });
        assert_eq!(q.len(), 1);
        assert_eq!(q[0].ts, 100);
    }

    #[test]
    fn a_null_provider_id_is_not_matched_by_a_filter() {
        // `provider_id: None` means "no provider attributed", which is different from "provider
        // pA attributed". The filter `provider_id: Some("pA")` must not match a row with
        // `provider_id: None`.
        let mut ledger = UsageLedger::with_capacity(10);
        ledger.append(row(100, "ui", None)).unwrap();
        let q = ledger
            .query(&LedgerFilter { provider_id: Some("pA".to_string()), ..Default::default() });
        assert!(q.is_empty());
    }

    #[test]
    fn combined_filters_intersect() {
        let mut ledger = UsageLedger::with_capacity(10);
        ledger.append(row(100, "ui", Some("pA"))).unwrap();
        ledger.append(row(200, "gateway", Some("pA"))).unwrap();
        ledger.append(row(300, "ui", Some("pB"))).unwrap();
        let q = ledger.query(&LedgerFilter {
            since: Some(150),
            source: Some("ui".to_string()),
            provider_id: Some("pA".to_string()),
        });
        assert!(q.is_empty(), "no row is >=150 AND ui AND pA");
    }

    // ---- sink ------------------------------------------------------------------------------

    #[derive(Default, Debug, Clone)]
    struct SpySink {
        entries: std::sync::Arc<std::sync::Mutex<Vec<LedgerRow>>>,
    }

    impl LedgerSink for SpySink {
        fn append(
            &self,
            entry: &LedgerRow,
        ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
            self.entries.lock().unwrap().push(entry.clone());
            Ok(())
        }
    }

    #[test]
    fn a_sink_receives_every_entry_in_order() {
        let spy = SpySink::default();
        let mut ledger = UsageLedger::with_capacity(10).with_sink(Box::new(spy.clone()));
        ledger.append(row(100, "ui", None)).unwrap();
        ledger.append(row(200, "ui", None)).unwrap();
        let got = spy.entries.lock().unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].ts, 100);
        assert_eq!(got[1].ts, 200);
    }

    #[test]
    fn a_sink_failure_returns_err_and_does_not_lose_the_in_memory_copy() {
        struct FailingSink;
        impl LedgerSink for FailingSink {
            fn append(
                &self,
                _entry: &LedgerRow,
            ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
                Err("disk full".into())
            }
        }
        let mut ledger = UsageLedger::with_capacity(10).with_sink(Box::new(FailingSink));
        let e = row(100, "ui", None);
        let result = ledger.append(e);
        assert!(result.is_err(), "the sink error is returned");
        // The entry is still in memory, because push_back happened before the sink call.
        assert_eq!(ledger.query(&LedgerFilter::default()).len(), 1);
    }

    #[test]
    fn no_sink_means_no_persistence_and_no_error() {
        let mut ledger = UsageLedger::with_capacity(10);
        ledger.append(row(100, "ui", None)).unwrap();
        assert_eq!(ledger.query(&LedgerFilter::default()).len(), 1);
        // The real assertion is that `append` returns `Ok` even with no sink. A mutation that
        // makes `append` return `Err` when `self.sink.is_none()` would fail here.
        let result = ledger.append(row(200, "ui", None));
        assert!(result.is_ok(), "append with no sink must not error");
    }

    #[test]
    fn evicted_entries_are_never_seen_by_the_sink_again() {
        // The sink sees every append; eviction is memory-only.
        let spy = SpySink::default();
        let mut ledger = UsageLedger::with_capacity(2).with_sink(Box::new(spy.clone()));
        ledger.append(row(100, "ui", None)).unwrap();
        ledger.append(row(200, "ui", None)).unwrap();
        ledger.append(row(300, "ui", None)).unwrap(); // evicts 100
        assert_eq!(
            spy.entries.lock().unwrap().len(),
            3,
            "sink saw all three, including the evicted one"
        );
        assert_eq!(
            ledger.query(&LedgerFilter::default()).len(),
            2,
            "memory holds only the last two"
        );
    }

    // ---- the store-backed sink (25d) ---------------------------------------------------

    /// A store on disk. The directory is `AtomicUsize`-suffixed rather than `pid + tag`: two tests
    /// that picked the same tag would open the same file, and one would fail with `DatabaseBusy`
    /// for a reason that has nothing to do with what it is testing.
    fn tmp_store() -> (Arc<Store>, std::path::PathBuf) {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "aip-ledger-sink-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        (Arc::new(Store::open(&dir).unwrap()), dir)
    }

    /// What actually landed in the `ledger` table, read back with SQL.
    ///
    /// **The assertion has to be on the row the host re-reads, not on the value handed to the sink.**
    /// A sink that accepted a row and wrote a different one — or wrote nothing at all — would pass
    /// any assertion made on its input, which is the mistake `cached_tokens` was found by.
    fn read_back(store: &Store) -> Vec<(i64, String, String, Option<String>)> {
        let conn = store.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT ts, source, model, provider_id FROM ledger ORDER BY ts").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn the_store_sink_writes_rows_that_read_back() {
        let (store, dir) = tmp_store();
        let sink = StoreLedgerSink::new(Arc::clone(&store));
        sink.append(&row(100, "ui", Some("pA"))).unwrap();
        sink.append(&row(200, "gateway", None)).unwrap();
        let got = read_back(&store);
        assert_eq!(got.len(), 2, "both rows landed");
        assert_eq!(got[0], (100, "ui".to_string(), "m1".to_string(), Some("pA".to_string())));
        assert_eq!(got[1], (200, "gateway".to_string(), "m1".to_string(), None));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The sink is accepted where a `Send + Sync` sink is required, which is a compile-time claim
    /// that no test could make — and this pins the whole path (ledger → sink → store) in one place
    /// rather than in three.
    #[test]
    fn the_sink_is_accepted_by_the_ledger_and_writes_through_it() {
        let (store, dir) = tmp_store();
        let mut ledger = UsageLedger::with_capacity(10)
            .with_sink(Box::new(StoreLedgerSink::new(Arc::clone(&store))));
        ledger.append(row(100, "ui", None)).unwrap();
        assert_eq!(ledger.query(&LedgerFilter::default()).len(), 1, "still in memory");
        assert_eq!(read_back(&store).len(), 1, "and on disk");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A database failure is sanitised, because this error becomes a client-visible 502.
    ///
    /// `ui_db_error` logs the detail host-side and returns a stable sentence, so what is asserted
    /// here is what must **not** be in the message: the table name, the SQL, the driver's own
    /// wording, and the absolute path of the database file.
    #[test]
    fn the_store_sink_sanitises_a_database_failure() {
        let (store, dir) = tmp_store();
        {
            let conn = store.conn.lock().unwrap();
            conn.execute("DROP TABLE ledger", []).unwrap();
        }
        let sink = StoreLedgerSink::new(Arc::clone(&store));
        let err = sink.append(&row(100, "ui", None)).expect_err("a dropped table is a failure");
        let msg = err.to_string();
        let path = dir.to_string_lossy().to_string();
        for leaked in ["ledger", "INSERT", "no such table", "sqlite", path.as_str()] {
            assert!(
                !msg.contains(leaked),
                "the client-visible message must not carry {leaked:?}: {msg}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A row the table refuses is an error, not a silent drop — and that is a real consequence of
    /// installing a sink. `ledger.source` is `CHECK (source IN ('ui','gateway','generator'))`, so a
    /// row naming any other source now fails the request that produced it, where before 25d it
    /// could only ever fail to be recorded in memory.
    #[test]
    fn a_row_that_violates_a_check_constraint_is_an_error_not_a_silent_drop() {
        let (store, dir) = tmp_store();
        let sink = StoreLedgerSink::new(Arc::clone(&store));
        let err = sink.append(&row(100, "assistant", None)).expect_err("the CHECK rejects it");
        assert!(!err.to_string().is_empty(), "the failure carries a message");
        assert!(read_back(&store).is_empty(), "nothing was written");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
