/**
 * Core-level acceptance tests (ARCHITECTURE.md Phase 1 exit: criteria 2, 3, 4 pass at the
 * core level against scripted fakes). Wires the REAL components: registry, catalog,
 * planner, health, execution engine, ledger, router facade, manifest interpreter.
 */
import { describe, expect, it } from "vitest";
import { PROVIDER_PROFILES } from "../src/builtin-templates.js";
import { ManifestInterpreter } from "../src/manifest-interpreter.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { ModelCatalog } from "../src/model-catalog.js";
import { AdapterRuntime } from "../src/adapter-runtime.js";
import { UsageLedger } from "../src/usage-ledger.js";
import { ModelRouter } from "../src/model-router.js";
import { AllAttemptsFailedError } from "../src/execution-engine.js";
import { FakeHttp, FakeVault } from "./fakes.js";

const OPENAI_TEXT_OK = (url: string): { status: number; body?: unknown; lines?: string[] } => {
  if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "gpt-4o" }, { id: "dall-e-3" }] } };
  if (url.endsWith("/chat/completions")) {
    return { status: 200, lines: [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ] };
  }
  if (url.endsWith("/images/generations")) return { status: 200, body: { data: [{ url: "https://img.example/x.png" }] } };
  return { status: 404 };
};

function withBaseUrl(m: ReturnType<NonNullable<(typeof PROVIDER_PROFILES)["openrouter"]>>, baseUrl: string) {
  return { ...m, provider: { ...m.provider, baseUrl } };
}

function makeSetup(opts: { responder?: (url: string, init: { method: string; body?: string; secretRef?: string }) => { status?: number; body?: unknown; lines?: string[] } } = {}) {
  const vault = new FakeVault();
  const registry = new ProviderRegistry(vault);
  const http = new FakeHttp(opts.responder ?? OPENAI_TEXT_OK);
  const adapters = new AdapterRuntime(http);

  // Provider A = OpenRouter-like (openai-compat with image endpoint), test base URL
  const a = registry.addProvider({ id: "pA", slug: "openrouter", name: "A", type: "builtin", baseUrl: "https://a.test/api/v1", status: "enabled", rotationStrategy: "round_robin" });
  // Provider B = another openai-compat provider carrying the same model (failover target)
  const b = registry.addProvider({ id: "pB", slug: "opencode", name: "B", type: "builtin", baseUrl: "https://b.test/zen/v1", status: "enabled", rotationStrategy: "priority" });
  adapters.register(a.id, withBaseUrl(PROVIDER_PROFILES.openrouter!(), "https://a.test/api/v1"));
  adapters.register(b.id, withBaseUrl(PROVIDER_PROFILES.opencode!(), "https://b.test/zen/v1"));

  const ledger = new UsageLedger();
  const catalog = new ModelCatalog(registry, adapters);
  const router = new ModelRouter(registry, adapters, catalog, ledger);

  return { vault, registry, http, adapters, ledger, catalog, router, pA: a, pB: b };
}

async function addKeys(s: ReturnType<typeof makeSetup>, providerId: string, n: number) {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const k = await s.registry.addKey({ providerId, label: `key-0${i}`, secret: `sk-test-${providerId}${i}` });
    ids.push(k.id);
  }
  return ids;
}

async function collect(it: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const c of it) out += c;
  return out;
}

describe("acceptance 2 — key rotation is silent to the caller", () => {
  it("first key 401 -> second key serves; caller sees a normal stream", async () => {
    const s = makeSetup({
      responder: (url, init) => {
        if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "gpt-4o" }] } };
        // key A#1 is invalid; A#2 works
        if (init.secretRef === "key:pA#1") return { status: 401, body: { error: "bad key" } };
        return OPENAI_TEXT_OK(url);
      },
    });
    await addKeys(s, "pA", 2);
    await addKeys(s, "pB", 1);
    await s.catalog.refreshProvider("pA");
    await s.catalog.refreshProvider("pB");

    const exec = await s.router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    const text = await collect(exec.chunks);
    expect(text).toBe("Hello");
    expect(exec.served()?.key.secretRef).toBe("key:pA#2");
    expect(exec.fallbackChain()).toHaveLength(1);
    expect(exec.fallbackChain()[0]!.cls).toBe("AUTH_FAILED");

    // The Usage ledger recorded the fallback chain (criterion 3's visibility half).
    const entry = s.ledger.query()[0]!;
    expect(entry.status).toBe("ok");
    expect(entry.fallbackChain).toHaveLength(1);
  });
});

describe("acceptance 3 — provider failover", () => {
  it("all A keys dead -> B serves, and the ledger shows the chain", async () => {
    const s = makeSetup({
      responder: (url) => {
        if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "gpt-4o" }] } };
        if (url.startsWith("https://a.test")) return { status: 429 };
        return OPENAI_TEXT_OK(url);
      },
    });
    await addKeys(s, "pA", 2);
    await addKeys(s, "pB", 1);
    await s.catalog.refreshProvider("pA");
    await s.catalog.refreshProvider("pB");

    const exec = await s.router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(await collect(exec.chunks)).toBe("Hello");
    expect(exec.served()?.provider.slug).toBe("opencode");
    const chain = exec.fallbackChain();
    expect(chain.map((c) => c.candidate.provider.slug)).toEqual(["openrouter", "openrouter"]);
    expect(chain.every((c) => c.cls === "RATE_LIMITED")).toBe(true);
    // Rate-limited A keys are on cooldown now — a second request skips straight to B.
    const exec2 = await s.router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    await collect(exec2.chunks);
    expect(exec2.fallbackChain()).toHaveLength(0);
    expect(exec2.served()?.provider.slug).toBe("opencode");
  });

  it("failover disabled -> no cross-provider fallback", async () => {
    const s = makeSetup({
      responder: (url) => {
        if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "gpt-4o" }] } };
        if (url.startsWith("https://a.test")) return { status: 401 };
        return OPENAI_TEXT_OK(url);
      },
    });
    s.router.settings.failoverEnabled = false;
    await addKeys(s, "pA", 1);
    await addKeys(s, "pB", 1);
    await s.catalog.refreshProvider("pA");
    await s.catalog.refreshProvider("pB");
    const exec = await s.router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    await expect(collect(exec.chunks)).rejects.toBeInstanceOf(AllAttemptsFailedError);
  });
});

