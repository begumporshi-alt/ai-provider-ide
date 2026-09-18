/**
 * code-adapter-e2e.test.ts — the Tier-2 review gate, LIVE (ARCHITECTURE.md §2.7).
 *
 * The unit tests prove the four gates reject bad modules. This file proves the security
 * claims that only real HTTP can prove, end to end:
 *
 *   1. the gate actually passes a module the System AI generated, over real HTTP — the
 *      guest really ran inside QuickJS-WASM, called http({path:"/models/query"}), and the
 *      free contract checks saw a real 200 from a real server;
 *   2. the credential contract on the wire: every egress request carried the sentinel
 *      `Bearer {{secret}}` pre-substitution, resolved to the real key only inside the host,
 *      stayed on the provider's own host, and the raw key never appears anywhere in the
 *      audit — including when the guest tries to set its own Authorization header, which the
 *      host drops and replaces;
 *   3. after human approval the same manifest registers, catalogs, and serves a real
 *      streaming request through the sandboxed adapter.
 *
 * The "AI" is a scripted oracle (exotic-code.mjs) so the whole stack — router AI route,
 * exclusion rule, gates, sandbox, egress — is real and deterministic while costing nothing.
 * Ports are disjoint from the other E2E files: vitest runs test files in parallel workers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateCodeCandidate,
  OnboardingOrchestrator,
  reviewCodeCandidate,
  type AdapterManifest,
  type OnboardingPersistence,
  type OnboardingSessionData,
  type RankedCandidate,
} from "@aiprovider/router-core";
import { startMocks } from "./mock-servers.js";
import { buildHarness, type RouterHarness } from "./router-harness.js";

const ORACLE_PORT = 18797;
const EXOTIC_PORT = 18798;
const ORACLE_BASE = `http://127.0.0.1:${ORACLE_PORT}/v1`;
const EXOTIC_BASE = `http://127.0.0.1:${EXOTIC_PORT}/v2`;
const RAW_KEY = "sk-nd-works";

let stopAll: () => Promise<void>;
let harness: RouterHarness;
let oracleKey: string;
let exoticKey: string;
let exoticId: string;

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const c of chunks) out += c;
  return out;
}

/** What the exotic mock actually received on its last protected route — the wire-level truth. */
async function seenOnWire(): Promise<{ url: string | null; headers: Record<string, string> }> {
  const res = await fetch(`http://127.0.0.1:${EXOTIC_PORT}/v2/e2e/seen`, { signal: AbortSignal.timeout(2000) });
  return (await res.json()) as { url: string | null; headers: Record<string, string> };
}

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

beforeAll(async () => {
  ({ stopAll } = await startMocks([
    {
      file: "exotic-code.mjs",
      port: ORACLE_PORT, // the health probe hits the oracle's model list
      healthPath: "/v1/models",
      env: { ORACLE_PORT: String(ORACLE_PORT), EXOTIC_PORT: String(EXOTIC_PORT) },
    },
  ]));
  harness = buildHarness();

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
  expect(harness.router.systemAiAvailable().available).toBe(true);
}, 30_000);

afterAll(async () => {
  await stopAll().catch(() => undefined);
});

// ---------------------------------------------------------------------------
// The describes below share the approved candidate across `it` blocks; these helpers keep the
// plumbing in one place rather than juggling nullable locals at describe scope.
// ---------------------------------------------------------------------------
let approvedCandidate: RankedCandidate | undefined;
let overrideCandidate: AdapterManifest | undefined;

function overrideManifest(): AdapterManifest {
  if (!approvedCandidate) throw new Error("the gate test must run first");
  if (!overrideCandidate) {
    // Same module, but the listModels call now tries to smuggle its own credential.
    const source = approvedCandidate.manifest!.code!.source.replace(
      'path: "/models/query", method: "POST"',
      'path: "/models/query", method: "POST", headers: { Authorization: "Bearer attacker-token", "x-custom": "kept" }',
    );
    overrideCandidate = {
      ...approvedCandidate.manifest!,
      code: { source, entry: "adapter" },
    };
  }
  return overrideCandidate;
}

function lastApprovedCandidate(): RankedCandidate | undefined {
  return approvedCandidate;
}

