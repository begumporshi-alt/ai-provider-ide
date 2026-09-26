/**
 * The regression guard for the custom-provider manifest.
 *
 * The defect this pins was measured live on 2026-09-26: a provider added through the custom form
 * dropped every tool call the model made — the upstream answered `finish_reason: tool_calls` with a
 * real `get_weather` call, and the gateway answered `finish_reason: stop` with `content: ""`. No
 * error, no tool call, nothing to see in the request. Four separate omissions shared one cause: the
 * manifest shape was written out by hand a second time and drifted from the template.
 *
 * So the load-bearing assertion here is not the two selector strings — it is **parity with the
 * builtin template**. Pinning the strings alone would let the next divergence through; pinning
 * parity means anything the template gains, the manual path must gain too.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES } from "@aiprovider/router-core";
import { authHeaderFor, buildManualManifest, type ManualDialect } from "./manual-manifest";

const URL = "https://api.example.com/v1";

function manifestFor(dialect: ManualDialect) {
  return buildManualManifest({
    url: URL, dialect, authHeader: { name: "Authorization", prefix: "Bearer" },
  });
}

function gen(dialect: ManualDialect) {
  const ep = manifestFor(dialect).endpoints.generateText;
  if (!ep) throw new Error("a manual manifest must carry endpoints.generateText");
  return ep;
}

describe("buildManualManifest", () => {
  it("reports tool calls — the hand-written body it replaces did not", () => {
    const ep = gen("openai-chat-v1");
    expect(ep.responseMap.toolCalls).toBe("$.choices[0].message.tool_calls");
    expect(ep.stream?.chunkMap.toolCalls).toBe("$.choices[0].delta.tool_calls");
  });

  it("stays in step with the builtin template it is derived from", () => {
    const pairs: Array<[ManualDialect, "openai-compat" | "anthropic-compat"]> = [
      ["openai-chat-v1", "openai-compat"],
      ["anthropic-messages-v1", "anthropic-compat"],
    ];
    for (const [dialect, id] of pairs) {
      const builtManifest = BUILTIN_TEMPLATES[id](URL);
      const built = builtManifest.endpoints.generateText;
      if (!built) throw new Error(`${id} has no generateText`);
      const manual = manifestFor(dialect);
      const ep = gen(dialect);
      // `expect(x, message)` — vitest takes the message as the second arg to `expect`, not to
      // `toBe`. The suite does not typecheck, so the wrong form fails silently.
      expect(ep.path, dialect).toBe(built.path);
      expect(ep.requestTemplate, dialect).toEqual(built.requestTemplate);
      expect(ep.responseMap, dialect).toEqual(built.responseMap);
      expect(ep.stream, dialect).toEqual(built.stream);
      // `limits` is a parity claim at the MANIFEST level, not the endpoint's: only the Anthropic
      // template sets it, and a test demanding it of both dialects would be asserting a property
      // of one. (The first draft of this file did exactly that and failed — the test doing its job
      // on its author.)
      expect(manual.limits, dialect).toEqual(builtManifest.limits);
    }
  });

  it("wires the Anthropic dialect to Anthropic paths, not just an Anthropic label", () => {
    const ep = gen("anthropic-messages-v1");
    expect(ep.path).toBe("/messages");
    expect(ep.responseMap.text).toBe("$.content[0].text");
    // The multi-event framing a tool call arrives in on that dialect.
    expect(ep.stream?.toolCallStream).toBeDefined();
  });

  it("overrides dialect, auth and provenance, and nothing else", () => {
    const m = buildManualManifest({
      url: URL, dialect: "openai-chat-v1",
      authHeader: { name: "X-K", prefix: "Token" },
      now: "2026-01-01T00:00:00.000Z",
    });
    expect(m.provider.baseUrl).toBe(URL);
    expect(m.provider.auth.headers[0]).toEqual({ name: "X-K", prefix: "Token" });
    expect(m.provenance.origin).toBe("user-edited");
    expect(m.provenance.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(m.kind).toBe("declarative");
  });
});

describe("authHeaderFor", () => {
  it("maps the form's three choices", () => {
    expect(authHeaderFor("bearer", "ignored", "ignored")).toEqual({ name: "Authorization", prefix: "Bearer" });
    expect(authHeaderFor("x-api-key", "ignored", "ignored")).toEqual({ name: "x-api-key" });
    expect(authHeaderFor("custom", "X-Custom", "Token")).toEqual({ name: "X-Custom", prefix: "Token" });
  });

  it("treats an empty custom prefix as no prefix, not an empty one", () => {
    expect(authHeaderFor("custom", "X-Custom", "")).toEqual({ name: "X-Custom", prefix: undefined });
  });
});
