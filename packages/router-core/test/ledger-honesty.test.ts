/**
 * Ledger honesty — the request log must not contradict itself.
 *
 * Written after a live row read `✕ NO_ROUTE` with provider/key `—` while the routing chain
 * stored beside it named `agnes · key-01 → BAD_REQUEST_SCHEMA`. Three claims in one row, all
 * wrong in the same direction: the ledger was recording a *category* where it owed a *cause*.
 * The live database held 50 such rows — every failure it had ever recorded — so this is the
 * normal path, not an edge case.
 *
 * Each test below is one defect. They are written to fail against the old code; verify that by
 * restoring `errorClass: served ? "NETWORK" : "NO_ROUTE"` before trusting them.
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

type Resp = { status?: number; body?: unknown; lines?: string[] };

function withBaseUrl(m: ReturnType<NonNullable<(typeof PROVIDER_PROFILES)["openrouter"]>>, baseUrl: string) {
  return { ...m, provider: { ...m.provider, baseUrl } };
}

const MODELS = { status: 200, body: { data: [{ id: "gpt-4o" }] } };

/** One enabled provider, one key, one text model. Enough to fail in a controlled way. */
function setup(responder: (url: string) => Resp) {
  const vault = new FakeVault();
  const registry = new ProviderRegistry(vault);
  const http = new FakeHttp(responder);
  const adapters = new AdapterRuntime(http);
  const p = registry.addProvider({
    id: "pA", slug: "openrouter", name: "Agnes", type: "builtin",
    baseUrl: "https://a.test/api/v1", status: "enabled", rotationStrategy: "priority",
  });
  adapters.register(p.id, withBaseUrl(PROVIDER_PROFILES.openrouter!(), "https://a.test/api/v1"));
  const ledger = new UsageLedger();
  const catalog = new ModelCatalog(registry, adapters);
  const router = new ModelRouter(registry, adapters, catalog, ledger);
  return { registry, ledger, catalog, router, adapters, providerId: p.id };
}

async function arm(s: ReturnType<typeof setup>) {
  const key = await s.registry.addKey({ providerId: s.providerId, label: "key-01", secret: "sk-test" });
  await s.catalog.refreshProvider(s.providerId);
  return key;
}

async function collect(it: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const c of it) out += c;
  return out;
}

const ask = (s: ReturnType<typeof setup>, signal?: AbortSignal) =>
  s.router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }, signal ? { signal } : undefined);

