/**
 * Which model ids a picker offers, and why a bare id is on the list at all.
 *
 * # The defect this exists to close
 *
 * A **qualified** id (`slug/native`) resolves to exactly one provider. That is deliberate —
 * `route-planner.ts`'s `resolveWanted` sets `qualified` and then skips the bare-id branch, with the
 * comment "a genuinely qualified id never reaches here, so it can never be silently rerouted to a
 * different provider". The consequence is that `failoverEnabled` is **inert for every model picked
 * as a qualified id**, and until this module existed that was every model the UI could offer:
 * `Assistant.tsx` and `Settings.tsx` both mapped the catalog to `slug/native`, and nothing anywhere
 * produced a bare id.
 *
 * Measured 2026-09-29 on this machine: `settings.router.failoverEnabled` was `true`, and a request
 * for `agent-routerv2/deepseek-v4-flash` recorded a **one-entry** fallback chain
 * (`[{"provider":"agent-routerv2","key":"key-01","cls":"BAD_REQUEST_SCHEMA"}]`) against a provider
 * that failed ~29% of requests — while `vice` carried the same `deepseek-v4-flash` the whole time
 * and served it (verified live: `POST https://vyceai.com/chat/completions` with
 * `model: deepseek-v4-flash` → `200`). The attempt loop has no `break` on a non-retryable class
 * (`execution-engine.ts:83-175`), so the plan *is* the retry policy: a second candidate would have
 * been tried. There was never a second candidate, and the reason was the id's form.
 *
 * The bare form is already the documented contract — `Gateway.tsx`: "qualified `provider/native`
 * for an exact provider, or a bare id to let the router pick + fail over". It was simply
 * unreachable from the UI. This module makes it reachable without removing the qualified form,
 * because pinning a provider is a legitimate thing to want.
 *
 * # Why the carrier set is computed the way the planner computes it
 *
 * **A bare id's carrier set is not "every catalog row with that native id".** It is whatever
 * `resolveWanted` resolves, and that function checks the **alias map first** and skips the
 * catalog scan entirely when an alias exists (`if (!qualified && aliasRows.length === 0)`). So an
 * alias can *narrow* a bare id to one provider, and on this machine it does: the persisted alias
 * `deepseek-v4-flash → vice` means the bare id reaches **vice only**, not vice + agent-routerv2.
 *
 * An earlier version of this module counted catalog rows and would have labelled that entry
 * "any provider (failover)" while the planner pinned it to one provider — a fresh instance of the
 * defect being fixed, one layer down, and invisible to a test whose fixture passed `aliases: []`.
 * `bareCarriers` therefore mirrors `resolveWanted`'s precedence (alias rows if any, else catalog
 * rows), and every label is derived from the *resolved* set rather than from the catalog.
 *
 * # Why the bare entry appears only when two or more *enabled* providers carry the id
 *
 * With one catalog carrier there is nothing to choose between, so a second entry would be noise.
 * And the count is taken over **enabled** providers only: `ModelCatalog.forModality` filters by
 * modality and nothing else, so a disabled provider's rows are in the list, while `buildPlan` drops
 * a disabled provider outright (`p.status === "enabled"`). Counting without that filter would offer
 * an option with nothing to reach.
 */
import type { CatalogModel } from "@aiprovider/router-core";

/** One entry in a model picker. `id` is stored and sent; `label` is only ever read. */
export interface SelectableModel {
  /** A bare native id (router default) or `slug/native` (pinned to one provider). */
  id: string;
  label: string;
}

/** The only part of `AliasEntry` this module reads — a structural subset, so `catalog.aliases` fits. */
export interface AliasRow {
  alias: string;
  providerId: string;
}

/** Marks the form that lets the router choose, so the capability is visible where it is chosen. */
const ANY_PROVIDER = " · any provider (failover)";

/**
 * The providers a bare `nativeId` would actually reach.
 *
 * Mirrors `resolveWanted`'s precedence: an alias row for the id wins outright and the catalog is
 * not consulted; otherwise every catalog row carrying the native id. Distinct providers, in the
 * order the planner would consider them.
 */
