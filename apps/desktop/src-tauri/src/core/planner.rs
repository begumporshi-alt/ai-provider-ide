//! The route planner (L2): expand one request into an ORDERED candidate plan of
//! `(provider, key, model)` triples — the Rust port of `route-planner.ts` (173 lines), and the
//! first piece of Phase 3.
//!
//! **Why this is where Phase 3 starts, and why it is the cheap half of it.** `route-planner.ts` is
//! *pure*: `buildPlan(input, ctx, now) -> Candidate[]` plus two helpers. It has no I/O, no async,
//! no SQLite and no adapter — the same line increments 1–6 of Phase 2 held deliberately — and
//! every row type it reads is already this crate's (`ProviderRow`, `ApiKeyRow`, `ModelRow`,
//! `AliasRow` in `persist.rs`; `HealthTracker` in `engine.rs`). Its only real dependency was
//! `priceRank` from `pricing.ts`, which is why `core::pricing` landed first (increment 11a). The
//! expensive half of Phase 3 is `model-router.ts` and the adapter layer behind it, which is
//! precisely what the seam in `core::adapter` exists to keep out of this module.
//!
//! **Rotation strategy orders keys WITHIN a provider; provider order comes from the catalog and
//! the alias priority.** Those are two different orderings and they are applied at two different
//! points: [`order_carriers`] orders the `(provider, model)` pairs, [`order_keys`] orders the keys
//! of one provider. Health filtering happens at plan time; `core::engine` re-checks per attempt
//! because state moves during a stream.
//!
//! **`now_ms` is a parameter and there is no default.** The TypeScript is
//! `buildPlan(input, ctx, now = Date.now())`; the port drops the default rather than smuggling a
//! clock into a module that is otherwise pure, which is this crate's convention already
//! (`HealthTracker::record_result`, `HealthTracker::is_key_usable`).
//!
//! **The context is a trait, not a struct of callbacks, and that was decided by a borrow.** A
//! struct holding `&'a dyn Fn(..)` forces every test to keep its closures alive longer than the
//! context it builds — `&|pid| ...` as a field is a temporary, and the borrow checker is right to
//! refuse it. [`PlanContext`] as a trait lets the fixture be the context, which is also what the
//! TypeScript is: an object literal with methods.
//!
//! **Three places the port is provably identical but not literally identical**, each pinned by a
//! test rather than left as a claim:
//!
//! 1. [`order_keys`]'s `rem_euclid` replaces JavaScript's `%` **plus** its negative `slice`
//!    indices. `-1 % 3` is `-1`, and `slice(-1)`/`slice(0, -1)` count from the end; `rem_euclid`
//!    gives the same rotation for every cursor, including negative ones.
//! 2. The TypeScript guards `orderCarriers` with `if (!ctx.pricingFor) return wanted`. With
//!    [`PlanContext::pricing_for`] returning `Option<PricingMicros>`, "no lookup supplied" and
//!    "a lookup that answers `None` for everything" are the *same* ordering: every rank is `None`,
//!    every comparison is `Equal`, and a stable sort is the identity. The guard is therefore
//!    unobservable and the port has no spelling of it — `pricing_for` is a **required** method
//!    with no default body, per this crate's rule, and "no pricing" is one of its answers.
//! 3. The dedup key is a `(provider_id, native_id)` tuple where the TypeScript builds
//!    `` `${providerId} ${nativeId}` ``. A space-separated string collapses two different pairs
//!    that happen to split differently (`("a b", "c")` and `("a", "b c")`); the tuple does not.
//!    Reachable only with an id containing a space, but the tuple is the stricter reading and
//!    costs nothing.

use std::borrow::Cow;
use std::collections::HashSet;

use crate::core::engine::HealthTracker;
use crate::core::persist::{AliasRow, ApiKeyRow, ModelRow, ProviderRow};
use crate::core::pricing::{price_rank, sort_by_price_rank, PricingMicros};

/// The rotation strategy that orders CARRIERS rather than keys (§3.6, audit R2).
const COST_SPREAD: &str = "cost_spread";

/// One planned attempt: which provider to call, with which key, for which model.
///
/// The Rust home of `route-planner.ts`'s `Candidate` (`:13-17`). It moved here from
/// `core::engine` in increment 11b, which is the increment that finally ports the planner — the
/// type's doc-comment there said it was parked in the engine only "because the planner itself is
/// not ported yet", and a planner module that does not own its own output type would be that
/// promise left unredeemed. The engine imports it.
///
/// **The name was taken, and the other holder gave way.** `context_scope.rs` already had a
/// `Candidate` — a *recalled memory* headed for the prompt, `{id, layer, text, pinned}` — now
/// `context_scope::MemoryItem`. The TypeScript is this port's reference and cannot move, so the
/// port keeps the source's name and the Rust-only type is the one renamed. Recorded as D21.
///
/// **The three rows are owned, and `Clone` is on them for this reason.** The TypeScript's
/// `Candidate` holds *references* to rows the caller still owns, so five candidates share one
/// provider object; the port clones. That is the one structural difference this shape forces, and
/// it is why `ProviderRow`, `ApiKeyRow` and `ModelRow` gained `Clone` in this increment.
///
/// **`Debug`, and only `Debug`.** `Clone` is here because building a plan needs it; `PartialEq` is
/// still deliberately absent — see the engine's module note for why `AttemptOutcome` does not
/// carry a candidate yet.
#[derive(Debug)]
pub struct Candidate {
    pub provider: ProviderRow,
    pub key: ApiKeyRow,
    pub model: ModelRow,
}