describe("acceptance 4 — text + image end-to-end (core level)", () => {
  it("anthropic-dialect provider streams via stopWhen and requires max_tokens", async () => {
    const vault = new FakeVault();
    const registry = new ProviderRegistry(vault);
    const http = new FakeHttp((url, init) => {
      if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "qwen3.8-flash" }] } };
      if (url.endsWith("/messages")) {
        const body = JSON.parse(init.body ?? "{}");
        expect(body.max_tokens).toBeGreaterThan(0); // template made it required
        expect(init.secretRef).toBeDefined();
        return { status: 200, lines: [
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "An" } })}`,
          `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "thropic" } })}`,
          `data: ${JSON.stringify({ type: "message_stop" })}`,
        ] };
      }
      return { status: 404 };
    });
    const adapters = new AdapterRuntime(http);
    const p = registry.addProvider({ id: "pBai", slug: "b.ai", name: "b.ai", type: "builtin", baseUrl: "https://api.b.ai/v1", status: "enabled", rotationStrategy: "priority" });
    adapters.register(p.id, PROVIDER_PROFILES["b.ai"]!());
    const ledger = new UsageLedger();
    const catalog = new ModelCatalog(registry, adapters);
    const router = new ModelRouter(registry, adapters, catalog, ledger);
    await registry.addKey({ providerId: "pBai", label: "k1", secret: "sk-test-bai" });
    await catalog.refreshProvider("pBai");

    const exec = await router.generateText({ model: "b.ai/qwen3.8-flash", messages: [{ role: "user", content: "hi" }] });
    expect(await collect(exec.chunks)).toBe("Anthropic");
    expect(exec.served()?.provider.slug).toBe("b.ai");
  });

  it("image generation resolves url + b64", async () => {
    const s = makeSetup({ responder: OPENAI_TEXT_OK });
    await addKeys(s, "pA", 1);
    // tag dall-e-3 as image via the openrouter profile's modalityRules
    await s.catalog.refreshProvider("pA");
    const imgs = s.catalog.forModality("image").map((m) => m.nativeId);
    expect(imgs).toContain("dall-e-3");
    const res = await s.router.generateImage({ model: "openrouter/dall-e-3", prompt: "cat" });
    expect(res.url).toBe("https://img.example/x.png");
    const entry = s.ledger.query()[0]!;
    expect(entry.modality).toBe("image");
    expect(entry.source).toBe("ui");
  });
});

describe("cancellation (spec req. 9)", () => {
  it("abort mid-stream stops consumption promptly", async () => {
    const lines = ["a", "b", "c", "d", "e"].map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}`);
    const s = makeSetup({
      responder: (url) => {
        if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "gpt-4o" }] } };
        return { status: 200, lines };
      },
    });
    await addKeys(s, "pA", 1);
    await s.catalog.refreshProvider("pA");
    const ac = new AbortController();
    const exec = await s.router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, { signal: ac.signal });
    const got: string[] = [];
    for await (const c of exec.chunks) {
      got.push(c);
      if (got.length === 2) ac.abort();
    }
    expect(got.length).toBeLessThanOrEqual(3); // consumed a couple more at most, not all 5
  });
});

describe("key-blindness (invariants 1–2)", () => {
  it("no request ever carries a raw secret; only secretRef + sentinel headers", async () => {
    const s = makeSetup();
    await addKeys(s, "pA", 1);
    await addKeys(s, "pB", 1);
    await s.catalog.refreshProvider("pA");
    await s.catalog.refreshProvider("pB");
    const exec = await s.router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    await collect(exec.chunks);
    for (const call of s.http.calls) {
      expect(call.secretRef).toMatch(/^key:/);
      for (const v of Object.values(call.headers)) {
        if (v === "Bearer {{secret}}" || v === "{{secret}}") continue;
        expect(v).not.toMatch(/sk-test/);
      }
    }
    // The interpreter instance itself never stores a secret
    const interp = new ManifestInterpreter(PROVIDER_PROFILES.openrouter!(), { http: s.http, vars: {} });
    expect(JSON.stringify(interp.manifest)).not.toMatch(/sk-/);
  });
});

describe("alias auto-derivation (Phase 1 exit criterion)", () => {
  it("identical native IDs across providers get bare aliases; qualified IDs resolve directly", async () => {
    const s = makeSetup({ responder: OPENAI_TEXT_OK });
    await addKeys(s, "pA", 1);
    await addKeys(s, "pB", 1);
    await s.catalog.refreshProvider("pA");
    await s.catalog.refreshProvider("pB");
    s.catalog.deriveAutoAliases();
    const aliasRows = s.catalog.aliases.filter((a) => a.alias === "gpt-4o");
    expect(aliasRows).toHaveLength(2); // one per provider
    const exec = await s.router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    expect(await collect(exec.chunks)).toBe("Hello");
  });
});
