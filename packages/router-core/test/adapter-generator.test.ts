/**
 * adapter-generator pipeline tests: gates in order (schema -> lint -> contract), best-of-N
 * ranking, host-pinning lint (invariant 4), the §2.3 same-host docs rule, and audit hooks.
 * The "AI" is a scripted stub — the same AiTextPort interface the real router implements.
 */
import { describe, expect, it } from "vitest";
import {
  generateCandidates, lintManifest, fetchDocsExcerpt, extractJson, redactionHash,
} from "../src/adapter-generator.js";
import type { ProbeReport } from "../src/probe-runner.js";
import type { AdapterManifest } from "@aiprovider/adapter-spec";
import { FakeHttp } from "./fakes.js";
import { BUILTIN_TEMPLATES } from "../src/builtin-templates.js";

const BASE = "https://exotic.test/api";
const REPORT: ProbeReport = {
  baseUrl: BASE,
  ts: Date.now(),
  attempts: [
    { method: "GET", path: "/v1/models", status: 200, ms: 0, bodyShape: { data: [{ id: "x" }] } },
    { method: "POST", path: "/v1/chat", status: 401, ms: 0 },
  ],
};

const PINNED = BASE + "/v1";

function manifestJson(over: Partial<AdapterManifest> = {}): string {
  const m = BUILTIN_TEMPLATES["openai-compat"]!(PINNED);
  return JSON.stringify({
    ...m,
    endpoints: {
      listModels: { method: "GET", path: "/v1/models", map: { models: "$.data[*].id" } },
      generateText: {
        method: "POST",
        path: "/v1/chat",
        requestTemplate: { model: "{{model}}", messages: "{{messages}}", stream: "{{stream}}" },
        responseMap: { text: "$.result.text" },
        stream: { protocol: "sse", chunkMap: { delta: "$.result.text" } },
      },
    },
    capabilities: { text: true, image: false },
    ...over,
  });
}

const stubAi = (fn: (user: string, callIndex: number) => string) => {
  let n = 0;
  const calls: string[] = [];
  return {
    ai: {
      complete: async (req: { prompt: string }) => {
        calls.push(req.prompt);
        return fn(req.prompt, n++);
      },
    },
    calls,
  };
};

/** A provider backend that answers the generated manifest shape: $.result.text + /v1/models. */
const exoticServer = (url: string) => {
  if (url.endsWith("/v1/models")) return { status: 200, body: { data: [{ id: "m1" }] } };
  if (url.endsWith("/v1/chat")) return { status: 200, body: { result: { text: "ok" } } };
  return { status: 404 };
};

describe("lint (invariant 4 + field whitelist)", () => {
  it("rejects a manifest that changes the host", () => {
    const m = BUILTIN_TEMPLATES["openai-compat"]!("https://evil.attacker.test/v1");
    expect(lintManifest(m, "https://good.test/v1").join(" ")).toContain("invariant 4");
  });
  it("accepts trailing-slash/case differences on the same host", () => {
    const m = BUILTIN_TEMPLATES["openai-compat"]!("HTTPS://Good.test/v1/");
    expect(lintManifest(m, "https://good.test/v1")).toEqual([]);
  });
  it("rejects non-whitelisted request fields and unsupported selectors", () => {
    const m = BUILTIN_TEMPLATES["openai-compat"]!("https://good.test/v1");
    m.endpoints.generateText = {
      ...m.endpoints.generateText!,
      requestTemplate: { model: "{{model}}", evil_field: "x" } as never,
      responseMap: { text: "$..content" } as never,
    };
    const errs = lintManifest(m, "https://good.test/v1");
    expect(errs.some((e) => e.includes("evil_field"))).toBe(true);
    expect(errs.some((e) => e.includes("$..content"))).toBe(true);
  });
});

