//! The per-key health records — the D38 story, moved verbatim from `engine.rs` (D98 phase 3).
//! What one attempt does to a credential, how long it is excluded, and the half-open breaker that
//! lets a single re-probe back in. Depends on the taxonomy's class; owns no I/O.
use std::collections::HashMap;
use std::sync::Mutex;

use super::taxonomy::{ErrorClass, COOLDOWN_FLOOR_MS};
use crate::core::persist::{ApiKeyRow, ProviderRow};

/// Consecutive auth failures before a key is treated as invalid rather than merely unlucky.
pub const AUTH_BREAKER_THRESHOLD: u32 = 3;

/// How long an open auth breaker excludes its key before one re-probe is allowed.
///
/// **A breaker with no half-open state is a permanent exclusion, and that was this crate's
/// behaviour until now.** [`KeyHealth::breaker_open_at`] was cleared *only* by an
/// [`ErrorClass::Ok`], and an open breaker meant the key was never tried again — so no `Ok` could
/// ever arrive to clear it. A credential rotated back into service, or an upstream that had a bad
/// five minutes, stayed dead to the router for the life of the process. This window bounds that:
/// past it the key is admissible again, and the next attempt decides — an `Ok` clears the breaker,
/// an `AuthFailed` re-stamps it and excludes the key for another window. A genuinely revoked key
/// therefore costs **one** `401` per window rather than one per request.
///
/// **The re-probe is safe because an auth failure is retryable with the next key** — see
/// [`is_retryable_with_next_key`], which lists [`ErrorClass::AuthFailed`]. The cost of admitting a
/// dead key is one wasted attempt, not a failed request.
///
/// One minute: long enough that a revoked credential is not sampled per request, short enough that
/// a credential restored by an operator comes back without restarting the daemon. **The breaker is
/// a heuristic layered on the persisted `status` column** — the way to exclude a key permanently is
/// `status = "disabled"`, which is [`KeyBlock::Denied`] and is genuinely not on a clock.
pub const BREAKER_HALF_OPEN_MS: u64 = 60_000;

/// The key statuses that make a key unusable outright.
///
/// **This is a deny-list, and that is load-bearing.** [`HealthTracker::is_key_usable`] rejects
/// these two and accepts *everything else*, including a status string this code has never seen. A
/// key left at `"pending"` is therefore tried. The TypeScript behaves the same way, and its
/// polarity is the **opposite** of the provider check below — a reader who assumes one rule for
/// both gets it backwards in one direction or the other.
const KEY_STATUS_DENIED: [&str; 2] = ["disabled", "invalid"];

/// The one provider status that makes a provider usable. An **allow-list**, unlike the key check.
const PROVIDER_STATUS_ENABLED: &str = "enabled";

/// Per-key circuit state. Every time is epoch **milliseconds**.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct KeyHealth {
    /// Epoch ms; `0` means ready.
    pub cooldown_until_ms: i64,
    /// Reset to zero by any `Ok`, because the breaker counts *consecutive* failures.
    pub consecutive_auth_failures: u32,
    /// When the auth breaker opened, epoch ms — `None` while it is closed.
    ///
    /// **The moment rather than a flag, and that is what bounds the exclusion.** A `bool` plus a
    /// separate `opened_at` would be two fields that must agree, and the pair has a state the flag
    /// cannot describe on its own: open, with no idea when it started. Storing the moment makes
    /// that state unrepresentable, and it is the moment — not the flag — that
    /// [`HealthTracker::key_block`] reads, so the half-open window cannot be defeated by a missing
    /// stamp. See [`BREAKER_HALF_OPEN_MS`].
    pub breaker_open_at: Option<i64>,
}

