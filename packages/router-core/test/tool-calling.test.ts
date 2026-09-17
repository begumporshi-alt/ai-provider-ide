/**
 * Tool-calling plumbing (§3.4). Regression guard for the mercury-2.5 incident: `TextRequest`
 * declared tools/toolChoice/responseFormat, but ModelRouter.generateText dropped them, so every
 * provider received a toolless request no matter what the caller asked for. A second gap: the
 * SSE loop only read `delta.content`, which is null on tool-call chunks, so a tool-calling
 * response streamed as an EMPTY transcript.
 */
import { describe, expect, it } from "vitest";
import { PROVIDER_PROFILES } from "../src/builtin-templates.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { ModelCatalog } from "../src/model-catalog.js";
import { AdapterRuntime } from "../src/adapter-runtime.js";
import { UsageLedger } from "../src/usage-ledger.js";
import { ModelRouter } from "../src/model-router.js";
import type { ToolCall } from "../src/ports.js";
import { FakeHttp, FakeVault } from "./fakes.js";

function withBaseUrl(
  m: ReturnType<NonNullable<(typeof PROVIDER_PROFILES)[keyof typeof PROVIDER_PROFILES]>>,
  baseUrl: string,
) {
  return { ...m, provider: { ...m.provider, baseUrl } };
}

/** Same setup, but registered as an anthropic-compat provider (b.ai profile). */
function makeAnthropicSetup(responder: (url: string) => { status?: number; body?: unknown; lines?: string[] }) {
  const vault = new FakeVault();
  const registry = new ProviderRegistry(vault);
  const http = new FakeHttp(responder);
  const adapters = new AdapterRuntime(http);
  const p = registry.addProvider({
    id: "pB", slug: "bai", name: "B", type: "builtin",
    baseUrl: "https://b.test/v1", status: "enabled", rotationStrategy: "round_robin",
  });
  adapters.register(p.id, withBaseUrl(PROVIDER_PROFILES["b.ai"]!(), "https://b.test/v1"));
  const ledger = new UsageLedger();
  const catalog = new ModelCatalog(registry, adapters);
  const router = new ModelRouter(registry, adapters, catalog, ledger);
  return { registry, http, catalog, router, pB: p };
}

function makeSetup(responder: (url: string) => { status?: number; body?: unknown; lines?: string[] }) {
  const vault = new FakeVault();
  const registry = new ProviderRegistry(vault);
  const http = new FakeHttp(responder);
  const adapters = new AdapterRuntime(http);
  const p = registry.addProvider({
    id: "pA", slug: "openrouter", name: "A", type: "builtin",
    baseUrl: "https://a.test/api/v1", status: "enabled", rotationStrategy: "round_robin",
  });
  adapters.register(p.id, withBaseUrl(PROVIDER_PROFILES.openrouter!(), "https://a.test/api/v1"));
  const ledger = new UsageLedger();
  const catalog = new ModelCatalog(registry, adapters);
  const router = new ModelRouter(registry, adapters, catalog, ledger);
  return { registry, http, catalog, router, pA: p };
}

async function ready(s: ReturnType<typeof makeSetup>) {
  await s.registry.addKey({ providerId: "pA", label: "key-01", secret: "sk-test-pA1" });
  await s.catalog.refreshProvider("pA");
}

/** The last request body the router put on the wire, parsed. */
function lastBody(http: FakeHttp): Record<string, unknown> {
  const call = [...http.calls].reverse().find((c) => c.method === "POST" && c.url.endsWith("/chat/completions"));
  if (!call?.body) throw new Error("no chat/completions request was made");
  return JSON.parse(call.body);
}

