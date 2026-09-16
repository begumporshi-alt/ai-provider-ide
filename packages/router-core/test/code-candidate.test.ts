/**
 * Tier-2 review-gate tests (ARCHITECTURE.md §2.7): a code adapter is EXECUTABLE AI output, so
 * it must clear schema → static lint → sandbox compile → free contract checks before a human
 * ever sees it as approvable. These pin each gate and the security invariants behind gate 4:
 * the untrusted code really runs, and really cannot reach anywhere but the provider's host.
 */
import { describe, expect, it } from "vitest";
import type { AdapterManifest } from "@aiprovider/adapter-spec";
import {
  generateCodeCandidate,
  lintCodeManifest,
  reviewCodeCandidate,
} from "../src/code-candidate.js";
import type { ProbeReport } from "../src/probe-runner.js";
import { FakeHttp, type Responder } from "./fakes.js";

const BASE = "https://provider.test/v1";
const SECRET_REF = "key-01#1";

const RESPOND: Responder = (url) => {
  if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "text-1" }] } };
  if (url.endsWith("/chat")) return { status: 200, body: { chunks: ["Al", "pha"] } };
  return undefined;
};

/** A cooperative guest implementing the full adapter contract. */
const GOOD_GUEST = `
export default {
  async listModels(http) {
    const r = await http({ path: "/models" });
    return JSON.parse(r.text).data.map((m) => m.id);
  },
  async generateText(http, emit, argsJson) {
    const args = JSON.parse(argsJson);
    const r = await http({ path: "/chat", method: "POST", body: args });
    for (const c of JSON.parse(r.text).chunks) emit(c);
  },
  async generateImage(http, argsJson) {
    const r = await http({ path: "/images", method: "POST", body: JSON.parse(argsJson) });
    return { ok: true, status: 200, base64: "QUJD" };
  },
};
`;

function codeManifest(source: string, baseUrl = BASE): AdapterManifest {
  return {
    manifestVersion: 1,
    kind: "code",
    dialect: "test-code-v1",
    provider: {
      baseUrl,
      auth: { headers: [{ name: "Authorization", prefix: "Bearer" }] },
    },
    endpoints: {},
    code: { source, entry: "adapter" },
    capabilities: { text: true, image: false },
    provenance: { origin: "ai-generated", generatorModel: "test-model", createdAt: "2026-09-16T00:00:00Z" },
  };
}

async function review(source: string, responder: Responder = RESPOND, baseUrl = BASE) {
  const http = new FakeHttp(responder);
  const logs: string[] = [];
  const candidate = await reviewCodeCandidate(codeManifest(source, baseUrl), {
    http,
    secretRef: SECRET_REF,
    baseUrl,
    onLog: (l) => logs.push(l),
  });
  return { http, logs, candidate };
}

describe("lintCodeManifest (gate 2: static tripwires)", () => {
  it("accepts a clean code manifest", () => {
    expect(lintCodeManifest(codeManifest(GOOD_GUEST), BASE)).toEqual([]);
  });
  it("rejects a baseUrl that is not the user-entered one (invariant 4)", () => {
    const errs = lintCodeManifest(codeManifest(GOOD_GUEST, "https://evil.test/v1"), BASE);
    expect(errs.join("; ")).toMatch(/differs from the user-entered URL/);
  });
  it("rejects a forbidden construct before QuickJS ever sees it", () => {
    const errs = lintCodeManifest(codeManifest(`export default { async listModels() { return fetch("https://x"); } };`), BASE);
    expect(errs.join("; ")).toMatch(/forbidden construct/);
  });
  it("rejects a code adapter declaring no capability at all", () => {
    const m = codeManifest(GOOD_GUEST);
    m.capabilities = { text: false, image: false };
    expect(lintCodeManifest(m, BASE).join("; ")).toMatch(/neither text nor image/);
  });
});

describe("reviewCodeCandidate — the happy path", () => {
  it("passes all four gates and reports the free checks", async () => {
    const { candidate, http, logs } = await review(GOOD_GUEST);
    expect(candidate.schemaErrors).toHaveLength(0);
    expect(candidate.lintErrors).toHaveLength(0);
    expect(candidate.code?.compiled).toBe(true);
    expect(candidate.manifest?.kind).toBe("code");
    expect(candidate.freePasses).toBeGreaterThan(0);
    expect(candidate.contract?.freePassed).toBe(true);

    // The guest really executed: it issued a real egress request for the model list.
    expect(http.calls.map((c) => c.url)).toContain(`${BASE}/models`);
    // The credential rode host-side as the sentinel — never a raw key, and the guest's own
    // header writes cannot override the auth slot.
    const modelsCall = http.calls.find((c) => c.url.endsWith("/models"))!;
    expect(modelsCall.secretRef).toBe(SECRET_REF);
    expect(modelsCall.headers.Authorization).toBe("Bearer {{secret}}");
    expect(logs.length).toBeGreaterThanOrEqual(0);
  });
});

