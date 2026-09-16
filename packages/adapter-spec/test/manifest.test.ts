import { describe, expect, it } from "vitest";
import { ADAPTER_MANIFEST_V1_1, REQUEST_FIELD_WHITELIST } from "../src/manifest.js";

const validManifest = {
  manifestVersion: 1,
  dialect: "openai-chat-v1",
  provider: { baseUrl: "https://a.test/api/v1", auth: { headers: [{ name: "Authorization", prefix: "Bearer" }] } },
  endpoints: {
    listModels: { method: "GET", path: "/models", map: { models: "$.data[*].id" } },
    generateText: {
      method: "POST",
      path: "/chat/completions",
      requestTemplate: { model: "{{model}}", messages: "{{messages}}", stream: "{{stream}}", max_tokens: "{{maxTokens?}}" },
      responseMap: { text: "$.choices[0].message.content" },
      stream: {
        protocol: "sse",
        chunkMap: { delta: "$.choices[0].delta.content" },
        errorMap: { "$.error": "PASS_THROUGH" },
        stopWhen: { path: "$.type", equals: "message_stop" },
      },
    },
  },
  capabilities: { text: true, image: false },
  provenance: { origin: "builtin-template", generatorModel: null, createdAt: "2026-09-15T00:00:00Z" },
};

describe("manifest grammar v1.1 (zod)", () => {
  it("accepts a well-formed template manifest", () => {
    expect(ADAPTER_MANIFEST_V1_1.safeParse(validManifest).success).toBe(true);
  });
  it("rejects a non-pinned / non-URL baseUrl (invariant 4)", () => {
    expect(ADAPTER_MANIFEST_V1_1.safeParse({ ...validManifest, provider: { ...validManifest.provider, baseUrl: "not a url" } }).success).toBe(false);
  });
  it("is intentionally permissive on selector syntax — the interpreter parser rejects it", () => {
    const bad = structuredClone(validManifest);
    bad.endpoints.generateText!.responseMap.text = "$..content"; // recursive descent is unsupported
    expect(ADAPTER_MANIFEST_V1_1.safeParse(bad).success).toBe(true); // schema enforces `$` prefix only
  });
  it("requires at least one auth header", () => {
    expect(
      ADAPTER_MANIFEST_V1_1.safeParse({ ...validManifest, provider: { baseUrl: "https://a.test", auth: { headers: [] } } }).success,
    ).toBe(false);
  });
  it("whitelists request fields per endpoint", () => {
    expect(REQUEST_FIELD_WHITELIST.generateText!.has("messages")).toBe(true);
    expect(REQUEST_FIELD_WHITELIST.generateText!.has("evil_param")).toBe(false);
  });
});

describe("manifest grammar: adapter kind (§2.7)", () => {
  const codeBody = { source: "export default { listModels() {} }", entry: "adapter" as const };

  it("defaults kind to declarative", () => {
    expect(ADAPTER_MANIFEST_V1_1.parse(validManifest).kind).toBe("declarative");
  });

  it("accepts a code adapter: kind:code + code.source, endpoints optional", () => {
    const r = ADAPTER_MANIFEST_V1_1.safeParse({
      ...validManifest,
      kind: "code",
      code: codeBody,
      endpoints: {}, // a code adapter needs no declarative endpoints at all
    });
    expect(r.success).toBe(true);
  });

  it("rejects kind:code without a code body", () => {
    const r = ADAPTER_MANIFEST_V1_1.safeParse({ ...validManifest, kind: "code" });
    expect(r.success).toBe(false);
  });

  it("rejects a code body on a declarative manifest", () => {
    const r = ADAPTER_MANIFEST_V1_1.safeParse({ ...validManifest, code: codeBody });
    expect(r.success).toBe(false);
  });

  it("requires listModels + generateText on a declarative manifest", () => {
    const r = ADAPTER_MANIFEST_V1_1.safeParse({ ...validManifest, endpoints: { listModels: validManifest.endpoints.listModels } });
    expect(r.success).toBe(false);
  });

  it("caps code source at 64 KB", () => {
    const r = ADAPTER_MANIFEST_V1_1.safeParse({ ...validManifest, kind: "code", code: { ...codeBody, source: "x".repeat(64_001) } });
    expect(r.success).toBe(false);
  });
});

describe("manifest grammar: modalityRules (2026-09-16 amendment — rawMatch)", () => {
  const withRules = (rules: unknown) => ADAPTER_MANIFEST_V1_1.safeParse({ ...validManifest, modalityRules: rules });

  it("accepts the pre-amendment id-pattern shape unchanged", () => {
    expect(withRules({ image: { modelIdPattern: "^dall-e" } }).success).toBe(true);
  });

  it("accepts the new metadata matcher with no id pattern (the OpenRouter case)", () => {
    const r = withRules({ image: { rawMatch: { path: "$.architecture.output_modalities[0]", contains: "image" } } });
    expect(r.success).toBe(true);
  });

  it("accepts both matchers on one rule (id pattern OR metadata)", () => {
    const r = withRules({ image: { modelIdPattern: "^dall-e", rawMatch: { path: "$.kind", contains: "image" } } });
    expect(r.success).toBe(true);
  });

  it("rejects a rule with neither matcher — it could never classify anything", () => {
    expect(withRules({ image: {} }).success).toBe(false);
  });

  it("requires the rawMatch path to be a $-rooted selector", () => {
    expect(withRules({ image: { rawMatch: { path: "architecture.output_modalities", contains: "image" } } }).success).toBe(false);
  });

  it("keeps map.raw as an optional $-rooted selector (declared in v1.1, consumed since the amendment)", () => {
    const ok = structuredClone(validManifest);
    ok.endpoints.listModels!.map = { models: "$.data[*].id", raw: "$.data[*]" } as never;
    expect(ADAPTER_MANIFEST_V1_1.safeParse(ok).success).toBe(true);
    const bad = structuredClone(validManifest);
    bad.endpoints.listModels!.map = { models: "$.data[*].id", raw: "data[*]" } as never;
    expect(ADAPTER_MANIFEST_V1_1.safeParse(bad).success).toBe(false);
  });
});