describe("tool-calling plumbing", () => {
  it("forwards tools and tool_choice to the provider", async () => {
    const s = makeSetup((url) =>
      url.endsWith("/models")
        ? { status: 200, body: { data: [{ id: "gpt-4o" }] } }
        : { status: 200, lines: [`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`, "data: [DONE]"] },
    );
    await ready(s);

    const tools = [{ type: "function", function: { name: "Bash", parameters: { type: "object" } } }];
    const exec = await s.router.generateText({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools,
      toolChoice: "auto",
    });
    for await (const _ of exec.chunks) void _;

    const body = lastBody(s.http);
    expect(body.tools).toEqual(tools);
    expect(body.tool_choice).toBe("auto");
  });

  it("omits the tool fields entirely when the caller supplies none", async () => {
    const s = makeSetup((url) =>
      url.endsWith("/models")
        ? { status: 200, body: { data: [{ id: "gpt-4o" }] } }
        : { status: 200, lines: [`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}`, "data: [DONE]"] },
    );
    await ready(s);

    const exec = await s.router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    for await (const _ of exec.chunks) void _;

    const body = lastBody(s.http);
    // Sending "tools": null breaks several servers — the {{x?}} rule must omit, not null.
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("response_format");
  });

  it("reports streamed tool calls through onToolCall, reassembling argument fragments", async () => {
    const s = makeSetup((url) =>
      url.endsWith("/models")
        ? { status: 200, body: { data: [{ id: "gpt-4o" }] } }
        : {
            status: 200,
            lines: [
              // arguments arrive in fragments across chunks — one delta per chunk
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Bash", arguments: "" } }] } }] })}`,
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"com" } }] } }] })}`,
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "mand\":\"ls\"}" } }] } }] })}`,
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
              "data: [DONE]",
            ],
          },
    );
    await ready(s);

    const calls: ToolCall[] = [];
    const exec = await s.router.generateText({
      model: "gpt-4o",
      messages: [{ role: "user", content: "list files" }],
      tools: [{ type: "function", function: { name: "Bash" } }],
      onToolCall: (c) => calls.push(c),
    });
    let text = "";
    for await (const c of exec.chunks) text += c;

    // The regression: content was null on every chunk, so the transcript came back empty.
    expect(text).toBe("");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("Bash");
    expect(calls[0]!.id).toBe("call_1");
    expect(JSON.parse(calls[0]!.arguments ?? "{}")).toEqual({ command: "ls" });
  });

  it("reassembles anthropic tool_use across content_block_start + input_json_delta events", async () => {
    const s = makeAnthropicSetup((url) =>
      url.endsWith("/models")
        ? { status: 200, body: { data: [{ id: "claude-x" }] } }
        : {
            status: 200,
            lines: [
              `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
              `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } })}`,
              `data: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } })}`,
              `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pa' } })}`,
              `data: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'th":"README.md"}' } })}`,
              `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}`,
              `data: ${JSON.stringify({ type: "message_stop" })}`,
            ],
          },
    );
    await s.registry.addKey({ providerId: "pB", label: "key-01", secret: "sk-test-pB1" });
    await s.catalog.refreshProvider("pB");

    const calls: ToolCall[] = [];
    const exec = await s.router.generateText({
      model: "claude-x",
      messages: [{ role: "user", content: "read the readme" }],
      tools: [{ name: "read_file" }],
      onToolCall: (c) => calls.push(c),
    });
    let text = "";
    for await (const c of exec.chunks) text += c;

    expect(text).toBe("Let me check.");
    // The text block at index 0 is not a tool call and must not be reported.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("toolu_1");
    expect(calls[0]!.name).toBe("read_file");
    expect(JSON.parse(calls[0]!.arguments ?? "{}")).toEqual({ path: "README.md" });
  });

  it("stays silent on onToolCall when the caller registers no handler", async () => {
    const s = makeSetup((url) =>
      url.endsWith("/models")
        ? { status: 200, body: { data: [{ id: "gpt-4o" }] } }
        : { status: 200, lines: [`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`, "data: [DONE]"] },
    );
    await ready(s);

    const exec = await s.router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    let text = "";
    for await (const c of exec.chunks) text += c;
    expect(text).toBe("hi");
  });
});