export function bareCarriers(
  rows: readonly Pick<CatalogModel, "providerId" | "nativeId">[],
  aliases: readonly AliasRow[],
  nativeId: string,
): string[] {
  const viaAlias = aliases.filter((a) => a.alias === nativeId).map((a) => a.providerId);
  const base = viaAlias.length ? viaAlias : rows.filter((r) => r.nativeId === nativeId).map((r) => r.providerId);
  return [...new Set(base)];
}

/**
 * Whether the bare id would genuinely fan out across more than one **enabled** provider.
 *
 * This is the honest spelling of "failover is available for this model", and it is what the Models
 * screen's marker means. An alias that narrows the id to one provider makes it false even when the
 * catalog carries the model twice — which is the case that a catalog-only count got wrong.
 */
export function hasFailoverCarrier(
  rows: readonly Pick<CatalogModel, "providerId" | "nativeId">[],
  aliases: readonly AliasRow[],
  nativeId: string,
  isEnabled: (providerId: string) => boolean,
): boolean {
  return bareCarriers(rows, aliases, nativeId).filter(isEnabled).length > 1;
}

/**
 * Whether the catalog carries this native id on two or more enabled providers.
 *
 * Deliberately **not** alias-aware, and deliberately separate from `hasFailoverCarrier`: this is
 * the question "is a bare entry worth offering", not "will it fan out". The two differ exactly when
 * an alias narrows the id, and the picker offers the entry either way — because a bare id that the
 * operator has routed to a specific provider is still the right thing to pick when the alternative
 * is a qualified id on a provider that fails.
 */
export function offersBareId(
  rows: readonly Pick<CatalogModel, "providerId" | "nativeId">[],
  nativeId: string,
  isEnabled: (providerId: string) => boolean,
): boolean {
  const carriers = new Set<string>();
  for (const r of rows) {
    if (r.nativeId !== nativeId) continue;
    if (!isEnabled(r.providerId)) continue;
    carriers.add(r.providerId);
    if (carriers.size > 1) return true;
  }
  return false;
}

/**
 * The bare entry for one native id, or `null` when the id does not warrant one.
 *
 * The label is derived from the **resolved** carriers, so it says what the router will do:
 * a genuine fan-out reads "any provider (failover)", and an alias-narrowed id names the provider
 * it will actually use. A label that overstated the reach would be the same class of defect as
 * offering a failover option that cannot fail over.
 */
export function bareEntry(
  rows: readonly Pick<CatalogModel, "providerId" | "nativeId">[],
  aliases: readonly AliasRow[],
  nativeId: string,
  isEnabled: (providerId: string) => boolean,
  slugOf: (providerId: string) => string,
): SelectableModel | null {
  if (!offersBareId(rows, nativeId, isEnabled)) return null;
  const reachable = bareCarriers(rows, aliases, nativeId).filter(isEnabled);
  if (reachable.length > 1) return { id: nativeId, label: nativeId + ANY_PROVIDER };
  if (reachable.length === 1) {
    return { id: nativeId, label: `${nativeId} · router default (${slugOf(reachable[0]!)})` };
  }
  // No enabled provider would be reached — nothing to offer.
  return null;
}

/**
 * The picker's options, in catalog order.
 *
 * The bare entry is emitted immediately before the first row of its native id, so the router-chosen
 * form leads its own group and every other model keeps the position it had. Nothing is filtered out
 * — a model on a disabled provider still appears as a qualified entry, exactly as before, because
 * removing options is a separate decision from adding one.
 */
export function selectableModels(
  rows: readonly Pick<CatalogModel, "providerId" | "nativeId">[],
  aliases: readonly AliasRow[],
  slugOf: (providerId: string) => string,
  isEnabled: (providerId: string) => boolean,
): SelectableModel[] {
  const out: SelectableModel[] = [];
  const emitted = new Set<string>();
  const groupDone = new Set<string>();

  for (const r of rows) {
    if (!groupDone.has(r.nativeId)) {
      groupDone.add(r.nativeId);
      const bare = bareEntry(rows, aliases, r.nativeId, isEnabled, slugOf);
      if (bare && !emitted.has(bare.id)) {
        emitted.add(bare.id);
        out.push(bare);
      }
    }
    const id = `${slugOf(r.providerId)}/${r.nativeId}`;
    if (emitted.has(id)) continue;
    emitted.add(id);
    out.push({ id, label: id });
  }
  return out;
}
