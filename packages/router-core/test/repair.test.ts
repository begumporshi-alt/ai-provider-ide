/**
 * Phase 5 pipeline tests: drift windows (§2.10) and the repair flow (re-probe ->
 * deterministic re-fingerprint -> AI patch -> contract gates -> staged versions ->
 * rollback), all against scripted fakes.
 */
import { describe, expect, it } from "vitest";
import { DriftMonitor, type DriftAttempt } from "../src/drift-monitor.js";
import { RepairOrchestrator } from "../src/repair-orchestrator.js";
import { ManifestInterpreter } from "../src/manifest-interpreter.js";
import { BUILTIN_TEMPLATES } from "../src/builtin-templates.js";
import { FakeHttp } from "./fakes.js";

function attempt(i: number, over: Partial<DriftAttempt> = {}): DriftAttempt {
  return {
    providerId: "pX", providerSlug: "x", model: `m${i % 2}`, requestedModel: `x/m${i % 2}`,
    cls: "PARSE_ERROR", ts: 1_000_000 + i * 1000, ...over,
  };
}

describe("DriftMonitor (§2.10 windows)", () => {
  it("triggers at >=5 drift errors across >=2 models when isolated to this provider", () => {
    let fired: string | null = null;
    const dm = new DriftMonitor({
      onTrigger: (e) => { fired = `${e.errors}/${e.models.length}`; },
      succeededElsewhere: () => true,
      now: () => 1_010_000,
    });
    for (let i = 0; i < 4; i++) dm.observe(attempt(i));
    expect(fired).toBeNull(); // 4 errors: not yet
    dm.observe(attempt(4));
    expect(fired).toBe("5/2");
  });

  it("does NOT trigger when every model fails everywhere (our bug, not provider drift)", () => {
    let fired = false;
    const dm = new DriftMonitor({
      onTrigger: () => { fired = true; },
      succeededElsewhere: () => false,
    });
    for (let i = 0; i < 20; i++) dm.observe(attempt(i));
    expect(fired).toBe(false);
  });

  it("single-model failure burst does not trigger (needs >=2 models)", () => {
    let fired = false;
    const dm = new DriftMonitor({
      onTrigger: () => { fired = true; },
      succeededElsewhere: () => true,
    });
    for (let i = 0; i < 20; i++) dm.observe(attempt(i, { model: "only", requestedModel: "only" }));
    expect(fired).toBe(false);
  });

  it("one trigger per provider per cooldown; manual repair clears the cooldown", () => {
    let triggers = 0;
    let now = 1_000_000;
    const dm = new DriftMonitor({
      cooldownMs: 50_000,
      onTrigger: () => { triggers++; },
      succeededElsewhere: () => true,
      now: () => now,
    });
    for (let i = 0; i < 5; i++) dm.observe(attempt(i));
    expect(triggers).toBe(1);
    for (let i = 5; i < 12; i++) dm.observe(attempt(i));
    expect(triggers).toBe(1); // still in cooldown
    now += 60_000;
    for (let i = 12; i < 20; i++) dm.observe(attempt(i));
    expect(triggers).toBe(2);
    dm.forceClearCooldown("pX");
    for (let i = 20; i < 28; i++) dm.observe(attempt(i));
    expect(triggers).toBe(3); // "Repair now" bypasses the rate limit
  });

  it("errors outside the window slide away", () => {
    let fired = false;
    let now = 1_000_000;
    const dm = new DriftMonitor({
      windowMs: 10_000, cooldownMs: 0,
      onTrigger: () => { fired = true; },
      succeededElsewhere: () => true,
      now: () => now,
    });
    for (let i = 0; i < 4; i++) dm.observe(attempt(i));
    now += 20_000; // old ones expired
    for (let i = 100; i < 103; i++) dm.observe(attempt(i));
    expect(fired).toBe(false);
  });

  it("OK and NETWORK classes are not drift signals", () => {
    let fired = false;
    const dm = new DriftMonitor({ onTrigger: () => { fired = true; }, succeededElsewhere: () => true });
    for (let i = 0; i < 10; i++) dm.observe(attempt(i, { cls: "OK" }));
    for (let i = 0; i < 10; i++) dm.observe(attempt(i, { cls: "NETWORK" }));
    expect(fired).toBe(false);
  });
});

describe("RepairOrchestrator (§2.10 repair flow)", () => {
  const provider = { id: "pX", slug: "x", name: "X", baseUrl: "https://x.test/v1" };
  const CURRENT = BUILTIN_TEMPLATES["openai-compat"]!("https://x.test/v1");
  const failing = [{ name: "models: catalog parses", pass: false, paid: false, detail: "empty" }];

  function deps(extra: Partial<import("../src/repair-orchestrator.js").RepairDeps> = {}) {
    return {
      http: new FakeHttp(() => ({ status: 404 })),
      ai: { complete: async () => "no json" },
      systemLabel: "sys",
      currentManifest: CURRENT,
      currentVersion: 1,
      provider,
      secretRef: "key:k1",
      otherHealthyProviders: 1,
      failingChecks: failing,
      ...extra,
    };
  }

  it("deterministic re-fingerprint fixes a provider that drifted back to a known dialect", async () => {
    const http = new FakeHttp((url) => {
      if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "m1" }] } };
      if (url.endsWith("/chat/completions")) return { status: 200, body: { choices: [{ message: { content: "ok" } }] } };
      return { status: 404 };
    });
    const orch = new RepairOrchestrator(deps({ http }));
    const plan = await orch.plan();
    expect(plan.status).toBe("planned");
    expect(plan.deterministic).toBeDefined();
    expect(plan.evidence.join(" ")).toContain("re-fingerprint matched");
  });

  it("no second provider -> AI path unavailable with the explanatory evidence (only-provider caveat)", async () => {
    const http = new FakeHttp(() => ({ status: 599 })); // nothing recognizable
    const orch = new RepairOrchestrator(deps({ http, otherHealthyProviders: 0 }));
    const plan = await orch.plan();
    expect(plan.status).toBe("no_ai_available");
    expect(plan.evidence.join(" ")).toContain("second healthy provider");
  });

  it("AI patch path: candidate produced via feedback prompt, gated by free checks", async () => {
    // provider speaks an exotic shape: no /models, custom chat endpoint -> fingerprint fails,
    // but a generated manifest (we script the AI to output one) passes free checks
    const chatManifest = {
      ...CURRENT,
      endpoints: {
        listModels: { method: "GET" as const, path: "/weird/items", map: { models: "$.items[*].name" } },
        generateText: CURRENT.endpoints.generateText,
      },
    };
    const http = new FakeHttp((url) => {
      if (url.endsWith("/weird/items")) return { status: 200, body: { items: [{ name: "m1" }] } };
      if (url.endsWith("/chat/completions")) return { status: 200, body: { choices: [{ message: { content: "hi" } }] } };
      return { status: 404 };
    });
    const ai = { complete: async () => JSON.stringify({ ...chatManifest, provenance: { origin: "ai-generated", generatorModel: null, createdAt: "x" } }) };
    const plan = await new RepairOrchestrator(deps({ http, ai })).plan();
    expect(plan.status).toBe("planned");
    expect(plan.candidate?.manifest).toBeDefined();
    expect(plan.candidate!.freePasses).toBeGreaterThanOrEqual(2);
    // the patch prompt carried the failing-assertions context (§2.10 "old manifest + failing assertions")
  });
});
