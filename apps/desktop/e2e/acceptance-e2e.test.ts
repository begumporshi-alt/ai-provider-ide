/**
 * acceptance-e2e.test.ts — the live acceptance pass (ARCHITECTURE.md §9, criteria A2-A5, A10).
 *
 * Every assertion below is driven over REAL HTTP against a spawned mock provider. The unit
 * suite in packages/router-core proves the routing math against scripted fakes; this suite
 * proves the same stack works when the wire is real: the manifest interpreter parses genuine
 * SSE bytes, the host egress contract (sentinel injection, allowlist, host pairing) is the
 * only thing standing between a request and the network, and the ledger records what actually
 * happened.
 *
 * Composition is production (store.ts) with two host swaps: HostHttp for the Rust egress
 * commands and HarnessVault for the OS keyring. Nothing above the ports is a fake.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SENTINEL } from "./host-http.js";
import { startMock, type MockServer } from "./mock-servers.js";
import { buildHarness, type RouterHarness } from "./router-harness.js";

const MOCK_PORT = 18787;

let server: MockServer;
let harness: RouterHarness;

beforeAll(async () => {
  server = await startMock("mock-provider.mjs", MOCK_PORT, "/v1/models");
  harness = buildHarness();
}, 30_000);

afterAll(async () => {
  await server?.kill().catch(() => undefined);
});

/** A provider wired to the mock with the OpenAI-compat template (image endpoint on). */
function addMockProvider(slug: string) {
  return harness.actions.addProvider({
    slug,
    name: `Mock ${slug}`,
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
  });
}

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const c of chunks) out += c;
  return out;
}

