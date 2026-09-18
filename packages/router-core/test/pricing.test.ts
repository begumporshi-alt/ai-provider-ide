/**
 * pricing (audit R2): the ledger used to write `costEstimateMicros: 0` for every request,
 * because `pricing_json` was stored but never read and `cost_spread` fell back to priority.
 * These tests pin: canonical-unit conversion, unknown != free, real cost reaching the ledger,
 * and cost_spread actually ordering carriers by price.
 */
import { describe, expect, it } from "vitest";
import { parsePricing, estimateCostMicros, priceRank } from "../src/pricing.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { ModelCatalog } from "../src/model-catalog.js";
import { AdapterRuntime } from "../src/adapter-runtime.js";
import { UsageLedger } from "../src/usage-ledger.js";
import { ModelRouter } from "../src/model-router.js";
import { buildPlan } from "../src/route-planner.js";
import { PROVIDER_PROFILES } from "../src/builtin-templates.js";
import { FakeHttp, FakeVault } from "./fakes.js";

// ---------- unit: normalization ----------

describe("parsePricing", () => {
  it("reads the OpenRouter shape (USD per token, as strings)", () => {
    // 0.00000015 USD/token -> 0.15 USD per 1M tokens -> 150_000 micro-USD per 1M tokens
    const p = parsePricing({ id: "m", pricing: { prompt: "0.00000015", completion: "0.0000006" } });
    expect(p).toEqual({ prompt: 150_000, completion: 600_000 });
  });

  it("accepts the generic input/output shape and numeric values", () => {
    const p = parsePricing({ pricing: { input: 0.000001, output: 0.000002 } });
    expect(p).toEqual({ prompt: 1_000_000, completion: 2_000_000 });
  });

  it("accepts the *_cost_per_token naming", () => {
    const p = parsePricing({ pricing: { input_cost_per_token: 1e-7, output_cost_per_token: 4e-7 } });
    expect(p).toEqual({ prompt: 100_000, completion: 400_000 });
  });

  it("returns undefined — never zero — when pricing is absent or unusable", () => {
    expect(parsePricing(undefined)).toBeUndefined();
    expect(parsePricing(null)).toBeUndefined();
    expect(parsePricing("nope")).toBeUndefined();
    expect(parsePricing({})).toBeUndefined();                                   // no pricing block
    expect(parsePricing({ pricing: {} })).toBeUndefined();                      // empty block
    expect(parsePricing({ pricing: { prompt: "x" } })).toBeUndefined();         // non-numeric
    expect(parsePricing({ pricing: { prompt: "1" } })).toBeUndefined();         // one side missing
    expect(parsePricing({ pricing: { prompt: -1, completion: 1 } })).toBeUndefined(); // nonsense
  });
});

describe("estimateCostMicros", () => {
  it("scales tokens by the per-1M price", () => {
    const p = { prompt: 150_000, completion: 600_000 }; // 0.15 / 0.60 USD per 1M
    // 1000 in -> 150 micros; 500 out -> 300 micros
    expect(estimateCostMicros(p, 1000, 500)).toBe(450);
  });

  it("rounds to whole micro-USD", () => {
    expect(estimateCostMicros({ prompt: 1, completion: 1 }, 1, 1)).toBe(0);
    expect(estimateCostMicros({ prompt: 333_333, completion: 0 }, 1, 0)).toBe(0);
    expect(estimateCostMicros({ prompt: 500_000, completion: 0 }, 1, 0)).toBe(1); // 0.5 -> 1 (round)
  });

  it("is undefined for unknown pricing, so callers can distinguish it from free", () => {
    expect(estimateCostMicros(undefined, 1000, 500)).toBeUndefined();
  });

  it("a genuinely free model yields 0, not undefined", () => {
    expect(estimateCostMicros({ prompt: 0, completion: 0 }, 1000, 500)).toBe(0);
  });
});

describe("priceRank", () => {
  it("sorts unknown pricing last", () => {
    const cheap = { prompt: 100, completion: 100 };
    const dear = { prompt: 900, completion: 900 };
    expect(priceRank(cheap)).toBeLessThan(priceRank(dear));
    expect(priceRank(undefined)).toBe(Number.POSITIVE_INFINITY);
  });
});

// ---------- integration: catalog -> router -> ledger ----------

function withBaseUrl(
  m: ReturnType<NonNullable<(typeof PROVIDER_PROFILES)[keyof typeof PROVIDER_PROFILES]>>,
  baseUrl: string,
) {
  return { ...m, provider: { ...m.provider, baseUrl } };
}

