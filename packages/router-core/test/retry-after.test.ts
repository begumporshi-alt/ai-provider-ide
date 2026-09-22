/**
 * retry-after (2026-09-22): the router must honour the backoff a provider asks for.
 *
 * Observed live through the gateway: a provider 429'd a client repeatedly while the router cooled
 * its keys for a flat 1 second and answered the client with `Retry-After: 1`. The provider's own
 * header was discarded at two points — `ManifestHttpError` kept only status and body, and
 * `AttemptOutcome.retryAfterMs` was never assigned — so `HealthTracker` fell through to its 1000ms
 * floor. Every retry therefore went straight back into a window the provider had asked us to wait
 * out, which is why a client saw seven consecutive 429s in thirteen seconds.
 *
 * `execution-engine.ts` already claims "backoff honoring Retry-After" in its header comment.
 * These tests pin the two halves that claim needs: parse it, and use it.
 */
import { describe, expect, it } from "vitest";
import { AllAttemptsFailedError, ExecutionEngine } from "../src/execution-engine.js";
import { HealthTracker } from "../src/health-tracker.js";
import { ManifestInterpreter } from "../src/manifest-interpreter.js";
import { PROVIDER_PROFILES } from "../src/builtin-templates.js";
import type { AdapterInstance } from "../src/adapter-instance.js";
import type { HttpPort } from "../src/ports.js";
import type { Candidate } from "../src/route-planner.js";
import type { ProviderRecord, ApiKeyRecord, CatalogModel } from "../src/domain.js";

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

/** Answers 429 with a `retry-after` header, which is what a rate-limited provider actually sends. */
class RateLimitedHttp implements HttpPort {
  constructor(private readonly retryAfterHeader: string) {}

  async request() {
    return {
      status: 429,
      headers: { "retry-after": this.retryAfterHeader },
      text: async () => JSON.stringify({ error: { message: "rate limited" } }),
      lines: (async function* () { /* no SSE on error */ })(),
    };
  }
}

function makeFactory(retryAfterHeader: string) {
  const adapters = new Map<string, AdapterInstance>();
  return {
    forProvider: async (pid: string) => {
      let a = adapters.get(pid);
      if (!a) {
        const baseUrl = `https://${pid}.test/v1`;
        const http = new RateLimitedHttp(retryAfterHeader);
        const manifest = { ...PROVIDER_PROFILES.openrouter!(), provider: { ...PROVIDER_PROFILES.openrouter!().provider, baseUrl } };
        a = new ManifestInterpreter(manifest, { http, vars: { appUrl: "https://x.test" } });
        adapters.set(pid, a);
      }
      return { adapter: a, baseUrl: `https://${pid}.test/v1` };
    },
  };
}

const ARGS = { messages: [{ role: "user", content: "hi" }] as unknown[], model: "m1", stream: false };

/** Drain the stream so the engine actually runs; a failed plan throws here. */
async function drain(chunks: AsyncIterable<string>) {
  try {
    for await (const _ of chunks) void _;
    return false;
  } catch {
    return true;
  }
}

describe("retry-after", () => {
  it("cools a rate-limited key for as long as the provider asked", async () => {
    const t0 = Date.now();
    const health = new HealthTracker();
    const engine = new ExecutionEngine(makeFactory("60"), health);

    const r = await engine.executeText({ ...ARGS, plan: [candidate("p1", "k1")] });
    expect(await drain(r.chunks)).toBe(true);
    expect(r.fallbackChain()[0]?.cls).toBe("RATE_LIMITED");

    // The provider said 60 seconds. A key that is eligible again after one second will be
    // retried straight back into the window it was told to wait out.
    expect(health.isKeyUsable(key("p1", "k1"), t0 + 30_000)).toBe(false);
    expect(health.isKeyUsable(key("p1", "k1"), t0 + 61_000)).toBe(true);
  });

  it("reads an HTTP-date retry-after, not just a delay in seconds", async () => {
    const t0 = Date.now();
    const health = new HealthTracker();
    const at = new Date(t0 + 45_000).toUTCString();
    const engine = new ExecutionEngine(makeFactory(at), health);

    const r = await engine.executeText({ ...ARGS, plan: [candidate("p1", "k1")] });
    expect(await drain(r.chunks)).toBe(true);

    expect(health.isKeyUsable(key("p1", "k1"), t0 + 20_000)).toBe(false);
    expect(health.isKeyUsable(key("p1", "k1"), t0 + 46_000)).toBe(true);
  });

  it("falls back to the one-second floor when no header is sent", async () => {
    const t0 = Date.now();
    const health = new HealthTracker();
    const engine = new ExecutionEngine(makeFactory(""), health);

    const r = await engine.executeText({ ...ARGS, plan: [candidate("p1", "k1")] });
    expect(await drain(r.chunks)).toBe(true);

    // Unchanged behaviour: an absent header must not cool a key longer than the floor.
    expect(health.isKeyUsable(key("p1", "k1"), t0 + 1_500)).toBe(true);
  });

  it("carries the provider's cooldown onto the thrown error, for the bridge to read", async () => {
    // Stage 2: the cooldown has to survive the plan failure and reach the client. The bridge
    // reads it off this error to decide the `Retry-After` it sends; without it the client gets
    // the middleware's 1s floor and retries straight back into the provider's window.
    const health = new HealthTracker();
    const engine = new ExecutionEngine(makeFactory("60"), health);
    const r = await engine.executeText({ ...ARGS, plan: [candidate("p1", "k1")] });

    let thrown: unknown;
    try {
      for await (const _ of r.chunks) void _;
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AllAttemptsFailedError);
    expect((thrown as AllAttemptsFailedError).maxRetryAfterMs()).toBe(60_000);
  });

  it("takes the longest cooldown across attempts, and zero when none was named", () => {
    // The max, not the last attempt's value: the client should wait out the window the provider
    // actually named. The longest is deliberately FIRST, so a `reduce` that keeps the last value
    // cannot pass. Zero means "no hint" — the bridge then omits the field entirely.
    expect(
      new AllAttemptsFailedError("m1", [
        { candidate: candidate("p1", "k1"), cls: "RATE_LIMITED", status: 429, retryAfterMs: 45_000 },
        { candidate: candidate("p1", "k2"), cls: "RATE_LIMITED", status: 429, retryAfterMs: 12_000 },
      ]).maxRetryAfterMs(),
    ).toBe(45_000);
    expect(
      new AllAttemptsFailedError("m1", [
        { candidate: candidate("p1", "k1"), cls: "RATE_LIMITED", status: 429 },
        { candidate: candidate("p1", "k2"), cls: "RATE_LIMITED", status: 429 },
      ]).maxRetryAfterMs(),
    ).toBe(0);
  });
});
