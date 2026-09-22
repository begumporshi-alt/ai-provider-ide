/**
 * Cached-prompt tokens — migration 0015.
 *
 * The question this measurement exists to answer is narrow, and easy to lose in the recording:
 * **does an upstream report prompt caching at all?** That is only answerable if "the response
 * carried no cache block" and "the response carried a cache block saying zero" end up as
 * *different* stored values. So the assertions that matter most here are the `undefined` ones —
 * they are what a `NOT NULL DEFAULT 0` column would have silently destroyed, leaving every
 * provider looking like a provider that caches nothing.
 *
 * The second shape is Anthropic's, which reports the same fact under a different name and at a
 * different depth (`cache_read_input_tokens`, top level) rather than nested inside
 * `prompt_tokens_details`.
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

const OPENAI = PROVIDER_PROFILES["openrouter"]!();

type Reply = { status: number; lines?: string[]; body?: unknown };

function interpreter(reply: Reply) {
  const http = new FakeHttp(() => reply);
  const interp = new ManifestInterpreter(OPENAI, { http, vault: new FakeVault(), vars: {} } as never);
  return { http, interp };
}

/** Drive the interpreter directly and hand back whatever usage it reported. */
async function usageFrom(reply: Reply, stream: boolean) {
  const { interp } = interpreter(reply);
  let seen: { cached_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | undefined;
  const args = {
    model: "gpt-4o",
    messages: [],
    stream,
    onUsage: (u: { cached_tokens?: number; prompt_tokens?: number; completion_tokens?: number }) => {
      seen = u;
    },
  };
  for await (const _c of interp.generateText("key:x", args as never)) void _c;
  return seen;
}

describe("cached tokens", () => {
  it("reads prompt_tokens_details.cached_tokens on a non-stream response", async () => {
    const seen = await usageFrom(
      {
        status: 200,
        body: {
          choices: [{ message: { content: "hi" } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 64 },
          },
        },
      },
      false,
    );
    expect(seen?.cached_tokens).toBe(64);
  });

  it("also reads Anthropic's cache_read_input_tokens, which sits at the top level", async () => {
    const seen = await usageFrom(
      {
        status: 200,
        body: {
          choices: [{ message: { content: "hi" } }],
          usage: { prompt_tokens: 100, completion_tokens: 5, cache_read_input_tokens: 90 },
        },
      },
      false,
    );
    expect(seen?.cached_tokens).toBe(90);
  });

  it("leaves cached_tokens undefined when no cache block is reported — and that is not 0", async () => {
    const seen = await usageFrom(
      {
        status: 200,
        body: {
          choices: [{ message: { content: "hi" } }],
          usage: { prompt_tokens: 100, completion_tokens: 5 },
        },
      },
      false,
    );
    // The callback must still fire: the token counts are real and worth recording.
    expect(seen).toBeDefined();
    expect(seen?.prompt_tokens).toBe(100);
    // The load-bearing assertion. `toBeUndefined` and `not.toBe(0)` are both here on purpose —
    // either alone would pass against an implementation that coerced absence to zero.
    expect(seen?.cached_tokens).toBeUndefined();
    expect(seen?.cached_tokens).not.toBe(0);
  });

  it("reports a genuine zero as 0, which is a different finding from undefined", async () => {
    const seen = await usageFrom(
      {
        status: 200,
        body: {
          choices: [{ message: { content: "hi" } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        },
      },
      false,
    );
    // "Caching is available and this request missed" — which is what justifies adding
    // `cache_control`, and is invisible if absence and zero share a value.
    expect(seen?.cached_tokens).toBe(0);
    expect(seen?.cached_tokens).not.toBeUndefined();
  });

  it("carries cached tokens off a streamed usage chunk", async () => {
    const seen = await usageFrom(
      {
        status: 200,
        lines: [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`,
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 50, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 32 } },
          })}`,
        ],
      },
      true,
    );
    expect(seen?.cached_tokens).toBe(32);
  });

  it("does not let a later usage chunk without a cache block erase an earlier one", async () => {
    // Anthropic puts usage on `message_delta`, not on every chunk, so a provider that reports the
    // cache once and then reports plain counts must keep the cache figure rather than overwrite
    // it with nothing.
    const seen = await usageFrom(
      {
        status: 200,
        lines: [
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 50, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 48 } },
          })}`,
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 50, completion_tokens: 2 },
          })}`,
        ],
      },
      true,
    );
    expect(seen?.cached_tokens).toBe(48);
  });

  it("reaches the ledger row end-to-end, through the router", async () => {
    // Every link above is verified in isolation, and the original token bug still reached the
    // ledger as zero — so the wiring gets its own assertion rather than being inferred.
    const base = "https://a.test/api/v1";
    const http = new FakeHttp((url: string) =>
      url.endsWith("/models")
        ? { status: 200, body: { data: [{ id: "gpt-4o" }] } }
        : {
            status: 200,
            lines: [
              `data: ${JSON.stringify({ choices: [{ delta: { content: "Ok!" } }] })}`,
              `data: ${JSON.stringify({
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: {
                  prompt_tokens: 80,
                  completion_tokens: 7,
                  prompt_tokens_details: { cached_tokens: 64 },
                },
              })}`,
              "data: [DONE]",
            ],
          },
    );
    const registry = new ProviderRegistry(new FakeVault());
    const adapters = new AdapterRuntime(http);
    const p = registry.addProvider({
      id: "pA",
      slug: "openrouter",
      name: "A",
      type: "builtin",
      baseUrl: base,
      status: "enabled",
      rotationStrategy: "round_robin",
    });
    adapters.register(p.id, PROVIDER_PROFILES["openrouter"]!());
    await registry.addKey({ providerId: p.id, label: "k1", secret: "sk-test-1" });
    const ledger = new UsageLedger();
    const catalog = new ModelCatalog(registry, adapters);
    const router = new ModelRouter(registry, adapters, catalog, ledger);
    await catalog.refreshProvider(p.id);

    const exec = await router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    for await (const _c of exec.chunks) void _c;

    const row = ledger.query()[0]!;
    expect(row.tokensIn).toBe(80);
    expect(row.cachedTokens).toBe(64);
  });

  it("reaches the ledger as undefined when the provider reports no cache", async () => {
    const base = "https://a.test/api/v1";
    const http = new FakeHttp((url: string) =>
      url.endsWith("/models")
        ? { status: 200, body: { data: [{ id: "gpt-4o" }] } }
        : {
            status: 200,
            lines: [
              `data: ${JSON.stringify({ choices: [{ delta: { content: "Ok!" } }] })}`,
              `data: ${JSON.stringify({
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 80, completion_tokens: 7 },
              })}`,
              "data: [DONE]",
            ],
          },
    );
    const registry = new ProviderRegistry(new FakeVault());
    const adapters = new AdapterRuntime(http);
    const p = registry.addProvider({
      id: "pA",
      slug: "openrouter",
      name: "A",
      type: "builtin",
      baseUrl: base,
      status: "enabled",
      rotationStrategy: "round_robin",
    });
    adapters.register(p.id, PROVIDER_PROFILES["openrouter"]!());
    await registry.addKey({ providerId: p.id, label: "k1", secret: "sk-test-1" });
    const ledger = new UsageLedger();
    const catalog = new ModelCatalog(registry, adapters);
    const router = new ModelRouter(registry, adapters, catalog, ledger);
    await catalog.refreshProvider(p.id);

    const exec = await router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    for await (const _c of exec.chunks) void _c;

    // `undefined` here is what becomes SQL NULL in `ledger.cached_tokens`. If this ever reads 0,
    // the measurement can no longer tell "provider does not report caching" from "provider
    // reported nothing cached", and the column is worthless.
    const row = ledger.query()[0]!;
    expect(row.cachedTokens).toBeUndefined();
  });
});
