/**
 * The picker's option list.
 *
 * # What this pins, and why the planner is in the test
 *
 * `selectable.ts` has one job: offer a **bare** native id when the operator can benefit from it. The
 * value of that id is not a property of the string — it is the property *"`buildPlan` reaches the
 * providers the label claims"*. So the assertions below run the real `buildPlan` alongside the
 * string, rather than asserting the string alone.
 *
 * # Why the fixtures carry aliases
 *
 * An earlier version of this file passed `aliases: []` to every plan context. That is not the shape
 * production has: `store.ts` loads the persisted alias table and marks every row `auto: false`, and
 * `resolveWanted` consults aliases **before** the catalog and skips the catalog scan entirely when
 * an alias matches. On this machine the persisted row `deepseek-v4-flash → vice` therefore narrows
 * the bare id to **one** provider — while the catalog carries it on two.
 *
 * With an empty alias list the helper looked correct and the fixture was a fabrication. The alias
 * rows below are the real ones, read from `model_aliases` on 2026-09-29.
 *
 * # The incident the fixtures are named after
 *
 * `settings.router.failoverEnabled` was `true`, and a request for `agent-routerv2/deepseek-v4-flash`
 * recorded a **one-entry** fallback chain while that provider failed ~29% of requests. `vice`
 * carried the same `deepseek-v4-flash` and serves it (verified live: `200`). The id's form was the
 * whole reason there was no alternative candidate, so the fixtures use the real names.
 */
import { describe, expect, it } from "vitest";
import {
  HealthTracker,
  buildPlan,
  type AliasEntry,
  type ApiKeyRecord,
  type CatalogModel,
  type PlanContext,
  type ProviderRecord,
} from "@aiprovider/router-core";
// `ProviderLifecycleState` lives in adapter-spec and is *not* re-exported by router-core
// (`index.ts` forwards only `AdapterManifest`), so it is named at its source rather than through
// the package that merely consumes it.
import type { ProviderLifecycleState } from "@aiprovider/adapter-spec";
import { bareCarriers, bareEntry, hasFailoverCarrier, offersBareId, selectableModels } from "./selectable";

/** The native id both carriers advertise in the incident. */
const SHARED = "deepseek-v4-flash";

function provider(id: string, slug: string, status: ProviderLifecycleState = "enabled"): ProviderRecord {
  return {
    id,
    slug,
    name: slug,
    type: "builtin",
    baseUrl: `https://${slug}.test/v1`,
    status,
    rotationStrategy: "priority",
    createdAt: 1,
    updatedAt: 1,
  };
}

function key(id: string, providerId: string): ApiKeyRecord {
  return {
    id,
    providerId,
    label: id,
    secretRef: `key:${providerId}:${id}`,
    status: "active",
    priority: 0,
    cooldownUntil: null,
    addedAt: 1,
    lastUsedAt: null,
    lastTestedAt: null,
  };
}

const row = (providerId: string, nativeId: string): CatalogModel => ({
  providerId,
  nativeId,
  modality: "text",
  fetchedAt: 1,
});

/** An alias row in the shape the host persists (`nativeModelId` + `priority` are required). */
const alias = (name: string, providerId: string, priority: number): AliasEntry => ({
  alias: name,
  providerId,
  nativeModelId: name,
  priority,
  auto: false,
});

/**
 * The alias table as it actually exists on this machine, read from `model_aliases`:
 * `deepseek-v4-flash` has **one** row (vice), `agnes-3.0-flash` has two.
 */
const PROD_ALIASES: AliasEntry[] = [
  alias("agnes-3.0-flash", "pA", 100),
  alias("agnes-3.0-flash", "pV", 101),
  alias(SHARED, "pV", 101),
];

/**
 * A `PlanContext` over a fixed catalog.
 *
 * `nextKeyCursor` is a constant and `rotationStrategy` is `priority`, so key order is deterministic
 * and the only variable in a plan is the carrier list — which is what these tests are about.
 */
function context(
  providers: ProviderRecord[],
  models: CatalogModel[],
  aliases: AliasEntry[] = [],
): PlanContext {
  return {
    providers,
    keysFor: (pid) => [key(`k-${pid}`, pid)],
    catalog: () => models,
    aliases,
    health: new HealthTracker(),
    nextKeyCursor: () => 0,
  };
}

/** The distinct providers a plan would actually reach, in attempt order. */
function plannedProviders(ctx: PlanContext, model: string): string[] {
  const seen: string[] = [];
  for (const c of buildPlan({ model, modality: "text" }, ctx)) {
    if (!seen.includes(c.provider.id)) seen.push(c.provider.id);
  }
  return seen;
}

/** The incident's two carriers plus the catalog rows they advertise. */
function incident(status: ProviderLifecycleState = "enabled") {
  const providers = [provider("pAR", "agent-routerv2"), provider("pV", "vice", status)];
  const models = [row("pAR", SHARED), row("pV", SHARED)];
  return { providers, models };
}

const enabledSlugs = (disabled: string[] = []) => (pid: string) => !disabled.includes(pid);
const slugOf = (pid: string) => (pid === "pAR" ? "agent-routerv2" : "vice");

