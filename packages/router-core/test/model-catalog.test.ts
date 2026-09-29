/**
 * Manual catalog entries — models the operator typed in rather than discovered.
 *
 * The behaviour under test is the one that decides whether the feature works at all: a manual row
 * has to survive a refresh. `refreshProvider` replaces a provider's set wholesale, and a manual
 * entry is usually present *because* the provider does not list that model, so the refresh that
 * looks like a no-op to the operator is exactly the operation that would delete it.
 */
import { describe, expect, it } from "vitest";
import { AdapterRuntime } from "../src/adapter-runtime.js";
import { BUILTIN_TEMPLATES } from "../src/builtin-templates.js";
import { HealthTracker } from "../src/health-tracker.js";
import { ModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { buildPlan, type PlanContext } from "../src/route-planner.js";
import type { AliasEntry } from "../src/domain.js";
import { FakeHttp, FakeVault } from "./fakes.js";

const PROVIDER_ID = "p1";
const BASE = "https://provider.example/v1";

/**
 * A catalog wired to a provider whose `/models` answers with `listed`.
 *
 * `listed` is per-harness so one test can have the provider list a model that another test's
 * provider does not — the case manual entry exists for.
 */
async function harness(listed: string[]) {
  const http = new FakeHttp((url) =>
    url.includes("/models") ? { status: 200, body: { data: listed.map((id) => ({ id })) } } : undefined,
  );
  const registry = new ProviderRegistry(new FakeVault());
  const adapters = new AdapterRuntime(http);
  const catalog = new ModelCatalog(registry, adapters);

  registry.hydrate(
    [{
      id: PROVIDER_ID, slug: "provider", name: "Provider", type: "manifest", baseUrl: BASE,
      status: "enabled", rotationStrategy: "round_robin", createdAt: 0, updatedAt: 0,
    }],
    [],
  );
  // `refreshProvider` needs an active key before it will list anything.
  await registry.addKey({ providerId: PROVIDER_ID, label: "k", secret: "sk-test-0000" });
  adapters.register(PROVIDER_ID, BUILTIN_TEMPLATES["openai-compat"](BASE));
  return { catalog, registry };
}

function idsOf(catalog: ModelCatalog): string[] {
  return catalog.all().filter((m) => m.providerId === PROVIDER_ID).map((m) => m.nativeId).sort();
}

describe("manual catalog entries", () => {
  it("are tagged manual and readable as such", async () => {
    const { catalog } = await harness([]);
    catalog.upsertManual({ providerId: PROVIDER_ID, nativeId: "my-model", modality: "text" });
    const row = catalog.all().find((m) => m.nativeId === "my-model");
    expect(row?.origin).toBe("manual");
    expect(catalog.manualOf(PROVIDER_ID).map((m) => m.nativeId)).toEqual(["my-model"]);
  });

  it("survive a refresh — the regression this column exists to prevent", async () => {
    const { catalog } = await harness(["gpt-listable"]);
    catalog.upsertManual({ providerId: PROVIDER_ID, nativeId: "typed-by-hand", modality: "text" });

    await catalog.refreshProvider(PROVIDER_ID);

    // Both, not one: the refresh adds what the provider lists and keeps what the operator typed.
    expect(idsOf(catalog)).toEqual(["gpt-listable", "typed-by-hand"]);
    expect(catalog.manualOf(PROVIDER_ID).map((m) => m.nativeId)).toEqual(["typed-by-hand"]);
  });

  it("are not duplicated when the provider also lists the same id", async () => {
    const { catalog } = await harness(["shared"]);
    catalog.upsertManual({ providerId: PROVIDER_ID, nativeId: "shared", modality: "text" });
    await catalog.refreshProvider(PROVIDER_ID);
    const rows = catalog.all().filter((m) => m.nativeId === "shared");
    expect(rows).toHaveLength(1);
  });

  it("win over the discovered row: the operator's context window is the one that plans", async () => {
    const { catalog } = await harness(["shared"]);
    catalog.upsertManual({
      providerId: PROVIDER_ID, nativeId: "shared", modality: "text", contextWindow: 999,
    });
    await catalog.refreshProvider(PROVIDER_ID);
    const row = catalog.all().find((m) => m.nativeId === "shared");
    expect(row?.origin).toBe("manual");
    expect(row?.contextWindow).toBe(999);
  });

  it("can be removed, and removal never touches a discovered row", async () => {
    const { catalog } = await harness(["gpt-listable"]);
    catalog.upsertManual({ providerId: PROVIDER_ID, nativeId: "typed-by-hand", modality: "text" });
    await catalog.refreshProvider(PROVIDER_ID);

    // A discovered id is refused, even though the row exists.
    expect(catalog.removeManual(PROVIDER_ID, "gpt-listable")).toBe(false);
    expect(catalog.removeManual(PROVIDER_ID, "typed-by-hand")).toBe(true);
    expect(idsOf(catalog)).toEqual(["gpt-listable"]);
  });

  it("treat a missing or zero context window as unknown, never as zero", async () => {
    const { catalog } = await harness([]);
    catalog.upsertManual({ providerId: PROVIDER_ID, nativeId: "a", modality: "text" });
    catalog.upsertManual({ providerId: PROVIDER_ID, nativeId: "b", modality: "text", contextWindow: 0 });
    const a = catalog.all().find((m) => m.nativeId === "a");
    const b = catalog.all().find((m) => m.nativeId === "b");
    // `0` would be read as a real window by the budget planner's minimum, which is worse than
    // unknown: it would size every request to nothing.
    expect(a?.contextWindow).toBeUndefined();
    expect(b?.contextWindow).toBeUndefined();
  });

  it("keep their origin across hydrate", () => {
    const { catalog } = { catalog: new ModelCatalog(new ProviderRegistry(new FakeVault()), new AdapterRuntime(new FakeHttp(() => undefined))) };
    catalog.hydrate(
      [
        { providerId: PROVIDER_ID, nativeId: "typed", modality: "text", fetchedAt: 1, origin: "manual" },
        { providerId: PROVIDER_ID, nativeId: "listed", modality: "text", fetchedAt: 1, origin: "discovered" },
      ],
      {},
    );
    expect(catalog.manualOf(PROVIDER_ID).map((m) => m.nativeId)).toEqual(["typed"]);
    expect(catalog.all()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Alias auto-derivation, and the cache that defeated it.
//
// `model_aliases` has **two** writers and four columns. `persistAliases` writes derived rows;
// `config_import` (`persist.rs`, `INSERT OR IGNORE`) merges the aliases out of an imported
// snapshot; and no column records which is which. Boot loaded all of it as operator intent, and
// `deriveAutoAliases` honours that by leaving the id alone — so a derived row could never be
// re-derived and the table was write-once.
//
// Measured on this machine 2026-09-29: `deepseek-v4-flash` carried by two enabled providers
// (`agent-routerv2`, `vice`), one alias row (`vice`), no failover.
// ---------------------------------------------------------------------------------------------

const A = "pA";
const B = "pB";
const BASE_A = "https://a.example/v1";
const BASE_B = "https://b.example/v1";
const SHARED = "shared";

/**
 * Two enabled providers, each with an active key and its own `/models` listing.
 *
 * The one-provider `harness` above cannot express the behaviour under test: an alias exists only
 * where two providers advertise the same native id, and the whole defect is that a cached row hid
 * the second carrier.
 */
async function twoProviders(listedA: string[], listedB: string[]) {
  const http = new FakeHttp((url) =>
    url.includes("/models")
      ? { status: 200, body: { data: (url.startsWith(BASE_A) ? listedA : listedB).map((id) => ({ id })) } }
      : undefined,
  );
  const registry = new ProviderRegistry(new FakeVault());
  const adapters = new AdapterRuntime(http);
  const catalog = new ModelCatalog(registry, adapters);

  registry.hydrate(
    [
      { id: A, baseUrl: BASE_A },
      { id: B, baseUrl: BASE_B },
    ].map((p) => ({
      id: p.id, slug: p.id.toLowerCase(), name: p.id, type: "manifest" as const,
      baseUrl: p.baseUrl, status: "enabled" as const, rotationStrategy: "priority" as const,
      createdAt: 0, updatedAt: 0,
    })),
    [],
  );
  await registry.addKey({ providerId: A, label: "ka", secret: "sk-test-aaaa" });
  await registry.addKey({ providerId: B, label: "kb", secret: "sk-test-bbbb" });
  adapters.register(A, BUILTIN_TEMPLATES["openai-compat"](BASE_A));
  adapters.register(B, BUILTIN_TEMPLATES["openai-compat"](BASE_B));
  return { catalog, registry };
}

/** Both providers carry `shared`, so the derivation owes a bare alias for it. */
async function withShared() {
  const h = await twoProviders([SHARED], [SHARED]);
  await h.catalog.refreshProvider(A);
  await h.catalog.refreshProvider(B);
  return h;
}

/** A `PlanContext` over the live catalog, so a claim about routing is made by the planner. */
function planCtx(catalog: ModelCatalog, registry: ProviderRegistry): PlanContext {
  return {
    providers: registry.listProviders(),
    keysFor: (pid) => registry.keysOf(pid),
    catalog: () => catalog.all(),
    aliases: catalog.aliases,
    health: new HealthTracker(),
    nextKeyCursor: () => 0,
  };
}

/**
 * A row as `/admin/aliases` returns it. No `auto` field: the column does not exist, which is the
 * reason the distinction has to be recovered rather than read.
 */
function hostRow(alias: string, providerId: string, nativeModelId: string, priority = 1): AliasEntry {
  return { alias, providerId, nativeModelId, priority };
}

describe("alias auto-derivation across a boot", () => {
  it("the incident: a cached row does not stop the second carrier being derived", async () => {
    const { catalog } = await withShared();

    // The table as the incident left it: one row, for the carrier configured second.
    catalog.hydrateAliases([hostRow(SHARED, B, SHARED, 101)]);

    const rows = catalog.aliases.filter((a) => a.alias === SHARED);
    expect(rows.map((r) => r.providerId).sort()).toEqual([A, B]);
  });

  it("so the bare id plans through both providers — the failover the incident lacked", async () => {
    const { catalog, registry } = await withShared();
    catalog.hydrateAliases([hostRow(SHARED, B, SHARED, 101)]);

    const plan = buildPlan({ model: SHARED, modality: "text" }, planCtx(catalog, registry));
    expect(plan.map((c) => c.provider.id).sort()).toEqual([A, B]);
  });

  it("keeps a row the derivation could not have emitted, and lets it own its id", async () => {
    const { catalog } = await withShared();

    // The shape `config_import` writes and the web-test seed ships: a *qualified* alias, so
    // `alias !== nativeModelId` and no derivation ever produces it.
    const authored = hostRow("sysai/oracle-mini", A, "oracle-mini");
    catalog.hydrateAliases([hostRow(SHARED, B, SHARED, 101), authored]);

    expect(catalog.aliases).toContainEqual({ ...authored, auto: false });
    // The documented rule (`domain.ts`: "manual entries win") is untouched by the fix above: the
    // kept row still suppresses derivation for the id it names.
    expect(catalog.aliases.filter((a) => a.alias === SHARED)).toHaveLength(2);
  });

  it("keeps a bare row for a provider that does not carry the id — a pin, not a derivation", async () => {
    const { catalog } = await withShared();

    const pin = hostRow(SHARED, "pZ", SHARED, 1);
    catalog.hydrateAliases([pin]);

    // Kept, and its id is left alone: one row, not the two the catalog would otherwise derive.
    expect(catalog.aliases).toEqual([{ ...pin, auto: false }]);
  });

  it("reports whether it moved the table, so a launch that changes nothing writes nothing", async () => {
    const { catalog } = await withShared();

    expect(catalog.hydrateAliases([])).toBe(true); // empty cache, two rows owed
    expect(catalog.hydrateAliases(catalog.aliases.map((a) => ({ ...a })))).toBe(false);
  });
});
