//! Per-provider network budgets.
//!
//! The upstream timeouts used to be one global set: 20s for headers, 20s for the first byte,
//! 44s for the whole plan. That calibration came from providers that answer in a second or two,
//! and it turns an aggregator that merely queues for 25s into a failed turn. This module lets one
//! provider carry a longer leash without making every fast provider's failures slow.
//!
//! **Storage is the `router` settings row, not the manifest.** A timeout is execution policy, not
//! a property of the wire shape: changing it should not mint a manifest version, and both serving
//! hosts already read `RouterSettings` per request. The map is keyed by provider id, so a profile
//! follows the provider row rather than its current manifest.
//!
//! **Parsing is lenient and clamped.** The row is webview-written JSON, so a typo, a string where a
//! number belongs, or a `0` must not be able to produce an instant timeout. Every invalid value
//! falls back to that field's default, and the resulting profile is normalized so the invariants
//! the engine and gateway rely on still hold.

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;

use crate::core::egress::{
    UPSTREAM_FIRST_BYTE_TIMEOUT, UPSTREAM_FIRST_OUTPUT_TIMEOUT, UPSTREAM_HEADER_TIMEOUT,
    UPSTREAM_IDLE_TIMEOUT,
};
use crate::core::engine::{MAX_ATTEMPTS_DEFAULT, PLAN_BUDGET};
use crate::core::planner::Candidate;

/// The smallest accepted value for any per-phase budget. Below this a "timeout" is a typo, not a
/// policy: a 1ms header wait would fail every provider the moment the row was saved.
const MIN_PHASE: Duration = Duration::from_secs(1);

/// The largest accepted per-phase budget. Ten minutes is ZCode's idle ceiling; a value above it is
/// far more likely to be a unit mistake (seconds written as milliseconds) than an intent.
const MAX_PHASE: Duration = Duration::from_secs(600);

/// The largest accepted plan budget. It bounds how long one request may hold a routing slot; the
/// gateway's first-message backstop is derived from the maximum across profiles.
const MAX_PLAN: Duration = Duration::from_secs(900);

/// Slack between the first-output deadline and the plan budget. A plan budget equal to the
/// first-output timeout leaves no room for the attempt to be recorded and the next candidate to
/// be admitted.
const PLAN_MARGIN: Duration = Duration::from_secs(5);

/// The budgets one provider's attempts use. Durations rather than milliseconds because every
/// consumer (`tokio::time::timeout`, the admission predicate, the gateway bound) already speaks
/// `Duration`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeoutProfile {
    /// How long the upstream may take to produce response headers.
    pub header: Duration,
    /// How long it may take to produce the first body byte, measured from the send. Encloses
    /// `header`.
    pub first_byte: Duration,
    /// How long the stream may run before it carries the first item the gateway counts as output.
    pub first_output: Duration,
    /// How long the stream may stay silent after it has started.
    pub idle: Duration,
    /// The whole plan's wall-clock budget, across every candidate.
    pub plan_budget: Duration,
    /// How many candidates this plan may dial.
    pub max_attempts: usize,
}

impl Default for TimeoutProfile {
    fn default() -> Self {
        Self {
            header: UPSTREAM_HEADER_TIMEOUT,
            first_byte: UPSTREAM_FIRST_BYTE_TIMEOUT,
            first_output: UPSTREAM_FIRST_OUTPUT_TIMEOUT,
            idle: UPSTREAM_IDLE_TIMEOUT,
            plan_budget: PLAN_BUDGET,
            max_attempts: MAX_ATTEMPTS_DEFAULT,
        }
    }
}

impl TimeoutProfile {
    /// One provider's entry over the defaults. Absent or unreadable fields keep the default; the
    /// result is then normalized so a partially-specified object still satisfies the ordering the
    /// engine assumes.
    fn from_entry(entry: &Value) -> Self {
        let default = Self::default();
        let Some(obj) = entry.as_object() else {
            return default;
        };
        let millis = |key: &str, fallback: Duration| {
            obj.get(key)
                .and_then(Value::as_u64)
                .map(Duration::from_millis)
                .filter(|d| *d > Duration::ZERO)
                .unwrap_or(fallback)
        };
        Self {
            header: millis("headerMs", default.header),
            first_byte: millis("firstByteMs", default.first_byte),
            first_output: millis("firstOutputMs", default.first_output),
            idle: millis("idleMs", default.idle),
            plan_budget: millis("planBudgetMs", default.plan_budget),
            max_attempts: obj
                .get("maxAttempts")
                .and_then(Value::as_u64)
                .map(|n| n as usize)
                .unwrap_or(default.max_attempts),
        }
        .normalized()
    }

