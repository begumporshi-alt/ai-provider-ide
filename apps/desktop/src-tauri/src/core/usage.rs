//! The one shape a provider's token counts take in Rust — the port of `ports.ts`'s `UsageTokens`
//! (`ports.ts:98-117`).
//!
//! **Why one type and not three inline literals.** The TypeScript says so itself, and the reason is
//! a defect it lived through: this shape is *written* by the manifest interpreter, *carried* by the
//! execution engine and *read* by the ledger, and "a field added in one place and not the others is
//! silently dropped — which is precisely how `cached_tokens` went unrecorded until migration 0015"
//! (`ports.ts:101-104`). The port keeps the single shape for the same reason, and the third field
//! below is the one that history is about.
//!
//! **The crate's other usage shape carries two of these three fields (D23).** `BridgeMsg::Usage`
//! (`gateway.rs:365-368`) is `{prompt_tokens: u64, completion_tokens: u64}` and has no
//! `cached_tokens`, so the gateway's client-facing `usage` object cannot report a cache count in any
//! of its four dialects. **Two channels, and only one of them was lossy.** The webview's `onUsage`
//! forwarded two fields to `gateway_usage` (`gateway-bridge.ts:299-305`, both deleted in 25f) and
//! that was what reached the response body; the *ledger* row was written on the webview side by the
//! router, which read `exec.usage()?.cached_tokens` in process (`model-router.ts:435`, `:519`) and
//! never crossed the bridge — so `cached_tokens` did reach the column for gateway traffic.
//!
//! **The split survived the port, and `BridgeMsg::Usage` is still the lossy side.**
//! `router_bridge.rs:344` builds `BridgeMsg::Usage` from a full [`UsageTokens`] and copies two of
//! its three fields, so the client-facing channel is exactly as lossy as the webview's `onUsage`
//! was — while `on_usage` still hands the ledger the whole shape. D23's warning is therefore a
//! description of the tree rather than a projection: the port avoided the mistake for the ledger
//! and reproduced it for the client.
//!
//! **The client-facing half is already recorded in full** (`09-status.md:179`, with the same
//! citations and with §8.2 as the reason its fix is deferred), so D23 does not re-find it. What D23
//! records is the **port-planning** consequence, which no entry held: routing was TypeScript when
//! this was written, so the lossy channel cost a client a field it could not derive, and the risk
//! was that moving routing into Rust would leave no webview holding the third value — so the ledger
//! row would have to be built here, and the obvious move, reusing the crate's only usage type,
//! would silently stop recording the measurement migration 0015 exists to take. **25e moved the
//! routing and the risk did not land:** `on_usage` carries the three-field shape, so the ledger
//! still sees it. That is why the shape was settled before the text half rather than alongside it.
//! `on_usage` hands over **this** type instead.
//!
//! **This is the shape the text half of the adapter seam was waiting for.** `adapter.rs` records
//! that `generateText` is absent because its `onUsage` callback "would introduce a **second** usage
//! shape beside the `BridgeMsg::Usage` the crate already has". That was the whole of the blocker,
//! and it is now decided rather than deferred: the callback carries [`UsageTokens`]. Nothing else
//! about the text half is settled by this module — the streaming shape and the ownership of the
//! loop's mutable state are still open.
//!
//! **Deliberately not `Serialize`.** The two boundaries that do serialise already have types with
//! their own conventions — `LedgerRow` is `rename_all = "camelCase"` (`persist.rs:455`) and the
//! bridge is a Rust enum with snake_case fields — so giving this one a serde representation would be
//! a third spelling of the same three numbers. It is an in-process shape, and the callers that cross
//! a boundary build their own.

/// Token counts for one attempt, as the upstream reported them.
///
/// **`cached_tokens: None` is not `0`, and the difference is the whole point.** `None` means the
/// provider reported no cache block at all; `Some(0)` means it reported one and nothing was cached.
/// Only the second is evidence that caching is unavailable to us, which is the question this
/// measurement exists to answer — and it is why `ledger.cached_tokens` is nullable with no default
/// (`store.rs:1083-1102`, migration 0015).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UsageTokens {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// Prompt tokens the upstream served from its own cache, when it said anything at all.
    pub cached_tokens: Option<u64>,
}

