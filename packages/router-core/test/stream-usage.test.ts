/**
 * Token usage on streamed requests.
 *
 * OpenAI-shaped servers send no usage block on a stream unless the caller asks for one, and
 * they reject `stream_options` outright on a non-stream request. Since the ledger computes cost
 * from tokens, "usage was never sent" is not a cosmetic gap: every streamed completion records
 * zero tokens, so cost is 0 and the monthly spend cap can never trigger.
 */
import { describe, expect, it } from "vitest";
import { ManifestInterpreter } from "../src/manifest-interpreter.js";
import { PROVIDER_PROFILES } from "../src/builtin-templates.js";
import { ProviderRegistry } from "../src/provider-registry.js";
import { ModelCatalog } from "../src/model-catalog.js";
import { AdapterRuntime } from "../src/adapter-runtime.js";
import { UsageLedger } from "../src/usage-ledger.js";
import { ModelRouter } from "../src/model-router.js";
import { FakeHttp, FakeVault } from "./fakes.js";

// OpenRouter is the OpenAI-shaped carrier in use, so it is the one that must ask for usage.
const OPENAI = PROVIDER_PROFILES["openrouter"]!();

type Reply = { status: number; lines?: string[]; body?: unknown };

function interpreter(reply: Reply) {
  const http = new FakeHttp(() => reply);
  const interp = new ManifestInterpreter(OPENAI, { http, vault: new FakeVault(), vars: {} } as never);
  return { http, interp };
}

