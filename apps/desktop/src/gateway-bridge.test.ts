/**
 * Gateway bridge tests (2026-09-18).
 *
 * The bridge is the one part of the gateway tool loop that Rust cannot reach: it runs as
 * TypeScript inside the webview. Everything below it (the sandbox) and above it (the dialect
 * handlers) is covered by Rust tests, but the loop itself — who owns the tools, what gets
 * executed, when the turn ends — was only ever exercised by hand in the running app.
 *
 * These tests mock the Tauri IPC layer and the model, then drive the real `handle()` loop,
 * so gateway mode, pass-through mode, the iteration cap and backpressure are all covered
 * headlessly. The mocks replace only the seams; the loop logic under test is the real thing.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// `vi.hoisted` because vi.mock factories run before any top-level `const` exists.
const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  invokes: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
  impl: null as null | ((cmd: string, args: Record<string, unknown>) => unknown),
  genCalls: [] as Array<Record<string, unknown>>,
  /** How many IPC calls had been made when each model turn started — used to prove ordering. */
  invokesAtGen: [] as number[],
  steps: [] as Array<{ text: string; calls?: Array<{ id?: string; name: string; arguments: string }> }>,
  chunkDelayMs: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    h.invokes.push({ cmd, args });
    if (h.impl) return h.impl(cmd, args);
    return undefined;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    h.handlers.set(name, cb);
    return async () => {
      h.handlers.delete(name);
    };
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  // The bridge refuses to start anywhere else (audit R1), so the label has to match.
  getCurrentWindow: () => ({ label: "gateway" }),
}));

vi.mock("./store", () => ({
  router: {
    generateText: async (req: Record<string, unknown>) => {
      const i = h.genCalls.length;
      h.invokesAtGen.push(h.invokes.length);
      h.genCalls.push(req);
      const step = h.steps[Math.min(i, h.steps.length - 1)];
      const onToolCall = req.onToolCall as ((c: unknown) => void) | undefined;
      step?.calls?.forEach((c) => onToolCall?.(c));
      return {
        chunks: (async function* () {
          yield step?.text ?? "";
          if (h.chunkDelayMs > 0) {
            await new Promise((r) => setTimeout(r, h.chunkDelayMs));
            yield " ";
          }
        })(),
      };
    },
    listModels: async () => [],
    generateImage: async () => ({ url: "http://example.test/i.png" }),
  },
}));

import { startGatewayBridge, gatewayStatus } from "./gateway-bridge";
import { AllAttemptsFailedError, type AttemptOutcome } from "@aiprovider/router-core";
import { AGENT_TOOLS, registryToOpenAI } from "./lib/tools/registry";

const calls = (cmd: string) => h.invokes.filter((i) => i.cmd === cmd);