/// Why a key cannot be tried right now.
///
/// **The variant is what decides whether waiting is worth anything**, which is why this is an enum
/// and not a `bool`. `Cooling` carries the moment the key comes back, so a caller can sleep exactly
/// that long; `Denied` and `Breaker` carry nothing, and they carry nothing for **different**
/// reasons — which is the distinction a single `bool` would lose. `Denied` is permanent, because
/// the persisted status is a decision an operator made. `Breaker` is not permanent: it expires
/// after [`BREAKER_HALF_OPEN_MS`], but on a scale of minutes, so it is still not something a
/// request should sleep on — the right answer to a dead credential is to fail over to the next key,
/// which [`is_retryable_with_next_key`] permits. A caller that could not tell the three apart would
/// either give up on a key that was about to be free, or wait on one that would not be free in time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyBlock {
    /// The persisted status is `disabled` or `invalid`. Waiting does not help, ever.
    Denied,
    /// Too many consecutive auth failures, inside the half-open window. Waiting does not help
    /// *in time*; the key returns after [`BREAKER_HALF_OPEN_MS`].
    Breaker,
    /// A cooldown that expires at this epoch-ms. Waiting **is** the remedy.
    Cooling(i64),
}

/// Per-key and per-provider circuit state, kept free of I/O so failover ordering can be tested
/// against it (TS `health-tracker.ts`).
///
/// **Interiorly mutable, and that is what makes a concurrent bridge possible.** This tracker is
/// process-wide state — one breaker, one cooldown per key — so every request must see the same one.
/// The engine used to take `&mut HealthTracker` and hold it for the whole of a request, which made
/// "two requests at once" unrepresentable: the borrow checker forced the caller to serialise, and
/// the serialisation stayed invisible until something tried to serve two clients. A `Mutex` inside
/// the type, rather than a `&mut` at the boundary, keeps the sharing honest — and the lock is taken
/// per *record*, never across an `await`, because every method here is synchronous.
///
/// The `Mutex` is never observed poisoned: `panic = "abort"` (`Cargo.toml`), so a panic that held
/// this lock does not unwind past it. `.lock().unwrap()` is therefore this crate's existing
/// convention rather than a new bet.
#[derive(Debug, Default)]
pub struct HealthTracker {
    keys: Mutex<HashMap<String, KeyHealth>>,
}

