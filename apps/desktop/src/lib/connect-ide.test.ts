/**
 * Pins for the "Connect your IDE" snippet builders.
 *
 * The one thing worth pinning hardest is the base-URL split: OpenAI-compatible clients carry
 * `/v1` in their base, Claude Code must NOT (it appends `/v1/messages` itself — the old preset's
 * `/v1/v1/messages` bug). A snippet that renders is not a snippet that dials.
 */
import { describe, expect, it } from "vitest";
import {
  CONNECT_KEY_PLACEHOLDER,
  CONNECT_TARGETS,
  buildConnectSnippet,
  rootUrl,
} from "./connect-ide";

const ENDPOINT = "http://127.0.0.1:8787/v1";
const input = { endpoint: ENDPOINT, model: "openrouter/anthropic/claude-fable-5.1", providerId: "test-uuid" };

describe("rootUrl", () => {
  it("strips the /v1 suffix a client would otherwise double", () => {
    expect(rootUrl(ENDPOINT)).toBe("http://127.0.0.1:8787");
  });

  it("passes a bare root through unchanged", () => {
    expect(rootUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });
});

describe("CONNECT_TARGETS", () => {
  it("mints one distinctly labeled key per target — one key per app is the point", () => {
    const labels = CONNECT_TARGETS.map((t) => t.mintLabel);
    expect(new Set(labels).size).toBe(CONNECT_TARGETS.length);
    expect(labels).toEqual(["zcode", "claude-code", "my-app"]);
  });
});

describe("buildConnectSnippet", () => {
  it("zcode: emits parseable JSON under \"provider\", keyed by the given id, with the /v1 base", () => {
    const snippet = buildConnectSnippet("zcode", input);
    const parsed = JSON.parse(snippet.split("\n").filter((l) => !l.startsWith("//")).join("\n")) as {
      provider: Record<string, { kind: string; options: { baseURL: string; apiKey: string } }>;
    };
    const entry = parsed.provider["test-uuid"];
    expect(entry.kind).toBe("openai-compatible");
    expect(entry.options.baseURL).toBe(ENDPOINT);
    expect(entry.options.apiKey).toBe(CONNECT_KEY_PLACEHOLDER);
  });

  it("claude-code: the base is the ROOT — the /v1 form would dial /v1/v1/messages", () => {
    const snippet = buildConnectSnippet("claude-code", input);
    expect(snippet).toContain('ANTHROPIC_BASE_URL="http://127.0.0.1:8787"');
    expect(snippet).not.toContain('ANTHROPIC_BASE_URL="http://127.0.0.1:8787/v1');
    expect(snippet).toContain(`ANTHROPIC_AUTH_TOKEN="${CONNECT_KEY_PLACEHOLDER}"`);
    expect(snippet).toContain("openrouter/anthropic/claude-fable-5.1");
  });

  it("openai: carries the /v1 base verbatim and interpolates the model into the smoke test", () => {
    const snippet = buildConnectSnippet("openai", input);
    expect(snippet).toContain(`Base URL: ${ENDPOINT}`);
    expect(snippet).toContain(`-d '{"model":"openrouter/anthropic/claude-fable-5.1"`);
    expect(snippet).toContain(CONNECT_KEY_PLACEHOLDER);
  });

  it("an empty model id degrades to an obvious placeholder, not an empty string", () => {
    const snippet = buildConnectSnippet("openai", { ...input, model: "  " });
    expect(snippet).toContain('{"model":"<model-id>"');
  });

  it("every target carries the paste-over placeholder — no snippet pretends to hold a secret", () => {
    for (const t of CONNECT_TARGETS) {
      expect(buildConnectSnippet(t.id, input)).toContain(CONNECT_KEY_PLACEHOLDER);
    }
  });
});
