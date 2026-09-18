/**
 * drift-repair-e2e.test.ts — the self-healing loop, live (ARCHITECTURE.md §9, criterion A9).
 *
 * A9: a provider that was working CHANGES its response shape underneath us. The drift monitor
 * must notice (sliding window of error-class attempts + the "succeeded elsewhere" isolation
 * gate that tells a provider-side change from our own bug), mark the provider repairing without
 * dropping traffic (failover keeps serving through the alias's second entry), build a repair
 * plan (free re-probe → deterministic re-fingerprint → AI patch with the failing provider
 * EXCLUDED from the generator's model pool), and after a human confirms, stage the patched
 * manifest as a NEW VERSION, hot-swap it in, and keep the previous version so a bad patch can be
 * rolled back in one call.
 *
 * The scenario: two providers (dbackup priority 1, dprimary priority 2) both front the SAME
 * upstream drift server, both speaking openai-compat. The upstream flips to a new shape
 * (/items + /chat2 with {text} framing). Every request now fails on dbackup first, then on
 * dprimary — so dprimary has proof the model worked elsewhere (via dbackup's ledger rows) and
 * triggers, while dbackup has no such proof and stays silent. That asymmetry IS the isolation
 * gate, asserted on the wire.
 *
 * The patched manifest comes from a scripted oracle (System AI) so the whole AI route —
 * exclusion rule, schema/lint gates, free contract checks — is real and deterministic.
 *
 * Every step mirrors apps/desktop/src/store.ts (driftMonitor + buildRepairPlan + approveRepair +
 * rollbackManifest) one-for-one; the only swap is the host boundary.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AllAttemptsFailedError,
  DriftMonitor,
  RepairOrchestrator,
  runContractSuite,
  type DriftEvidence,
  type RepairPlan,
} from "@aiprovider/router-core";
import { startMocks } from "./mock-servers.js";
import { buildHarness, type RouterHarness } from "./router-harness.js";

// Ports are disjoint from the other E2E files: vitest runs test files in parallel workers and
// each file hosts its own mock set.
const DRIFT_PORT = 18796;
const ORACLE_PORT = 18795;
const DRIFT_BASE = `http://127.0.0.1:${DRIFT_PORT}/v1`;
const ORACLE_BASE = `http://127.0.0.1:${ORACLE_PORT}/v1`;
const DRIFT_KEY = "sk-drift-works";
const ORACLE_KEY = "sk-oracle-works";

let stopAll: () => Promise<void>;
let harness: RouterHarness;

/** A pending repair, exactly like store.ts `pendingRepairs` plus an awaitable for the plan. */
interface PendingRepair {
  evidence: DriftEvidence;
  plan?: RepairPlan;
  error?: string;
  done: Promise<void>;
}
const repairs = new Map<string, PendingRepair>();

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const c of chunks) out += c;
  return out;
}

beforeAll(async () => {
  ({ stopAll } = await startMocks([
    {
      // The pair hosts two servers; /__state answers 200 unauthenticated and pins the drift
      // server's mode (v1) so the health poll proves the right server is up.
      file: "drift-and-oracle.mjs",
      port: DRIFT_PORT,
      healthPath: "/__state",
      env: { ORACLE_PORT: String(ORACLE_PORT), DRIFT_PORT: String(DRIFT_PORT) },
    },
  ]));
  harness = buildHarness();
}, 30_000);

afterAll(async () => {
  await stopAll().catch(() => undefined);
});

/**
 * store.ts buildRepairPlan, minus the `invoke(...)` persistence: free re-checks produce the
 * failing-assertion context the AI patch prompt needs, then the orchestrator plans.
 */