async function waitFor(pred: () => boolean, ms = 3_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

/** Dispatch one request through the listener the bridge registered, and wait for it to end. */
async function send(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<void> {
  const handler = h.handlers.get("gateway-request");
  if (!handler) throw new Error("bridge registered no gateway-request listener");
  handler({ payload: { requestId: 1, kind: "chat", body, headers } });
  await waitFor(() => calls("gateway_done").length > 0 || calls("gateway_error").length > 0);
}

beforeAll(async () => {
  // The bridge installs a heartbeat with `window.setInterval`; vitest runs in `node`.
  (globalThis as unknown as { window: unknown }).window = { setInterval: () => 0 };
  await startGatewayBridge();
});

beforeEach(() => {
  h.invokes.length = 0;
  h.genCalls.length = 0;
  h.invokesAtGen.length = 0;
  h.steps = [];
  h.chunkDelayMs = 0;
  h.impl = (cmd) => {
    if (cmd === "get_tools_enabled") return true;
    if (cmd === "gateway_tool_run") return { ok: true, output: "ok" };
    return undefined;
  };
});

describe("gateway-bridge tool loop", () => {
  it("gateway mode: supplies its own registry, executes, feeds results back, then answers", async () => {
    h.steps = [
      {
        text: "on it: ",
        calls: [{ id: "c1", name: "write_file", arguments: '{"path":"a.txt","content":"hi"}' }],
      },
      { text: "wrote it" },
    ];

    await send({ model: "m1", messages: [{ role: "user", content: "write a file" }] });

    // It asked whether gateway tools are on, because the client brought none.
    expect(calls("get_tools_enabled").length).toBe(1);

    // Turn 1 went out with our registry, not the client's (there wasn't one).
    const expectedTools = registryToOpenAI(AGENT_TOOLS);
    expect(JSON.stringify(h.genCalls[0].tools)).toBe(JSON.stringify(expectedTools));
    expect(h.genCalls[0].toolChoice).toBe("auto");

    // The call ran here...
    const runs = calls("gateway_tool_run");
    expect(runs.length).toBe(1);
    expect(runs[0].args.toolName).toBe("write_file");
    expect(JSON.parse(String(runs[0].args.arguments))).toMatchObject({ path: "a.txt" });

    // ...and turn 2 shows the model a well-formed pair: the turn that asked, then the answer.
    const msgs = h.genCalls[1].messages as Array<Record<string, unknown>>;
    const assistantTurn = msgs.find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    expect(assistantTurn).toBeTruthy();
    const toolMsg = msgs.find((m) => m.role === "tool");
    expect(toolMsg?.tool_call_id).toBe("c1");

    // The client sees only the answer the model settled on. The "on it: " preamble belongs
    // to a turn that went on to call a tool, so it is dropped, not streamed.
    expect(calls("gateway_tool_calls").length).toBe(0);
    const streamed = calls("gateway_chunk").map((c) => c.args.text).join("");
    expect(streamed).toBe("wrote it");
    expect(streamed).not.toContain("on it: ");
    expect(calls("gateway_done").length).toBe(1);
  });

  it("a provider that omits the call id still gets a matched, wire-shaped pair", async () => {
    // The real-world case: `manifest-interpreter` emits `id: undefined` when the provider's
    // tool-call payload carries no id (or the manifest maps none). The assistant turn and the
    // tool result then each applied their OWN fallback — "" in one, the tool *name* in the
    // other — so the ids could never match and the provider answered 400 on the continuation.
    h.steps = [
      {
        text: "on it: ",
        calls: [{ name: "write_file", arguments: '{"path":"a.txt","content":"hi"}' }],
      },
      { text: "wrote it" },
    ];

    await send({ model: "m1", messages: [{ role: "user", content: "write a file" }] });

    const msgs = h.genCalls[1].messages as Array<Record<string, unknown>>;
    const assistantTurn = msgs.find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    expect(assistantTurn).toBeTruthy();
    const declared = (assistantTurn!.tool_calls as Array<Record<string, unknown>>)[0]!;
    const toolMsg = msgs.find((m) => m.role === "tool");

    // The pairing rule: a tool result must name a call the assistant turn actually declared.
    expect(typeof declared.id).toBe("string");
    expect(declared.id).not.toBe("");
    expect(toolMsg?.tool_call_id).toBe(declared.id);

    // And the entry has to be OpenAI's wire shape — `type` plus a nested `function` — not the
    // flat internal `{id,name,arguments}`, which servers reject as malformed.
    expect(declared.type).toBe("function");
    expect(declared.function).toMatchObject({ name: "write_file" });
    expect(typeof (declared.function as Record<string, unknown>).arguments).toBe("string");
  });

  it("pass-through: emits the client's calls and ends, without executing them", async () => {
    const clientTools = [{ type: "function", function: { name: "their_tool" } }];
    h.steps = [{ text: "thinking", calls: [{ id: "c1", name: "their_tool", arguments: "{}" }] }];

    await send({
      model: "m1",
      messages: [{ role: "user", content: "go" }],
      tools: clientTools,
    });

    // The client brought its own tools, so the gateway never asks about its own.
    expect(calls("get_tools_enabled").length).toBe(0);

    // One turn only: we do not answer our own follow-up, the client will.
    expect(h.genCalls.length).toBe(1);
    // The client's tool, not ours. normalizeGatewayRequest fills in a JSON Schema
    // `parameters` when the client omits one, so compare on identity of the tool, not
    // byte equality of the whole array.
    const forwarded = h.genCalls[0].tools as Array<{ function: { name: string } }>;
    expect(forwarded.map((t) => t.function.name)).toEqual(["their_tool"]);
    expect(h.genCalls[0].toolChoice).toBeUndefined();

    const emitted = calls("gateway_tool_calls");
    expect(emitted.length).toBe(1);
    expect(JSON.parse(String(emitted[0].args.toolCallsJson))[0].name).toBe("their_tool");

    // Executing here would run the file write twice.
    expect(calls("gateway_tool_run").length).toBe(0);
    // No follow-up turn, so nothing is held back — pass-through streams as it arrives.
    expect(calls("gateway_chunk").map((c) => c.args.text).join("")).toContain("thinking");
    expect(calls("gateway_done").length).toBe(1);
  });

  it("gateway tools off and no client tools: forwards nothing rather than inventing tools", async () => {
    h.impl = (cmd) => (cmd === "get_tools_enabled" ? false : undefined);
    h.steps = [{ text: "hi" }];

    await send({ model: "m1", messages: [{ role: "user", content: "hi" }] });

    expect(h.genCalls[0].tools).toBeUndefined();
    expect(calls("gateway_tool_run").length).toBe(0);
    expect(calls("gateway_done").length).toBe(1);
  });

  it("caps a model that never stops calling tools", async () => {
    h.steps = [{ text: "still working", calls: [{ id: "c1", name: "write_file", arguments: "{}" }] }];

    await send({ model: "m1", messages: [{ role: "user", content: "loop forever" }] });

    // 8 is MAX_TOOL_ITERATIONS; the point is that it is bounded, not that it is 8.
    expect(h.genCalls.length).toBe(8);
    // There is no clean answer to show, but the last turn is released anyway: a client that
    // receives nothing cannot tell "gave up" from "broke".
    expect(calls("gateway_chunk").map((c) => c.args.text).join("")).toContain("still working");
    expect(calls("gateway_done").length).toBe(1);
  });

  it("proves liveness before the first turn, so a slow turn is not failed as a dead window", async () => {
    // The regression: the probe used to be skipped on iteration 1 (`iter > 1`). Gateway mode
    // emits nothing until a turn finishes, so Rust's first-message bound saw silence for the
    // whole of turn 1 and answered 503 — blaming a suspended window for what was really a
    // long turn. Measured on a live gateway: a ~150k-token prompt ran past the bound and was
    // reported as "the gateway window may be suspended" while the window was serving
    // normally on both sides of the failure.
    h.steps = [{ text: "eventually" }];

    await send({ model: "m1", messages: [{ role: "user", content: "a very large prompt" }] });

    // A probe is an empty chunk: nothing on the wire, purely "the worker is alive".
    const probes = calls("gateway_chunk").filter((c) => c.args.text === "");
    expect(probes.length).toBeGreaterThan(0);

    // And it has to land BEFORE the first model call — that precedence is the entire point.
    // It is what tells Rust the worker is working rather than suspended.
    const beforeFirstTurn = h.invokes.slice(0, h.invokesAtGen[0]!);
    expect(beforeFirstTurn.some((i) => i.cmd === "gateway_chunk" && i.args.text === "")).toBe(true);

    // Probing changed liveness reporting, not the stream: the answer still arrives intact.
    expect(calls("gateway_chunk").map((c) => c.args.text).join("")).toBe("eventually");
    expect(calls("gateway_done").length).toBe(1);
  });

  it("aborts when the client is gone instead of paying for more tokens", async () => {
    // A chunk that fails means the HTTP request died; that is the loop's only backpressure.
    h.impl = (cmd) => {
      if (cmd === "gateway_chunk") throw new Error("request is no longer active");
      if (cmd === "get_tools_enabled") return true;
      if (cmd === "gateway_tool_run") return { ok: true, output: "ok" };
      return undefined;
    };
    h.chunkDelayMs = 20;
    h.steps = [{ text: "hello", calls: [{ id: "c1", name: "write_file", arguments: "{}" }] }];

    const handler = h.handlers.get("gateway-request");
    if (!handler) throw new Error("bridge registered no gateway-request listener");
    handler({ payload: { requestId: 1, kind: "chat", body: { model: "m1", messages: [] }, headers: {} } });

    expect(await waitFor(() => calls("gateway_chunk").length > 0)).toBe(true);
    await new Promise((r) => setTimeout(r, 150));

    // Neither finished nor errored: it just stopped.
    expect(calls("gateway_done").length).toBe(0);
    // Strictly better than before: the probe now runs BEFORE turn 1 instead of after it, so
    // a dead client is caught without ever calling the model or the sandbox. Previously the
    // disconnect surfaced only at the next turn boundary — after turn 1 had run its tool and
    // its tokens had been paid for.
    expect(h.genCalls.length).toBe(0);
    expect(calls("gateway_tool_run").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The status handed to the client when a request fails.
// ---------------------------------------------------------------------------

/**
 * `AllAttemptsFailedError` is the only thing that knows the upstream status, so the failure path
 * reads it instead of pattern-matching the message. Before this it chose the status with
 * `/no route|not found/i.test(msg) ? 404 : 502`, which reported every schema rejection as 502 —
 * "the gateway is broken" — inviting a retry for a request that can never succeed.
 */
describe("gatewayStatus", () => {
  const attempt = (status: number, cls: string) =>
    ({
      candidate: {
        provider: { id: "p", slug: "agnes" },
        key: { id: "k", label: "key-01" },
        model: { nativeId: "agnes-2.5-flash" },
      },
      cls,
      status,
    }) as unknown as AttemptOutcome;

  const failed = (status: number, cls: string) =>
    new AllAttemptsFailedError("agnes/agnes-2.5-flash", [attempt(status, cls)]);

  it("reports the upstream status when the client's own request was the cause", () => {
    expect(gatewayStatus(failed(400, "BAD_REQUEST_SCHEMA"), "all attempts failed")).toBe(400);
    expect(gatewayStatus(failed(429, "RATE_LIMITED"), "all attempts failed")).toBe(429);
    expect(gatewayStatus(failed(404, "NOT_FOUND"), "all attempts failed")).toBe(404);
  });

  it("does not pass through a status that is about our key, not the client's", () => {
    // A 401 here means *our* stored key was rejected. Echoing it would send the client hunting for
    // a credential problem it does not have.
    expect(gatewayStatus(failed(401, "AUTH_FAILED"), "all attempts failed")).toBe(502);
    expect(gatewayStatus(failed(500, "SERVER_ERROR"), "all attempts failed")).toBe(502);
  });

  it("treats status 0 as a gateway-side failure", () => {
    // 0 means the attempt never reached the provider at all (DNS, TLS, timeout).
    expect(gatewayStatus(failed(0, "NETWORK"), "all attempts failed")).toBe(502);
  });

  it("falls back to the message only for errors that carry no attempt", () => {
    expect(gatewayStatus(new Error('no route for model "x"'), 'no route for model "x"')).toBe(404);
    expect(gatewayStatus(new Error("boom"), "boom")).toBe(502);
  });
});