describe("reviewCodeCandidate — each gate rejects on its own terms", () => {
  it("gate 2: a forbidden construct never compiles", async () => {
    const { candidate, http } = await review(`export default { async listModels() { return fetch("/models"); } };`);
    expect(candidate.lintErrors.join("; ")).toMatch(/forbidden construct/);
    expect(candidate.code).toBeUndefined(); // never reached compile
    expect(candidate.manifest).toBeUndefined();
    expect(http.calls).toHaveLength(0); // and never touched the network
  });

  it("gate 3: a syntactically broken module fails compile, not contract", async () => {
    const { candidate, http } = await review(`export default { async listModels(http) { )(); } };`);
    expect(candidate.code?.compiled).toBe(false);
    expect(candidate.code?.compileError).toMatch(/compile/);
    expect(candidate.freePasses).toBe(0);
    expect(candidate.contract).toBeUndefined();
    // The source is kept read-only for the human, but it is not approvable.
    expect(candidate.manifest?.code?.source).toMatch(/async listModels/);
    expect(http.calls).toHaveLength(0);
  });

  it("gate 4: a guest that cannot list models is unusable", async () => {
    const guest = `export default { async listModels(http) { const r = await http({ path: "/empty" }); return []; } };`;
    const { candidate } = await review(guest, (url) =>
      url.endsWith("/empty") ? { status: 200, body: { data: [] } } : undefined,
    );
    expect(candidate.code?.compiled).toBe(true);
    expect(candidate.freePasses).toBe(0);
    expect(candidate.contract?.freePassed).toBe(false);
  });

  it("gate 4: a guest that throws is unusable and its error is surfaced", async () => {
    const guest = `export default { async listModels() { throw new Error("nope"); } };`;
    const { candidate } = await review(guest);
    expect(candidate.freePasses).toBe(0);
    // The contract suite catches the guest error and records it in the check detail — that
    // is what the review panel shows the human.
    const detail = candidate.contract?.checks.map((c) => c.detail ?? "").join(" ");
    expect(detail ?? "").toMatch(/nope/);
  });

  it("gate 4: an absolute-path guest cannot escape the provider host", async () => {
    const guest = `export default { async listModels(http) {
      const r = await http({ path: "https://evil.test/v1/models" });
      return JSON.parse(r.text).data.map((m) => m.id);
    } };`;
    const { candidate, http } = await review(guest);
    expect(candidate.freePasses).toBe(0);
    // Nothing was ever requested: the sandbox rejected the non-relative path host-side.
    expect(http.calls.map((c) => c.url)).not.toContain("https://evil.test/v1/models");
  });

  it("gate 4: a guest setting an auth header cannot override the credential", async () => {
    const guest = `export default { async listModels(http) {
      const r = await http({ path: "/models", headers: { authorization: "Bearer attacker-token" } });
      return JSON.parse(r.text).data.map((m) => m.id);
    } };`;
    const { candidate, http } = await review(guest);
    expect(candidate.freePasses).toBeGreaterThan(0);
    const call = http.calls.find((c) => c.url.endsWith("/models"))!;
    expect(call.headers.Authorization).toBe("Bearer {{secret}}"); // host value wins
    expect(Object.values(call.headers).join(" ")).not.toContain("attacker-token");
  });
});

describe("generateCodeCandidate — the model output is envelope-shaped, manifest is host-assembled", () => {
  const report: ProbeReport = {
    baseUrl: BASE,
    ts: Date.now(),
    attempts: [{ method: "GET", path: "/models", status: 200, contentType: "application/json", bodyShape: { data: [{ id: "string" }] }, ms: 12 }],
  };

  it("wraps the model's envelope and gates it (good guest)", async () => {
    const http = new FakeHttp(RESPOND);
    const envelope = {
      dialect: "exotic-v1",
      authHeader: { name: "x-api-key" },
      capabilities: { text: true, image: false },
      source: GOOD_GUEST,
    };
    const candidate = await generateCodeCandidate({
      ai: { complete: async () => JSON.stringify(envelope) },
      systemLabel: "sys/model (system)",
      report,
      baseUrl: BASE,
      secretRef: SECRET_REF,
      excludeProviderIds: ["p1"],
      http,
    });
    expect(candidate.manifest?.kind).toBe("code");
    expect(candidate.manifest?.provider.auth.headers[0]?.name).toBe("x-api-key");
    expect(candidate.manifest?.provider.baseUrl).toBe(BASE); // pinned, not the model's
    expect(candidate.manifest?.provenance.origin).toBe("ai-generated");
    expect(candidate.freePasses).toBeGreaterThan(0);
  });

  it("rejects unparseable model output before any network I/O", async () => {
    const http = new FakeHttp(RESPOND);
    const candidate = await generateCodeCandidate({
      ai: { complete: async () => "sorry, here is some prose instead" },
      systemLabel: "sys/model (system)",
      report,
      baseUrl: BASE,
      secretRef: SECRET_REF,
      excludeProviderIds: ["p1"],
      http,
    });
    expect(candidate.schemaErrors.join("; ")).toMatch(/no parseable JSON/);
    expect(candidate.manifest).toBeUndefined();
    expect(http.calls).toHaveLength(0);
  });

  it("rejects a model envelope whose source fails the gate", async () => {
    const candidate = await generateCodeCandidate({
      ai: { complete: async () => JSON.stringify({ dialect: "x", authHeader: { name: "Authorization" }, source: "export default { f: fetch('x') };" }) },
      systemLabel: "sys/model (system)",
      report,
      baseUrl: BASE,
      secretRef: SECRET_REF,
      excludeProviderIds: ["p1"],
      http: new FakeHttp(RESPOND),
    });
    expect(candidate.lintErrors.join("; ")).toMatch(/forbidden construct/);
    expect(candidate.freePasses).toBe(0);
  });

  it("survives an AI call failure", async () => {
    const candidate = await generateCodeCandidate({
      ai: { complete: async () => { throw new Error("model is down"); } },
      systemLabel: "sys/model (system)",
      report,
      baseUrl: BASE,
      secretRef: SECRET_REF,
      excludeProviderIds: ["p1"],
      http: new FakeHttp(RESPOND),
    });
    expect(candidate.rejectedReason ?? "").toMatch(/model is down/);
    expect(candidate.manifest).toBeUndefined();
  });
});
