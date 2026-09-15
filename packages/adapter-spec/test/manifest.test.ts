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
