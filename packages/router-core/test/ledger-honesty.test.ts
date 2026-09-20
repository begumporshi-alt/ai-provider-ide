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