/** One OpenAI-compatible provider whose catalog publishes OpenRouter-style pricing. */
function makeSetup(pricing: unknown, usage = { prompt_tokens: 1000, completion_tokens: 500 }) {
  const vault = new FakeVault();
  const registry = new ProviderRegistry(vault);
  const http = new FakeHttp((url) => {
    if (url.includes("/models")) {
      return { status: 200, body: { data: [{ id: "m1", pricing }] } };
    }
    // Chat: streamed (ModelRouter always streams). Usage rides on the final chunk — that is
    // the only place the interpreter reads it from (`$.usage` on any chunk).
    return {
      status: 200,
      lines: [
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        `data: {"choices":[],"usage":${JSON.stringify(usage)}}`,
        "data: [DONE]",
      ],
    };
  });
  const adapters = new AdapterRuntime(http);
  const p = registry.addProvider({
    id: "pA", slug: "openrouter", name: "A", type: "builtin",
    baseUrl: "https://a.test/api/v1", status: "enabled", rotationStrategy: "round_robin",
  });
  adapters.register(p.id, withBaseUrl(PROVIDER_PROFILES.openrouter!(), "https://a.test/api/v1"));
  const ledger = new UsageLedger();
  const catalog = new ModelCatalog(registry, adapters);
  const router = new ModelRouter(registry, adapters, catalog, ledger);
  return { registry, http, catalog, router, ledger, pA: p };
}

async function ready(s: ReturnType<typeof makeSetup>) {
  await s.registry.addKey({ providerId: "pA", label: "key-01", secret: "sk-test-pA1" });
  await s.catalog.refreshProvider("pA");
}

describe("catalog captures pricing (R2)", () => {
  it("stores normalized pricing from the provider's raw catalog entry", async () => {
    const s = makeSetup({ prompt: "0.00000015", completion: "0.0000006" });
    await ready(s);
    expect(s.catalog.pricingFor("pA", "m1")).toEqual({ prompt: 150_000, completion: 600_000 });
  });

  it("leaves pricing undefined when the provider publishes none", async () => {
    const s = makeSetup(undefined);
    await ready(s);
    expect(s.catalog.pricingFor("pA", "m1")).toBeUndefined();
  });
});

describe("router writes real cost to the ledger (R2)", () => {
  it("computes cost from usage and pricing instead of a constant 0", async () => {
    const s = makeSetup({ prompt: "0.00000015", completion: "0.0000006" });
    await ready(s);
    const exec = await s.router.generateText({ model: "m1", messages: [{ role: "user", content: "hi" }] });
    for await (const _ of exec.chunks) void _;
    const row = s.ledger.query()[0]!;
    expect(row.status).toBe("ok");
    expect(row.tokensIn).toBe(1000);
    expect(row.tokensOut).toBe(500);
    expect(row.costEstimateMicros).toBe(450); // 150 + 300, as computed above
  });

  it("writes 0 when pricing is unknown (the UI renders that as unknown, not free)", async () => {
    const s = makeSetup(undefined);
    await ready(s);
    const exec = await s.router.generateText({ model: "m1", messages: [{ role: "user", content: "hi" }] });
    for await (const _ of exec.chunks) void _;
    expect(s.ledger.query()[0]!.costEstimateMicros).toBe(0);
    // ...but the catalog still reports it as unknown, which is what the UI keys off.
    expect(s.catalog.pricingFor("pA", "m1")).toBeUndefined();
  });
});

describe("cost_spread orders carriers by price (R2)", () => {
  const providers = [
    { id: "pExp", slug: "exp", name: "Expensive", type: "builtin" as const, baseUrl: "https://exp.test/v1", status: "enabled" as const, rotationStrategy: "cost_spread" as const, createdAt: 1, updatedAt: 1 },
    { id: "pCheap", slug: "cheap", name: "Cheap", type: "builtin" as const, baseUrl: "https://cheap.test/v1", status: "enabled" as const, rotationStrategy: "cost_spread" as const, createdAt: 1, updatedAt: 1 },
  ];
  const models = [
    { providerId: "pExp", nativeId: "m1", modality: "text" as const, fetchedAt: 1, pricing: { prompt: 900_000, completion: 900_000 } },
    { providerId: "pCheap", nativeId: "m1", modality: "text" as const, fetchedAt: 2, pricing: { prompt: 100_000, completion: 100_000 } },
  ];
  const aKey = (providerId: string) => ({
    id: `${providerId}:k1`, providerId, label: "k1", secretRef: `key:${providerId}:k1`,
    status: "active" as const, priority: 0, cooldownUntil: null, addedAt: 1, lastUsedAt: null, lastTestedAt: null,
  });
  const baseCtx = {
    providers,
    keysFor: (pid: string) => [aKey(pid)],
    catalog: () => models,
    aliases: [],
  };

  it("puts the cheapest carrier first once pricing is available", () => {
    const plan = buildPlan(
      { model: "m1", modality: "text" },
      { ...baseCtx, health: { isKeyUsable: () => true } as never, nextKeyCursor: () => 0, pricingFor: (pid, nid) => models.find((m) => m.providerId === pid && m.nativeId === nid)?.pricing },
    );
    // pExp is listed first in `providers`, so this order proves cost ordering happened.
    expect(plan.map((c) => c.provider.id)).toEqual(["pCheap", "pExp"]);
  });

  it("preserves the incoming (catalog) order when no pricing lookup is supplied (legacy)", () => {
    const plan = buildPlan(
      { model: "m1", modality: "text" },
      { ...baseCtx, health: { isKeyUsable: () => true } as never, nextKeyCursor: () => 0 },
    );
    // Both providers carry m1, so both are candidates; without pricing the catalog order stands.
    expect(plan.map((c) => c.provider.id)).toEqual(["pExp", "pCheap"]);
  });
});
