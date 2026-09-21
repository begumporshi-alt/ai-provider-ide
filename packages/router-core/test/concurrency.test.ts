/**
 * concurrency (audit R3): per-provider in-flight caps.
 *
 * The failure mode being guarded: the gateway admits requests through ONE global semaphore, so a
 * single slow provider can occupy every slot and starve all the others — which defeats failover.
 * These tests pin the two behaviours that matter:
 *   1. a saturated provider is SKIPPED (not waited on), so another provider serves, and
 *   2. slots are released on every exit path, so capacity can never leak.
 *
 * Adapters are real `ManifestInterpreter`s over a gated HttpPort, so "in flight" is produced by
 * suspending the actual HTTP call rather than by timing or sleeps.
 */
import { describe, expect, it } from "vitest";
import { ExecutionEngine, AllAttemptsFailedError } from "../src/execution-engine.js";
import { ProviderLimiter, PER_PROVIDER_DEFAULT, MAX_PER_PROVIDER, clampConcurrency } from "../src/concurrency.js";
import { ModelRouter } from "../src/model-router.js";
import { HealthTracker } from "../src/health-tracker.js";
import { ManifestInterpreter } from "../src/manifest-interpreter.js";
import { PROVIDER_PROFILES } from "../src/builtin-templates.js";
import type { AdapterInstance } from "../src/adapter-instance.js";
import type { HttpPort } from "../src/ports.js";
import type { Candidate } from "../src/route-planner.js";
import type { ProviderRecord, ApiKeyRecord, CatalogModel } from "../src/domain.js";

// ---------- helpers ----------

function provider(id: string, slug = id): ProviderRecord {
  return {
    id, slug, name: slug, type: "builtin",
    baseUrl: `https://${slug}.test/v1`, status: "enabled",
    rotationStrategy: "round_robin", createdAt: 1, updatedAt: 1,
  };
}

function key(providerId: string, label: string): ApiKeyRecord {
  return {
    id: `${providerId}:${label}`, providerId, label, secretRef: `key:${providerId}:${label}`,
    status: "active", priority: 0, cooldownUntil: null, addedAt: 1, lastUsedAt: null, lastTestedAt: null,
  };
}

function model(providerId: string, nativeId = "m1"): CatalogModel {
  return { providerId, nativeId, modality: "text", fetchedAt: 1 };
}

