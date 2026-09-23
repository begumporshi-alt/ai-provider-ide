//! The per-provider in-flight cap — the Rust port of `concurrency.ts` (audit finding R3), and the
//! fifth of the six modules `execution-engine.ts` cannot run without
//! (`docs/dev-book/10-headless-service.md` §7).
//!
//! **Why this exists.** The gateway admits requests through ONE global semaphore — `permits`
//! (8 concurrent plus a 32-deep queue). A global bound cannot see providers, so a single slow or
//! rate-limited provider can occupy every permit and starve every other provider, which defeats
//! the point of having a failover chain at all. This limiter can see providers, so a saturated
//! provider's candidates are *skipped in the plan* and the request fails over to a provider that
//! can actually serve it, rather than being rejected outright or queued behind a degraded one.
//!
//! **The Rust gateway has the global semaphore and, until this file, no per-provider cap at
//! all.** `per_provider_concurrency` appears nowhere in this tree: R3 is implemented in
//! TypeScript only. Closing that is the point of the increment.
//!
//! # Three places the port deliberately differs from the original
//!
//! **1. The release is RAII, and still idempotent.** TypeScript returns `(() => void) | null` and
//! the caller must remember to call it; a forgotten release leaks a slot for the lifetime of the
//! process, and nothing reports it. `acquire` here returns a [`Permit`] that gives the slot back
//! on `Drop`, so the forgettable step is gone. [`Permit::release`] also stays callable and stays
//! idempotent — the property the original guards with a local `released` flag — so the
//! double-release case is still *representable* and still tested. `Drop` calls that same
//! `release`, so a permit can never decrement twice.
//!
//! **2. The check and the increment are one critical section.** `acquire` in TypeScript is a
//! check-then-act: `if (!this.hasCapacity(id)) return null;` then `this.inFlight.set(...)`. That
//! is atomic there because JavaScript runs one thread. Here it is a race, and a literal
//! translation would admit more than the cap under contention — two threads both read `cap - 1`
//! and both write `cap`. `the_cap_holds_under_concurrent_acquires` is the test that pins it, and
//! it is the one test in this file a literal translation fails.
//!
//! **3. The cap is `usize`, so a negative is unrepresentable.** In TypeScript `-1` satisfies
//! `maxPerProvider <= 0` and therefore behaves as *unlimited* while displaying as a bound — the
//! exact hazard [`clamp_concurrency`] exists to catch. The type removes it here.
//! `clamp_concurrency` still rejects a stored negative, because a stored value is untrusted input
//! from a settings blob rather than a number this program produced.
//!
//! # The boundary rule
//!
//! Untrusted value → [`clamp_concurrency`] → [`ProviderLimiter`]. The limiter trusts its caller
//! and does **not** clamp: `new(0)` and `set_max_per_provider(0)` are the documented "unlimited",
//! not a typo, so clamping inside would have to distinguish two spellings of one state — which is
//! the defect this codebase already carries elsewhere.
//!
//! # What is deliberately preserved
//!
//! A skipped candidate is reported with class `RATE_LIMITED` and status `429`
//! (`execution-engine.ts:85`, `:169`) even though the provider was never contacted and may be
//! perfectly healthy — it is saturated by *our own* in-flight count. The port keeps that,
//! because the class drives the client-facing `Retry-After` and a saturated provider genuinely
//! does want a wait. The loop that consumes this (Phase 3) must keep it too.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// The cap applied when none is configured (TS `PER_PROVIDER_DEFAULT`).
pub const PER_PROVIDER_DEFAULT: usize = 4;

/// Upper bound on a user-set cap (TS `MAX_PER_PROVIDER`).
///
/// Not a security control — `0` already means unlimited, and that is a legitimate choice — but
/// 5000 in-flight requests to one provider is not a different setting from 64; it is 64 with the
/// failure arriving later.
pub const MAX_PER_PROVIDER: usize = 64;