/// What was asked for. The port of `PlanInput` (`route-planner.ts:19-25`).
pub struct PlanInput<'a> {
    /// Bare native id, `<slug>/<native>` qualified id, or a configured alias.
    pub model: &'a str,
    /// `"text"` or `"image"`. A `&str` and not a `Modality` enum because that is what
    /// `ModelRow::modality` is in this crate — the catalog is a string column, and an enum here
    /// would mean a conversion at every comparison for no checking.
    pub modality: &'a str,
    /// System-route exclusion (§2.8 rule 3): never plan through these providers.
    pub exclude_provider_ids: &'a [String],
}

/// Everything the planner reads, and nothing it writes. The port of `PlanContext`
/// (`route-planner.ts:27-40`).
///
/// A trait rather than a struct of `&dyn Fn` fields — see the module note. Every method is
/// required: there is no default body anywhere, so a new member breaks every implementor at
/// compile time, which is the discipline the rest of this crate holds.
pub trait PlanContext {
    fn providers(&self) -> &[ProviderRow];
    fn aliases(&self) -> &[AliasRow];
    fn health(&self) -> &HealthTracker;

    /// Every key of `provider_id`, in whatever order the store returned them.
    fn keys_for(&self, provider_id: &str) -> Vec<ApiKeyRow>;

    /// The model catalog. Called once per carrier, as the TypeScript calls it
    /// (`route-planner.ts:52`).
    fn catalog(&self) -> Vec<ModelRow>;

    /// Round-robin cursor for `provider_id`, advanced by the caller after a successful attempt.
    fn next_key_cursor(&self, provider_id: &str) -> i64;

    /// Normalized pricing for one model on one provider, or `None` when the provider published
    /// none. `None` is **not** a zero; see `core::pricing` for why that distinction is the whole
    /// point of the unit it returns.
    fn pricing_for(&self, provider_id: &str, native_id: &str) -> Option<PricingMicros>;
}

/// A `(provider, model)` pair the request wants, before any of it is checked against the catalog.
/// The port of the private `WantedRef` (`route-planner.ts:62-65`).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Wanted {
    provider_id: String,
    native_id: String,
}

/// Expand a request into an ordered plan (§3.1). The port of `buildPlan` (`:42-60`).
///
/// **Each carrier contributes as many candidates as it has usable keys**, and the carrier order
/// decides the failover order: every key of the first carrier precedes every key of the second.
///
/// **A carrier contributes nothing — rather than a candidate with no key — when its provider is
/// disabled, excluded, missing the model at the requested modality, or out of usable keys.** The
/// TypeScript `continue`s in each of those cases (`:51`, `:55`) and so does this; the plan is
/// allowed to be empty, and an empty plan is a caller-visible "no route for model".
pub fn build_plan(input: &PlanInput<'_>, ctx: &impl PlanContext, now_ms: i64) -> Vec<Candidate> {
    let wanted = resolve_wanted(input.model, ctx);
    let mut plan = Vec::new();

    for w in order_carriers(wanted, ctx) {
        // **The provider check is `HealthTracker::is_provider_usable`, not an inline
        // `status == "enabled"`.** The TypeScript spells the string literal here
        // (`route-planner.ts:49`) while the tracker owns the same allow-list one file over
        // (`health-tracker.ts`). Two spellings of one rule is the defect this crate keeps
        // finding, so the port calls the one the engine already calls. Same answer for every row.
        let Some(provider) = ctx.providers().iter().find(|p| {
            p.id == w.provider_id
                && HealthTracker::is_provider_usable(p)
                && !input.exclude_provider_ids.contains(&p.id)
        }) else {
            continue;
        };
        let Some(model) = ctx.catalog().into_iter().find(|m| {
            m.provider_id == provider.id
                && m.native_id == w.native_id
                && m.modality == input.modality
        }) else {
            continue;
        };

        let keys = order_keys(
            ctx.keys_for(&provider.id),
            &provider.rotation_strategy,
            ctx,
            &provider.id,
            ctx.health(),
            now_ms,
        );
        for key in keys {
            plan.push(Candidate { provider: provider.clone(), key, model: model.clone() });
        }
    }
    plan
}

/// `cost_spread` carrier ordering (audit R2). The port of `orderCarriers` (`:72-84`).
///
/// **Ordering is decided by whether ANY wanted carrier asked for `cost_spread` — including a
/// carrier whose own provider uses a different strategy.** That is the TypeScript's `wanted.some(
/// ... )` (`:74-76`) and it is kept, but it is worth reading twice: one `cost_spread` provider on
/// the list reorders every other provider's carrier, cheapest-first, whether they asked or not.
///
/// **The sort is stable, so equal and unknown prices keep their priority/catalog order** — which
/// is why no index decoration is needed. `core::pricing::sort_by_price_rank` is the comparator.
fn order_carriers(wanted: Vec<Wanted>, ctx: &impl PlanContext) -> Vec<Wanted> {
    let asked = wanted.iter().any(|w| {
        ctx.providers()
            .iter()
            .find(|p| p.id == w.provider_id)
            .is_some_and(|p| p.rotation_strategy == COST_SPREAD)
    });
    if !asked {
        return wanted;
    }
    let mut out = wanted;
    sort_by_price_rank(&mut out, |w| price_rank(ctx.pricing_for(&w.provider_id, &w.native_id)));
    out
}