async function buildRepairPlan(evidence: DriftEvidence): Promise<RepairPlan | undefined> {
  // Register BEFORE the first await: onTrigger is synchronous and attaches the real `done`
  // promise to this entry, so a caller can await the plan instead of racing it.
  const entry: PendingRepair = { evidence, done: Promise.resolve() };
  repairs.set(evidence.providerId, entry);
  const provider = harness.registry.getProvider(evidence.providerId);
  if (!provider) return undefined;
  const { adapter } = await harness.adapters.forProvider(provider.id);
  const secretRef = harness.registry.keysOf(provider.id)[0]?.secretRef;
  if (!secretRef) return undefined;
  const otherHealthy = harness.registry
    .listProviders()
    .filter((p) => p.id !== provider.id && p.status === "enabled").length;
  try {
    const contract = await runContractSuite(adapter, {
      secretRef,
      consent: { text: false, image: false },
    });
    const plan = await new RepairOrchestrator({
      http: harness.http,
      ai: harness.router,
      systemLabel: "sysai/oracle-chat (system)",
      currentManifest: adapter.manifest,
      currentVersion: harness.actions.manifestHistory(provider.id).find((r) => r.isActive)?.version ?? 1,
      provider: { id: provider.id, slug: provider.slug, name: provider.name, baseUrl: provider.baseUrl },
      secretRef,
      otherHealthyProviders: otherHealthy,
      failingChecks: contract.checks.filter((c) => !c.pass),
    }).plan();
    // Mutate in place: onTrigger handed this same object to a waiter; replacing it in the map
    // would leave the waiter holding a promise that resolves against a stale entry.
    entry.plan = plan;
    return plan;
  } catch (err) {
    entry.error = String((err as Error).message);
    return undefined;
  }
}

/** Wire the drift monitor exactly like store.ts: onAttempt -> observe, onTrigger -> repair. */
function wireDriftMonitor(): DriftMonitor {
  const monitor = new DriftMonitor({
    succeededElsewhere: (requestedModel, excludeProviderId) => {
      const now = Date.now();
      return harness.ledger
        .query({ since: now - 60 * 60_000 })
        .some(
          (e) =>
            e.status === "ok" &&
            e.requestedModel === requestedModel &&
            !!e.providerId &&
            e.providerId !== excludeProviderId,
        );
    },
    onTrigger: (e) => {
      // mark repairing — the route planner drops the provider, failover covers via the alias.
      harness.actions.setProviderStatus(e.providerId, "repairing");
      const p = buildRepairPlan(e).then(() => undefined);
      const entry = repairs.get(e.providerId);
      if (entry) entry.done = p;
    },
  });
  harness.router.onAttempt = (a) => monitor.observe(a);
  return monitor;
}

/** A request that is expected to fail everywhere; its attempts still feed the drift window.
 *  The execution generator is lazy — the attempts (and the failure) only happen while the
 *  chunks are iterated, so the request must be collected for the error to surface. */
async function failingRequest(model: string): Promise<void> {
  const exec = await harness.router.generateText({
    model,
    messages: [{ role: "user", content: "hi" }],
  });
  await expect(collect(exec.chunks)).rejects.toThrow(AllAttemptsFailedError);
}

// ---------------------------------------------------------------------------
// A9 — drift detection
// ---------------------------------------------------------------------------
let oracleSecretRef: string;
let driftSecretRef: string;