/// Clamp a stored or user-supplied per-provider cap into `[0, MAX_PER_PROVIDER]`.
///
/// `0` is preserved: it is the documented "unlimited", and `has_capacity` tests it as such.
/// Flooring it to `1` would silently turn "no cap" into "one request at a time".
///
/// A **negative** falls back to the default rather than to `0`: removing the cap should take a
/// deliberate `0`, and a stored negative is corruption. Corruption must yield a real cap, not no
/// cap at all.
///
/// The parameter is a [`serde_json::Value`] because that is what `unknown` means on this side —
/// the value arrives from the settings blob that `model-router.ts:85` reads with no validation,
/// so it can be any JSON at all. Numbers and numeric strings are accepted; everything else
/// (`null`, booleans, arrays, objects, the empty string, whitespace) falls back to the default.
/// The original's reason for that guard is worth restating, because it is the whole reason the
/// function is not a one-line `Number(value)`: `Number(null)` is `0` and `Number("")` is `0`, so
/// without the guard a *missing* setting would read as a deliberate removal of the cap. `""` is
/// specifically what a text field produces when the user clears it, which makes it the shape that
/// actually reaches a person.
///
/// The finiteness check is load-bearing on the **string** path, not defensive: `"Infinity"`
/// parses to `f64::INFINITY` and `"NaN"` to `f64::NAN`, and `f64::min` ignores a `NaN` operand,
/// so without the check both would clamp to `MAX_PER_PROVIDER` — a corrupted string would become
/// the largest cap this program allows.
///
/// **One documented divergence.** JavaScript's `Number("0x10")` is `16` and `Number("0o7")` is
/// `7`; Rust's `str::parse::<f64>()` rejects both, so they fall back to the default here. Neither
/// is a concurrency cap a person types, and matching `Number()`'s full coercion table would mean
/// accepting spellings nobody intended — but it is a difference, so it is tested rather than left
/// implicit (`a_hex_string_is_rejected_where_javascript_would_coerce_it`).
pub fn clamp_concurrency(value: &serde_json::Value) -> usize {
    let n = match value {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) if !s.trim().is_empty() => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    let Some(n) = n else {
        return PER_PROVIDER_DEFAULT;
    };
    if !n.is_finite() {
        return PER_PROVIDER_DEFAULT;
    }
    let floored = n.floor();
    if floored < 0.0 {
        return PER_PROVIDER_DEFAULT;
    }
    // `floored` is finite and non-negative here and the bound is 64, so the cast loses nothing
    // that `floor` has not already removed.
    floored.min(MAX_PER_PROVIDER as f64) as usize
}

/// The shared state behind [`ProviderLimiter`].
///
/// Separate from the handle so a [`Permit`] can hold the *state* rather than the *handle*, which
/// keeps `acquire(&self)` from needing `&Arc<Self>`.
struct LimiterInner {
    /// `0` means unlimited. `Relaxed` is sufficient and deliberate: this guards no other memory,
    /// so it needs to not tear — which an `AtomicUsize` guarantees — and nothing more. The
    /// counts below are protected by their own mutex.
    max_per_provider: AtomicUsize,
    in_flight: Mutex<HashMap<String, usize>>,
}

/// Per-provider in-flight cap. Cheap to clone; every clone shares one budget.
///
/// Shared between the router (which changes the cap at runtime) and the engine (which consults it
/// per candidate), so it is `Send + Sync` and interiorly mutable.
#[derive(Clone)]
pub struct ProviderLimiter {
    inner: Arc<LimiterInner>,
}

