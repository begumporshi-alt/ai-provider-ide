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
import { ModelCatalog } from "../src/model-catalog.js";
import { ProviderRegistry } from "../src/provider-registry.js";
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
