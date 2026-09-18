/**
 * Client-side model namespaces.
 *
 * Clients that front a catalog they did not build stamp their own tag onto the id — WorkBuddy
 * prefixes every entry loaded from `~/.codebuddy/models.json` with `custom-local:`. That tag is
 * the client's bookkeeping, not part of any provider's native id, so the router has to see past
 * it or every request from such a client fails with "no route for model".
 */
import { describe, expect, it } from "vitest";
import { buildPlan, stripClientNamespace } from "../src/route-planner.js";

const providers = [
  { id: "pOR", slug: "openrouter", name: "OpenRouter", type: "builtin" as const, baseUrl: "https://or.test/v1", status: "enabled" as const, rotationStrategy: "round_robin" as const, createdAt: 1, updatedAt: 1 },
];
const models = [
  { providerId: "pOR", nativeId: "openai/gpt-4o-mini", modality: "text" as const, fetchedAt: 1, pricing: undefined },
];
const ctx = {
  providers,
  keysFor: () => [{ id: "k1", providerId: "pOR", label: "k1", secretRef: "key:pOR:k1", status: "active" as const, priority: 0, cooldownUntil: null, addedAt: 1, lastUsedAt: null, lastTestedAt: null }],
  catalog: () => models,
  aliases: [],
  health: { isKeyUsable: () => true } as never,
  nextKeyCursor: () => 0,
};

describe("stripClientNamespace", () => {
  it("drops a client tag the router has no provider for", () => {
    expect(stripClientNamespace("custom-local:openrouter/openai/gpt-4o-mini", ctx)).toBe("openrouter/openai/gpt-4o-mini");
  });

  it("leaves a provider-qualified id alone — the colon is a variant suffix, not a namespace", () => {
    expect(stripClientNamespace("openrouter/openai/gpt-4o:extended", ctx)).toBe("openrouter/openai/gpt-4o:extended");
  });

  it("leaves a bare native id alone", () => {
    expect(stripClientNamespace("gpt-4o-mini", ctx)).toBe("gpt-4o-mini");
  });

  it("does not strip a prefix that names a real provider", () => {
    // A slug-shaped prefix is a route, not bookkeeping.
    expect(stripClientNamespace("openrouter:whatever", ctx)).toBe("openrouter:whatever");
  });
});

describe("buildPlan with a namespaced id", () => {
  it("routes `custom-local:<slug>/<native>` and resolves to the bare native model", () => {
    const plan = buildPlan({ model: "custom-local:openrouter/openai/gpt-4o-mini", modality: "text" }, ctx);
    expect(plan).toHaveLength(1);
    // The native id is what goes upstream; the client's tag must not reach the provider.
    expect(plan[0]!.model.nativeId).toBe("openai/gpt-4o-mini");
    expect(plan[0]!.provider.slug).toBe("openrouter");
  });

  it("still finds nothing when the stripped id is genuinely unknown", () => {
    expect(buildPlan({ model: "custom-local:openrouter/no-such-model", modality: "text" }, ctx)).toEqual([]);
  });
});

/**
 * OpenRouter publishes native ids that already contain a slash (`openai/gpt-4o-mini`), so a
 * client sending the provider's own id is indistinguishable from a `<slug>/<native>` qualified
 * id. Read the slash as a qualifier only when it names a real provider; otherwise the id must
 * still resolve as a bare native id, or every such client 404s.
 */
describe("buildPlan with a provider-native id that contains a slash", () => {
  it("routes the bare native id to the provider that carries it", () => {
    const plan = buildPlan({ model: "openai/gpt-4o-mini", modality: "text" }, ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.provider.slug).toBe("openrouter");
    expect(plan[0]!.model.nativeId).toBe("openai/gpt-4o-mini");
  });

  it("routes it through a client tag too", () => {
    const plan = buildPlan({ model: "custom-local:openai/gpt-4o-mini", modality: "text" }, ctx);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.model.nativeId).toBe("openai/gpt-4o-mini");
  });

  it("does not silently reroute a genuinely qualified id", () => {
    // `openrouter` IS a provider here, so the id is qualified and the bare-id fallback must not
    // also fire — otherwise a request could be served by whichever provider happens to carry a
    // model literally named `openrouter/openai/gpt-4o-mini`.
    const ambiguous = [
      ...models,
      { providerId: "pOR", nativeId: "openrouter/openai/gpt-4o-mini", modality: "text" as const, fetchedAt: 1, pricing: undefined },
    ];
    const plan = buildPlan({ model: "openrouter/openai/gpt-4o-mini", modality: "text" }, { ...ctx, catalog: () => ambiguous });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.model.nativeId).toBe("openai/gpt-4o-mini");
  });
});