/// Drop a client's own namespace tag from a model id, if it is one. The port of
/// `stripClientNamespace` (`:95-102`).
///
/// **Every answer is borrowed, including the stripped one.** The function returns `Cow` because
/// it is called once per plan and the common case strips nothing, but the borrow is the real
/// point: no path allocates.
///
/// Three shapes are left alone, and each has a reason: no colon at all; a prefix *containing a
/// slash* (so `openai/gpt-4o:extended` keeps its variant suffix — the prefix is a route, not a
/// tag); and a prefix that names a real provider slug.
///
/// **The provider lookup ignores status.** A disabled provider still claims its own slug here,
/// which is how a qualified id can resolve to a provider the plan then refuses — see
/// `a_disabled_provider_still_claims_the_qualifier_and_shuts_off_the_bare_id_fallback`.
pub fn strip_client_namespace<'a>(model: &'a str, ctx: &impl PlanContext) -> Cow<'a, str> {
    let Some(i) = model.find(':') else {
        return Cow::Borrowed(model);
    };
    let prefix = &model[..i];
    if prefix.contains('/') {
        return Cow::Borrowed(model);
    }
    if ctx.providers().iter().any(|p| p.slug == prefix) {
        return Cow::Borrowed(model);
    }
    Cow::Borrowed(&model[i + 1..])
}

/// Turn one requested id into the `(provider, model)` pairs it could mean. The port of
/// `resolveWanted` (`:104-145`).
///
/// **Three sources, in this order: the qualified `<slug>/<native>` form, the alias map, and the
/// bare native id.** The bare-id pass runs only when the id was *not* qualified **and** no alias
/// matched (`:132`) — which is what stops a genuinely qualified id from being silently rerouted to
/// whichever other provider happens to carry a model with that literal name.
///
/// **A slash is a provider qualifier only when it resolves.** OpenRouter's own native ids contain
/// one (`openai/gpt-4o-mini`), so a bare native id and a qualified id are indistinguishable on the
/// wire; reading every slash as a qualifier would 404 every client that sends the provider's own
/// id.
fn resolve_wanted(requested: &str, ctx: &impl PlanContext) -> Vec<Wanted> {
    let stripped = strip_client_namespace(requested, ctx);
    let model: &str = stripped.as_ref();
    let mut out: Vec<Wanted> = Vec::new();

    let mut qualified = false;
    if let Some(slash) = model.find('/') {
        let slug = &model[..slash];
        if let Some(p) = ctx.providers().iter().find(|x| x.slug == slug) {
            out.push(Wanted {
                provider_id: p.id.clone(),
                native_id: model[slash + 1..].to_string(),
            });
            qualified = true;
        }
    }

    // **The alias rows are copied before they are sorted, and that is the TypeScript's shape, not
    // an accident of the port.** `ctx.aliases.filter(...).sort(...)` (`:125`) sorts the *result*
    // of `filter`, never `ctx.aliases`; a Rust `retain` followed by `sort` would reorder the
    // caller's own vector through a `&mut`. Pinned by
    // `the_alias_pass_sorts_a_copy_and_never_the_callers_rows`.
    let mut alias_rows: Vec<&AliasRow> =
        ctx.aliases().iter().filter(|a| a.alias == model).collect();
    alias_rows.sort_by_key(|a| a.priority);
    for a in &alias_rows {
        out.push(Wanted {
            provider_id: a.provider_id.clone(),
            native_id: a.native_model_id.clone(),
        });
    }

    if !qualified && alias_rows.is_empty() {
        for c in ctx.catalog() {
            if c.native_id == model {
                out.push(Wanted { provider_id: c.provider_id, native_id: c.native_id });
            }
        }
    }

    let mut seen: HashSet<(String, String)> = HashSet::new();
    out.into_iter().filter(|w| seen.insert((w.provider_id.clone(), w.native_id.clone()))).collect()
}