// ---------------------------------------------------------------------------
// Gate 1-4: the AI's module must clear schema -> lint -> compile -> free contract checks,
// all over real HTTP, before it is ever offerable to a human.
// ---------------------------------------------------------------------------
describe("Tier-2 review gate over real HTTP", () => {
  let candidate: RankedCandidate;

  it("fingerprints the exotic provider as unexpressible in the declarative grammar", async () => {
    const p = harness.actions.addPendingProvider({
      slug: "ndcode",
      name: "Newline Provider",
      baseUrl: EXOTIC_BASE,
    });
    exoticId = p.id;
    const k = await harness.actions.addKey(p.id, "key-01", RAW_KEY);
    exoticKey = k.secretRef;

    const orch = new OnboardingOrchestrator(harness.http, memoryPersistence());
    const report = await orch.start({ name: "Newline Provider", baseUrl: EXOTIC_BASE });
    expect(report.attempts.length).toBeGreaterThan(0);
    // The classic surfaces are all absent, so the deterministic fingerprinter must miss.
    expect((await orch.identify()).dialect).toBe("unknown");
  });

  it("generates a code adapter through the System AI and passes all four gates", async () => {
    const orch = new OnboardingOrchestrator(harness.http, memoryPersistence());
    await orch.start({ name: "Newline Provider", baseUrl: EXOTIC_BASE });

    const logs: string[] = [];
    candidate = await generateCodeCandidate({
      ai: harness.router,
      systemLabel: "sysai/oracle-chat (system)",
      report: orch.session.probeReport!,
      baseUrl: EXOTIC_BASE,
      secretRef: exoticKey,
      excludeProviderIds: [exoticId],
      http: harness.http,
      onLog: (line) => logs.push(line),
    });

    // Gates 1+2: schema and lint clean.
    expect(candidate.schemaErrors, candidate.schemaErrors.join("; ")).toHaveLength(0);
    expect(candidate.lintErrors, candidate.lintErrors.join("; ")).toHaveLength(0);
    expect(candidate.id).toBe("JS");

    // Gate 3: the module actually compiled inside QuickJS-WASM.
    expect(candidate.code?.compiled).toBe(true);
    expect(candidate.code?.compileError).toBeUndefined();

    // Gate 4: the free contract checks ran over REAL HTTP against the live provider.
    expect(candidate.contract).toBeDefined();
    expect(candidate.contract!.freePassed).toBe(true);
    expect(candidate.freePasses).toBe(2); // ping (model list) + catalog parses
    expect(candidate.contract!.checks.filter((c) => c.paid)).toHaveLength(0); // no consent given

    // The manifest is host-assembled: pinned baseUrl, our grammar version, our provenance.
    const m = candidate.manifest!;
    expect(m.kind).toBe("code");
    expect(m.provider.baseUrl).toBe(EXOTIC_BASE); // invariant 4
    expect(m.provenance.origin).toBe("ai-generated");
    expect(m.provenance.generatorModel).toContain("sysai");
    expect(m.provider.auth.headers[0]!.name).toBe("Authorization");
    expect(m.capabilities).toEqual({ text: true, image: false });

    // The guest ran for real: it logged through the sandbox host function.
    expect(logs.length).toBeGreaterThan(0);

    approvedCandidate = candidate;
  });

  it("kept the AI on its own provider and never let it serve through the adapter", async () => {
    // The exclusion rule, wire level: every AI completion went to the oracle.
    const aiCalls = harness.http.audit.filter(
      (a) => a.url.includes("/chat/completions") && new URL(a.url).port === String(ORACLE_PORT),
    );
    expect(aiCalls.length).toBeGreaterThanOrEqual(1);
    for (const a of aiCalls) expect(a.secretRef).toBe(oracleKey);

    // The exotic was only ever probed / contract-checked: every authenticated call during
    // generation was a model-list lookup, never the chat route the AI would need to serve
    // through the adapter being built. (The probe POSTs to /chat/completions are
    // unauthenticated fingerprint attempts — they carry no secretRef.)
    const authenticated = harness.http.audit.filter(
      (a) => a.secretRef === exoticKey && new URL(a.url).port === String(EXOTIC_PORT),
    );
    expect(authenticated.length).toBeGreaterThan(0);
    for (const a of authenticated) expect(a.url.includes("/models/query")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The credential contract: the guest never sees the key, never addresses another host, and
// cannot override the injected credential even by setting the header itself.
// ---------------------------------------------------------------------------
describe("egress isolation of the sandboxed adapter", () => {
  it("carried the sentinel, stayed on the provider host, and never leaked the raw key", async () => {
    const exoticCalls = harness.http.audit.filter((a) => new URL(a.url).port === String(EXOTIC_PORT));
    expect(exoticCalls.length).toBeGreaterThan(0);

    // The unauthenticated entries are fingerprint probes (§2.2 — no credential by design).
    // The sandbox's own calls all carry the secretRef the host injected on its behalf.
    const sandboxed = exoticCalls.filter((a) => a.secretRef !== undefined);
    expect(sandboxed.length).toBeGreaterThan(0);
    for (const a of sandboxed) {
      // Pre-substitution, the audit holds only the sentinel — the raw key is resolved and
      // injected inside the host (HostHttp), never recorded.
      expect(a.secretRef).toBe(exoticKey);
      expect(a.headers.Authorization).toBe("Bearer {{secret}}");
      expect(JSON.stringify(a)).not.toContain(RAW_KEY);
      // Host pin: the guest addressed only relative paths, so every URL is baseUrl + path.
      expect(a.url.startsWith(EXOTIC_BASE)).toBe(true);
    }

    // And no raw secret known to the host appears anywhere in the whole audit.
    for (const secret of harness.vault.knownSecrets()) {
      for (const a of harness.http.audit) expect(JSON.stringify(a)).not.toContain(secret);
    }

    // Wire-level truth: the credential the guest never held is the one that arrived.
    const seen = await seenOnWire();
    expect(seen.headers.authorization).toBe(`Bearer ${RAW_KEY}`);
  });

  it("drops a guest-set auth header and injects the real credential instead", async () => {
    // The gate is re-run against the same module with one change: the guest tries to set its
    // own Authorization (and one harmless custom header, which must survive).
    const base = harness.http.audit.length;

    const reviewed = await reviewCodeCandidate(overrideManifest(), {
      http: harness.http,
      secretRef: exoticKey,
      baseUrl: EXOTIC_BASE,
    });
    expect(reviewed.freePasses).toBeGreaterThan(0); // it still passes — the host fixed the auth

    // The bogus credential never reached the wire; the real one did.
    const seen = await seenOnWire();
    expect(seen.headers.authorization).toBe(`Bearer ${RAW_KEY}`);
    expect(JSON.stringify(seen.headers)).not.toContain("attacker-token");

    // The new requests are sentinel-disciplined too, and the custom header was kept.
    for (const a of harness.http.audit.slice(base)) {
      expect(a.headers.Authorization).toBe("Bearer {{secret}}");
      expect(JSON.stringify(a)).not.toContain("attacker-token");
    }
    expect(harness.http.audit.some((a) => a.headers["x-custom"] === "kept")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Approval: the human says yes, the manifest registers, and a real request streams through
// the sandboxed adapter — the same bytes the human reviewed.
// ---------------------------------------------------------------------------
describe("serving through the approved code adapter", () => {
  it("registers, catalogs and streams a real request through the sandbox", async () => {
    const candidate = lastApprovedCandidate();
    expect(candidate).toBeDefined();

    const version = harness.actions.stageManifest(exoticId, candidate!.manifest!, {
      origin: "ai-generated",
      contract: candidate!.contract,
    });
    expect(version).toBe(1);
    expect(harness.actions.activateManifest(exoticId, version)).toBeNull(); // first activation

    harness.actions.setProviderStatus(exoticId, "enabled");
    expect(await harness.actions.refreshCatalog(exoticId)).toBe(2); // nd-lite, nd-pro

    // The router plans over the code adapter's catalog entries; the stream is reassembled
    // from the guest's plain-text emits.
    const exec = await harness.router.generateText({
      model: "ndcode/nd-lite",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(await collect(exec.chunks)).toBe("Hellofromnd-lite");
    expect(exec.served()?.provider.slug).toBe("ndcode");

    // The request was attributed to the provider (spec req. 11, criterion 10).
    expect(harness.ledger.query({ providerId: exoticId, source: "ui" })).toHaveLength(1);
  });
});
