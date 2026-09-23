//! Provider catalog pricing, normalized to one unit — the port of `pricing.ts` (95 lines).
//!
//! **Why this is the first piece of Phase 3 and not a detail of it.** `route-planner.ts` imports
//! exactly one thing, and this is it (`route-planner.ts:9`): `priceRank`, for the `cost_spread`
//! carrier ordering. Everything else the planner touches is already in Rust — `ProviderRow`,
//! `ApiKeyRow`, `ModelRow`, `AliasRow` (`persist.rs`), `HealthTracker::is_key_usable` and
//! `Candidate` — so pricing is the whole of the gap between "the planner is pure" and "the planner
//! can be ported".
//!
//! **Canonical unit: micro-USD per 1M tokens, as an integer.** Micros because the ledger column is
//! `cost_estimate_micros INTEGER`; per-1M because per-token prices are ~1e-7 and would round to
//! zero in any integer representation.
//!
//! **"Unknown" is `None`, never `Some(0)`, and that is the load-bearing distinction in this
//! module.** A provider that publishes no pricing is a different fact from one that publishes
//! free, and the UI renders them differently. This is the same defect class the register keeps
//! finding elsewhere — `NULL ≠ 0` in the ledger's `cached_tokens` (`core::usage`), "no cap" as
//! `NULL` rather than `0` (`core::limiter`) — so the shape states it rather than commenting it:
//! every fallible step here returns `None` rather than a zero.
//!
//! **Currency is assumed USD** because that is what providers publish, and anything not
//! confidently readable as USD is `None`. There is no conversion here and no guessing.

use serde_json::Value;

/// Micro-USD in one USD.
pub const MICROS_PER_USD: i64 = 1_000_000;

/// The denominator that makes a per-token price representable as an integer.
pub const TOKENS_PER_MILLION: i64 = 1_000_000;

/// Normalized pricing for one model on one provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PricingMicros {
    /// Micro-USD per 1M prompt (input) tokens.
    pub prompt: i64,
    /// Micro-USD per 1M completion (output) tokens.
    pub completion: i64,
}

/// Read a number out of raw catalog JSON, or `None`.
///
/// **Numbers and non-empty numeric strings only, and the empty string is the reason this is not a
/// one-line `as_f64()`.** The rule is the one `clamp_concurrency` documents for the same reason
/// (`core::limiter`): `"".parse::<f64>()` fails, which is right, but a *coercing* conversion would
/// give `0` — and `0` here would mean "free", turning a provider that published nothing into the
/// cheapest carrier on the list. `""` is specifically what a text field produces when a user
/// clears it, so it is the shape that actually reaches a person.
///
/// **One documented divergence from JavaScript.** `Number("0x10")` is `16` and `Number("0o7")` is
/// `7`; `str::parse::<f64>()` rejects both, so they are unknown here. Neither is a price anybody
/// publishes, and matching `Number()`'s full coercion table would mean accepting spellings nobody
/// intended — but it is a difference, so it is tested rather than left implicit
/// (`a_hex_string_is_rejected_where_javascript_would_coerce_it`).
///
/// **There is deliberately no finiteness filter here, and the first draft had one.** `"Infinity"`
/// and `"NaN"` do parse successfully in Rust, so filtering looked necessary — but
/// [`usd_per_token_to_micros_per_mtok`] rejects them anyway, because it checks the *product*:
/// `Infinity * 1e12` is `Infinity` and `NaN * 1e12` is `NaN`, and neither is finite. A gate here
/// would be a second spelling of a state the conversion already refuses, which is the defect class
/// this crate keeps finding. Found by falsification, not by reading: dropping the filter left
/// `a_non_finite_string_is_unknown_rather_than_the_largest_price` passing, because the test was
/// measuring the conversion all along.
fn to_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if !s.trim().is_empty() => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// USD per token -> micro-USD per 1M tokens (same magnitude, integer-safe).
///
/// Returns `None` rather than saturating: a price that does not fit in `i64` is not a price this
/// program can compare, and saturating would forge the largest price imaginable out of a value we
/// could not read. Callers treat `None` as unknown, which sorts last rather than first.
fn usd_per_token_to_micros_per_mtok(usd_per_token: f64) -> Option<i64> {
    let micros = usd_per_token * (TOKENS_PER_MILLION as f64) * (MICROS_PER_USD as f64);
    if !micros.is_finite() || micros < i64::MIN as f64 || micros > i64::MAX as f64 {
        return None;
    }
    Some(micros.round() as i64)
}

