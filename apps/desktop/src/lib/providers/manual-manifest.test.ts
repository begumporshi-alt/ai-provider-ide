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
import {
  authHeaderFor, buildManualManifest, headersToLines, parseHeaderLines, type ManualDialect,
} from "./manual-manifest";

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

/**
 * Custom request headers — the capability that makes a client-gate gateway reachable.
 *
 * The property that matters is not that a header is written somewhere, but that it reaches **every**
 * endpoint. Measured 2026-09-29 on `agentrouter.org`: `GET /v1/models` answers
 * `401 unauthorized_client_error` for any unrecognised `User-Agent`, and that is the call the ping,
 * the probe and the catalog refresh all make. A header on `generateText` alone would leave the
 * provider unusable while looking fully configured — the exact shape of silent failure this file
 * already exists to guard against.
 */
describe("custom headers", () => {
  const UA = { "user-agent": "claude-cli/2.0.0 (external, cli)" };
  const withHeaders = (dialect: ManualDialect) =>
    buildManualManifest({
      url: URL, dialect, authHeader: { name: "Authorization", prefix: "Bearer" }, extraHeaders: UA,
    });

  it("reaches the model list, not only text generation", () => {
    const m = withHeaders("openai-chat-v1");
    expect(m.endpoints.listModels?.headers).toEqual(UA);
    expect(m.endpoints.generateText?.headers).toEqual(UA);
  });

  it("merges over the template's headers rather than replacing them", () => {
    // The anthropic template carries `anthropic-version`, which the dialect requires. Replacing the
    // map instead of merging would drop it, and the provider would start failing for a second,
    // unrelated reason.
    const m = withHeaders("anthropic-messages-v1");
    expect(m.endpoints.generateText?.headers).toEqual({
      "anthropic-version": "2023-06-01",
      ...UA,
    });
  });

  it("leaves the manifest identical to the template when nothing is entered", () => {
    // The no-op case, asserted so the merge cannot quietly add an empty `headers` key that would
    // make every existing provider look edited.
    const m = buildManualManifest({
      url: URL, dialect: "openai-chat-v1", authHeader: { name: "Authorization", prefix: "Bearer" },
    });
    expect(m.endpoints.listModels?.headers).toBeUndefined();
  });

  it("survives a round trip through the form, and does not promote template headers into it", () => {
    for (const dialect of ["openai-chat-v1", "anthropic-messages-v1"] as ManualDialect[]) {
      const lines = headersToLines(withHeaders(dialect), dialect);
      expect(lines, dialect).toBe('user-agent: claude-cli/2.0.0 (external, cli)');
      // Re-parsing the hydrated text must rebuild the same headers — this is what stops an edit
      // that touches only the provider's name from deleting them.
      expect(parseHeaderLines(lines).headers, dialect).toEqual(UA);
    }
  });
});

describe("parseHeaderLines", () => {
  it("reads one pair per line and ignores blanks and comments", () => {
    const { headers, problems } = parseHeaderLines(
      "# relay gateway\nuser-agent: claude-cli/2.0.0 (external, cli)\n\nx-app: cli\n",
    );
    expect(problems).toEqual([]);
    expect(headers).toEqual({ "user-agent": "claude-cli/2.0.0 (external, cli)", "x-app": "cli" });
  });

  it("keeps colons inside a value", () => {
    // A UA and a URL both contain colons, so splitting on the first colon is the only correct read.
    expect(parseHeaderLines("referer: https://a.test/x").headers).toEqual({ referer: "https://a.test/x" });
  });

  it("reports a line it cannot read instead of inventing a separator", () => {
    const { headers, problems } = parseHeaderLines("user-agent claude-cli/2.0.0");
    expect(headers).toEqual({});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Name: value");
  });

  it("accepts an empty value, which is a header being cleared", () => {
    expect(parseHeaderLines("x-empty:").headers).toEqual({ "x-empty": "" });
  });
});
