/**
 * onboarding-e2e.test.ts — the two onboarding paths, live (ARCHITECTURE.md §9, criteria A7 + 12).
 *
 * A7 (zero-AI bootstrap): on a fresh install with ZERO providers, adding an OpenAI-compatible
 * provider must complete end-to-end with no AI in the loop at all — probe → fingerprint →
 * template → free contract checks → confirm → enable → a real request. The deterministic
 * fingerprinter is the only path at first boot; the AI path is not even reachable.
 *
 * Phase 4 (AI-assisted): the same wizard, but against a provider that speaks NO known dialect
 * (an exotic {items:[{name}]} model list and a /completions-v2 chat surface). The fingerprint
 * misses, the wizard hands off to the System AI, and the AI's manifest is gated by schema →
 * lint (baseUrl pinned) → FREE contract checks over real HTTP before a human ever sees it.
 * The "intelligence" is a scripted oracle so the whole stack — router AI route, exclusion rule,
 * gates, hot-swap registration — is real and deterministic while costing nothing.
 *
 * Every step mirrors apps/desktop/src/screens/Onboarding.tsx one-for-one; the only swap is the
 * host boundary (HostHttp for the Rust egress commands, HarnessVault for the keyring).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateCandidates,
  OnboardingOrchestrator,
  runContractSuite,
  type OnboardingPersistence,
  type OnboardingSessionData,
} from "@aiprovider/router";
import { startMocks } from "./mock-servers.js";
import { buildHarness, type RouterHarness } from "./router-harness.js";

// Ports are disjoint from the other E2E files: vitest runs test files in parallel workers and
// each file hosts its own mock set.
const MOCK_PORT = 18793;
const ORACLE_PORT = 18791;
const EXOTIC_PORT = 18789;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/v1`;
const EXOTIC_BASE = `http://127.0.0.1:${EXOTIC_PORT}/v2`;
const ORACLE_BASE = `http://127.0.0.1:${ORACLE_PORT}/v1`;

let stopAll: () => Promise<void>;
let harness: RouterHarness;

/** In-memory OnboardingPersistence — the wizard's session survives a restart in production. */
function memoryPersistence(): OnboardingPersistence & { saved: OnboardingSessionData[] } {
  const saved: OnboardingSessionData[] = [];
  return {
    saved,
    async save(data) {
      saved.push(data);
    },
    async loadLatest() {
      return saved[saved.length - 1] ?? null;
    },
  };
}

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const c of chunks) out += c;
  return out;
}

beforeAll(async () => {
  ({ stopAll } = await startMocks([
    { file: "mock-provider.mjs", port: MOCK_PORT, healthPath: "/v1/models" },
    // The oracle pair hosts two servers; the health probe hits the oracle's model list.
    {
      file: "exotic-and-oracle.mjs",
      port: ORACLE_PORT,
      healthPath: "/v1/models",
      env: { ORACLE_PORT: String(ORACLE_PORT), EXOTIC_PORT: String(EXOTIC_PORT) },
    },
  ]));
  harness = buildHarness();
}, 30_000);

afterAll(async () => {
  await stopAll().catch(() => undefined);
});

