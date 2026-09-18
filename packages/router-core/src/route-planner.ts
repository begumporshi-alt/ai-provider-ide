/**
 * route-planner (L2): expand a request into an ORDERED candidate plan of
 * `(provider, key, model)` triples (§3.1). Rotation strategy orders keys WITHIN a provider;
 * provider order comes from the catalog (which provider carries the model) and, for aliases,
 * the alias priority. Health filtering is applied at plan time; the execution engine re-checks
 * per-attempt because state moves during a stream.
 */
import type { Modality } from "@aiprovider/adapter-spec";
import { priceRank, type PricingMicros } from "./pricing.js";
import type { AliasEntry, ApiKeyRecord, CatalogModel, ProviderRecord } from "./domain.js";
import type { HealthTracker } from "./health-tracker.js";

export interface Candidate {
  provider: ProviderRecord;
  key: ApiKeyRecord;
  model: CatalogModel; // the resolved native model that will serve
}

export interface PlanInput {
  /** Bare native id, `<slug>/<native>` qualified id, or a configured alias. */
  model: string;
  modality: Modality;
  /** System-route exclusion (§2.8 rule 3): never plan through these providers. */
  excludeProviderIds?: string[];
}

export interface PlanContext {
  providers: ProviderRecord[];
  keysFor(providerId: string): ApiKeyRecord[];
  catalog(): CatalogModel[];
  aliases: AliasEntry[];
  health: HealthTracker;
  /** Round-robin cursor per provider (advanced by the caller after a successful attempt). */
  nextKeyCursor(providerId: string): number;
  /**
   * Normalized pricing lookup (audit R2). Optional so existing callers/tests keep their order;
   * when present AND a carrier declares `cost_spread`, carriers are ordered cheapest-first.
   */
  pricingFor?(providerId: string, nativeId: string): PricingMicros | undefined;
}

export function buildPlan(input: PlanInput, ctx: PlanContext, now = Date.now()): Candidate[] {
  const excluded = new Set(input.excludeProviderIds ?? []);
  const wanted = resolveWanted(input.model, ctx);

  const plan: Candidate[] = [];
  for (const w of orderCarriers(wanted, ctx)) {
    const provider = ctx.providers.find(
      (p) => p.id === w.providerId && p.status === "enabled" && !excluded.has(p.id),
    );
    if (!provider) continue;
    const model = ctx.catalog().find(
      (m) => m.providerId === provider.id && m.nativeId === w.nativeId && m.modality === input.modality,
    );
    if (!model) continue; // provider doesn't carry this model here — it becomes a failover target
    const keys = orderKeys(ctx.keysFor(provider.id), provider.rotationStrategy, ctx, provider.id, ctx.health, now);
    for (const key of keys) plan.push({ provider, key, model });
  }
  return plan;
}

interface WantedRef {
  providerId: string;
  nativeId: string;
}

/**
 * `cost_spread` carrier ordering (audit R2). Previously inert — it fell back to priority order
 * because no pricing existed. Cheapest-first, unknown pricing last, and only when a carrier
 * actually asked for cost_spread; otherwise the incoming order is preserved exactly.
 */
function orderCarriers(wanted: WantedRef[], ctx: PlanContext): WantedRef[] {
  if (!ctx.pricingFor) return wanted;
  const asked = wanted.some(
    (w) => ctx.providers.find((p) => p.id === w.providerId)?.rotationStrategy === "cost_spread",
  );
  if (!asked) return wanted;
  const rank = (w: WantedRef) => priceRank(ctx.pricingFor!(w.providerId, w.nativeId));
  // Stable sort: equal/unknown prices keep their original (priority/catalog) order.
  return wanted
    .map((w, i) => ({ w, i }))
    .sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i)
    .map((x) => x.w);
}

/**
 * Clients stamp a namespace onto model ids they did not define themselves: WorkBuddy prefixes
 * every entry it loads from `models.json` with `custom-local:`. That tag belongs to the client's
 * own catalog, not to any provider, so it is not part of the native id — resolve without it.
 *
 * Only a prefix with no `/` is eligible, which keeps the ordinary shapes intact:
 * `openrouter/gpt-4o` has no colon at all, and `openai/gpt-4o:extended` is a variant suffix whose
 * prefix contains a slash. A prefix that names a real provider is also left alone.
 */
export function stripClientNamespace(model: string, ctx: Pick<PlanContext, "providers">): string {
  const i = model.indexOf(":");
  if (i < 0) return model;
  const prefix = model.slice(0, i);
  if (prefix.includes("/")) return model;
  if (ctx.providers.some((p) => p.slug === prefix)) return model;
  return model.slice(i + 1);
}

function resolveWanted(requested: string, ctx: PlanContext): WantedRef[] {
  const out: WantedRef[] = [];
  const model = stripClientNamespace(requested, ctx);

  if (model.includes("/")) {
    const slug = model.split("/")[0]!;
    const p = ctx.providers.find((x) => x.slug === slug);
    if (p) out.push({ providerId: p.id, nativeId: model.slice(slug.length + 1) });
  }

  // Alias map: every provider carrying the alias, priority order (§3.4 bare-ID rule):
  // LOWER priority number = more preferred = primary route; ties keep catalog order.
  const aliasRows = ctx.aliases.filter((a) => a.alias === model).sort((a, b) => a.priority - b.priority);
  for (const a of aliasRows) out.push({ providerId: a.providerId, nativeId: a.nativeModelId });

  // Bare native id present on one or more providers: include all carriers — primary first,
  // the rest become automatic failover candidates (§3.1).
  if (!model.includes("/") && aliasRows.length === 0) {
    for (const c of ctx.catalog().filter((m) => m.nativeId === model)) {
      out.push({ providerId: c.providerId, nativeId: c.nativeId });
    }
  }

  const seen = new Set<string>();
  return out.filter((w) => {
    const k = `${w.providerId} ${w.nativeId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Rotation strategy: order the keys within one provider (§3.6, spec req. 6). */
export function orderKeys(
  keys: ApiKeyRecord[],
  strategy: ProviderRecord["rotationStrategy"],
  ctx: PlanContext,
  providerId: string,
  health: HealthTracker,
  now: number,
): ApiKeyRecord[] {
  const usable = keys.filter((k) => health.isKeyUsable(k, now));
  switch (strategy) {
    case "priority":
      return usable.sort((a, b) => a.priority - b.priority || a.addedAt - b.addedAt);
    case "lru":
      return usable.sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0));
    case "round_robin": {
      const start = ctx.nextKeyCursor(providerId) % Math.max(usable.length, 1);
      return [...usable.slice(start), ...usable.slice(0, start)];
    }
    case "cost_spread":
    default:
      // Cost_spread orders CARRIERS (providers), see `orderCarriers` — pricing is per model,
      // not per key, so within one provider there is nothing to spread. Keys fall back to
      // priority order, which is the documented v1 behaviour.
      return usable.sort((a, b) => a.priority - b.priority || a.addedAt - b.addedAt);
  }
}