    /// Clamp every phase and restore the ordering the rest of the system reads.
    ///
    /// The ordering is not cosmetic: the gateway's first-message bound is derived from the plan
    /// budget, and the egress's first-byte bound encloses its header bound. A stored profile that
    /// inverted either would make the comment that promises "the engine fails first" false.
    fn normalized(mut self) -> Self {
        self.header = clamp(self.header, MIN_PHASE, MAX_PHASE);
        self.first_byte = clamp(self.first_byte.max(self.header), MIN_PHASE, MAX_PHASE);
        self.first_output = clamp(self.first_output.max(self.first_byte), MIN_PHASE, MAX_PHASE);
        self.idle = clamp(self.idle, MIN_PHASE, MAX_PHASE);
        self.plan_budget = clamp(
            self.plan_budget.max(self.first_output.saturating_add(PLAN_MARGIN)),
            MIN_PHASE,
            MAX_PLAN,
        );
        self.max_attempts = self.max_attempts.clamp(1, 12);
        self
    }
}

fn clamp(d: Duration, min: Duration, max: Duration) -> Duration {
    d.max(min).min(max)
}

/// The provider id → profile map, plus the defaults every unconfigured provider uses.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProviderTimeouts {
    default: TimeoutProfile,
    by_provider: BTreeMap<String, TimeoutProfile>,
}

impl ProviderTimeouts {
    /// Read the `providerTimeouts` key out of a stored `router` settings object.
    ///
    /// Absent, `null`, or not an object is the default map — the same rule
    /// `RouterSettings::from_value` applies to every other field, so one malformed key cannot
    /// change the behaviour of providers it does not name.
    pub fn from_router_settings(v: &Value) -> Self {
        let Some(map) = v.get("providerTimeouts") else {
            return Self::default();
        };
        Self::from_map(map)
    }

    /// Read a bare `{ "<provider-id>": { … } }` map.
    pub fn from_map(v: &Value) -> Self {
        let mut out = Self::default();
        let Some(obj) = v.as_object() else {
            return out;
        };
        for (id, entry) in obj {
            out.by_provider.insert(id.clone(), TimeoutProfile::from_entry(entry));
        }
        out
    }

    /// The profile for one provider, or the defaults.
    pub fn resolve(&self, provider_id: &str) -> TimeoutProfile {
        self.by_provider.get(provider_id).copied().unwrap_or(self.default)
    }

    /// The most patient profile in a plan. A plan may span providers, and the plan budget has to
    /// cover the slowest one or its candidates would be refused before they were dialled.
    pub fn max_plan_budget_for(&self, plan: &[Candidate]) -> Duration {
        plan.iter()
            .map(|c| self.resolve(&c.provider.id).plan_budget)
            .max()
            .unwrap_or(self.default.plan_budget)
    }

    /// The largest attempt allowance in a plan, so a mixed plan cannot be truncated to the first
    /// provider's count.
    pub fn max_attempts_for(&self, plan: &[Candidate]) -> usize {
        plan.iter()
            .map(|c| self.resolve(&c.provider.id).max_attempts)
            .max()
            .unwrap_or(self.default.max_attempts)
    }

    /// The largest plan budget across every configured profile. The gateway's first-message
    /// backstop is sized from this: it must stay above the engine's own bound for any provider.
    pub fn max_plan_budget(&self) -> Duration {
        self.by_provider
            .values()
            .map(|p| p.plan_budget)
            .max()
            .unwrap_or(self.default.plan_budget)
            .max(self.default.plan_budget)
    }

    /// The largest explicitly configured plan budget, or `None` when no provider has a profile.
    ///
    /// **The gateway uses this rather than [`Self::max_plan_budget`].** With no profiles the
    /// backstop must stay at its existing constant; deriving 44s + margin from the *default*
    /// would raise it for every provider that never asked for a longer leash.
    pub fn configured_max_plan_budget(&self) -> Option<Duration> {
        self.by_provider.values().map(|p| p.plan_budget).max()
    }