function candidate(providerId: string, label = "k1"): Candidate {
  return { provider: provider(providerId), key: key(providerId, label), model: model(providerId) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Let pending microtasks/awaits run, so an in-flight request reaches its HTTP call. */
const tick = () => new Promise((r) => setTimeout(r, 0));

interface GateSpec {
  /** host -> gate to await before responding (undefined = respond immediately) */
  gate?: (url: string) => Promise<void> | undefined;
  /** host -> forced HTTP status (undefined = 200) */
  status?: (url: string) => number | undefined;
}

/** HttpPort that can suspend a call indefinitely — that is what makes a request "in flight". */
class GatedHttp implements HttpPort {
  calls: string[] = [];

  constructor(private readonly spec: GateSpec) {}

  async request(req: Parameters<HttpPort["request"]>[0]) {
    this.calls.push(req.url);
    const gate = this.spec.gate?.(req.url);
    if (gate) await gate;
    const status = this.spec.status?.(req.url) ?? 200;
    if (status >= 400) {
      return {
        status, headers: {},
        text: async () => JSON.stringify({ error: { message: "gated failure" } }),
        lines: (async function* () { /* no SSE on error */ })(),
      };
    }
    return {
      status: 200, headers: {},
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      lines: (async function* () { /* unary path */ })(),
    };
  }
}

/** AdapterFactory: one real ManifestInterpreter per provider, each with its own gated HttpPort. */
function makeFactory(spec: GateSpec) {
  const adapters = new Map<string, AdapterInstance>();
  const httpPorts = new Map<string, GatedHttp>();
  return {
    httpFor: (pid: string) => httpPorts.get(pid)!,
    forProvider: async (pid: string) => {
      let a = adapters.get(pid);
      if (!a) {
        const baseUrl = `https://${pid}.test/v1`;
        const http = new GatedHttp(spec);
        httpPorts.set(pid, http);
        const manifest = { ...PROVIDER_PROFILES.openrouter!(), provider: { ...PROVIDER_PROFILES.openrouter!().provider, baseUrl } };
        a = new ManifestInterpreter(manifest, { http, vars: { appUrl: "https://x.test" } });
        adapters.set(pid, a);
      }
      return { adapter: a, baseUrl: `https://${pid}.test/v1` };
    },
  };
}

const PLAN_SLOW_FIRST = [candidate("slow"), candidate("slow"), candidate("healthy")];
const ARGS = { messages: [{ role: "user", content: "hi" }] as unknown[], model: "m1", stream: false };

// ---------- ProviderLimiter unit behaviour ----------

describe("ProviderLimiter", () => {
  it("admits up to the cap and refuses beyond it", () => {
    const lim = new ProviderLimiter(2);
    expect(lim.acquire("p1")).not.toBeNull();
    expect(lim.acquire("p1")).not.toBeNull();
    expect(lim.acquire("p1")).toBeNull(); // saturated
    expect(lim.inFlightCount("p1")).toBe(2);
  });

  it("tracks providers independently", () => {
    const lim = new ProviderLimiter(1);
    expect(lim.acquire("p1")).not.toBeNull();
    expect(lim.acquire("p1")).toBeNull();
    expect(lim.acquire("p2")).not.toBeNull(); // different provider, own budget
  });

  it("release is idempotent — a double release cannot leak capacity", () => {
    const lim = new ProviderLimiter(1);
    const rel = lim.acquire("p1")!;
    rel();
    rel();
    rel();
    expect(lim.inFlightCount("p1")).toBe(0);
    expect(lim.acquire("p1")).not.toBeNull(); // still admits after over-release
  });

  it("treats a non-positive cap as unlimited", () => {
    const lim = new ProviderLimiter(0);
    for (let i = 0; i < 50; i++) expect(lim.acquire("p1")).not.toBeNull();
  });

  it("defaults to PER_PROVIDER_DEFAULT", () => {
    expect(new ProviderLimiter().maxPerProvider).toBe(PER_PROVIDER_DEFAULT);
  });
});

// ---------- engine integration ----------

describe("ExecutionEngine — per-provider cap (R3)", () => {
  it("skips a saturated provider and fails over to one with capacity", async () => {
    const hold = deferred();
    const f = makeFactory({
      gate: (url) => (url.includes("slow.test") ? hold.promise : undefined),
    });
    const limiter = new ProviderLimiter(1);
    const engine = new ExecutionEngine(f, new HealthTracker(), limiter);

    // Request 1: starts against 'slow' and suspends inside its HTTP call, holding the slot.
    const first = await engine.executeText({ ...ARGS, plan: PLAN_SLOW_FIRST });
    const it1 = first.chunks[Symbol.asyncIterator]();
    const p1 = it1.next();
    await tick();
    expect(f.httpFor("slow").calls.length).toBe(1); // attempt really is in flight

    // Request 2: 'slow' is saturated, so both its candidates are skipped and 'healthy' serves.
    const second = await engine.executeText({ ...ARGS, plan: PLAN_SLOW_FIRST });
    let out = "";
    for await (const c of second.chunks) out += c;
    expect(out).toBe("ok");
    expect(second.served()?.provider.id).toBe("healthy");

    const skipped = second.fallbackChain().filter((a) => a.candidate.provider.id === "slow");
    expect(skipped).toHaveLength(2);
    expect(skipped.every((s) => s.cls === "RATE_LIMITED")).toBe(true);
    // The saturated provider was never re-entered.
    expect(f.httpFor("slow").calls.length).toBe(1);

    hold.resolve();
    await p1;
  });

  it("releases the slot when an attempt fails, so capacity is never leaked", async () => {
    const f = makeFactory({ status: (url) => (url.includes("p1.test") ? 500 : undefined) });
    const limiter = new ProviderLimiter(1);
    const engine = new ExecutionEngine(f, new HealthTracker(), limiter);
    const plan = [candidate("p1")];

    const first = await engine.executeText({ ...ARGS, plan });
    let failed = false;
    try {
      for await (const _ of first.chunks) void _;
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    // The failed attempt must have released its slot, or the cap would leak.
    expect(limiter.inFlightCount("p1")).toBe(0);

    // A leaked cap would make this next request skip its only candidate and fail.
    const f2 = makeFactory({});
    const engine2 = new ExecutionEngine(f2, new HealthTracker(), limiter);
    const second = await engine2.executeText({ ...ARGS, plan });
    let out = "";
    for await (const c of second.chunks) out += c;
    expect(out).toBe("ok");
  });

  it("without a limiter, behaviour is unchanged (legacy path)", async () => {
    const f = makeFactory({});
    const engine = new ExecutionEngine(f, new HealthTracker()); // no limiter
    const plan = [candidate("p1"), candidate("p1")];
    const exec = await engine.executeText({ ...ARGS, plan });
    let out = "";
    for await (const c of exec.chunks) out += c;
    expect(out).toBe("ok");
    expect(exec.fallbackChain()).toHaveLength(0); // first candidate served, nothing skipped
  });

  it("image path honours the same cap", async () => {
    const hold = deferred();
    const f = makeFactory({ gate: (url) => (url.includes("p1.test") ? hold.promise : undefined) });
    const limiter = new ProviderLimiter(1);
    const engine = new ExecutionEngine(f, new HealthTracker(), limiter);
    const plan = [candidate("p1")];

    // Occupy p1's single slot via the text path.
    const held = await engine.executeText({ ...ARGS, plan });
    const it = held.chunks[Symbol.asyncIterator]();
    const p = it.next();
    await tick();

    // The image attempt on the same provider must be skipped -> no candidates left.
    await expect(
      engine.executeImage({ plan, prompt: "x", model: "m1" }),
    ).rejects.toBeInstanceOf(AllAttemptsFailedError);

    hold.resolve();
    await p;
  });
});

describe("clampConcurrency", () => {
  // The cap is a *bound*, so the dangerous values are the ones that look like a bound and are
  // not — not the ones a type checker would reject.

  it("leaves a sane value alone", () => {
    for (const n of [0, 1, 4, 32, MAX_PER_PROVIDER]) {
      expect(clampConcurrency(n)).toBe(n);
    }
  });

  it("keeps zero — it means unlimited, by design", () => {
    // `hasCapacity` tests `maxPerProvider <= 0`, so 0 is a real setting, not a missing one.
    // Flooring it to 1 would silently turn "no cap" into "one request at a time".
    expect(clampConcurrency(0)).toBe(0);
    expect(clampConcurrency("0")).toBe(0);
  });

  it("rejects a negative number rather than letting it mean unlimited", () => {
    // This is the one that bites: -1 passes `maxPerProvider <= 0` and therefore behaves as
    // unlimited while displaying as a bound. Removing the cap must take a deliberate 0 —
    // a stored negative is corruption, and corruption must yield a real cap, not no cap.
    expect(clampConcurrency(-1)).toBe(PER_PROVIDER_DEFAULT);
    expect(clampConcurrency(-12)).toBe(PER_PROVIDER_DEFAULT);
  });

  it("caps a value that would only delay the failure", () => {
    expect(clampConcurrency(5000)).toBe(MAX_PER_PROVIDER);
  });

  it("falls back to the default for input that is not a number at all", () => {
    // `Number(null)` is 0, which would silently become "unlimited" — a missing setting must
    // not read as a deliberate removal of the cap. `""` has exactly the same shape, and it is what
    // a text field produces when the user clears it, so it is the one that reaches a real user:
    // hence the explicit `value.trim() !== ""` guard in `clampConcurrency`. Whitespace-only is the
    // same input as far as a person is concerned.
    for (const v of [NaN, Infinity, undefined, null, "four", "", " ", "   ", {}, [], true]) {
      expect(clampConcurrency(v)).toBe(PER_PROVIDER_DEFAULT);
    }
  });

  it("accepts a numeric string, because that is what a text field produces", () => {
    expect(clampConcurrency("8")).toBe(8);
  });
});

describe("syncConcurrency", () => {
  // `router.settings` is hydrated with `Object.assign(router.settings, JSON.parse(raw))` — no
  // validation — so whatever the stored blob holds is what reaches the limiter.
  const makeRouter = (): ModelRouter =>
    new ModelRouter(
      { listProviders: () => [] } as never,
      { forProvider: () => undefined } as never,
      { forModality: () => [] } as never,
      { append: () => undefined } as never,
    );

  it("clamps a stored value rather than trusting it", () => {
    const r = makeRouter();
    r.settings.perProviderConcurrency = -1;
    r.syncConcurrency();
    // -1 would otherwise read as unlimited (maxPerProvider <= 0) — the cap silently gone while
    // the screen showed a number. Now it degrades to the default, which is still a cap.
    expect(r.limiter.maxPerProvider).toBe(PER_PROVIDER_DEFAULT);
    expect(r.limiter.hasCapacity("p1")).toBe(true);
    // ...and it really is a bound, not unlimited: the 5th concurrent attempt must be refused.
    for (let i = 0; i < PER_PROVIDER_DEFAULT; i++) expect(r.limiter.acquire("p1")).not.toBeNull();
    expect(r.limiter.acquire("p1")).toBeNull();
  });

  it("applies a good stored value to the live limiter", () => {
    const r = makeRouter();
    r.settings.perProviderConcurrency = 2;
    r.syncConcurrency();
    expect(r.limiter.maxPerProvider).toBe(2);
    expect(r.limiter.acquire("p1")).not.toBeNull();
    expect(r.limiter.acquire("p1")).not.toBeNull();
    expect(r.limiter.acquire("p1")).toBeNull(); // third is refused
  });
});