describe("a failed route records the cause, not a category", () => {
  it("HTTP 400 from the only candidate -> BAD_REQUEST_SCHEMA, HTTP 400, and no provider named", async () => {
    const s = setup((url) => (url.endsWith("/models") ? MODELS : { status: 400, body: { error: { message: "bad schema" } } }));
    await arm(s);

    const exec = await ask(s);
    await expect(collect(exec.chunks)).rejects.toThrow();

    const row = s.ledger.query()[0]!;
    expect(row.status).toBe("error");
    // The defect: this was the string "NO_ROUTE" on all 50 failure rows in the live ledger,
    // while the chain stored beside it already knew the real class.
    expect(row.errorClass).toBe("BAD_REQUEST_SCHEMA");
    // The defect: http_status was never written, so a 400 was indistinguishable from a
    // connection that never landed.
    expect(row.httpStatus).toBe(400);
    // Nothing served. A null provider here is the signal, not a gap — see the mid-stream test
    // below, where the same field is non-null precisely because a provider did serve.
    expect(row.providerId).toBeUndefined();
    expect(row.keyId).toBeUndefined();
    expect(row.fallbackChain?.map((a) => a.cls)).toEqual(["BAD_REQUEST_SCHEMA"]);
    expect(row.fallbackChain?.[0]?.candidate.provider.slug).toBe("openrouter");
  });

  it("a success names who served", async () => {
    const s = setup((url) => (url.endsWith("/models") ? MODELS : {
      status: 200,
      lines: [`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`, "data: [DONE]"],
    }));
    const key = await arm(s);

    const exec = await ask(s);
    expect(await collect(exec.chunks)).toBe("hi");

    const row = s.ledger.query()[0]!;
    expect(row.status).toBe("ok");
    // The other half of the providerId invariant: set when something served.
    expect(row.providerId).toBe(s.providerId);
    expect(row.keyId).toBe(key.id);
  });

  it("an error after the first byte still names the provider that served", async () => {
    const s = setup((url) => (url.endsWith("/models") ? MODELS : { status: 200, lines: ["data: [DONE]"] }));
    await arm(s);

    // Swap in an adapter that dies mid-stream. Built after the catalog refresh so the setup
    // path is untouched; only the execution path sees it.
    const dying = {
      forProvider: async () => ({
        baseUrl: "https://a.test/api/v1",
        adapter: {
          async *generateText() {
            yield "partial";
            throw new Error("connection reset by peer");
          },
        },
      }),
    } as unknown as AdapterRuntime;
    const router = new ModelRouter(s.registry, dying, s.catalog, s.ledger);

    const exec = await router.generateText({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    await expect(collect(exec.chunks)).rejects.toThrow("connection reset");

    const row = s.ledger.query()[0]!;
    expect(row.status).toBe("error");
    expect(row.errorClass).toBe("NETWORK");
    // Non-null BECAUSE it served before breaking — which is what makes the null in the 400 test
    // above mean something specific rather than being an absence of information.
    expect(row.providerId).toBe(s.providerId);
    expect(row.httpStatus).toBeUndefined();
  });

  it("a tool call delivered then a mid-stream break does not fail over", async () => {
    // The defect: `emitted` was chunk-only, so a tool call delivered and then a break still
    // failed over (`Next`) — the next candidate re-issued the same tool call. The fix folds
    // a tool-call count into the failover predicate, so a delivered tool call also rethrows.
    //
    // Fail this against the old code by reverting `if (emitted || toolCalls > 0)` to
    // `if (emitted)` in `execution-engine.ts`.
    const s = setup((url) => (url.endsWith("/models") ? MODELS : { status: 200, lines: ["data: [DONE]"] }));
    await arm(s);

    // A second key so failover *can* reach a second candidate — the test's point is that it
    // must not.
    await s.registry.addKey({ providerId: s.providerId, label: "key-02", secret: "sk-test2" });

    // Swap in an adapter that delivers a tool call then dies mid-stream. The tool call is
    // delivered *before* the stream starts, which is where a real adapter puts them.
    let toolCallsDelivered = 0;
    const dying = {
      forProvider: async () => ({
        baseUrl: "https://a.test/api/v1",
        adapter: {
          generateText(_secret: string, args: { onToolCall?: (tc: ToolCall) => void }) {
            // Deliver the tool call before the stream starts, then the stream breaks.
            args.onToolCall?.({ id: "call_1", name: "Bash", arguments: "{\"command\":\"ls\"}" });
            toolCallsDelivered++;
            return (async function* () {
              throw new Error("connection reset by peer");
            })();
          },
        },
      }),
    } as unknown as AdapterRuntime;
    const router = new ModelRouter(s.registry, dying, s.catalog, s.ledger);

    const calls: ToolCall[] = [];
    const exec = await router.generateText({
      model: "gpt-4o",
      messages: [{ role: "user", content: "list files" }],
      tools: [{ type: "function", function: { name: "Bash" } }],
      onToolCall: (c) => calls.push(c),
    });
    await expect(collect(exec.chunks)).rejects.toThrow("connection reset");

    // The tool call was delivered exactly once — no re-issue by a second candidate.
    expect(calls).toHaveLength(1);
    expect(toolCallsDelivered).toBe(1);

    const row = s.ledger.query()[0]!;
    expect(row.status).toBe("error");
    expect(row.errorClass).toBe("NETWORK");
    // The provider that served the tool call is named, not blank.
    expect(row.providerId).toBe(s.providerId);
  });
});

describe("a stream that completes without serving is not a success", () => {
  it("a 200 with no content is logged as an error, not as ok", async () => {
    const s = setup((url) => (url.endsWith("/models") ? MODELS : { status: 200, lines: [] }));
    await arm(s);

    const exec = await ask(s);
    expect(await collect(exec.chunks)).toBe("");

    const row = s.ledger.query()[0]!;
    // The defect: this was "ok". The live ledger held 7 such rows — requests that never reached
    // a provider, logged as successes, two of them after 99.5s and 83s of waiting.
    expect(row.status).toBe("error");
    expect(row.errorClass).toBe("PARSE_ERROR");
    expect(row.providerId).toBeUndefined();
    // And the row now says what the stream carried — which for zero events is itself a finding
    // (the provider sent nothing at all), not an absence of evidence.
    expect(row.failureDetail).toBe("stream carried no SSE events at all");
  });

  it("a stream whose events match nothing names them, so the manifest can be checked", async () => {
    // The other half of the drained arm: the provider DID answer, with events the manifest's
    // chunkMap does not select. Before the observation existed this row was byte-identical to the
    // empty-body one above — 154 of them in the live ledger for one provider, undiagnosable.
    const s = setup((url) =>
      url.endsWith("/models")
        ? MODELS
        : {
            status: 200,
            lines: [
              `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking..." } }] })}`,
              `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "more" } }] })}`,
              "data: [DONE]",
            ],
          },
    );
    await arm(s);

    const exec = await ask(s);
    expect(await collect(exec.chunks)).toBe("");

    const row = s.ledger.query()[0]!;
    expect(row.errorClass).toBe("PARSE_ERROR");
    const detail = row.failureDetail!;
    expect(detail).toContain("2 SSE event");
    expect(detail).toContain("reasoning_content");
    expect(detail).toContain("none matched the manifest's delta selector");
  });

  it("an aborted request is logged as CANCELLED, not as ok", async () => {
    const s = setup((url) => (url.endsWith("/models") ? MODELS : {
      status: 200,
      lines: [`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}`, "data: [DONE]"],
    }));
    await arm(s);

    const ac = new AbortController();
    const exec = await ask(s, ac.signal);
    // Abort before the generator is first driven, so no attempt is ever made. The engine
    // returns rather than throwing, which is exactly the state that used to read as success.
    ac.abort();
    expect(await collect(exec.chunks)).toBe("");

    const row = s.ledger.query()[0]!;
    expect(row.status).toBe("error");
    expect(row.errorClass).toBe("CANCELLED");
  });
});

describe("a request nothing can serve leaves a trace", () => {
  it("records NO_ROUTE instead of failing silently", async () => {
    const s = setup((url) => (url.endsWith("/models") ? MODELS : { status: 200, lines: [] }));
    await arm(s);

    // A model no enabled provider carries. The guard rejects it before the engine ever runs.
    await expect(
      s.router.generateText({ model: "no-such-model", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/no route/);

    // The defect: the ledger held nothing at all, so an error appeared in the UI and the log the
    // user is told to consult showed no sign of it. Asserted separately from the row's contents so
    // a missing row fails as "expected [] to have a length of 1" rather than a TypeError.
    expect(s.ledger.query()).toHaveLength(1);

    const row = s.ledger.query()[0]!;
    expect(row.status).toBe("error");
    // The class that used to be written for *every* failure, now written only where it is true.
    expect(row.errorClass).toBe("NO_ROUTE");
    expect(row.providerId).toBeUndefined();
    expect(row.requestedModel).toBe("no-such-model");
    // Honest: no candidate was ever attempted, so there is no chain to show.
    expect(row.fallbackChain).toEqual([]);
  });
});

/**
 * A tool-call turn delivers its whole answer through `onToolCall`, and none of it through
 * `chunks` — so a ledger that decides "did anything get served?" by counting chunks answers
 * "no" for a request that succeeded. Measured on the live ledger: 11 of the 42 rows written
 * since the 2026-09-27 deploy were `PARSE_ERROR`, and two of those (1714/1715) were probed
 * end to end — both were healthy `finish_reason: "tool_calls"` answers the client received
 * intact, non-streaming and streaming alike.
 *
 * Fail this against the old code by restoring `onToolCall: args.onToolCall` in
 * `execution-engine.ts:97` (i.e. drop the wrapper that marks the candidate as served).
 */
describe("a turn whose only output is a tool call is a success", () => {
  it("records ok and names the provider, not PARSE_ERROR", async () => {
    const s = setup((url) => (url.endsWith("/models") ? MODELS : {
      status: 200,
      lines: [
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Bash", arguments: "" } }] } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"command\":\"ls\"}" } }] } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}`,
        "data: [DONE]",
      ],
    }));
    const key = await arm(s);

    const calls: ToolCall[] = [];
    const exec = await s.router.generateText({
      model: "gpt-4o",
      messages: [{ role: "user", content: "list files" }],
      tools: [{ type: "function", function: { name: "Bash" } }],
      onToolCall: (c) => calls.push(c),
    });
    // The whole point: the answer travels by onToolCall and the transcript is empty.
    expect(await collect(exec.chunks)).toBe("");
    expect(calls).toHaveLength(1);

    const row = s.ledger.query()[0]!;
    // The defect: this was `status: "error"` / `PARSE_ERROR` with no provider named, while the
    // same request recorded "OK" in key health.
    expect(row.status).toBe("ok");
    expect(row.errorClass).toBeUndefined();
    expect(row.providerId).toBe(s.providerId);
    expect(row.keyId).toBe(key.id);
  });
});