/// Rotation strategy: order the keys within one provider (§3.6, spec req. 6). The port of
/// `orderKeys` (`:148-173`).
///
/// **`health` is a parameter *and* `ctx.health()` exists, which is the TypeScript's own
/// redundancy** (`:56` passes `ctx.health` into a function that already has `ctx`). The port keeps
/// the signature because it is an export and a caller could hand in a different tracker; it is
/// not a second spelling of a rule, because only the parameter is ever consulted.
///
/// **`cost_spread` lands in the priority arm on purpose.** Pricing is per model, not per key, so
/// within one provider there is nothing to spread; `order_carriers` is where that strategy acts.
/// So does every *unrecognised* strategy string — the TypeScript's `default` — rather than being
/// rejected, which is what keeps an unknown value in a store column from disabling a provider.
pub fn order_keys(
    mut keys: Vec<ApiKeyRow>,
    strategy: &str,
    ctx: &impl PlanContext,
    provider_id: &str,
    health: &HealthTracker,
    now_ms: i64,
) -> Vec<ApiKeyRow> {
    keys.retain(|k| health.is_key_usable(k, now_ms));
    match strategy {
        "lru" => keys.sort_by_key(|k| k.last_used_at.unwrap_or(0)),
        "round_robin" => {
            // **`rem_euclid`, not `%`, and the two agree for every cursor including negative
            // ones.** JavaScript's `%` keeps the sign (`-1 % 3` is `-1`) and then `slice(-1)` /
            // `slice(0, -1)` count backwards from the end, so `start = -1` on three keys means
            // "begin at index 2" — which is exactly `rem_euclid(3)`. `rem_euclid` is therefore a
            // total, panic-free spelling of the same rotation rather than a rounding of it.
            //
            // `max(1)` is the TypeScript's `Math.max(usable.length, 1)` (`:163`): with no usable
            // keys the modulus must not be zero, and the rotation of an empty list is empty.
            let start = ctx.next_key_cursor(provider_id).rem_euclid(keys.len().max(1) as i64);
            keys.rotate_left(start as usize);
        }
        // "priority", "cost_spread", and anything else.
        _ => keys.sort_by(|a, b| a.priority.cmp(&b.priority).then(a.added_at.cmp(&b.added_at))),
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::pricing::PricingMicros;

    // ---- fixtures ---------------------------------------------------------------------------

    fn provider(id: &str, slug: &str, rotation: &str) -> ProviderRow {
        provider_status(id, slug, rotation, "enabled")
    }

    fn provider_status(id: &str, slug: &str, rotation: &str, status: &str) -> ProviderRow {
        ProviderRow {
            id: id.to_string(),
            slug: slug.to_string(),
            name: id.to_string(),
            r#type: Some("builtin".to_string()),
            base_url: format!("https://{slug}.test/v1"),
            status: status.to_string(),
            rotation_strategy: rotation.to_string(),
            created_at: 1,
            updated_at: 1,
        }
    }

    fn key(id: &str, provider_id: &str) -> ApiKeyRow {
        ApiKeyRow {
            id: id.to_string(),
            provider_id: provider_id.to_string(),
            label: id.to_string(),
            secret_ref: format!("key:{id}"),
            secret_hint: None,
            status: "active".to_string(),
            priority: 0,
            cooldown_until: None,
            added_at: 1,
            last_used_at: None,
            last_tested_at: None,
        }
    }

    fn model(provider_id: &str, native_id: &str, modality: &str) -> ModelRow {
        ModelRow {
            provider_id: provider_id.to_string(),
            native_id: native_id.to_string(),
            modality: modality.to_string(),
            context_window: None,
            fetched_at: 1,
            pricing_json: None,
            capabilities_json: None,
        }
    }

    fn alias(alias: &str, provider_id: &str, native_model_id: &str, priority: i64) -> AliasRow {
        AliasRow {
            alias: alias.to_string(),
            provider_id: provider_id.to_string(),
            native_model_id: native_model_id.to_string(),
            priority,
        }
    }

    /// The context, as a value rather than as a bundle of closures.
    #[derive(Default)]
    struct Fixture {
        providers: Vec<ProviderRow>,
        aliases: Vec<AliasRow>,
        keys: Vec<ApiKeyRow>,
        models: Vec<ModelRow>,
        /// `(provider_id, native_id, pricing)`; absent means unknown, which is not free.
        pricing: Vec<(String, String, PricingMicros)>,
        cursor: i64,
        health: HealthTracker,
    }

    impl PlanContext for Fixture {
        fn providers(&self) -> &[ProviderRow] {
            &self.providers
        }
        fn aliases(&self) -> &[AliasRow] {
            &self.aliases
        }
        fn health(&self) -> &HealthTracker {
            &self.health
        }
        fn keys_for(&self, provider_id: &str) -> Vec<ApiKeyRow> {
            self.keys.iter().filter(|k| k.provider_id == provider_id).cloned().collect()
        }
        fn catalog(&self) -> Vec<ModelRow> {
            self.models.clone()
        }
        fn next_key_cursor(&self, _provider_id: &str) -> i64 {
            self.cursor
        }
        fn pricing_for(&self, provider_id: &str, native_id: &str) -> Option<PricingMicros> {
            self.pricing
                .iter()
                .find(|(p, n, _)| p == provider_id && n == native_id)
                .map(|(_, _, pricing)| *pricing)
        }
    }

    /// Build a plan for one model at `"text"` modality with nothing excluded.
    fn plan_for(model_id: &str, f: &Fixture) -> Vec<Candidate> {
        let input = PlanInput { model: model_id, modality: "text", exclude_provider_ids: &[] };
        build_plan(&input, f, 1_000)
    }

    fn carrier_ids(plan: &[Candidate]) -> Vec<&str> {
        plan.iter().map(|c| c.provider.id.as_str()).collect()
    }

    fn key_ids(plan: &[Candidate]) -> Vec<&str> {
        plan.iter().map(|c| c.key.id.as_str()).collect()
    }

    // ---- stripClientNamespace --------------------------------------------------------------

    #[test]
    fn a_client_tag_the_router_has_no_provider_for_is_dropped() {
        let f = Fixture {
            providers: vec![provider("pOR", "openrouter", "round_robin")],
            ..Default::default()
        };
        assert_eq!(
            strip_client_namespace("custom-local:openrouter/openai/gpt-4o-mini", &f),
            "openrouter/openai/gpt-4o-mini"
        );
    }

    #[test]
    fn a_colon_that_follows_a_slash_is_a_variant_suffix_not_a_namespace() {
        // The prefix contains a slash, so it is a route: `openai/gpt-4o:extended` is untouched.
        let f = Fixture {
            providers: vec![provider("pOR", "openrouter", "round_robin")],
            ..Default::default()
        };
        assert_eq!(
            strip_client_namespace("openrouter/openai/gpt-4o:extended", &f),
            "openrouter/openai/gpt-4o:extended"
        );
    }

    #[test]
    fn a_bare_native_id_and_a_prefix_naming_a_real_provider_are_left_alone() {
        let f = Fixture {
            providers: vec![provider("pOR", "openrouter", "round_robin")],
            ..Default::default()
        };
        assert_eq!(strip_client_namespace("gpt-4o-mini", &f), "gpt-4o-mini");
        assert_eq!(strip_client_namespace("openrouter:whatever", &f), "openrouter:whatever");
    }

    // ---- resolveWanted: the three sources --------------------------------------------------

    #[test]
    fn a_bare_id_plans_every_provider_that_carries_it() {
        // §3.1: the carriers are automatic failover candidates, in catalog order.
        let f = Fixture {
            providers: vec![provider("pA", "a", "priority"), provider("pB", "b", "priority")],
            keys: vec![key("a:k1", "pA"), key("b:k1", "pB")],
            models: vec![model("pA", "m1", "text"), model("pB", "m1", "text")],
            ..Default::default()
        };
        let plan = plan_for("m1", &f);
        assert_eq!(carrier_ids(&plan), vec!["pA", "pB"], "every carrier, catalog order");
    }

    #[test]
    fn a_qualified_id_plans_only_the_named_provider_and_is_never_rerouted() {
        // `a` IS a provider here, so `a/m1` is qualified. A second carrier happens to carry a
        // model literally named `a/m1`; the bare-id fallback must not reach it.
        let f = Fixture {
            providers: vec![provider("pA", "a", "priority"), provider("pB", "b", "priority")],
            keys: vec![key("a:k1", "pA"), key("b:k1", "pB")],
            models: vec![
                model("pA", "m1", "text"),
                model("pB", "a/m1", "text"),
                model("pB", "m1", "text"),
            ],
            ..Default::default()
        };
        let plan = plan_for("a/m1", &f);
        assert_eq!(carrier_ids(&plan), vec!["pA"]);
        assert_eq!(plan[0].model.native_id, "m1", "the qualifier is not part of the native id");
    }

    #[test]
    fn a_slash_bearing_native_id_still_resolves_as_a_bare_id() {
        // OpenRouter's own native ids contain a slash; the leading segment names no provider of
        // ours, so the qualifier reading must be abandoned rather than 404ing the client.
        let f = Fixture {
            providers: vec![provider("pOR", "openrouter", "round_robin")],
            keys: vec![key("or:k1", "pOR")],
            models: vec![model("pOR", "openai/gpt-4o-mini", "text")],
            ..Default::default()
        };
        let plan = plan_for("openai/gpt-4o-mini", &f);
        assert_eq!(carrier_ids(&plan), vec!["pOR"]);
        assert_eq!(plan[0].model.native_id, "openai/gpt-4o-mini");
    }

    #[test]
    fn a_client_tag_is_stripped_and_never_reaches_the_provider() {
        let f = Fixture {
            providers: vec![provider("pOR", "openrouter", "round_robin")],
            keys: vec![key("or:k1", "pOR")],
            models: vec![model("pOR", "openai/gpt-4o-mini", "text")],
            ..Default::default()
        };
        // Qualified after stripping: `custom-local:` goes, `openrouter/` is the qualifier.
        let plan = plan_for("custom-local:openrouter/openai/gpt-4o-mini", &f);
        assert_eq!(carrier_ids(&plan), vec!["pOR"]);
        assert_eq!(plan[0].model.native_id, "openai/gpt-4o-mini");

        // ...and an unknown stripped id is still unknown.
        assert!(plan_for("custom-local:openrouter/no-such-model", &f).is_empty());
    }

    #[test]
    fn an_alias_resolves_to_every_carrier_in_priority_order() {
        // §3.4 bare-ID rule: LOWER priority number is more preferred; ties keep the row order.
        let f = Fixture {
            providers: vec![
                provider("pA", "a", "priority"),
                provider("pB", "b", "priority"),
                provider("pC", "c", "priority"),
            ],
            keys: vec![key("a:k1", "pA"), key("b:k1", "pB"), key("c:k1", "pC")],
            models: vec![
                model("pA", "native-a", "text"),
                model("pB", "native-b", "text"),
                model("pC", "native-c", "text"),
            ],
            aliases: vec![
                alias("smart", "pB", "native-b", 5),
                alias("smart", "pA", "native-a", 1),
                alias("smart", "pC", "native-c", 5),
            ],
            ..Default::default()
        };
        let plan = plan_for("smart", &f);
        assert_eq!(carrier_ids(&plan), vec!["pA", "pB", "pC"], "priority, ties in row order");
    }

    #[test]
    fn an_alias_suppresses_the_bare_id_carriers() {
        // `aliasRows.length === 0` gates the bare pass (route-planner.ts:132), so a provider that
        // carries a model literally named `smart` is NOT a failover target for the alias `smart`.
        let f = Fixture {
            providers: vec![provider("pA", "a", "priority"), provider("pB", "b", "priority")],
            keys: vec![key("a:k1", "pA"), key("b:k1", "pB")],
            models: vec![model("pA", "native-a", "text"), model("pB", "smart", "text")],
            aliases: vec![alias("smart", "pA", "native-a", 1)],
            ..Default::default()
        };
        assert_eq!(carrier_ids(&plan_for("smart", &f)), vec!["pA"]);
    }

    #[test]
    fn the_alias_pass_sorts_a_copy_and_never_the_callers_rows() {
        // The TypeScript sorts the *result* of `filter`. A `retain`-then-`sort` here would
        // reorder `ctx.aliases` through a shared borrow, so the fixture's own rows are the
        // assertion: they must come back in the order they were handed over.
        let f = Fixture {
            providers: vec![provider("pA", "a", "priority"), provider("pB", "b", "priority")],
            keys: vec![key("a:k1", "pA"), key("b:k1", "pB")],
            models: vec![model("pA", "native-a", "text"), model("pB", "native-b", "text")],
            aliases: vec![alias("smart", "pB", "native-b", 5), alias("smart", "pA", "native-a", 1)],
            ..Default::default()
        };
        assert_eq!(carrier_ids(&plan_for("smart", &f)), vec!["pA", "pB"]);
        assert_eq!(
            f.aliases.iter().map(|a| a.provider_id.as_str()).collect::<Vec<_>>(),
            vec!["pB", "pA"],
            "the caller's alias rows are untouched — the plan sorted a copy"
        );
    }

    #[test]
    fn the_same_provider_and_model_are_planned_once() {
        // The only shape that actually produces a duplicate: the qualifier `a/m1` resolves to
        // `{pA, m1}`, and an alias *named* `a/m1` resolves to the same pair. Without the dedup
        // the plan carries the carrier twice and the engine would try the same key twice.
        let f = Fixture {
            providers: vec![provider("pA", "a", "priority")],
            keys: vec![key("a:k1", "pA")],
            models: vec![model("pA", "m1", "text")],
            aliases: vec![alias("a/m1", "pA", "m1", 1)],
            ..Default::default()
        };
        let plan = plan_for("a/m1", &f);
        assert_eq!(carrier_ids(&plan), vec!["pA"], "one carrier, not two");
    }

    #[test]
    fn an_unknown_model_plans_nothing() {
        let f = Fixture {
            providers: vec![provider("pA", "a", "priority")],
            keys: vec![key("a:k1", "pA")],
            models: vec![model("pA", "m1", "text")],
            ..Default::default()
        };
        assert!(plan_for("nope", &f).is_empty(), "no route for model");
    }

    // ---- buildPlan: what drops a carrier ---------------------------------------------------

    #[test]
    fn a_disabled_provider_is_not_planned() {
        let f = Fixture {
            providers: vec![
                provider_status("pA", "a", "priority", "disabled"),
                provider("pB", "b", "priority"),
            ],
            keys: vec![key("a:k1", "pA"), key("b:k1", "pB")],
            models: vec![model("pA", "m1", "text"), model("pB", "m1", "text")],
            ..Default::default()
        };
        assert_eq!(carrier_ids(&plan_for("m1", &f)), vec!["pB"]);
    }

    #[test]
    fn an_excluded_provider_is_not_planned() {
        // §2.8 rule 3: the system route's own provider must never be a candidate for itself.
        let f = Fixture {
            providers: vec![provider("pA", "a", "priority"), provider("pB", "b", "priority")],
            keys: vec![key("a:k1", "pA"), key("b:k1", "pB")],
            models: vec![model("pA", "m1", "text"), model("pB", "m1", "text")],
            ..Default::default()
        };
        let excluded = vec!["pA".to_string()];
        let input = PlanInput { model: "m1", modality: "text", exclude_provider_ids: &excluded };
        assert_eq!(carrier_ids(&build_plan(&input, &f, 1_000)), vec!["pB"]);
    }

    #[test]
    fn a_disabled_provider_still_claims_the_qualifier_and_shuts_off_the_bare_id_fallback() {
        // A sharp edge worth knowing, kept rather than fixed. `stripClientNamespace` and the
        // qualifier lookup both read `ctx.providers` **regardless of status**, while `buildPlan`
        // then requires `enabled`. So `a/m1` resolves as qualified against a disabled `a`, the
        // bare-id fallback is suppressed by `qualified`, and the plan comes back empty even
        // though another enabled provider carries a model literally named `a/m1`.
        let f = Fixture {
            providers: vec![
                provider_status("pA", "a", "priority", "disabled"),
                provider("pB", "b", "priority"),
            ],
            keys: vec![key("a:k1", "pA"), key("b:k1", "pB")],
            models: vec![model("pA", "m1", "text"), model("pB", "a/m1", "text")],
            ..Default::default()
        };
        assert!(
            plan_for("a/m1", &f).is_empty(),
            "the disabled provider claims the qualifier, so the fallback never runs"
        );
    }

    #[test]
    fn a_provider_that_lacks_the_requested_modality_is_not_planned() {
        let f = Fixture {
            providers: vec![provider("pA", "a", "priority"), provider("pB", "b", "priority")],
            keys: vec![key("a:k1", "pA"), key("b:k1", "pB")],
            models: vec![model("pA", "m1", "image"), model("pB", "m1", "text")],
            ..Default::default()
        };
        assert_eq!(carrier_ids(&plan_for("m1", &f)), vec!["pB"]);
    }

    #[test]
    fn an_unusable_key_is_dropped_and_a_provider_with_none_left_contributes_nothing() {
        // Usability is the real tracker, not a stub: a cooldown on the key record is one of the
        // four ways `is_key_usable` says no.
        let mut cooled = key("a:k1", "pA");
        cooled.cooldown_until = Some(9_999);
        let f = Fixture {
            providers: vec![provider("pA", "a", "priority"), provider("pB", "b", "priority")],
            keys: vec![cooled.clone(), key("a:k2", "pA"), key("b:k1", "pB")],
            models: vec![model("pA", "m1", "text"), model("pB", "m1", "text")],
            ..Default::default()
        };
        let plan = plan_for("m1", &f);
        assert_eq!(carrier_ids(&plan), vec!["pA", "pB"]);
        assert_eq!(key_ids(&plan), vec!["a:k2", "b:k1"], "the cooled key is not planned");

        let none_left = Fixture {
            providers: vec![provider("pA", "a", "priority")],
            keys: vec![cooled],
            models: vec![model("pA", "m1", "text")],
            ..Default::default()
        };
        assert!(
            plan_for("m1", &none_left).is_empty(),
            "a carrier with no usable key contributes no candidate at all"
        );
    }

    // ---- orderKeys: the four strategies ----------------------------------------------------

    fn key_ids_of(keys: &[ApiKeyRow]) -> Vec<&str> {
        keys.iter().map(|k| k.id.as_str()).collect()
    }

    fn order(strategy: &str, keys: Vec<ApiKeyRow>, cursor: i64) -> Vec<ApiKeyRow> {
        let f = Fixture { cursor, ..Default::default() };
        let health = HealthTracker::new();
        order_keys(keys, strategy, &f, "pA", &health, 1_000)
    }

    #[test]
    fn priority_orders_by_priority_then_added_at() {
        let mut k1 = key("k1", "pA");
        k1.priority = 5;
        k1.added_at = 1;
        let mut k2 = key("k2", "pA");
        k2.priority = 1;
        k2.added_at = 9;
        let mut k3 = key("k3", "pA");
        k3.priority = 1;
        k3.added_at = 2;
        assert_eq!(key_ids_of(&order("priority", vec![k1, k2, k3], 0)), vec!["k3", "k2", "k1"]);
    }

    #[test]
    fn lru_orders_a_never_used_key_first() {
        let mut k1 = key("k1", "pA");
        k1.last_used_at = Some(500);
        let mut k2 = key("k2", "pA");
        k2.last_used_at = Some(100);
        let k3 = key("k3", "pA"); // never used — `?? 0`
        assert_eq!(key_ids_of(&order("lru", vec![k1, k2, k3], 0)), vec!["k3", "k2", "k1"]);
    }

    #[test]
    fn round_robin_rotates_from_the_cursor() {
        let keys = vec![key("k1", "pA"), key("k2", "pA"), key("k3", "pA")];
        assert_eq!(key_ids_of(&order("round_robin", keys.clone(), 0)), vec!["k1", "k2", "k3"]);
        assert_eq!(key_ids_of(&order("round_robin", keys.clone(), 1)), vec!["k2", "k3", "k1"]);
        // The cursor wraps: a caller advances it past the end rather than resetting it.
        assert_eq!(key_ids_of(&order("round_robin", keys.clone(), 4)), vec!["k2", "k3", "k1"]);
    }

    #[test]
    fn a_negative_cursor_rotates_from_the_end_exactly_as_javascript_slice_does() {
        // The documented equivalence. JavaScript: `-1 % 3` is `-1`, then `slice(-1)` is the last
        // element and `slice(0, -1)` the rest — so `start = -1` means "begin at index 2".
        // `rem_euclid(3)` is 2, and `rotate_left(2)` produces the same list.
        let keys = vec![key("k1", "pA"), key("k2", "pA"), key("k3", "pA")];
        assert_eq!(key_ids_of(&order("round_robin", keys.clone(), -1)), vec!["k3", "k1", "k2"]);
        assert_eq!(key_ids_of(&order("round_robin", keys, -5)), vec!["k2", "k3", "k1"]);
    }

    #[test]
    fn round_robin_over_no_usable_keys_is_empty_rather_than_a_division_by_zero() {
        // `Math.max(usable.length, 1)` is the guard; `rem_euclid` needs the same one.
        assert!(order("round_robin", vec![], 3).is_empty());
    }

    #[test]
    fn an_unrecognised_strategy_falls_back_to_priority_order() {
        // The TypeScript's `default`. An unknown value in a store column must degrade, not
        // disable the provider — and `cost_spread` lands here too, because pricing is per model.
        let mut k1 = key("k1", "pA");
        k1.priority = 5;
        let mut k2 = key("k2", "pA");
        k2.priority = 1;
        for strategy in ["cost_spread", "something-else", ""] {
            assert_eq!(
                key_ids_of(&order(strategy, vec![k1.clone(), k2.clone()], 0)),
                vec!["k2", "k1"],
                "`{strategy}` orders by priority"
            );
        }
    }

    // ---- orderCarriers: cost_spread --------------------------------------------------------

    fn spread_fixture(pricing: Vec<(String, String, PricingMicros)>, rotation: &str) -> Fixture {
        Fixture {
            providers: vec![
                provider("pExp", "exp", rotation),
                provider("pCheap", "cheap", rotation),
            ],
            keys: vec![key("exp:k1", "pExp"), key("cheap:k1", "pCheap")],
            models: vec![model("pExp", "m1", "text"), model("pCheap", "m1", "text")],
            pricing,
            ..Default::default()
        }
    }

    fn micros(prompt: i64, completion: i64) -> PricingMicros {
        PricingMicros { prompt, completion }
    }

    #[test]
    fn cost_spread_puts_the_cheapest_carrier_first() {
        // `pExp` is listed first in `providers`, so this order proves the reordering happened.
        let f = spread_fixture(
            vec![
                ("pExp".to_string(), "m1".to_string(), micros(900_000, 900_000)),
                ("pCheap".to_string(), "m1".to_string(), micros(100_000, 100_000)),
            ],
            "cost_spread",
        );
        assert_eq!(carrier_ids(&plan_for("m1", &f)), vec!["pCheap", "pExp"]);
    }

    #[test]
    fn cost_spread_preserves_the_catalog_order_when_no_price_is_known() {
        // The TypeScript's legacy shape supplies NO `pricingFor` at all; here `pricing_for`
        // answers `None` for everything. Those are the same ordering — every rank is `None`,
        // every comparison is `Equal`, and a stable sort is the identity — which is why the port
        // has no spelling of the `if (!ctx.pricingFor)` guard.
        let f = spread_fixture(vec![], "cost_spread");
        assert_eq!(carrier_ids(&plan_for("m1", &f)), vec!["pExp", "pCheap"]);
    }

    #[test]
    fn one_carrier_asking_for_cost_spread_reorders_the_others_too() {
        // `wanted.some(...)` — the strategy is read off the carrier that asked, and the ordering
        // it produces is applied to every carrier on the list.
        let f = Fixture {
            providers: vec![
                provider("pExp", "exp", "priority"),
                provider("pCheap", "cheap", "cost_spread"),
            ],
            keys: vec![key("exp:k1", "pExp"), key("cheap:k1", "pCheap")],
            models: vec![model("pExp", "m1", "text"), model("pCheap", "m1", "text")],
            pricing: vec![
                ("pExp".to_string(), "m1".to_string(), micros(900_000, 900_000)),
                ("pCheap".to_string(), "m1".to_string(), micros(100_000, 100_000)),
            ],
            ..Default::default()
        };
        assert_eq!(
            carrier_ids(&plan_for("m1", &f)),
            vec!["pCheap", "pExp"],
            "pExp never asked for cost_spread and was still reordered by it"
        );
    }

    #[test]
    fn no_carrier_asking_for_cost_spread_leaves_the_order_alone_even_with_prices() {
        // The mirror image: prices exist, but the guard is whether a carrier *asked*, not whether
        // an answer is available.
        let f = spread_fixture(
            vec![
                ("pExp".to_string(), "m1".to_string(), micros(900_000, 900_000)),
                ("pCheap".to_string(), "m1".to_string(), micros(100_000, 100_000)),
            ],
            "priority",
        );
        assert_eq!(carrier_ids(&plan_for("m1", &f)), vec!["pExp", "pCheap"]);
    }

    #[test]
    fn a_carrier_with_an_unknown_price_sorts_last_not_first() {
        // `None` is "published nothing", and the cheapest-first ordering must not read it as
        // free — the distinction `core::pricing` exists to keep.
        let f = spread_fixture(
            vec![("pExp".to_string(), "m1".to_string(), micros(900_000, 900_000))],
            "cost_spread",
        );
        assert_eq!(
            carrier_ids(&plan_for("m1", &f)),
            vec!["pExp", "pCheap"],
            "the priced carrier first, the unknown one last"
        );
    }

    // ---- the plan's shape ------------------------------------------------------------------

    #[test]
    fn every_usable_key_of_a_carrier_precedes_every_key_of_the_next() {
        // Carrier order first, key order within it — the two orderings compose rather than merge.
        let f = Fixture {
            providers: vec![provider("pA", "a", "priority"), provider("pB", "b", "priority")],
            keys: vec![key("a:k1", "pA"), key("a:k2", "pA"), key("b:k1", "pB")],
            models: vec![model("pA", "m1", "text"), model("pB", "m1", "text")],
            ..Default::default()
        };
        assert_eq!(key_ids(&plan_for("m1", &f)), vec!["a:k1", "a:k2", "b:k1"]);
    }
}