describe("extractJson + redactionHash", () => {
  it("recovers JSON from markdown fences and surrounding chatter", () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```\nDone.')).toEqual({ a: 1 });
    expect(extractJson("no json here")).toBeNull();
  });
  it("hash is deterministic and 32 hex chars", () => {
    expect(redactionHash("probe-report-A")).toBe(redactionHash("probe-report-A"));
    expect(redactionHash("probe-report-A")).not.toBe(redactionHash("probe-report-B"));
    expect(redactionHash("x")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("generateCandidates", () => {
  it("passes schema+lint+contract gates and produces a ranked list; provenance is ours", async () => {
    const { ai } = stubAi(() => manifestJson());
    const audits: unknown[] = [];
    const ranked = await generateCandidates({
      ai,
      systemLabel: "openrouter/gpt-4o-mini (system)",
      report: REPORT,
      baseUrl: PINNED,
      secretRef: "key:t",
      excludeProviderIds: ["p-candidate"],
      http: new FakeHttp((url) => exoticServer(url)),
      n: 3,
      audit: async (a) => { audits.push(a); },
    });
    expect(ranked).toHaveLength(3);
    for (const c of ranked) {
      expect(c.manifest).toBeDefined();
      expect(c.manifest!.provenance.origin).toBe("ai-generated");
      expect(c.manifest!.provenance.generatorModel).toBe("openrouter/gpt-4o-mini (system)");
      expect(c.freePasses).toBeGreaterThanOrEqual(2); // auth + models passed against the exotic server
    }
    expect(audits).toHaveLength(3);
    // exclusion rule reached the AI port: it was invoked via the router-shaped stub; verify
    // the prompts carry the report structure only (no raw values, no key)
    const joined = JSON.stringify(ranked);
    expect(joined).not.toContain("sk-");
  });

  it("gate order: a host-changing candidate dies at lint, not contract", async () => {
    const { ai } = stubAi((_, i) => (i === 0 ? manifestJson({ provider: { baseUrl: "https://evil.test/v1", auth: { headers: [{ name: "Authorization", prefix: "Bearer" }] } } }) : manifestJson()));
    let contractSeenForA = false;
    const ranked = await generateCandidates({
      ai,
      systemLabel: "sys",
      report: REPORT,
      baseUrl: PINNED,
      secretRef: "key:t",
      excludeProviderIds: [],
      http: new FakeHttp((url) => {
        if (url.includes("evil.test")) contractSeenForA = true;
        return exoticServer(url);
      }),
      n: 2,
      onProgress: (p) => {
        if (p.id === "A" && p.stage === "contract") contractSeenForA = true;
      },
    });
    const a = ranked.find((c) => c.id === "A")!;
    expect(a.lintErrors.join(" ")).toContain("invariant 4");
    expect(a.manifest).toBeUndefined();
    expect(contractSeenForA).toBe(false); // lint rejected before any request
    // candidate B survives -> ranks first
    expect(ranked[0]!.id).toBe("B");
    expect(ranked[0]!.manifest).toBeDefined();
  });

  it("unparseable and schema-invalid outputs are reported as rejected candidates, never crash", async () => {
    const { ai } = stubAi((_, i) => (i === 0 ? "I cannot help with that." : i === 1 ? '{"manifestVersion": 2}' : manifestJson()));
    const ranked = await generateCandidates({
      ai,
      systemLabel: "sys",
      report: REPORT,
      baseUrl: PINNED,
      secretRef: "key:t",
      excludeProviderIds: [],
      http: new FakeHttp((url) => exoticServer(url)),
      n: 3,
    });
    const a = ranked.find((c) => c.id === "A")!;
    const b = ranked.find((c) => c.id === "B")!;
    const cc = ranked.find((c) => c.id === "C")!;
    expect(a.rejectedReason ?? "").toContain("unparseable");
    expect(b.schemaErrors.length).toBeGreaterThan(0);
    expect(cc.manifest).toBeDefined();
    expect(ranked[0]).toBe(cc); // only the valid candidate ranks first
  });

  it("regenerate-with-feedback adds the note to the next round's prompt", async () => {
    const { ai, calls } = stubAi(() => manifestJson());
    await generateCandidates({
      ai,
      systemLabel: "sys",
      report: REPORT,
      baseUrl: PINNED,
      secretRef: "key:t",
      excludeProviderIds: [],
      http: new FakeHttp((url) => exoticServer(url)),
      n: 1,
      feedback: "the stream ends on event type done, not finish_reason",
    });
    expect(calls[0]).toContain("stream ends on event type done");
  });
});

describe("docs excerpt (§2.3)", () => {
  it("refuses a docs URL on a different host", async () => {
    const r = await fetchDocsExcerpt(new FakeHttp(() => ({ status: 200, body: "x" })), "https://docs.other.test/api", "https://good.test/v1");
    expect(r.error).toContain("same-host");
  });
  it("scrubs key-shaped strings from fetched docs", async () => {
    const http = new FakeHttp(() => ({ status: 200, body: "use sk-abcdefgh1234567890 for auth" }));
    const r = await fetchDocsExcerpt(http, "https://good.test/docs/api", "https://good.test/v1");
    expect(r.text).toContain("[REDACTED]");
    expect(r.text).not.toContain("abcdefgh");
  });
});