/// Read pricing out of a provider's RAW catalog entry.
///
/// Recognised shapes (all USD-per-token, string or number):
///  - OpenRouter:  `{ pricing: { prompt, completion } }`
///  - generic:     `{ pricing: { input, output } }`
///  - LiteLLM-ish: `{ pricing: { input_cost_per_token, output_cost_per_token } }`
///
/// Anything else is `None` — **never** `Some(PricingMicros { 0, 0 })`. Providers that publish no
/// pricing (most Anthropic-compatible catalogs) legitimately return `None`, and a zero would make
/// them the cheapest carrier in any `cost_spread` ordering.
pub fn parse_pricing(raw: &Value) -> Option<PricingMicros> {
    let pricing = raw.get("pricing")?;
    if !pricing.is_object() {
        return None;
    }
    // **The four spellings are tried with `find_map`, not with a `?` chain, and the difference is
    // a bug the first draft had.** `to_number(pricing.get("prompt")?).or_else(|| to_number(
    // pricing.get("input")?))` looks like the original's `??` chain and is not one: the inner `?`
    // returns from `parse_pricing` on the first miss, so a catalog using the `input`/`output`
    // spelling parsed as *unknown* rather than as the price it declared — which in a
    // cheapest-first ordering silently demotes that provider to last. `??` in TypeScript falls
    // through to the next operand; `?` in Rust returns from the function. Pinned by
    // `the_three_recognised_shapes_all_parse`, whose generic case is the one that caught it.
    let prompt = ["prompt", "input", "input_cost_per_token", "prompt_cost_per_token"]
        .into_iter()
        .find_map(|k| pricing.get(k).and_then(to_number));
    let completion = ["completion", "output", "output_cost_per_token", "completion_cost_per_token"]
        .into_iter()
        .find_map(|k| pricing.get(k).and_then(to_number));
    let (Some(prompt), Some(completion)) = (prompt, completion) else {
        return None;
    };

    // A nonsense price is unknown, not zero. A negative here is corruption, and reading it as `0`
    // would promote the corrupt row to the front of a cheapest-first ordering.
    if prompt < 0.0 || completion < 0.0 {
        return None;
    }
    Some(PricingMicros {
        prompt: usd_per_token_to_micros_per_mtok(prompt)?,
        completion: usd_per_token_to_micros_per_mtok(completion)?,
    })
}

/// Cost of one request in micro-USD, or `None` when pricing is unknown.
///
/// **The sum is rounded once, not each term.** The original is
/// `Math.round(inCost + outCost)` with both terms as floats; truncating each term to an integer
/// first looks equivalent and is not — 500k tokens at 1 micro each is 0.5 + 0.5, which rounds to
/// **1** as a sum and truncates to **0** per term. The difference is a systematic under-report of
/// every cost whose terms each fall below half a unit, which is the common case for cheap models.
/// Pinned by `the_cost_is_the_rounded_sum_not_the_sum_of_rounded_terms`.
///
/// An overflow is `None` (unknown) rather than a saturated number: a cost this program cannot
/// represent must not be written to the ledger as a real one.
pub fn estimate_cost_micros(
    pricing: Option<PricingMicros>,
    tokens_in: u64,
    tokens_out: u64,
) -> Option<i64> {
    let pricing = pricing?;
    let total = (tokens_in as i128) * (pricing.prompt as i128)
        + (tokens_out as i128) * (pricing.completion as i128);
    // `Math.round` on a non-negative value is `(x + 1/2) | 0` — ties away from zero. For a
    // negative total (impossible with non-negative inputs, but reachable if a caller passes one)
    // this must subtract instead, so the sign is handled rather than assumed.
    let rounded = if total >= 0 {
        (total + TOKENS_PER_MILLION as i128 / 2) / TOKENS_PER_MILLION as i128
    } else {
        -((-total + TOKENS_PER_MILLION as i128 / 2) / TOKENS_PER_MILLION as i128)
    };
    i64::try_from(rounded).ok()
}