    /// Whether any provider has a profile. Used by the seed only.
    pub fn is_empty(&self) -> bool {
        self.by_provider.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_are_the_constants_the_rest_of_the_system_uses() {
        let p = TimeoutProfile::default();
        assert_eq!(p.header, UPSTREAM_HEADER_TIMEOUT);
        assert_eq!(p.first_byte, UPSTREAM_FIRST_BYTE_TIMEOUT);
        assert_eq!(p.first_output, UPSTREAM_FIRST_OUTPUT_TIMEOUT);
        assert_eq!(p.idle, UPSTREAM_IDLE_TIMEOUT);
        assert_eq!(p.plan_budget, PLAN_BUDGET);
        assert_eq!(p.max_attempts, MAX_ATTEMPTS_DEFAULT);
    }

    #[test]
    fn a_provider_entry_overrides_only_the_fields_it_names() {
        let map = ProviderTimeouts::from_map(&json!({
            "slow": { "headerMs": 60_000, "planBudgetMs": 180_000, "maxAttempts": 4 }
        }));
        let p = map.resolve("slow");
        assert_eq!(p.header, Duration::from_secs(60));
        assert_eq!(p.first_byte, Duration::from_secs(60), "first byte encloses headers");
        assert_eq!(p.first_output, Duration::from_secs(60), "first output encloses first byte");
        assert_eq!(p.plan_budget, Duration::from_secs(180));
        assert_eq!(p.max_attempts, 4);
        assert_eq!(map.resolve("fast"), TimeoutProfile::default(), "unconfigured keeps defaults");
    }

    #[test]
    fn corrupt_values_fall_back_and_clamp_to_a_usable_profile() {
        let map = ProviderTimeouts::from_map(&json!({
            "zero": { "headerMs": 0, "planBudgetMs": 0, "maxAttempts": 0 },
            "huge": { "headerMs": 9_999_999, "planBudgetMs": 9_999_999, "maxAttempts": 99 },
            "junk": { "headerMs": "60s", "maxAttempts": -1 },
            "not-an-object": "nope"
        }));
        let zero = map.resolve("zero");
        assert_eq!(zero.header, UPSTREAM_HEADER_TIMEOUT);
        assert!(zero.plan_budget >= zero.first_output + PLAN_MARGIN);
        assert_eq!(zero.max_attempts, 1);

        let huge = map.resolve("huge");
        assert_eq!(huge.header, MAX_PHASE);
        assert_eq!(huge.plan_budget, MAX_PLAN);
        assert_eq!(huge.max_attempts, 12);

        assert_eq!(map.resolve("junk"), TimeoutProfile::default());
        assert_eq!(map.resolve("not-an-object"), TimeoutProfile::default());
    }

    #[test]
    fn a_plan_budget_never_ends_below_the_first_output_deadline() {
        let map = ProviderTimeouts::from_map(&json!({
            "tight": { "headerMs": 60_000, "firstOutputMs": 60_000, "planBudgetMs": 60_000 }
        }));
        let p = map.resolve("tight");
        assert_eq!(p.plan_budget, p.first_output + PLAN_MARGIN);
    }

    #[test]
    fn the_router_reader_looks_for_the_nested_key() {
        let empty = ProviderTimeouts::from_router_settings(&json!({ "failoverEnabled": true }));
        assert!(empty.is_empty());

        let nested = ProviderTimeouts::from_router_settings(&json!({
            "providerTimeouts": { "p1": { "headerMs": 30_000 } }
        }));
        assert_eq!(nested.resolve("p1").header, Duration::from_secs(30));
    }

    #[test]
    fn max_plan_budget_covers_every_profile() {
        let map = ProviderTimeouts::from_map(&json!({
            "a": { "headerMs": 60_000, "planBudgetMs": 180_000 },
            "b": { "headerMs": 10_000, "planBudgetMs": 30_000 }
        }));
        assert_eq!(map.max_plan_budget(), Duration::from_secs(180));
        assert_eq!(map.max_plan_budget_for(&[]), PLAN_BUDGET);
    }

    #[test]
    fn the_recommended_agent_router_profile_keeps_the_system_ordering() {
        let map = ProviderTimeouts::from_map(&json!({
            "agent-router": {
                "headerMs": 60_000,
                "firstByteMs": 60_000,
                "firstOutputMs": 60_000,
                "planBudgetMs": 180_000,
                "maxAttempts": 4
            }
        }));
        let p = map.resolve("agent-router");
        assert!(p.header <= p.first_byte);
        assert!(p.first_byte <= p.first_output);
        assert!(p.first_output <= p.plan_budget);
        assert!(
            p.plan_budget >= p.header * 3,
            "three full attempts must fit, or the third key is unreachable"
        );
    }
}