impl UsageTokens {
    pub fn new(prompt_tokens: u64, completion_tokens: u64, cached_tokens: Option<u64>) -> Self {
        Self { prompt_tokens, completion_tokens, cached_tokens }
    }

    /// The two counts that cross to a client, in the order `BridgeMsg::Usage` names them.
    ///
    /// Returns a plain pair rather than a `BridgeMsg::Usage` so that this module names no gateway
    /// type and the dependency stays one-way: `gateway` may know `usage`, never the reverse. The
    /// caller that owns the bridge builds the variant.
    pub fn counts(&self) -> (u64, u64) {
        (self.prompt_tokens, self.completion_tokens)
    }

    /// The value `ledger.cached_tokens` takes. `None` stays `None` and becomes SQL `NULL`.
    ///
    /// The cast is `as`, not `i64::try_from(..).ok()`, and the tidier-looking alternative is worse
    /// than it appears: `try_from` would turn a count above `i64::MAX` into `None`, which is
    /// **indistinguishable from "the provider reported no cache block"** — forging the exact
    /// distinction this field exists to keep. A count that large is unreachable in any case, so the
    /// choice is between a wrong number and a wrong *state*; a wrap is the former.
    pub fn cached_for_ledger(&self) -> Option<i64> {
        self.cached_tokens.map(|c| c as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `None`/`Some(0)` distinction, stated as a value rather than as a comment.
    #[test]
    fn a_provider_that_reported_no_cache_block_is_not_a_provider_that_reported_zero() {
        let silent = UsageTokens::new(120, 34, None);
        let reported_nothing_cached = UsageTokens::new(120, 34, Some(0));

        assert_ne!(
            silent, reported_nothing_cached,
            "absence and a reported zero are different findings and must not compare equal"
        );
        assert_eq!(silent.counts(), reported_nothing_cached.counts(), "the other two fields agree");
    }

    #[test]
    fn the_ledger_keeps_an_unreported_cache_block_as_an_absence() {
        // `None`, never `Some(0)`. This is the value the column was made nullable for, and the one
        // 0015's 1530 rows carry.
        assert_eq!(UsageTokens::new(120, 34, None).cached_for_ledger(), None);
    }

    #[test]
    fn the_ledger_keeps_a_reported_zero_as_a_zero() {
        assert_eq!(UsageTokens::new(120, 34, Some(0)).cached_for_ledger(), Some(0));
    }

    #[test]
    fn the_ledger_keeps_a_reported_count() {
        assert_eq!(UsageTokens::new(120, 34, Some(64)).cached_for_ledger(), Some(64));
    }

    #[test]
    fn the_two_counts_the_client_sees_are_the_two_the_provider_reported() {
        let u = UsageTokens::new(120, 34, Some(64));
        assert_eq!(u.counts(), (120, 34));
        // The pair is exactly the two fields `BridgeMsg::Usage` has, in its order — and the third
        // is deliberately not in it. That omission is D23, not an oversight of this method.
        assert_eq!(u.counts().0, u.prompt_tokens);
        assert_eq!(u.counts().1, u.completion_tokens);
    }

    /// **The guard against the defect `ports.ts:101-104` names is this literal, at compile time.**
    ///
    /// No runtime assertion can see a field that does not exist yet. An exhaustive construction can:
    /// a fourth field added to [`UsageTokens`] breaks every literal in this module, which forces
    /// whoever adds it to decide which boundary carries it instead of dropping it silently. So the
    /// test below asserts the three fields reach the two boundaries *and* keeps the literal
    /// exhaustive — the assertions are the readable half, the literal is the load-bearing one.
    #[test]
    fn every_field_reaches_one_of_the_two_boundaries() {
        let u = UsageTokens { prompt_tokens: 120, completion_tokens: 34, cached_tokens: Some(64) };

        assert_eq!(u.counts(), (120, 34));
        assert_eq!(u.cached_for_ledger(), Some(64));
        assert_eq!(u.prompt_tokens, 120);
        assert_eq!(u.completion_tokens, 34);
        assert_eq!(u.cached_tokens, Some(64));
    }
}
