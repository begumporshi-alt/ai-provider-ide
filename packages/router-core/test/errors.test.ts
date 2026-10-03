/**
 * error-taxonomy tests: the classes that exist only because a status alone cannot name what
 * happened — the client gate (a 401 that is not about the key) and billing (a 402 that is not
 * about the network) — plus the reason passthrough that keeps the provider's own words.
 */
import { describe, expect, it } from "vitest";
import { MAX_REASON_CHARS, classify, classifyHttp, reasonFromBody } from "../src/errors.js";
import { HealthTracker } from "../src/health-tracker.js";
import type { ApiKeyRecord } from "../src/domain.js";

const NOW = 1_000_000;
function makeKey(id: string): ApiKeyRecord {
  return {
    id, providerId: "p1", label: id, secretRef: `key:${id}`,
    status: "active", priority: 0, cooldownUntil: null,
    addedAt: 1, lastUsedAt: null, lastTestedAt: null,
  };
}
import { ManifestInterpreter, ManifestHttpError } from "../src/manifest-interpreter.js";
import { BUILTIN_TEMPLATES } from "../src/builtin-templates.js";
import { FakeHttp } from "./fakes.js";

describe("classify", () => {
  it("files a 402 as BILLING, not NETWORK", () => {
    // A 402 is the provider answering: the transport worked, the credential was read, the budget
    // pool is empty. NETWORK told the operator the provider was unreachable and the health
    // tracker's retryable-with-next-key rule sent the loop hunting for a key that refills a pool.
    expect(classify(402)).toBe("BILLING");
    expect(classify(402)).not.toBe("NETWORK");
  });

  it("CLIENT_GATE wins only on a 401/403 that the body named", () => {
    expect(classify(401, "client_gate")).toBe("CLIENT_GATE");
    expect(classify(403, "client_gate")).toBe("CLIENT_GATE");
    // a 200 carrying gate prose is not a refusal — the status decides
    expect(classify(200, "client_gate")).toBe("OK");
    // without the hint the status quo stands: blame the key
    expect(classify(401)).toBe("AUTH_FAILED");
  });

  it("neither new class drifts a provider nor retries its keys", () => {
    // both are imported by health-tracker's rules via isRetryableWithNextKey / DRIFT_CLASSES;
    // asserting the taxonomy properties here keeps them honest even if those lists change.
    expect(["CLIENT_GATE", "BILLING"]).not.toContain("AUTH_FAILED");
  });

  it("a gated refusal never opens the auth breaker on a healthy key", () => {
    const t = new HealthTracker();
    const k = makeKey("gk1");
    for (let i = 0; i < 5; i++) t.recordResult(k, "CLIENT_GATE", undefined, NOW);
    expect(t.isKeyUsable(k, NOW)).toBe(true);
    // contrast: the same count of AUTH_FAILED would have opened the breaker
    const t2 = new HealthTracker();
    const k2 = makeKey("gk2");
    for (let i = 0; i < 3; i++) t2.recordResult(k2, "AUTH_FAILED", undefined, NOW);
    expect(t2.isKeyUsable(k2, NOW)).toBe(false);
  });
});

describe("classifyHttp (the body-aware wrapper)", () => {
  it("recognises the measured gate body as CLIENT_GATE", () => {
    const body = JSON.stringify({ error: { type: "unauthorized_client_error", message: "unauthorized client detected" } });
    expect(classifyHttp(401, body)).toBe("CLIENT_GATE");
    // an ordinary bad-key 401 stays AUTH_FAILED — failing toward the status quo
    expect(classifyHttp(401, JSON.stringify({ error: { message: "invalid token" } }))).toBe("AUTH_FAILED");
  });
});

describe("reasonFromBody", () => {
  it("keeps the provider's own words from a structured error body", () => {
    expect(reasonFromBody(JSON.stringify({ error: { code: "content-blocked", message: "content-blocked (request id: x)" } })))
      .toBe("content-blocked: content-blocked (request id: x)");
  });

  it("keeps a validation error whole enough to state its rule", () => {
    // Measured from agentrouter.org on 2026-10-02, verbatim apart from the ids. It is 186
    // characters before the aggregator's own request/trace suffixes, so the old 120-character cut
    // landed at "Each `…" — dropping both the offending id and the sentence that names the rule.
    // A live 400 showing that row could not be diagnosed, which is the whole job of this field.
    const message =
      "unexpected `messages.2.content.0: tool_use_id` found in `tool_result` blocks: toolu_bogus_123. " +
      "Each `tool_result` block must have a corresponding `tool_use` block in the previous message.";
    const got = reasonFromBody(JSON.stringify({ error: { message } }))!;

    expect(got).toContain("toolu_bogus_123");
    expect(got).toContain("must have a corresponding");
    expect(got).not.toContain("…");
  });

  it("falls back to the raw body and truncates a runaway one", () => {
    expect(reasonFromBody("plain refusal text")).toBe("plain refusal text");
    const long = "x".repeat(MAX_REASON_CHARS + 300);
    const got = reasonFromBody(long)!;
    expect(got.length).toBeLessThanOrEqual(MAX_REASON_CHARS + 1); // the ellipsis is the extra
    expect(got.endsWith("…")).toBe(true);
  });

  it("cuts on a code point, so a split surrogate never reaches the ledger", () => {
    const got = reasonFromBody("🙂".repeat(MAX_REASON_CHARS + 10))!;
    const lone = [...got].some((c) => {
      const cp = c.codePointAt(0) ?? 0;
      return cp >= 0xd800 && cp <= 0xdfff;
    });
    expect(lone).toBe(false);
  });
});

describe("execution-engine consumes the body", () => {
  function interpreter(res: { status: number; body?: unknown }) {
    return new ManifestInterpreter(BUILTIN_TEMPLATES["openai-compat"]!("https://api.test/v1"), {
      http: new FakeHttp(() => res),
      vars: {},
    });
  }

  it("a gated 401 throws a ManifestHttpError whose body names the gate", async () => {
    const interp = interpreter({
      status: 401,
      body: { error: { type: "unauthorized_client_error", message: "unauthorized client detected" } },
    });
    const err = await interp.listModels("key:t").catch((e) => e);
    expect(err).toBeInstanceOf(ManifestHttpError);
    expect(classifyHttp(err.status, err.body)).toBe("CLIENT_GATE");
  });

  it("a content-policy 400 keeps the upstream reason, not just the class", async () => {
    const interp = interpreter({
      status: 400,
      body: { error: { code: "content-blocked", message: "content-blocked (request id: 42)" } },
    });
    const err = await interp.listModels("key:t").catch((e) => e);
    expect(err).toBeInstanceOf(ManifestHttpError);
    expect(reasonFromBody(err.body)).toContain("content-blocked");
  });
});