describe("stream usage", () => {
  it("asks for usage when streaming, so tokens — and therefore cost — are not silently zero", async () => {
    const { http, interp } = interpreter({
      status: 200,
      lines: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 3 } })}`,
      ],
    });
    let seen: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    // `as never` because the test drives the interpreter directly rather than through TextArgs.
    const args = { model: "gpt-4o", messages: [], stream: true, onUsage: (u: { prompt_tokens: number; completion_tokens: number }) => { seen = u; } };
    for await (const _c of interp.generateText("key:x", args as never)) {
      void _c;
    }
    const body = JSON.parse(http.calls[0]!.body!);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(seen).toEqual({ prompt_tokens: 11, completion_tokens: 3 });
  });

  it("still asks when the stored manifest predates the flag", async () => {
    // Providers already in the database were generated before `requestUsage` existed, so their
    // manifests carry no flag. They must still get usage — otherwise cost stays 0 forever for
    // every provider created before this fix.
    const legacy = JSON.parse(JSON.stringify(OPENAI)) as typeof OPENAI & {
      endpoints: { generateText: { stream?: Record<string, unknown> } };
    };
    delete legacy.endpoints.generateText.stream?.requestUsage;
    const http = new FakeHttp(() => ({
      status: 200,
      lines: [`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`],
    }));
    const interp = new ManifestInterpreter(legacy, { http, vault: new FakeVault(), vars: {} } as never);
    for await (const _c of interp.generateText("key:x", { model: "gpt-4o", messages: [], stream: true } as never)) {
      void _c;
    }
    expect(JSON.parse(http.calls[0]!.body!).stream_options).toEqual({ include_usage: true });
  });

  it("reads usage that arrives AFTER the finish_reason chunk", async () => {
    // The measured OpenRouter ordering: content, finish_reason, then a trailing chunk carrying
    // usage and an empty `choices`, then [DONE]. Stopping at finish_reason loses the usage —
    // this is the ordering that zeroed every ledger row.
    const http = new FakeHttp(() => ({
      status: 200,
      lines: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Ok!" } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 69, completion_tokens: 3 } })}`,
        "data: [DONE]",
      ],
    }));
    const interp = new ManifestInterpreter(OPENAI, { http, vault: new FakeVault(), vars: {} } as never);
    let seen: { prompt_tokens: number; completion_tokens: number } | undefined;
    for await (const _c of interp.generateText("key:x", { model: "gpt-4o", messages: [], stream: true, onUsage: (u: { prompt_tokens: number; completion_tokens: number }) => { seen = u; } } as never)) {
      void _c;
    }
    expect(seen).toEqual({ prompt_tokens: 69, completion_tokens: 3 });
  });

  it("reaches the ledger: a real OpenRouter-shaped stream records its tokens", async () => {
    // End-to-end through the router, because every link above is verified individually and the
    // ledger was still writing 0. OpenRouter puts usage on the SAME chunk as finish_reason, so
    // this is the shape that has to survive.
    const base = "https://a.test/api/v1";
    const vault = new FakeVault();
    const registry = new ProviderRegistry(vault);
    const http = new FakeHttp((url: string) =>
      url.endsWith("/models")
        ? { status: 200, body: { data: [{ id: "gpt-4o" }] } }
        : {
            status: 200,
            lines: [
              `data: ${JSON.stringify({ choices: [{ delta: { content: "Ok!", role: "assistant" } }] })}`,
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 9, total_tokens: 17 } })}`,
              "data: [DONE]",
            ],
          },
    );
    const adapters = new AdapterRuntime(http);
    const p = registry.addProvider({ id: "pA", slug: "openrouter", name: "A", type: "builtin", baseUrl: base, status: "enabled", rotationStrategy: "round_robin" });
    adapters.register(p.id, PROVIDER_PROFILES["openrouter"]!());
    await registry.addKey({ providerId: p.id, label: "k1", secret: "sk-test-1" });
    const ledger = new UsageLedger();
    const catalog = new ModelCatalog(registry, adapters);
    const router = new ModelRouter(registry, adapters, catalog, ledger);
    await catalog.refreshProvider(p.id);

    const exec = await router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    for await (const _c of exec.chunks) void _c;

    const row = ledger.query()[0]!;
    expect(row.tokensIn).toBe(8);
    expect(row.tokensOut).toBe(9);
  });

  it("reaches the caller too — the bridge forwards usage host-side", async () => {
    // `TextRequest.onUsage` was declared but never passed down, so the engine swallowed it and
    // every gateway response reported `usage: null` even when the ledger had the numbers.
    const base = "https://a.test/api/v1";
    const http = new FakeHttp((url: string) =>
      url.endsWith("/models")
        ? { status: 200, body: { data: [{ id: "gpt-4o" }] } }
        : {
            status: 200,
            lines: [
              `data: ${JSON.stringify({ choices: [{ delta: { content: "Ok!" } }] })}`,
              `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 6 } })}`,
              "data: [DONE]",
            ],
          },
    );
    const registry = new ProviderRegistry(new FakeVault());
    const adapters = new AdapterRuntime(http);
    const p = registry.addProvider({ id: "pA", slug: "openrouter", name: "A", type: "builtin", baseUrl: base, status: "enabled", rotationStrategy: "round_robin" });
    adapters.register(p.id, PROVIDER_PROFILES["openrouter"]!());
    await registry.addKey({ providerId: p.id, label: "k1", secret: "sk-test-1" });
    const catalog = new ModelCatalog(registry, adapters);
    const router = new ModelRouter(registry, adapters, catalog, new UsageLedger());
    await catalog.refreshProvider(p.id);

    let seen: { prompt_tokens: number; completion_tokens: number } | undefined;
    const exec = await router.generateText({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      onUsage: (u) => { seen = u; },
    });
    for await (const _c of exec.chunks) void _c;
    expect(seen).toEqual({ prompt_tokens: 4, completion_tokens: 6 });
  });

  it("does NOT send stream_options on a non-stream request — servers reject it", async () => {
    const { http, interp } = interpreter({
      status: 200,
      body: { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } },
    });
    for await (const _c of interp.generateText("key:x", { model: "gpt-4o", messages: [], stream: false } as never)) {
      void _c;
    }
    const body = JSON.parse(http.calls[0]!.body!);
    expect(body.stream_options).toBeUndefined();
  });
});