/// Cheapest-first rank for `cost_spread`; unknown pricing sorts last.
///
/// **`None` rather than `f64::INFINITY`, and that is a deliberate improvement.** The original
/// returns `Number.POSITIVE_INFINITY` for unknown, which works only by accident: `Infinity -
/// Infinity` is `NaN`, and `NaN || (a.i - b.i)` falls through to the index comparison. Ported
/// literally into Rust it would need a NaN-aware comparator to reproduce the same tie-break, and
/// a reader who wrote `partial_cmp().unwrap()` would panic on it. `Option<i64>` says "no price"
/// instead, and the caller handles it explicitly — see `sort_by_price_rank`.
///
/// The two components are `saturating_add`ed rather than `checked_add`ed so that an absurd price
/// stays *a price* (and stays last) instead of collapsing into "unknown", which is the
/// two-spellings-of-one-state defect one level down.
pub fn price_rank(pricing: Option<PricingMicros>) -> Option<i64> {
    pricing.map(|p| p.prompt.saturating_add(p.completion))
}

/// Cheapest first, unknown last, ties in their original order.
///
/// The sort is stable, so equal ranks keep their incoming order — which is the priority/catalog
/// order the caller already built. This is the comparator `route-planner.ts`'s `orderCarriers`
/// needs, and it is here rather than in the planner so the "unknown goes last" rule has one home
/// and one set of tests.
pub fn sort_by_price_rank<T, F>(items: &mut [T], rank_of: F)
where
    F: Fn(&T) -> Option<i64>,
{
    items.sort_by(|a, b| match (rank_of(a), rank_of(b)) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (Some(_), None) => std::cmp::Ordering::Less,
        (Some(x), Some(y)) => x.cmp(&y),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn micros(prompt: i64, completion: i64) -> PricingMicros {
        PricingMicros { prompt, completion }
    }

    #[test]
    fn an_unknown_price_is_not_a_free_price() {
        // The distinction this module exists to keep. `None` is "no price published";
        // `Some(micros(0, 0))` is "free", and a `cost_spread` ordering must not confuse them.
        assert_eq!(parse_pricing(&json!({})), None);
        assert_eq!(parse_pricing(&json!("not an object")), None);
        assert_eq!(parse_pricing(&json!(null)), None);
        // A `pricing` field that exists but is not an object. The three inputs above all fail one
        // step earlier (`raw.get("pricing")` misses), so without these the `is_object` branch is
        // never reached — found by falsification, which reported this test blind to it.
        assert_eq!(parse_pricing(&json!({"pricing": 5})), None);
        assert_eq!(parse_pricing(&json!({"pricing": []})), None);
        assert_eq!(parse_pricing(&json!({"pricing": "0.0000025"})), None);
        assert_ne!(
            parse_pricing(&json!({})),
            Some(micros(0, 0)),
            "unknown and free are different facts and must not compare equal"
        );
    }

    #[test]
    fn a_negative_price_is_unknown_rather_than_zero() {
        // A corrupt row must not be promoted to the front of a cheapest-first ordering.
        assert_eq!(parse_pricing(&json!({"pricing": {"prompt": -1, "completion": 5}})), None);
        assert_eq!(parse_pricing(&json!({"pricing": {"prompt": 5, "completion": -1}})), None);
    }

    #[test]
    fn the_three_recognised_shapes_all_parse() {
        // OpenRouter, generic, and LiteLLM-ish — the three dialects `pricing.ts` names.
        let openrouter = json!({"pricing": {"prompt": "0.0000025", "completion": "0.00001"}});
        assert_eq!(parse_pricing(&openrouter), Some(micros(2_500_000, 10_000_000)));

        let generic = json!({"pricing": {"input": 0.0000025, "output": 0.00001}});
        assert_eq!(parse_pricing(&generic), Some(micros(2_500_000, 10_000_000)));

        let litellm = json!({"pricing": {"input_cost_per_token": 0.0000025, "output_cost_per_token": 0.00001}});
        assert_eq!(parse_pricing(&litellm), Some(micros(2_500_000, 10_000_000)));
    }

    #[test]
    fn an_empty_string_price_is_unknown_not_free() {
        // `Number("")` is `0` in JavaScript. Here the string path requires a non-empty trim, so a
        // cleared field stays unknown instead of becoming the cheapest carrier on the list.
        assert_eq!(
            parse_pricing(&json!({"pricing": {"prompt": "", "completion": "0.00001"}})),
            None
        );
        assert_eq!(
            parse_pricing(&json!({"pricing": {"prompt": "   ", "completion": "0.00001"}})),
            None
        );
    }

    #[test]
    fn a_hex_string_is_rejected_where_javascript_would_coerce_it() {
        // The documented divergence. `Number("0x10")` is `16`; `str::parse::<f64>()` rejects it.
        assert_eq!(
            parse_pricing(&json!({"pricing": {"prompt": "0x10", "completion": "0x10"}})),
            None
        );
    }

    #[test]
    fn a_non_finite_string_is_unknown_rather_than_the_largest_price() {
        // `"Infinity"` and `"NaN"` parse successfully in Rust; only the finiteness filter keeps
        // them out, and a NaN would poison every comparison below it.
        assert_eq!(
            parse_pricing(&json!({"pricing": {"prompt": "Infinity", "completion": "1"}})),
            None
        );
        assert_eq!(parse_pricing(&json!({"pricing": {"prompt": "NaN", "completion": "1"}})), None);
    }

    #[test]
    fn an_unrepresentable_price_is_unknown_rather_than_saturated() {
        // Saturating would forge the largest price this program can hold from a value it could
        // not read.
        assert_eq!(
            parse_pricing(&json!({"pricing": {"prompt": 1e300, "completion": 1e300}})),
            None
        );
    }

    #[test]
    fn the_cost_is_the_rounded_sum_not_the_sum_of_rounded_terms() {
        // 500k tokens at 1 micro each is 0.5 + 0.5: `Math.round` of the sum is 1, truncating each
        // term first is 0. The truncating version under-reports every cheap request.
        let pricing = micros(1, 1);
        assert_eq!(estimate_cost_micros(Some(pricing), 500_000, 500_000), Some(1));
        assert_eq!(estimate_cost_micros(Some(pricing), 499_999, 499_999), Some(1));
        assert_eq!(estimate_cost_micros(Some(pricing), 400_000, 400_000), Some(1));
        assert_eq!(estimate_cost_micros(Some(pricing), 100_000, 100_000), Some(0));
    }

    #[test]
    fn an_unknown_price_has_no_cost() {
        assert_eq!(estimate_cost_micros(None, 1_000, 1_000), None);
    }

    #[test]
    fn a_known_price_costs_what_the_two_terms_add_to() {
        let pricing = micros(2_500_000, 10_000_000);
        // 1M in at 2.5 USD + 1M out at 10 USD = 12.5 USD = 12_500_000 micros.
        assert_eq!(estimate_cost_micros(Some(pricing), 1_000_000, 1_000_000), Some(12_500_000));
    }

    #[test]
    fn cheapest_first_unknown_last_and_ties_keep_their_order() {
        // The `cost_spread` comparator, spelled as a whole ordering rather than as a number.
        let mut items = vec![
            ("unknown-a", price_rank(None)),
            ("price-5", price_rank(Some(micros(3, 2)))),
            ("price-5-tie", price_rank(Some(micros(1, 4)))),
            ("price-2", price_rank(Some(micros(1, 1)))),
            ("unknown-b", price_rank(None)),
        ];
        sort_by_price_rank(&mut items, |(_, r)| *r);
        let order: Vec<&str> = items.iter().map(|(n, _)| *n).collect();
        assert_eq!(
            order,
            vec!["price-2", "price-5", "price-5-tie", "unknown-a", "unknown-b"],
            "cheapest first, unknown last, equal ranks in their original order"
        );
    }

    #[test]
    fn the_rank_of_an_unknown_price_is_absent_rather_than_infinite() {
        // The deliberate divergence from `Number.POSITIVE_INFINITY`: there is no NaN here for a
        // comparator to trip over.
        assert_eq!(price_rank(None), None);
        assert_eq!(price_rank(Some(micros(3, 4))), Some(7));
    }
}