describe("the defect, reproduced and then closed", () => {
  it("plans one provider for the qualified id the pickers used to offer", () => {
    const { providers, models } = incident();
    // This is the measurement, not a hypothesis: the qualified form resolves to exactly one carrier
    // by design, so `failoverEnabled` had nothing to fail over to.
    expect(plannedProviders(context(providers, models, PROD_ALIASES), `agent-routerv2/${SHARED}`)).toEqual(["pAR"]);
  });

  it("plans a different, working provider for the bare id the picker now offers", () => {
    const { providers, models } = incident();
    // The alias narrows it to vice — which is the point: the request stops landing on the provider
    // that fails ~29% of the time.
    expect(plannedProviders(context(providers, models, PROD_ALIASES), SHARED)).toEqual(["pV"]);
  });

  it("labels the alias-narrowed entry with the provider it will actually use", () => {
    const { models } = incident();
    const entry = bareEntry(models, PROD_ALIASES, SHARED, enabledSlugs(), slugOf);
    // Not "any provider (failover)": one provider is reachable, and a label that overstated the
    // reach would be the same class of defect as offering an option that cannot fail over.
    expect(entry).toEqual({ id: SHARED, label: `${SHARED} · router default (vice)` });
  });

  it("fans out and says so when no alias narrows the id", () => {
    const { providers, models } = incident();
    const ctx = context(providers, models);
    expect(plannedProviders(ctx, SHARED)).toEqual(["pAR", "pV"]);
    expect(bareEntry(models, [], SHARED, enabledSlugs(), slugOf)).toEqual({
      id: SHARED,
      label: `${SHARED} · any provider (failover)`,
    });
  });

  it("offers only ids that reach the providers their label claims", () => {
    const { providers, models } = incident();
    const ctx = context(providers, models, PROD_ALIASES);
    const options = selectableModels(models, PROD_ALIASES, slugOf, enabledSlugs());

    for (const o of options) {
      const reach = plannedProviders(ctx, o.id);
      if (o.label.endsWith("(failover)")) {
        expect(reach.length, `${o.id} claims failover`).toBeGreaterThan(1);
      } else if (o.label.includes("router default")) {
        // The label names exactly one provider, so the plan must reach exactly that one.
        const named = o.label.slice(o.label.indexOf("(") + 1, o.label.lastIndexOf(")"));
        expect(reach.map(slugOf), `${o.id} names ${named}`).toEqual([named]);
      } else {
        // A qualified id must not fan out, or pinning a provider would be impossible.
        expect(reach.length, `qualified id ${o.id} must not fan out`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("selectableModels", () => {
  it("leads each group with the bare entry, then keeps catalog order", () => {
    const { models } = incident();
    expect(selectableModels(models, PROD_ALIASES, slugOf, enabledSlugs())).toEqual([
      { id: SHARED, label: `${SHARED} · router default (vice)` },
      { id: `agent-routerv2/${SHARED}`, label: `agent-routerv2/${SHARED}` },
      { id: `vice/${SHARED}`, label: `vice/${SHARED}` },
    ]);
  });

  it("adds no bare entry when one provider carries the id", () => {
    // With one carrier the two forms are the same request, so a second entry is noise.
    const models = [row("pAR", SHARED)];
    expect(selectableModels(models, [], slugOf, enabledSlugs())).toEqual([
      { id: `agent-routerv2/${SHARED}`, label: `agent-routerv2/${SHARED}` },
    ]);
  });

  it("adds no bare entry when the second carrier is disabled", () => {
    const { models } = incident("disabled");
    expect(selectableModels(models, PROD_ALIASES, slugOf, enabledSlugs(["pV"])).map((m) => m.id)).toEqual([
      `agent-routerv2/${SHARED}`,
      `vice/${SHARED}`,
    ]);
  });

  it("does not fan out on a disabled carrier — so offering it would promise nothing", () => {
    // `ModelCatalog.forModality` keeps a disabled provider's rows in the list, so counting rows
    // without filtering would offer an option with one provider to reach.
    const { providers, models } = incident("disabled");
    expect(plannedProviders(context(providers, models), SHARED)).toEqual(["pAR"]);
  });

  it("still lists a disabled provider's rows as qualified entries", () => {
    // Nothing is removed. Dropping options is a separate decision from adding one, and this module
    // only adds — the plan is empty because the planner drops a disabled provider outright.
    const { providers, models } = incident("disabled");
    expect(selectableModels(models, PROD_ALIASES, slugOf, enabledSlugs(["pV"])).map((m) => m.id)).toContain(
      `vice/${SHARED}`,
    );
    expect(plannedProviders(context(providers, models, PROD_ALIASES), `vice/${SHARED}`)).toEqual([]);
  });

  it("emits a repeated row once", () => {
    const models = [row("pAR", SHARED), row("pAR", SHARED), row("pV", SHARED)];
    expect(selectableModels(models, PROD_ALIASES, slugOf, enabledSlugs()).map((m) => m.id)).toEqual([
      SHARED,
      `agent-routerv2/${SHARED}`,
      `vice/${SHARED}`,
    ]);
  });

  it("leaves a single-carrier model in its own position", () => {
    const models = [row("pAR", "gpt-4o-mini"), row("pAR", SHARED), row("pV", SHARED)];
    expect(selectableModels(models, PROD_ALIASES, slugOf, enabledSlugs()).map((m) => m.id)).toEqual([
      `agent-routerv2/gpt-4o-mini`,
      SHARED,
      `agent-routerv2/${SHARED}`,
      `vice/${SHARED}`,
    ]);
  });

  it("offers a bare id that itself contains a slash", () => {
    // OpenRouter's native ids carry a slash (`openai/gpt-4o-mini`), so the bare form is not
    // slash-free. `resolveWanted` reads the leading segment as a provider qualifier only when it
    // resolves to a real slug — `openai` is not one here — so the bare form still fans out. The
    // picker must not try to normalise the slash away.
    const providers = [provider("pOR", "openrouter"), provider("pV", "vice")];
    const models = [row("pOR", "openai/gpt-4o-mini"), row("pV", "openai/gpt-4o-mini")];
    const ctx = context(providers, models);
    const ids = selectableModels(models, [], (pid) => (pid === "pOR" ? "openrouter" : "vice"), enabledSlugs()).map(
      (m) => m.id,
    );

    expect(ids).toContain("openai/gpt-4o-mini");
    expect(plannedProviders(ctx, "openai/gpt-4o-mini")).toEqual(["pOR", "pV"]);
    // And the qualified form still pins to one, which is the whole reason both are offered.
    expect(plannedProviders(ctx, "openrouter/openai/gpt-4o-mini")).toEqual(["pOR"]);
  });

  it("fans out when the alias table names both carriers", () => {
    // The `agnes-3.0-flash` shape on this machine: an alias row per provider. Both are reached, so
    // the label may claim failover.
    const providers = [provider("pA", "agnes"), provider("pV", "vice")];
    const models = [row("pA", "agnes-3.0-flash"), row("pV", "agnes-3.0-flash")];
    const ctx = context(providers, models, PROD_ALIASES);
    const aliases = PROD_ALIASES;

    expect(plannedProviders(ctx, "agnes-3.0-flash")).toEqual(["pA", "pV"]);
    expect(bareEntry(models, aliases, "agnes-3.0-flash", enabledSlugs(), (pid) => (pid === "pA" ? "agnes" : "vice"))).toEqual({
      id: "agnes-3.0-flash",
      label: "agnes-3.0-flash · any provider (failover)",
    });
  });
});

describe("carrier resolution", () => {
  const rows = [row("pAR", SHARED), row("pV", SHARED), row("pAR", "gpt-4o-mini")];

  it("lets an alias win over the catalog", () => {
    // `resolveWanted` skips the catalog scan entirely when an alias matches, so the catalog's
    // second carrier is unreachable — the exact case a catalog-only count got wrong.
    expect(bareCarriers(rows, PROD_ALIASES, SHARED)).toEqual(["pV"]);
    expect(hasFailoverCarrier(rows, PROD_ALIASES, SHARED, enabledSlugs())).toBe(false);
    // ...but the entry is still worth offering, which is a different question.
    expect(offersBareId(rows, SHARED, enabledSlugs())).toBe(true);
  });

  it("falls back to the catalog when no alias names the id", () => {
    expect(bareCarriers(rows, [], SHARED)).toEqual(["pAR", "pV"]);
    expect(hasFailoverCarrier(rows, [], SHARED, enabledSlugs())).toBe(true);
  });

  it("does not count a disabled provider, on either path", () => {
    expect(hasFailoverCarrier(rows, [], SHARED, enabledSlugs(["pV"]))).toBe(false);
    expect(bareCarriers(rows, PROD_ALIASES, SHARED).filter(enabledSlugs(["pV"]))).toEqual([]);
  });

  it("is false for an id nobody carries", () => {
    expect(bareCarriers(rows, [], "no-such-model")).toEqual([]);
    expect(hasFailoverCarrier(rows, [], "no-such-model", enabledSlugs())).toBe(false);
    expect(offersBareId(rows, "no-such-model", enabledSlugs())).toBe(false);
    expect(bareEntry(rows, [], "no-such-model", enabledSlugs(), slugOf)).toBeNull();
  });

  it("does not count the same provider twice", () => {
    const dupes = [row("pAR", SHARED), row("pAR", SHARED)];
    expect(bareCarriers(dupes, [], SHARED)).toEqual(["pAR"]);
    expect(hasFailoverCarrier(dupes, [], SHARED, enabledSlugs())).toBe(false);
  });

  it("offers nothing when the alias names only disabled providers", () => {
    // The alias exists and the catalog has two carriers, so a bare entry is warranted — but it
    // would reach nobody, and an option that cannot serve is worse than no option.
    expect(bareEntry(rows, PROD_ALIASES, SHARED, enabledSlugs(["pV"]), slugOf)).toBeNull();
  });
});