// ---------------------------------------------------------------------------
// A7 — zero-AI bootstrap: the whole wizard with nothing but the deterministic fingerprinter.
// ---------------------------------------------------------------------------
describe("A7 zero-AI onboarding bootstrap", () => {
  it("has no AI path available on a fresh install with zero providers", () => {
    expect(harness.registry.listProviders()).toHaveLength(0);
    const health = harness.router.systemAiAvailable();
    expect(health.available).toBe(false);
    expect(health.reason).toContain("first enabled provider");
  });

  it("probes, fingerprints and templates an OpenAI-compatible provider", async () => {
    // start(): provider row first (pending = probes can reach it), then the key.
    const p = harness.actions.addPendingProvider({ slug: "mock", name: "Mock Provider", baseUrl: MOCK_BASE });
    const key = await harness.actions.addKey(p.id, "key-01", "sk-mock-key-B");
    expect(p.status).toBe("pending");

    const orch = new OnboardingOrchestrator(harness.http, memoryPersistence());
    const report = await orch.start({ name: "Mock Provider", baseUrl: MOCK_BASE });

    // Every probe crossed real HTTP; the OpenAI surface answered.
    expect(report.attempts).toHaveLength(9);
    expect(report.attempts.filter((a) => a.status !== null)).toHaveLength(9);
    expect(report.attempts.find((a) => a.path === "/models")!.status).toBe(200);
    expect(report.attempts.find((a) => a.path === "/chat/completions")!.status).toBe(200);

    const fp = await orch.identify();
    expect(fp.dialect).toBe("openai-compat");
    expect(fp.template).toBeDefined();
    expect(fp.template!.provider.baseUrl).toBe(MOCK_BASE); // pinned to the user's URL
    expect(orch.session.state).toBe("template_instantiated");

    // The wizard registers the template and persists it as version 1.
    harness.actions.registerManifest(p.id, fp.template!);
    const v1 = harness.actions.stageManifest(p.id, fp.template!, { origin: "builtin-template" });
    expect(v1).toBe(1);
    expect(harness.actions.activateManifest(p.id, v1)).toBeNull(); // first activation, no previous

    // Free contract checks over real HTTP (no consent given — paid checks must not run).
    const { adapter } = await harness.adapters.forProvider(p.id);
    const free = await runContractSuite(adapter, { secretRef: key.secretRef, consent: { text: false, image: false } });
    expect(free.freePassed).toBe(true);
    expect(free.checks.filter((c) => c.paid)).toHaveLength(0);

    // The state machine will not confirm a provider whose free checks failed.
    await orch.setContract(free);
    await orch.confirmRegistration();
    expect(orch.session.state).toBe("human_confirmation");
  });

  it("enables the provider and serves a Playground request with zero AI calls", async () => {
    const p = harness.registry.providerBySlug("mock")!;
    const orch = new OnboardingOrchestrator(harness.http, memoryPersistence());
    await orch.resume({
      ...orch.session,
      input: { name: "Mock Provider", baseUrl: MOCK_BASE },
      state: "human_confirmation",
      manifest: harness.actions.activeManifest(p.id),
    });

    // enableProvider(): human confirms, status flips, catalog refresh, state machine done.
    harness.actions.setProviderStatus(p.id, "enabled");
    expect(await harness.actions.refreshCatalog(p.id)).toBe(2);
    await orch.enable();
    expect(orch.session.state).toBe("enabled");

    // The request routes to the newly enabled provider and the stream reassembles.
    const exec = await harness.router.generateText({
      model: "mock/mock-fast",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(await collect(exec.chunks)).toBe("Hello, world!");
    expect(exec.served()?.provider.slug).toBe("mock");

    // ZERO-AI proof, wire level: no generator ledger row was ever written and the oracle was
    // never contacted. The bootstrap needed no intelligence.
    expect(harness.ledger.query({ source: "generator" })).toHaveLength(0);
    expect(harness.http.audit.filter((a) => new URL(a.url).port === String(ORACLE_PORT))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — AI-assisted onboarding of a provider that speaks no known dialect.
// ---------------------------------------------------------------------------
describe("AI-assisted onboarding of an exotic provider", () => {
  let oracleKey: string;
  let exoticKey: string;

  it("unlocks the AI path once the first provider is live", async () => {
    // The System AI is just another provider routed through the same router (§2.9).
    const oracle = harness.actions.addProvider({
      slug: "sysai",
      name: "System AI oracle",
      baseUrl: ORACLE_BASE,
    });
    const k = await harness.actions.addKey(oracle.id, "oracle-key", "sk-oracle-works");
    oracleKey = k.secretRef;
    expect(await harness.actions.refreshCatalog(oracle.id)).toBe(1);
    harness.actions.setSystemAi(oracle.id, "oracle-chat");

    const health = harness.router.systemAiAvailable();
    expect(health.available).toBe(true);
  });

  it("fingerprints the exotic provider as unknown and generates a gated manifest", async () => {
    const exotic = harness.actions.addPendingProvider({ slug: "exotic", name: "Exotic", baseUrl: EXOTIC_BASE });
    const k = await harness.actions.addKey(exotic.id, "key-01", "sk-exotic-works");
    exoticKey = k.secretRef;

    const orch = new OnboardingOrchestrator(harness.http, memoryPersistence());
    const report = await orch.start({ name: "Exotic", baseUrl: EXOTIC_BASE });
    // The exotic surface is deliberately unrecognizable: model list under {items:[{name}]} and
    // no /chat/completions, no /messages.
    expect(report.attempts.find((a) => a.path === "/models")!.status).toBe(401);
    expect(report.attempts.find((a) => a.path === "/chat/completions")!.status).toBe(404);

    const fp = await orch.identify();
    expect(fp.dialect).toBe("unknown");
    expect(orch.session.state).toBe("failed");
    expect(orch.session.failureReason).toContain("Phase 4");
    expect(harness.router.systemAiAvailable().available).toBe(true);

    // The generator: best-of-N through the System AI, each candidate gated schema -> lint ->
    // free checks over real HTTP. The AI may never serve through the adapter being built.
    const ranked = await generateCandidates({
      ai: harness.router,
      systemLabel: "sysai/oracle-chat (system)",
      report: orch.session.probeReport!,
      baseUrl: EXOTIC_BASE,
      secretRef: exoticKey,
      excludeProviderIds: [exotic.id],
      http: harness.http,
    });

    expect(ranked.length).toBeGreaterThan(0);
    const best = ranked.find((c) => c.manifest && c.freePasses > 0);
    expect(best, "no candidate passed the free contract checks").toBeDefined();
    expect(best!.manifest!.dialect).toBe("exotic-v2");
    expect(best!.manifest!.provider.baseUrl).toBe(EXOTIC_BASE); // lint invariant 4 held
    expect(best!.manifest!.provenance.origin).toBe("ai-generated"); // ours, never the model's
    expect(best!.schemaErrors).toHaveLength(0);
    expect(best!.lintErrors).toHaveLength(0);

    // pickCandidate(): stage + activate + hot-swap the adapter, then the wizard adopts it.
    const version = harness.actions.stageManifest(exotic.id, best!.manifest!, {
      origin: "ai-generated",
      contract: best!.contract,
    });
    expect(version).toBe(1);
    harness.actions.activateManifest(exotic.id, version);
    await orch.adoptGeneratedManifest(best!.manifest!);

    // The exclusion rule held on the wire: every AI completion went to the oracle, none to the
    // exotic provider being built.
    const aiCalls = harness.http.audit.filter(
      (a) => a.url.includes("/chat/completions") && new URL(a.url).port === String(ORACLE_PORT),
    );
    expect(aiCalls.length).toBeGreaterThanOrEqual(1);
    for (const a of aiCalls) expect(a.secretRef).toBe(oracleKey);
    const exoticDuringGeneration = harness.http.audit.filter(
      (a) => new URL(a.url).port === String(EXOTIC_PORT) && a.secretRef === exoticKey && a.url.includes("completions"),
    );
    // The exotic was only ever probed/contract-checked, never asked to complete for the AI.
    expect(exoticDuringGeneration).toHaveLength(0);
  });

  it("confirms, enables and serves requests through the AI-generated adapter", async () => {
    const exotic = harness.registry.providerBySlug("exotic")!;

    const { adapter } = await harness.adapters.forProvider(exotic.id);
    const free = await runContractSuite(adapter, { secretRef: exoticKey, consent: { text: false, image: false } });
    expect(free.freePassed).toBe(true);

    const orch = new OnboardingOrchestrator(harness.http, memoryPersistence());
    await orch.resume({
      ...orch.session,
      input: { name: "Exotic", baseUrl: EXOTIC_BASE },
      state: "contract_testing",
      manifest: harness.actions.activeManifest(exotic.id),
      contract: free,
    });
    await orch.confirmRegistration();
    harness.actions.setProviderStatus(exotic.id, "enabled");
    expect(await harness.actions.refreshCatalog(exotic.id)).toBe(2); // ex-lite, ex-pro
    await orch.enable();
    expect(orch.session.state).toBe("enabled");

    // Non-streaming: the generated responseMap {text: "$.text"} reads the exotic envelope.
    const unary = await harness.router.generateText({
      model: "exotic/ex-lite",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(await collect(unary.chunks)).toBe("exotic answered with ex-lite");

    // Streaming: the generated chunkMap {delta: "$.text"} reassembles the exotic's SSE framing.
    const streamed = await harness.router.generateText({
      model: "exotic/ex-pro",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(await collect(streamed.chunks)).toBe("exotic answered with ex-pro");
    expect(streamed.served()?.provider.slug).toBe("exotic");
  });
});