// ---------------------------------------------------------------------------
// A2 — key rotation: a dead key is skipped silently and the next key serves.
// ---------------------------------------------------------------------------
describe("A2 key rotation over real HTTP", () => {
  it("rotates past a 401 key to a working key", async () => {
    const p = addMockProvider("rot");
    await harness.actions.addKey(p.id, "dead-A", "sk-mock-key-A"); // 401 by design
    const good = await harness.actions.addKey(p.id, "good-B", "sk-mock-key-B");
    expect(await harness.actions.refreshCatalog(p.id)).toBe(2);

    const exec = await harness.router.generateText({
      model: "rot/mock-fast",
      messages: [{ role: "user", content: "hi" }],
    });
    const text = await collect(exec.chunks);

    expect(text).toBe("Hello, world!");
    expect(exec.served()?.key.id).toBe(good.id);

    // The dead attempt is recorded in the fallback chain, not hidden.
    const chain = exec.fallbackChain();
    expect(chain).toHaveLength(1);
    expect(chain[0]!.status).toBe(401);
    expect(chain[0]!.candidate.key.id).not.toBe(good.id);
  });

  it("serves a follow-up request without retrying the known-dead key", async () => {
    // The same bare-id request now routes straight to the live key: the plan is rebuilt at
    // request time and rotation state carried over.
    const exec = await harness.router.generateText(
      { model: "rot/mock-fast", messages: [{ role: "user", content: "again" }] },
      { source: "ui" },
    );
    expect(await collect(exec.chunks)).toBe("Hello, world!");
    expect(exec.fallbackChain().filter((a) => a.status === 401)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A3 — failover: when every key of the primary provider is dead, the request fails over to
// the next provider carrying the model, and the ledger records the whole chain.
// ---------------------------------------------------------------------------
describe("A3 cross-provider failover", () => {
  it("fails over to the second provider when the primary's keys are exhausted", async () => {
    const primary = addMockProvider("fail-primary");
    const secondary = addMockProvider("fail-secondary");
    await harness.actions.addKey(primary.id, "dead-A", "sk-mock-key-A"); // only key, always 401
    const c = await harness.actions.addKey(secondary.id, "good-C", "sk-mock-key-C");
    await harness.actions.refreshCatalog(primary.id);
    await harness.actions.refreshCatalog(secondary.id);

    // Pin the alias order explicitly: auto-derivation ties on priority and breaks the tie by
    // provider id (a UUID), which is not a stable "primary". A manual alias decides the route.
    harness.catalog.setAliases([
      { alias: "mock-fast", providerId: primary.id, nativeModelId: "mock-fast", priority: 1, auto: false },
      { alias: "mock-fast", providerId: secondary.id, nativeModelId: "mock-fast", priority: 2, auto: false },
    ]);

    const exec = await harness.router.generateText({
      model: "mock-fast",
      messages: [{ role: "user", content: "failover" }],
    });
    await collect(exec.chunks);

    expect(exec.served()?.provider.id).toBe(secondary.id);
    expect(exec.served()?.key.id).toBe(c.id);
    // The mock's stream branch emits fixed chunks regardless of key, so the text cannot prove
    // which provider served — the secret that actually went on the wire can.
    const sentWithC = harness.http.audit.filter(
      (a) => a.url.endsWith("/chat/completions") && a.secretRef === c.secretRef,
    );
    expect(sentWithC.length).toBeGreaterThan(0);

    const chain = exec.fallbackChain();
    expect(chain).toHaveLength(1);
    expect(chain[0]!.candidate.provider.id).toBe(primary.id);
    expect(chain[0]!.status).toBe(401);
  });

  it("records the serving provider, key and fallback chain in the ledger", async () => {
    const secondaryId = harness.registry.providerBySlug("fail-secondary")!.id;
    const rows = harness.ledger.query({ source: "ui" });
    const failoverRow = rows.find(
      (r) => r.requestedModel === "mock-fast" && r.providerId === secondaryId && (r.fallbackChain?.length ?? 0) >= 1,
    );
    expect(failoverRow).toBeDefined();
    expect(failoverRow!.status).toBe("ok");
    expect(failoverRow!.providerId).toBe(secondaryId);
    expect(failoverRow!.keyId).toBe(harness.registry.keysOf(secondaryId)[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// A4 — both modalities end to end: streaming text and a generated image.
// ---------------------------------------------------------------------------
describe("A4 text + image over real HTTP", () => {
  it("streams chat completion chunks that reassemble the full text", async () => {
    const p = harness.registry.providerBySlug("rot")!;
    const exec = await harness.router.generateText({
      model: `${p.slug}/mock-fast`,
      messages: [{ role: "user", content: "stream me" }],
    });
    // The mock emits ["Hel","lo, ","world","!"] as discrete SSE events; the interpreter must
    // surface each as its own chunk.
    const chunks: string[] = [];
    for await (const c of exec.chunks) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe("Hello, world!");
  });

  it("generates an image and returns the embedded payload", async () => {
    const p = harness.registry.providerBySlug("rot")!;
    const res = await harness.router.generateImage({
      model: `${p.slug}/sd-mock-1`,
      prompt: "a tiny red pixel",
    });
    expect(res.base64).toBeTruthy();
    // The 1px PNG the mock embeds, verbatim.
    expect(res.base64).toBe(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    );
  });
});

// ---------------------------------------------------------------------------
// A5 — the wire invariant: no raw secret ever leaves the process. Every request the host
// dispatched is inspected as recorded BEFORE substitution.
// ---------------------------------------------------------------------------
describe("A5 no raw secret crosses the wire", () => {
  it("never put a raw secret into a header or url", () => {
    expect(harness.http.audit.length).toBeGreaterThan(0);
    const secrets = harness.vault.knownSecrets();
    expect(secrets.length).toBeGreaterThan(0);

    for (const entry of harness.http.audit) {
      // Every authed request hides the credential behind the sentinel in exactly one header.
      const values = Object.values(entry.headers);
      expect(values.some((v) => v.includes(SENTINEL))).toBe(true);
      for (const s of secrets) {
        for (const v of values) expect(v).not.toContain(s);
        expect(entry.url).not.toContain(s);
      }
      expect(entry.secretRef).toMatch(/^key:.+$/);
    }
  });

  it("only ever contacted the allowlisted local host", () => {
    for (const entry of harness.http.audit) {
      expect(new URL(entry.url).hostname).toBe("127.0.0.1");
    }
  });
});

// ---------------------------------------------------------------------------
// A10 — source attribution: the ledger distinguishes who initiated a request.
// ---------------------------------------------------------------------------
describe("A10 ledger source attribution", () => {
  it("tags UI requests and generator requests separately", async () => {
    const p = harness.registry.providerBySlug("rot")!;
    const before = harness.ledger.query({ source: "generator" }).length;

    // A UI-sourced request.
    await collect((await harness.router.generateText({ model: `${p.slug}/mock-fast`, messages: [{ role: "user", content: "ui one" }] }, { source: "ui" })).chunks);

    // A generator-sourced request: the wizard's AI path goes through router.complete, which
    // always records source "generator".
    await harness.router.complete({
      prompt: "build an adapter",
      maxTokens: 100,
      timeoutMs: 5000,
      excludeProviderIds: [],
    });

    const uiRows = harness.ledger.query({ source: "ui" });
    const genRows = harness.ledger.query({ source: "generator" });
    expect(uiRows.some((r) => r.requestedModel === "rot/mock-fast")).toBe(true);
    expect(genRows.length).toBeGreaterThan(before);
    // No cross-contamination: every row carries exactly one source.
    for (const r of [...uiRows, ...genRows]) {
      expect(["ui", "gateway", "generator"]).toContain(r.source);
    }
    expect(uiRows.every((r) => r.source === "ui")).toBe(true);
    expect(genRows.every((r) => r.source === "generator")).toBe(true);
  });
});