impl HealthTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Why `key` cannot be tried at `now_ms`, or `None` when it can.
    ///
    /// **One spelling of the rule, two readers.** [`Self::is_key_usable`] asks "may I try it" and
    /// [`Self::key_retry_at`] asks "when may I try it again" — and the second is only answerable
    /// for [`KeyBlock::Cooling`]. Two independent predicates would be two spellings of one rule,
    /// which is the defect this crate keeps finding; they are derived from this one instead.
    fn key_block(&self, key: &ApiKeyRow, now_ms: i64) -> Option<KeyBlock> {
        if KEY_STATUS_DENIED.contains(&key.status.as_str()) {
            return Some(KeyBlock::Denied);
        }
        // A read must not create an entry. The TypeScript `health()` inserts on read, which grows
        // the map for every key ever *considered*; the answer is identical either way, because an
        // absent entry means default health.
        let h = self.keys.lock().unwrap().get(&key.id).copied().unwrap_or_default();
        // **Half-open: an open breaker excludes the key for one window, then admits it again.**
        // See [`BREAKER_HALF_OPEN_MS`]. Past the window this *falls through* rather than returning,
        // so the key is tried once more — and that attempt decides the breaker's fate: an `Ok`
        // clears it, an `AuthFailed` re-stamps it and excludes the key for another window. The
        // alternative, an unbounded `if h.breaker_open { return .. }`, is a latch: nothing but an
        // `Ok` could clear it, and an open breaker means no `Ok` is ever attempted.
        if let Some(opened_at) = h.breaker_open_at {
            // `saturating_add` rather than `+`: the stamp is wall-clock derived, so a clock step
            // could make the sum exceed `i64::MAX` — and that is a panic in a debug build, on the
            // path that decides whether a request may proceed. Saturating excludes the key instead.
            if now_ms < opened_at.saturating_add(BREAKER_HALF_OPEN_MS as i64) {
                return Some(KeyBlock::Breaker);
            }
        }
        // **The tracker's cooldown and the row's own `cooldown_until` are two different fields**,
        // and the later of the two is when the key is actually free again. Taking the max rather
        // than checking them separately keeps `is_key_usable`'s answer and `key_retry_at`'s time
        // from disagreeing about which one is in force.
        let until = h.cooldown_until_ms.max(key.cooldown_until.unwrap_or(0));
        (until > now_ms).then_some(KeyBlock::Cooling(until))
    }

    /// Whether `key` may be tried at `now_ms`.
    ///
    /// Four independent ways to be unusable, deliberately separate: the persisted status, this
    /// tracker's breaker, this tracker's cooldown, and the key record's **own** `cooldown_until` —
    /// a different field from the in-memory one, and currently unreachable. See
    /// `a_key_cooldown_on_the_record_is_honoured`.
    pub fn is_key_usable(&self, key: &ApiKeyRow, now_ms: i64) -> bool {
        self.key_block(key, now_ms).is_none()
    }

    /// When `key` becomes tryable again, if a cooldown is the **only** reason it is not now.
    ///
    /// **`None` is the load-bearing answer, and it means "do not wait on this key".** It covers
    /// three cases: the key is usable already; its status is `disabled`/`invalid`; or its auth
    /// breaker is open. `Denied` is permanent — no clock clears it, so a caller that slept on it
    /// would sleep until the gateway gave up. **`Breaker` is different, and the difference is the
    /// point**: it *does* expire now, but after [`BREAKER_HALF_OPEN_MS`], which is minutes against a
    /// request's seconds — so waiting for it is still the wrong answer and failing over to the next
    /// key is still the right one. Only a genuine cooldown yields a time, and that time is strictly
    /// greater than `now_ms`, so a caller looping on this answer is guaranteed to make progress
    /// rather than spin.
    pub fn key_retry_at(&self, key: &ApiKeyRow, now_ms: i64) -> Option<i64> {
        match self.key_block(key, now_ms) {
            Some(KeyBlock::Cooling(until)) => Some(until),
            _ => None,
        }
    }

    /// Whether `provider` may be tried at all. An allow-list: only `"enabled"` passes.
    pub fn is_provider_usable(provider: &ProviderRow) -> bool {
        provider.status == PROVIDER_STATUS_ENABLED
    }

    /// Record what an attempt did to `key_id`'s health.
    ///
    /// `retry_after_ms` is what the provider asked us to wait, and the cooldown is floored at
    /// [`COOLDOWN_FLOOR_MS`] — the same constant [`min_retry_after_ms`] uses, so the wait enforced
    /// and the wait reported are one number rather than two 1000s free to drift apart.
    ///
    /// `&self`, not `&mut self`: the tracker is shared, so a request records through it rather than
    /// owning it. See the type's note for why that is the shape a concurrent bridge needs.
    pub fn record_result(
        &self,
        key_id: &str,
        cls: ErrorClass,
        retry_after_ms: Option<u64>,
        now_ms: i64,
    ) {
        let mut keys = self.keys.lock().unwrap();
        let h = keys.entry(key_id.to_string()).or_default();
        match cls {
            ErrorClass::Ok => {
                // Taken rather than cleared so the recovery can be *observed*: a key that was
                // excluded by a breaker and has just served a request is the one event that proves
                // the half-open window did its job, and it is otherwise indistinguishable from a
                // key that was never blocked at all.
                let recovered = h.breaker_open_at.take();
                h.consecutive_auth_failures = 0;
                h.cooldown_until_ms = 0;
                if recovered.is_some() {
                    tracing::info!(key_id = key_id, "auth breaker cleared by a successful re-probe");
                }
            }
            ErrorClass::RateLimited => {
                let wait = retry_after_ms.unwrap_or(0).max(COOLDOWN_FLOOR_MS);
                h.cooldown_until_ms = now_ms + wait as i64;
                // **A 429 says nothing about the credential, so a half-open breaker stays
                // half-open.** The key is cooled but its stamp is left alone, which is what makes
                // the two readers agree: the key is unusable *now* (cooling) yet not re-armed, so
                // the next attempt — not this rate limit — decides the breaker.
            }
            ErrorClass::AuthFailed => {
                h.consecutive_auth_failures += 1;
                if h.consecutive_auth_failures >= AUTH_BREAKER_THRESHOLD {
                    // **Stamped on every failure past the threshold, not only on the transition.**
                    // A half-open re-probe that fails again must re-arm the window; if the stamp
                    // were written only when the breaker first opened, the key would be admitted on
                    // every request from then on — the latch traded for the opposite defect.
                    let re_armed = h.breaker_open_at.is_some();
                    h.breaker_open_at = Some(now_ms);
                    // The event is otherwise invisible: without this line "the breaker just
                    // excluded this key" and "the key was already excluded" leave the same trace,
                    // which is none. `re_armed` is what distinguishes a dead credential from a
                    // fresh one, and it is the only place that distinction is recorded.
                    tracing::warn!(
                        key_id = key_id,
                        failures = h.consecutive_auth_failures,
                        re_armed = re_armed,
                        "auth breaker opened; the key is excluded for one half-open window"
                    );
                }
            }
            // Everything else leaves key health alone, and this arm is *explicit* on purpose. The
            // TypeScript spells it as `else if (!isRetryableWithNextKey(cls)) return;`, which is a
            // no-op: the classes it names would fall through to the same "do nothing" anyway, and
            // SERVER_ERROR, NETWORK and TIMEOUT are not named by it at all yet still reach it.
            // Listing them exhaustively keeps the cases that change nothing visible instead of
            // implied by an absent branch.
            ErrorClass::NotFound
            | ErrorClass::BadRequestSchema
            | ErrorClass::ParseError
            // The provider honoured its contract and the model never wrote an answer — nothing here
            // is evidence against the credential, and counting it would cool a healthy key for a
            // request-side cause.
            | ErrorClass::NoOutput
            | ErrorClass::ServerError
            | ErrorClass::Timeout
            | ErrorClass::Network
            // A refusal by our own egress says nothing about the key — every key of a provider dials
            // the same host, so cooling this one would burn a good credential for a policy decision.
            | ErrorClass::EgressDenied
            // **The whole point of the class**: a client gate refused the caller without reading
            // any credential, so counting it here would open the breaker on a healthy key — the
            // exact defect `CLIENT_GATE` exists to prevent.
            | ErrorClass::ClientGate
            // A budget pool is per-provider, not per-key; rotating keys cannot refill it.
            | ErrorClass::Billing => {}
        }
    }

    /// Forget everything known about a key.
    pub fn reset_key(&self, key_id: &str) {
        self.keys.lock().unwrap().remove(key_id);
    }

    /// What is recorded about one key, or `None` when nothing has been.
    ///
    /// **`None` is not `Some(KeyHealth::default())`, and the distinction is the reason this returns
    /// an `Option`.** An absent entry and an entry whose every field sits at its default are
    /// different findings: the first means no attempt has touched this key, the second means
    /// attempts were recorded and changed nothing. [`HealthTracker::record_result`] inserts an entry
    /// even for the classes that leave health alone, so both states are reachable — and a caller
    /// that flattened them could not tell "never tried" from "tried, no effect".
    pub fn key_health(&self, key_id: &str) -> Option<KeyHealth> {
        self.keys.lock().unwrap().get(key_id).copied()
    }

    /// The raw map, for tests that assert on the shape of what was recorded.
    ///
    /// **Test-only on purpose.** Production readers want [`HealthTracker::key_health`], which
    /// answers the only question that exists outside a test — "what is recorded about this key?" —
    /// and does not hand out the map's own type. This exists because fourteen assertions in this
    /// module compare a whole `KeyHealth` or read one field off it, and rewriting each of them
    /// through `key_health(..).unwrap()` would be fourteen chances to change what is being asserted
    /// while claiming only to have moved it.
    #[cfg(test)]
    pub(crate) fn keys(&self) -> std::sync::MutexGuard<'_, HashMap<String, KeyHealth>> {
        self.keys.lock().unwrap()
    }
}