impl ProviderLimiter {
    /// A limiter with `max_per_provider` in flight allowed per provider. `0` means unlimited.
    ///
    /// Not clamped — see the module's boundary rule.
    pub fn new(max_per_provider: usize) -> Self {
        Self {
            inner: Arc::new(LimiterInner {
                max_per_provider: AtomicUsize::new(max_per_provider),
                in_flight: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// The live cap. Read on every `has_capacity`, so a settings change takes effect on the next
    /// candidate rather than on the next restart.
    pub fn max_per_provider(&self) -> usize {
        self.inner.max_per_provider.load(Ordering::Relaxed)
    }

    /// Apply a new cap (Router Settings). `0` means unlimited.
    pub fn set_max_per_provider(&self, cap: usize) {
        self.inner.max_per_provider.store(cap, Ordering::Relaxed);
    }

    /// How many attempts this provider currently has in flight.
    pub fn in_flight_count(&self, provider: &str) -> usize {
        self.inner.in_flight.lock().unwrap().get(provider).copied().unwrap_or(0)
    }

    /// Whether the provider could be admitted *right now*.
    ///
    /// **Advisory, and not a reservation.** It answers "is there room at this instant" for a
    /// settings screen; between this call and any later [`acquire`](Self::acquire) the answer can
    /// change, and another thread can take the slot. Do **not** gate an acquire on it —
    /// `acquire` does its own check under the same lock as its increment, and rewriting it as
    /// `if !self.has_capacity(p) { return None }` reintroduces the race the port exists to avoid.
    pub fn has_capacity(&self, provider: &str) -> bool {
        let cap = self.max_per_provider();
        cap == 0 || self.in_flight_count(provider) < cap
    }

    /// Reserve one slot for `provider`, or return `None` when it is saturated.
    ///
    /// **`None` means skip, never wait.** The caller's contract
    /// (`execution-engine.ts:84`, `:168`) is to record the candidate as `RATE_LIMITED`/`429` and
    /// advance to the next one: failover is a better answer than queueing behind a degraded
    /// provider, and consecutive candidates of the same saturated provider are skipped the same
    /// way. There is no blocking variant and no async one, and adding either would change what a
    /// plan means.
    ///
    /// The check and the increment are one critical section — see the module doc, difference 2.
    pub fn acquire(&self, provider: &str) -> Option<Permit> {
        let cap = self.max_per_provider();
        let mut in_flight = self.inner.in_flight.lock().unwrap();
        if cap != 0 && in_flight.get(provider).copied().unwrap_or(0) >= cap {
            return None;
        }
        *in_flight.entry(provider.to_string()).or_insert(0) += 1;
        drop(in_flight);
        Some(Permit {
            inner: Arc::clone(&self.inner),
            provider: provider.to_string(),
            released: AtomicBool::new(false),
        })
    }

    /// Diagnostics only (Router Settings / Activity): current per-provider occupancy.
    ///
    /// A provider with nothing in flight is **absent**, not `0` — the release removes the entry
    /// at zero rather than storing one, so "never used" and "was used and finished" stay
    /// distinguishable from "is using".
    pub fn snapshot(&self) -> HashMap<String, usize> {
        self.inner.in_flight.lock().unwrap().clone()
    }
}

impl Default for ProviderLimiter {
    fn default() -> Self {
        Self::new(PER_PROVIDER_DEFAULT)
    }
}

/// One reserved slot. Releases on `Drop`; [`release`](Permit::release) is idempotent.
pub struct Permit {
    inner: Arc<LimiterInner>,
    provider: String,
    released: AtomicBool,
}

impl Permit {
    /// The provider this slot belongs to.
    pub fn provider(&self) -> &str {
        &self.provider
    }

    /// Give the slot back. Idempotent: the second and later calls do nothing, so an explicit
    /// release followed by `Drop` counts once. A double release that *did* decrement twice would
    /// not under-count visibly — it would slowly leak capacity until the limiter stopped
    /// admitting traffic.
    pub fn release(&self) {
        // `swap` returns the previous value, so exactly one caller sees `false`. `SeqCst` is the
        // conservative choice; the decrement below is behind a mutex of its own, so a weaker
        // ordering would also be correct — but this runs once per attempt and the cost of
        // arguing the point is higher than the cost of the fence.
        if self.released.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut in_flight = self.inner.in_flight.lock().unwrap();
        // `saturating_sub` stands in for the original's `if (next <= 0) delete`. With `usize` the
        // negative it guards against is unrepresentable, and the branch is unreachable unless a
        // permit were released without ever having been counted — which the RAII shape prevents.
        let next = in_flight.get(&self.provider).copied().unwrap_or(0).saturating_sub(1);
        if next == 0 {
            in_flight.remove(&self.provider);
        } else {
            in_flight.insert(self.provider.clone(), next);
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn limiter(cap: usize) -> ProviderLimiter {
        ProviderLimiter::new(cap)
    }

    // ---------- ProviderLimiter ----------

    #[test]
    fn admits_up_to_the_cap_and_refuses_beyond_it() {
        let lim = limiter(2);
        let _first = lim.acquire("p1").expect("the first is admitted");
        let _second = lim.acquire("p1").expect("the second is admitted");
        assert!(lim.acquire("p1").is_none(), "the third is over the cap");
        assert_eq!(lim.in_flight_count("p1"), 2);
    }

    #[test]
    fn tracks_providers_independently() {
        let lim = limiter(1);
        let _p1 = lim.acquire("p1").expect("admitted");
        assert!(lim.acquire("p1").is_none());
        let _p2 = lim.acquire("p2").expect("a different provider has its own budget");
    }

    #[test]
    fn a_double_release_cannot_leak_capacity() {
        // Kept for fidelity to the TypeScript suite — and it is **weak**, which is worth knowing
        // before trusting it. Measured 2026-09-23: deleting the `released` flag from the
        // TypeScript original leaves this test passing, because with a cap of 1 the count is
        // already 0 and the entry already deleted after the first release, so the second and
        // third calls take the "delete at zero" branch again and change nothing. The property
        // only bites with **two** permits held, which is why
        // `an_explicit_release_followed_by_drop_counts_once` below is the test that actually
        // carries it. Recorded as D18.
        let lim = limiter(1);
        let permit = lim.acquire("p1").expect("admitted");
        permit.release();
        permit.release();
        permit.release();
        assert_eq!(lim.in_flight_count("p1"), 0);
        assert!(lim.acquire("p1").is_some(), "still admits after an over-release");
    }

    #[test]
    fn dropping_a_permit_returns_the_slot() {
        let lim = limiter(1);
        {
            let _permit = lim.acquire("p1").expect("admitted");
            assert!(lim.acquire("p1").is_none(), "the slot is held");
        }
        assert_eq!(lim.in_flight_count("p1"), 0);
        assert!(lim.acquire("p1").is_some(), "the slot came back without anyone calling release");
    }

    #[test]
    fn an_explicit_release_followed_by_drop_counts_once() {
        let lim = limiter(2);
        let first = lim.acquire("p1").expect("admitted");
        let _second = lim.acquire("p1").expect("admitted");
        assert_eq!(lim.in_flight_count("p1"), 2);
        first.release();
        drop(first);
        assert_eq!(lim.in_flight_count("p1"), 1, "released once, not twice");
    }

    #[test]
    fn treats_a_non_positive_cap_as_unlimited() {
        let lim = limiter(0);
        let mut held = Vec::new();
        for _ in 0..50 {
            held.push(lim.acquire("p1").expect("0 means unlimited"));
        }
        assert_eq!(lim.in_flight_count("p1"), 50);
    }

    #[test]
    fn defaults_to_per_provider_default() {
        assert_eq!(ProviderLimiter::default().max_per_provider(), PER_PROVIDER_DEFAULT);
    }

    #[test]
    fn the_cap_can_change_while_the_limiter_is_shared() {
        let lim = limiter(1);
        let router_side = lim.clone();
        let held = lim.acquire("p1").expect("admitted");
        assert!(lim.acquire("p1").is_none());

        router_side.set_max_per_provider(2);
        let second = lim.acquire("p1").expect("the engine sees the new cap");
        assert!(lim.acquire("p1").is_none(), "and the new cap is a real bound");

        router_side.set_max_per_provider(0);
        let mut unlimited = Vec::new();
        for _ in 0..20 {
            unlimited.push(lim.acquire("p1").expect("unlimited applies immediately"));
        }
        assert_eq!(lim.in_flight_count("p1"), 22, "2 held plus 20 unbounded");

        drop((held, second, unlimited));
        assert_eq!(lim.in_flight_count("p1"), 0);
    }

    #[test]
    fn has_capacity_is_advisory_and_does_not_reserve() {
        let lim = limiter(1);
        assert!(lim.has_capacity("p1"));
        assert!(lim.has_capacity("p1"), "asking twice reserves nothing");
        let _permit = lim.acquire("p1").expect("admitted");
        assert!(!lim.has_capacity("p1"));
    }

    #[test]
    fn a_permit_that_is_never_bound_cannot_leak_capacity() {
        // The RAII difference, pinned. In TypeScript the release is a function the caller must
        // remember to call, so a call site that ignores the return value holds the slot for the
        // lifetime of the process and nothing reports it. Here the slot returns as soon as the
        // value is dropped, so the worst case for a careless caller is that the cap is not
        // enforced for that one attempt — fail-open, not fail-closed. `Option` is `#[must_use]`,
        // so the careless call site is a compiler warning as well.
        let lim = limiter(1);
        let _ = lim.acquire("p1"); // deliberately unbound
        assert_eq!(lim.in_flight_count("p1"), 0);
        assert!(lim.acquire("p1").is_some(), "the slot was never taken");
    }

    #[test]
    fn the_snapshot_names_only_providers_with_something_in_flight() {
        let lim = limiter(4);
        assert!(lim.snapshot().is_empty());
        let _a = lim.acquire("p1").expect("admitted");
        let _b = lim.acquire("p1").expect("admitted");
        let _c = lim.acquire("p2").expect("admitted");
        let snap = lim.snapshot();
        assert_eq!(snap.get("p1").copied(), Some(2));
        assert_eq!(snap.get("p2").copied(), Some(1));
        assert_eq!(snap.len(), 2, "a provider with nothing in flight is absent, not zero");
    }

    #[test]
    fn a_permit_can_be_held_across_a_thread_boundary() {
        // The gateway will hold a permit across an `.await` inside a spawned task, which needs
        // `Send`; a settings screen reads the cap from another thread, which needs `Sync`.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Permit>();
        assert_send_sync::<ProviderLimiter>();
    }

    #[test]
    fn the_cap_holds_under_concurrent_acquires() {
        // The test a literal translation fails. `acquire` is a check-then-act in TypeScript,
        // atomic only because JavaScript has one thread; a port that checked and then incremented
        // under two separate locks would let two threads both read `cap - 1` and both admit.
        //
        // Each round is exact rather than statistical: no permit is released until every thread
        // has finished deciding, so the number of simultaneous holders is precisely `CAP` for the
        // correct implementation and can only exceed it for a racy one.
        const ROUNDS: usize = 50;
        const THREADS: usize = 64;
        const CAP: usize = 4;

        for round in 0..ROUNDS {
            let lim = Arc::new(limiter(CAP));
            let admitted = Arc::new(AtomicUsize::new(0));
            let start = Arc::new(std::sync::Barrier::new(THREADS));
            let decided = Arc::new(std::sync::Barrier::new(THREADS));

            let mut handles = Vec::with_capacity(THREADS);
            for _ in 0..THREADS {
                let lim = Arc::clone(&lim);
                let admitted = Arc::clone(&admitted);
                let start = Arc::clone(&start);
                let decided = Arc::clone(&decided);
                handles.push(std::thread::spawn(move || {
                    start.wait();
                    let permit = lim.acquire("p1");
                    if permit.is_some() {
                        admitted.fetch_add(1, Ordering::SeqCst);
                    }
                    // Every thread arrives, admitted or not, so the permits stay held until all
                    // acquisitions are done — and no assertion lives in here, where a panic would
                    // strand the others on the barrier.
                    decided.wait();
                    drop(permit);
                }));
            }
            for handle in handles {
                handle.join().expect("no thread panicked");
            }

            assert_eq!(
                admitted.load(Ordering::SeqCst),
                CAP,
                "round {round}: exactly the cap is admitted, never more"
            );
            assert_eq!(lim.in_flight_count("p1"), 0, "round {round}: all released");
        }
    }

    // ---------- clamp_concurrency ----------

    #[test]
    fn leaves_a_sane_value_alone() {
        for n in [0, 1, 4, 32, MAX_PER_PROVIDER] {
            assert_eq!(clamp_concurrency(&json!(n)), n, "for {n}");
        }
    }

    #[test]
    fn keeps_zero_because_it_means_unlimited() {
        // `has_capacity` tests `maxPerProvider <= 0`, so 0 is a real setting, not a missing one.
        // Flooring it to 1 would silently turn "no cap" into "one request at a time".
        assert_eq!(clamp_concurrency(&json!(0)), 0);
        assert_eq!(clamp_concurrency(&json!("0")), 0);
    }

    #[test]
    fn rejects_a_negative_rather_than_letting_it_mean_unlimited() {
        // The one that bites: a negative would behave as unlimited while displaying as a bound.
        // Removing the cap must take a deliberate 0 — a stored negative is corruption, and
        // corruption must yield a real cap, not no cap at all.
        assert_eq!(clamp_concurrency(&json!(-1)), PER_PROVIDER_DEFAULT);
        assert_eq!(clamp_concurrency(&json!(-12)), PER_PROVIDER_DEFAULT);
        assert_eq!(
            clamp_concurrency(&json!("-1")),
            PER_PROVIDER_DEFAULT,
            "and a negative typed into the field is the same value"
        );
    }

    #[test]
    fn caps_a_value_that_would_only_delay_the_failure() {
        assert_eq!(clamp_concurrency(&json!(5000)), MAX_PER_PROVIDER);
    }

    #[test]
    fn floors_a_fraction_rather_than_rounding_it() {
        assert_eq!(clamp_concurrency(&json!(3.9)), 3);
        assert_eq!(clamp_concurrency(&json!("3.9")), 3);
        assert_eq!(
            clamp_concurrency(&json!(-0.5)),
            PER_PROVIDER_DEFAULT,
            "floor(-0.5) is -1, which is below the floor"
        );
    }

    #[test]
    fn falls_back_to_the_default_for_input_that_is_not_a_number_at_all() {
        // `Number(null)` is 0, which would silently become "unlimited" — a missing setting must
        // not read as a deliberate removal of the cap. `""` has the same shape and is what a text
        // field produces when the user clears it, so it is the one that reaches a real user.
        for v in [
            json!(null),
            json!(true),
            json!(false),
            json!({}),
            json!([]),
            json!(""),
            json!(" "),
            json!("   "),
            json!("four"),
            json!("1 2"),
        ] {
            assert_eq!(clamp_concurrency(&v), PER_PROVIDER_DEFAULT, "for {v}");
        }
    }

    #[test]
    fn a_string_that_parses_to_a_non_finite_number_falls_back_rather_than_to_the_maximum() {
        // The finiteness check is load-bearing here, not defensive: `f64::min` ignores a NaN
        // operand, so without it `"NaN"` and `"Infinity"` would both clamp to `MAX_PER_PROVIDER`
        // — a corrupted string becoming the largest cap this program allows.
        for v in ["Infinity", "-Infinity", "inf", "NaN"] {
            assert_eq!(clamp_concurrency(&json!(v)), PER_PROVIDER_DEFAULT, "for {v}");
        }
    }

    #[test]
    fn accepts_a_numeric_string_because_that_is_what_a_text_field_produces() {
        assert_eq!(clamp_concurrency(&json!("8")), 8);
        assert_eq!(clamp_concurrency(&json!(" 8 ")), 8, "Number() trims, and so does this");
        assert_eq!(clamp_concurrency(&json!("8.0")), 8);
    }

    #[test]
    fn a_hex_string_is_rejected_where_javascript_would_coerce_it() {
        // The one deliberate divergence, pinned so it stays deliberate. `Number("0x10")` is 16 in
        // JavaScript; `"0x10".parse::<f64>()` is an error here. Neither is a concurrency cap a
        // person types, and matching `Number()`'s coercion table would mean accepting spellings
        // nobody intended.
        assert_eq!(clamp_concurrency(&json!("0x10")), PER_PROVIDER_DEFAULT);
        assert_eq!(clamp_concurrency(&json!("0o7")), PER_PROVIDER_DEFAULT);
    }
}