describe("A9 drift detection", () => {
  let dprimary: string;
  let dbackup: string;

  it("boots two providers over the same upstream and serves through the first", async () => {
    // The System AI first — the repair needs a second healthy provider to draw a patch from.
    const oracle = harness.actions.addProvider({
      slug: "sysai",
      name: "System AI oracle",
      baseUrl: ORACLE_BASE,
    });
    oracleSecretRef = (await harness.actions.addKey(oracle.id, "oracle-key", ORACLE_KEY)).secretRef;
    expect(await harness.actions.refreshCatalog(oracle.id)).toBe(1);
    harness.actions.setSystemAi(oracle.id, "oracle-chat");

    // Two providers fronting the SAME upstream: the alias spans both so failover is real.
    const backup = harness.actions.addProvider({
      slug: "dbackup",
      name: "Drift Backup",
      baseUrl: DRIFT_BASE,
    });
    const primary = harness.actions.addProvider({
      slug: "dprimary",
      name: "Drift Primary",
      baseUrl: DRIFT_BASE,
    });
    dbackup = backup.id;
    dprimary = primary.id;
    driftSecretRef = (await harness.actions.addKey(primary.id, "key-01", DRIFT_KEY)).secretRef;
    await harness.actions.addKey(backup.id, "key-01", DRIFT_KEY);
    expect(await harness.actions.refreshCatalog(backup.id)).toBe(2);
    expect(await harness.actions.refreshCatalog(primary.id)).toBe(2);

    // Both adapters are version-1 manifests (the rollback target). addProvider registers the
    // template with the adapter runtime; stage/activate mirror it into the manifest store.
    const { adapter: primaryAdapter } = await harness.adapters.forProvider(primary.id);
    expect(harness.actions.stageManifest(primary.id, primaryAdapter.manifest, { origin: "builtin-template" })).toBe(1);
    expect(harness.actions.activateManifest(primary.id, 1)).toBeNull();

    harness.catalog.setAliases([
      { alias: "dgpt", providerId: backup.id, nativeModelId: "dgpt", priority: 1, auto: false },
      { alias: "dgpt", providerId: primary.id, nativeModelId: "dgpt", priority: 2, auto: false },
      { alias: "dsecond", providerId: backup.id, nativeModelId: "dsecond", priority: 1, auto: false },
      { alias: "dsecond", providerId: primary.id, nativeModelId: "dsecond", priority: 2, auto: false },
    ]);

    wireDriftMonitor();

    // Pre-flip: the alias's first entry serves; both models succeed and seed the ledger.
    let exec = await harness.router.generateText({
      model: "dgpt",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(await collect(exec.chunks)).toBe("drift-v1:dgpt");
    expect(exec.served()?.provider.slug).toBe("dbackup");
    exec = await harness.router.generateText({
      model: "dsecond",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(await collect(exec.chunks)).toBe("drift-v1:dsecond");
  });

  it("detects the provider-side change and isolates it from our own bug", async () => {
    // The upstream changes shape out from under us.
    const flip = await fetch(`http://127.0.0.1:${DRIFT_PORT}/__flip`, { method: "POST" });
    expect(flip.status).toBe(200);

    // Failover keeps trying: each request burns the whole chain (backup 404 -> primary 404).
    for (let i = 0; i < 3; i++) await failingRequest("dgpt");
    for (let i = 0; i < 3; i++) await failingRequest("dsecond");

    // dprimary: >=5 errors across >=2 models AND proof the model worked elsewhere -> triggers.
    const entry = repairs.get(dprimary);
    expect(entry, "dprimary should have triggered").toBeDefined();
    await entry!.done; // fire-and-forget in production; here we wait for the plan to land.
    expect(entry!.error).toBeUndefined();
    expect(entry!.evidence.models).toContain("dgpt");
    expect(entry!.evidence.models).toContain("dsecond");
    expect(entry!.evidence.errors).toBeGreaterThanOrEqual(5);

    // dbackup: same error stream, but nothing ever served "dgpt"/"dsecond" through a DIFFERENT
    // provider — no elsewhere-proof, so the monitor stays silent. That is the isolation gate.
    expect(repairs.has(dbackup), "dbackup must not trigger without elsewhere-proof").toBe(false);

    // Marked repairing and dropped from the plan (failover covers via dbackup... which is also
    // broken here — the point is the planner no longer admits a known-broken provider).
    expect(harness.registry.getProvider(dprimary)?.status).toBe("repairing");
  });

  it("builds a gated AI patch with the drifted provider excluded from generation", async () => {
    const plan = repairs.get(dprimary)!.plan!;
    expect(plan.status).toBe("planned");
    expect(plan.currentVersion).toBe(1);
    // The deterministic re-fingerprint cannot recognize the new shape — it's not any known
    // dialect — so the plan falls through to the AI patch.
    expect(plan.evidence).toContain("re-fingerprint: no known dialect matched");

    const candidate = plan.candidate!;
    expect(candidate).toBeDefined();
    expect(candidate.manifest!.dialect).toBe("drifted-v2");
    expect(candidate.manifest!.provider.baseUrl).toBe(DRIFT_BASE); // lint pins the user's URL
    expect(candidate.schemaErrors).toHaveLength(0); // zod gate clean
    expect(candidate.lintErrors).toHaveLength(0); // lint gate clean
    expect(candidate.freePasses).toBeGreaterThan(0);

    // EXCLUSION RULE on the wire: every generation call left the egress with the ORACLE's
    // secretRef — the drifted provider's key never produced its own replacement. (The audit
    // records pre-substitution headers, so a raw key here would itself be a leak; the sentinel
    // proves the secret travelled only in its sanctioned slot.)
    const oracleCalls = harness.http.audit.filter(
      (a) => new URL(a.url).port === String(ORACLE_PORT) && a.url.includes("/chat/completions"),
    );
    expect(oracleCalls.length).toBeGreaterThan(0);
    for (const c of oracleCalls) {
      expect(c.secretRef).toBe(oracleSecretRef);
      // The audit keeps PRE-substitution headers, so the sentinel — not the raw key — is what
      // proves the secret rode in its sanctioned slot. Header casing is the manifest's choice.
      const authHeader = Object.entries(c.headers).find(([k]) => k.toLowerCase() === "authorization");
      expect(authHeader, "an Authorization header must be present").toBeDefined();
      expect(authHeader![1]).toContain("{{secret}}");
    }
    expect(harness.http.audit.filter((a) => a.secretRef === driftSecretRef && new URL(a.url).port === String(ORACLE_PORT))).toHaveLength(0);
    // The generator's ledger rows exist and were served by the oracle (this IS the AI path).
    const genRows = harness.ledger.query({ source: "generator" });
    expect(genRows.length).toBeGreaterThan(0);
    expect(genRows.every((r) => r.providerId === harness.registry.providerBySlug("sysai")!.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A9 — human confirmation, hot-swap, and rollback
// ---------------------------------------------------------------------------
describe("A9 repair approval and rollback", () => {
  const dprimarySlug = "dprimary";

  it("stages the patch as version 2 and hot-swaps it after confirmation", async () => {
    const p = harness.registry.providerBySlug(dprimarySlug)!;
    const plan = repairs.get(p.id)!.plan!;
    const manifest = plan.candidate!.manifest!;

    // approveRepair(): stage as a NEW version, activate (returns the previous one), hot-swap,
    // re-enable, refresh the catalog from the new shape.
    const v2 = harness.actions.stageManifest(p.id, manifest, {
      origin: "ai-patched",
      contract: plan.candidate!.contract,
    });
    expect(v2).toBe(2);
    const previous = harness.actions.activateManifest(p.id, v2);
    expect(previous).toBe(1);
    harness.actions.setProviderStatus(p.id, "enabled");
    expect(await harness.actions.refreshCatalog(p.id)).toBe(2);
    expect(harness.actions.activeManifest(p.id)!.dialect).toBe("drifted-v2");

    // The patched provider serves the NEW shape; failover preserved (dbackup still 404s first).
    const exec = await harness.router.generateText({
      model: "dgpt",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(await collect(exec.chunks)).toBe("drift-v2:dgpt");
    expect(exec.served()?.provider.slug).toBe(dprimarySlug);
    expect(exec.fallbackChain().map((f) => f.candidate.provider.slug)).toContain("dbackup");
  });

  it("streams through the patched manifest too", async () => {
    const exec = await harness.router.generateText({
      model: "dsecond",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(await collect(exec.chunks)).toBe("drift-v2:dsecond");
    expect(exec.served()?.provider.slug).toBe(dprimarySlug);
  });

  it("rolls back to the previous version in one call when the patch is bad", async () => {
    const p = harness.registry.providerBySlug(dprimarySlug)!;
    // rollbackManifest(): reactivate v1, read back the active row, hot-swap it back in.
    const back = harness.actions.activateManifest(p.id, 1);
    expect(back).toBe(2);
    expect(harness.actions.activeManifest(p.id)!.dialect).toBe("openai-chat-v1");
    expect(harness.actions.manifestHistory(p.id)).toHaveLength(2);
    expect(harness.actions.manifestHistory(p.id).find((r) => r.version === 1)!.isActive).toBe(true);

    // The rolled-back adapter can't speak the new shape — the request fails again, exactly as
    // before the repair, proving the rollback actually took effect on the live adapter. The
    // generator is lazy, so the failure only surfaces while the chunks are iterated.
    const exec = await harness.router.generateText({
      model: "dgpt",
      messages: [{ role: "user", content: "hi" }],
    });
    await expect(collect(exec.chunks)).rejects.toThrow(AllAttemptsFailedError);
  });
});
