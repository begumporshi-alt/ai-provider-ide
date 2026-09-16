/**
 * Tier-2 sandbox tests (ARCHITECTURE.md §2.7): the generated code adapter runs inside
 * QuickJS-WASM with only `http`/`log` host functions. These tests pin the security
 * invariants of that seam — no guest code, no real network; the host owns credentials,
 * egress, and every budget.
 */
import { describe, expect, it } from "vitest";
import type { AdapterManifest } from "@aiprovider/adapter-spec";
import { CodeAdapterInstance, SandboxError, lintCodeSource } from "../src/code-adapter.js";
import type { HttpPort } from "../src/ports.js";
import { FakeHttp, type Responder } from "./fakes.js";

const RESPOND: Responder = (url) => {
  if (url.endsWith("/models")) return { status: 200, body: { data: [{ id: "text-1" }, { id: "img-2" }] } };
  if (url.endsWith("/chat")) return { status: 200, body: { chunks: ["Al", "pha"] } };
  if (url.endsWith("/images")) return { status: 200, body: { b64: "QUJD" } };
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
    const r = await http({ path: "/chat", method: "POST", body: args, headers: { "x-trace": "guest" } });
    for (const c of JSON.parse(r.text).chunks) emit(c);
  },
  async generateImage(http, argsJson) {
    const r = await http({ path: "/images", method: "POST", body: JSON.parse(argsJson) });
    return { ok: true, status: 200, base64: JSON.parse(r.text).b64 };
  },
};
`;

function codeManifest(source: string, opts: { image?: boolean } = {}): AdapterManifest {
  return {
    manifestVersion: 1,
    kind: "code",
    dialect: "test-v1",
    provider: {
      baseUrl: "https://provider.test/v1",
      auth: { headers: [{ name: "Authorization", prefix: "Bearer" }] },
    },
    endpoints: {},
    code: { source, entry: "adapter" },
    capabilities: { text: true, image: opts.image ?? true },
    modalityRules: { image: { modelIdPattern: "^img-" } },
    provenance: { origin: "ai-generated", generatorModel: "test-model", createdAt: "2026-09-16T00:00:00Z" },
  };
}

function makeAdapter(source = GOOD_GUEST, responder: Responder = RESPOND, opBudgetMs?: number) {
  return new CodeAdapterInstance(codeManifest(source), {
    http: new FakeHttp(responder),
    ...(opBudgetMs ? { opBudgetMs } : {}),
  });
}

describe("lintCodeSource (static gate before QuickJS ever sees the source)", () => {
  it("accepts the cooperative guest", () => {
    expect(lintCodeSource(GOOD_GUEST)).toEqual([]);
  });
  it("requires an `export default {`", () => {
    expect(lintCodeSource("export default 42;")).toContain('must contain "export default {"');
  });
  it("rejects oversized source", () => {
    expect(lintCodeSource("export default {" + "x".repeat(64_000)).join("; ")).toMatch(/source too large/);
  });
  for (const bad of ["import('x')", "import fs from 'fs'", "require('fs')", "eval('1')", "new Function('1')", "fetch('x')", "XMLHttpRequest", "WebAssembly", "import.meta.url"]) {
    it(`rejects forbidden construct: ${bad}`, () => {
      expect(lintCodeSource(`export default { }; const a = ${bad};`).join("; ")).toMatch(/forbidden construct/);
    });
  }
});

describe("CodeAdapterInstance construction", () => {
  it("rejects unlinted source at construction (never compiles it)", () => {
    expect(() => makeAdapter("export default { f: require('fs') }")).toThrowError(SandboxError);
  });
  it("rejects a non-code manifest", () => {
    const m = codeManifest(GOOD_GUEST);
    (m as { kind: string }).kind = "declarative";
    expect(() => new CodeAdapterInstance(m, { http: new FakeHttp(RESPOND) })).toThrowError(SandboxError);
  });
  it("exposes manifest-derived capabilities and modality tagging", () => {
    const a = makeAdapter();
    expect(a.capabilities()).toEqual({ text: true, image: true });
    // tagModality takes the whole entry (2026-09-16 amendment): a rule may match raw metadata,
    // so the id alone is no longer enough to classify. The id-pattern rule still votes here.
    expect(a.tagModality({ nativeId: "img-2", raw: { id: "img-2" } })).toBe("image");
    expect(a.tagModality({ nativeId: "text-1", raw: { id: "text-1" } })).toBe("text");
  });
  it("classifies by raw provider metadata when the id says nothing (namespaced catalogs)", () => {
    const m = codeManifest(GOOD_GUEST);
    m.modalityRules = { image: { rawMatch: { path: "$.architecture.output_modalities[0]", contains: "image" } } };
    const a = new CodeAdapterInstance(m, { http: new FakeHttp(RESPOND) });
    expect(a.tagModality({ nativeId: "google/gemini-2.5-flash-image", raw: { architecture: { output_modalities: ["image", "text"] } } })).toBe("image");
    // auto-router leads with text -> stays a text model even though it can also emit images
    expect(a.tagModality({ nativeId: "openrouter/auto", raw: { architecture: { output_modalities: ["text", "image"] } } })).toBe("text");
    // metadata absent entirely -> text (never guess)
    expect(a.tagModality({ nativeId: "openai/gpt-4o", raw: { id: "openai/gpt-4o" } })).toBe("text");
  });
});

describe("sandbox operations against a scripted egress fake", () => {
  it("listModels returns guest-mapped native ids", async () => {
    const a = makeAdapter();
    const models = await a.listModels("ref-1");
    expect(models.map((m) => m.nativeId)).toEqual(["text-1", "img-2"]);
  });

  it("host injects the auth sentinel + secretRef; the guest never sees a secret", async () => {
    const http = new FakeHttp(RESPOND);
    const a = new CodeAdapterInstance(codeManifest(GOOD_GUEST), { http });
    await a.listModels("ref-1");
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.secretRef).toBe("ref-1");
    expect(http.calls[0]!.url).toBe("https://provider.test/v1/models");
    // The guest cannot read the credential: the header carries only the sentinel.
    expect(http.calls[0]!.headers.Authorization).toBe("Bearer {{secret}}");
  });

  it("drops guest-supplied auth headers (credentials are host-owned)", async () => {
    const http = new FakeHttp(RESPOND);
    const a = new CodeAdapterInstance(codeManifest(GOOD_GUEST), { http });
    // An async generator only runs while it is iterated — drain it to drive the guest.
    for await (const _chunk of a.generateText("ref-1", { model: "text-1", messages: [{ role: "user", content: "hi" }], stream: false })) {
      void _chunk;
    }
    expect(http.calls[0]!.headers.Authorization).toBe("Bearer {{secret}}");
    expect(http.calls[0]!.headers["x-trace"]).toBe("guest"); // non-auth headers pass through
  });

  it("generateText streams chunks emitted by the guest", async () => {
    const a = makeAdapter();
    const out: string[] = [];
    for await (const chunk of a.generateText("ref-1", {
      model: "text-1",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })) {
      out.push(chunk);
    }
    expect(out).toEqual(["Al", "pha"]);
  });

  it("generateImage surfaces base64 from the guest", async () => {
    const a = makeAdapter();
    const res = await a.generateImage("ref-1", { model: "img-2", prompt: "a pixel" });
    expect(res).toMatchObject({ ok: true, status: 200, base64: "QUJD" });
  });

  it("pingKey reports ok when the guest lists models", async () => {
    expect((await makeAdapter().pingKey("ref-1")).ok).toBe(true);
  });
});

describe("sandbox containment", () => {
  it("refuses absolute / protocol-relative / traversal paths", async () => {
    const a = makeAdapter(`
      export default {
        async listModels(http) {
          await http({ path: "https://evil.test/v1/models" });
          return [];
        },
      };
    `);
    await expect(a.listModels("ref-1")).rejects.toThrowError(/relative provider path/);
  });

  it("enforces the per-operation http call budget", async () => {
    const a = makeAdapter(`
      export default {
        async listModels(http) {
          for (let i = 0; i < 40; i++) await http({ path: "/models" });
          return [];
        },
      };
    `);
    await expect(a.listModels("ref-1")).rejects.toThrowError(/rate limit/);
  });

  it("kills a guest that overruns its wall-clock budget", async () => {
    const neverSettles: HttpPort = { request: () => new Promise(() => {}) };
    const a = new CodeAdapterInstance(
      codeManifest(`
        export default {
          async listModels(http) { await http({ path: "/models" }); return []; },
        };
      `),
      { http: neverSettles, opBudgetMs: 150 },
    );
    const err = await a.listModels("ref-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).reason).toBe("timeout");
  });

  it("refuses to even compile a guest construct banned by the lint gate", () => {
    // The gate is eager: the source is rejected at construction, so QuickJS never sees it.
    expect(() => makeAdapter("export default { async listModels() { return eval('1'); } };")).toThrowError(SandboxError);
  });

  it("fails closed after disposal", async () => {
    const a = makeAdapter();
    await a.dispose();
    await expect(a.listModels("ref-1")).rejects.toThrowError(/disposed/);
  });

  it("recovers on the next operation after a wedged guest (context rebuilt from source)", async () => {
    const a = makeAdapter(`
      export default {
        async listModels(http) { throw new Error("boom"); },
        async generateImage(http, argsJson) { return { ok: true, status: 200, base64: "QUJD" }; },
      };
    `);
    await expect(a.listModels("ref-1")).rejects.toThrowError(/boom/);
    // The faulted context was disposed; a fresh one is built for the next op.
    expect((await a.generateImage("ref-1", { model: "img-2", prompt: "p" })).base64).toBe("QUJD");
  });
});
