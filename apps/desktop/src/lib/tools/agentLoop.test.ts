/**
 * Agent-loop unit tests (2026-09-17).
 *
 * The loop is pure: a fake `generate` (model) and a fake `ToolHost` drive it, so this tests
 * the orchestration — round-trips, denial, iteration cap — with no Tauri and no network.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runAgentLoop, clampIterations, DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS_CAP } from "./agentLoop";
import { AGENT_TOOLS } from "./registry";
import type { AgentEvent, GenerateFn, ToolHost } from "./types";
import type { ChatMessage, TextStream, ToolCall } from "@aiprovider/router-core";

function streamOf(...chunks: string[]): TextStream {
  return {
    chunks: (async function* () {
      for (const c of chunks) yield c;
    })(),
  };
}

/** A model script: each call to `generate` consumes one step. `calls` are emitted via onToolCall;
 *  `truncated` fires `onFinish(undefined)` (a declared-finish stream that ended without one) and
 *  `finish` fires it with the given reason. Neither set = the manifest declares no selector, and
 *  the callback never fires. */
function fakeModel(
  steps: Array<{ text: string; calls?: ToolCall[]; truncated?: boolean; finish?: string }>,
): GenerateFn {
  let i = 0;
  return async (req) => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    step.calls?.forEach((c) => req.onToolCall?.(c));
    if (step.truncated) req.onFinish?.(undefined);
    else if (step.finish !== undefined) req.onFinish?.(step.finish);
    return streamOf(step.text);
  };
}

describe("runAgentLoop", () => {
  it("executes a tool call, feeds the result back, and returns the final answer", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const host: ToolHost = {
      async run(name, args) {
        calls.push({ name, args });
        return { ok: true, output: `result-for-${name}` };
      },
    };
    const events: AgentEvent[] = [];
    const model = fakeModel([
      { text: "Reading it.", calls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' }] },
      { text: "Here is the answer." },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      onEvent: (e) => events.push(e),
    });

    expect(out.text).toBe("Here is the answer.");
    expect(calls).toEqual([{ name: "read_file", args: { path: "a.txt" } }]);
    expect(events.map((e) => e.type)).toEqual([
      "assistant",
      "tool_call",
      "tool_result",
      "assistant",
      "done",
    ]);
    const result = events.find((e) => e.type === "tool_result");
    expect(result && result.type === "tool_result" && result.ok).toBe(true);
    expect(result && result.type === "tool_result" && result.result).toBe("result-for-read_file");
  });

  it("re-asks a truncated stream and returns the retried answer", async () => {
    // 2026-10-03, live on vice/deepseek-v4-flash: "First, let me check" arrived, the tool call
    // never did, and the old loop recorded the turn as a clean one-iteration success. A
    // declared-finish stream that ends without its finish reason is a truncation; the loop
    // re-asks the same iteration instead of accepting it.
    const events: AgentEvent[] = [];
    let calls = 0;
    const model: GenerateFn = async (req) => {
      calls += 1;
      if (calls === 1) {
        req.onFinish?.(undefined);
        return streamOf("First, let me check");
      }
      req.onFinish?.("stop");
      return streamOf("Here is the answer.");
    };

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host: { async run() { return { ok: true, output: "" }; } },
      onEvent: (e) => events.push(e),
    });

    expect(calls).toBe(2);
    expect(out.text).toBe("Here is the answer.");
    expect(out.truncated).toBe(false);
    expect(events).toContainEqual({ type: "truncation_retry", attempt: 1 });
  });

  it("flags the turn when every re-ask truncates too", async () => {
    const events: AgentEvent[] = [];
    let calls = 0;
    const model: GenerateFn = async (req) => {
      calls += 1;
      req.onFinish?.(undefined);
      return streamOf("First, let me che");
    };

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host: { async run() { return { ok: true, output: "" }; } },
      onEvent: (e) => events.push(e),
    });

    // The original attempt plus both re-asks, then the turn is accepted and flagged rather than
    // retried forever.
    expect(calls).toBe(3);
    expect(out.truncated).toBe(true);
    const done = events.find((e) => e.type === "done");
    expect(done && done.type === "done" && done.truncated).toBe(true);
  });

  it("accepts a finish-less turn without retrying when no finish selector is declared", async () => {
    // The interpreter fires onFinish only for a declared selector, so a callback that never fires
    // means the loop has no way to judge — the old behavior stands: one call, no retry.
    let calls = 0;
    const model: GenerateFn = async () => {
      calls += 1;
      return streamOf("just an answer");
    };

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host: { async run() { return { ok: true, output: "" }; } },
    });

    expect(calls).toBe(1);
    expect(out.text).toBe("just an answer");
    expect(out.truncated).toBe(false);
  });

  it("falls back to thinking-off when the model answers with reasoning only", async () => {
    // 2026-10-03, live on agentrouter/deepseek-v4-flash: ~8180 thinking deltas, zero text — the
    // whole output budget spent reasoning. LiteLLM's fallback pattern applied to our own failure
    // class: the engine classifies NO_OUTPUT with evidence, and the loop re-asks once with
    // thinking forced off — the one lever that works even against a provider that ignores
    // budget tokens.
    const events: AgentEvent[] = [];
    const reasoningFor: string[] = [];
    let calls = 0;
    const model: GenerateFn = async (req) => {
      calls += 1;
      reasoningFor.push(req.reasoning ?? "(unset)");
      if (calls === 1) {
        req.onReasoning?.("thinking hard");
        req.onFinish?.("length");
        return streamOf("");
      }
      req.onFinish?.("stop");
      return streamOf("Here is the answer.");
    };

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host: { async run() { return { ok: true, output: "" }; } },
      onEvent: (e) => events.push(e),
    });

    expect(calls).toBe(2);
    expect(reasoningFor).toEqual(["(unset)", "off"]);
    expect(out.text).toBe("Here is the answer.");
    expect(events).toContainEqual({ type: "no_output_retry", attempt: 1 });
  });

  it("fails loudly when even the thinking-off re-ask answers nothing", async () => {
    let calls = 0;
    const model: GenerateFn = async (req) => {
      calls += 1;
      req.onReasoning?.("still thinking");
      req.onFinish?.("length");
      return streamOf("");
    };

    await expect(
      runAgentLoop({
        model: "m",
        messages: [{ role: "user", content: "go" }],
        registry: AGENT_TOOLS,
        generate: model,
        host: { async run() { return { ok: true, output: "" }; } },
      }),
    ).rejects.toThrow(/re-asked once with thinking off/);
    expect(calls).toBe(2);
  });

  it("does not fall back when an empty stream carried no reasoning", async () => {
    // Empty text with a silent thinking channel is not the NO_OUTPUT class — that predicate is
    // "reasoning without an answer" (the engine files this shape PARSE_ERROR instead). This
    // model declares no finish selector either, so no callback ever fires.
    let calls = 0;
    const model: GenerateFn = async () => {
      calls += 1;
      return streamOf("");
    };

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host: { async run() { return { ok: true, output: "" }; } },
    });

    expect(calls).toBe(1);
    expect(out.text).toBe("");
  });

  it("honours a denial from the confirm gate without touching the host", async () => {
    const calls: Array<{ name: string }> = [];
    const host: ToolHost = {
      async run(name) {
        calls.push({ name });
        return { ok: true, output: "should-not-happen" };
      },
    };
    const events: AgentEvent[] = [];
    const model = fakeModel([
      { text: "x", calls: [{ id: "c1", name: "run_command", arguments: '{"program":"ls"}' }] },
      { text: "stop" },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      confirm: async () => false,
      onEvent: (e) => events.push(e),
    });

    expect(out.text).toBe("stop");
    expect(calls).toEqual([]); // host never ran
    const result = events.find((e) => e.type === "tool_result");
    expect(result && result.type === "tool_result" && result.ok).toBe(false);
    expect(result && result.type === "tool_result" && result.result).toContain("denied");
  });

  it("uses the gate's own reason when the refusal was not the user's doing", async () => {
    // Plan mode refuses a write itself. Telling the model "the user denied this" when the user was
    // never shown the call is what makes it rephrase the same edit instead of proposing a plan.
    const events: AgentEvent[] = [];
    const host: ToolHost = { async run() { return { ok: true, output: "should-not-happen" }; } };
    const model = fakeModel([
      { text: "x", calls: [{ id: "c1", name: "write_file", arguments: '{"path":"a","content":"b"}' }] },
      { text: "here is my plan" },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      confirm: async () => ({ allow: false, reason: "PLAN MODE: propose the change instead." }),
      onEvent: (e) => events.push(e),
    });

    expect(out.text).toBe("here is my plan");
    const result = events.find((e) => e.type === "tool_result");
    expect(result && result.type === "tool_result" && result.result).toBe("PLAN MODE: propose the change instead.");
  });

  it("still blames the user when a plain `false` denies the call", async () => {
    // The widened contract must not lose the old wording: an ordinary deny is still the user's.
    const events: AgentEvent[] = [];
    const host: ToolHost = { async run() { return { ok: true, output: "nope" }; } };
    const model = fakeModel([
      { text: "x", calls: [{ id: "c1", name: "write_file", arguments: '{"path":"a","content":"b"}' }] },
      { text: "ok" },
    ]);

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      confirm: async () => false,
      onEvent: (e) => events.push(e),
    });

    const result = events.find((e) => e.type === "tool_result");
    expect(result && result.type === "tool_result" && result.result).toContain("denied by the user");
  });

  it("stops at the iteration ceiling instead of looping forever", async () => {
    const events: AgentEvent[] = [];
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    // A model that ALWAYS calls a tool.
    const model = fakeModel([
      { text: "loop", calls: [{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }] },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      maxIterations: 3,
      onEvent: (e) => events.push(e),
    });

    const done = events.find((e) => e.type === "done");
    expect(done && done.type === "done" && done.iterations).toBe(3);
    expect(out.text).toBe("loop");
  });

  it("replays the assistant turn with tool_calls so providers accept the result", async () => {
    const seen: ChatMessage[][] = [];
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    const model = fakeModel([
      { text: "doing", calls: [{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }] },
      { text: "final" },
    ]);
    // Capture every message list handed to the model.
    const capturing: GenerateFn = async (req) => {
      seen.push(JSON.parse(JSON.stringify(req.messages)));
      return model(req);
    };

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: capturing,
      host,
    });

    // Second model call must include an assistant turn carrying tool_calls and a tool result.
    const second = seen[1];
    expect(second).toBeDefined();
    const assistantTurn = second.find((m) => m.role === "assistant");
    expect(assistantTurn?.tool_calls).toBeDefined();
    const toolTurn = second.find((m) => m.role === "tool");
    expect(toolTurn?.tool_call_id).toBe("c1");
    expect(toolTurn?.content).toBe("r");
  });

  it("never hands the model an empty tool result when the tool fails", async () => {
    // The Tauri host used to return `{ ok, output }` and drop `error`. On the failure path Rust
    // sends `output: ""` with the reason in `error`, so a refused program, an unusable workspace
    // root or a confined path all reached the model as a BLANK tool result. The model then
    // reported "the tool results came back empty, which is unusual" and had no way to say why.
    const seen: ChatMessage[][] = [];
    const host: ToolHost = { async run() { return { ok: false, output: "" }; } };
    const model = fakeModel([
      { text: "doing", calls: [{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }] },
      { text: "final" },
    ]);
    const capturing: GenerateFn = async (req) => {
      seen.push(JSON.parse(JSON.stringify(req.messages)));
      return model(req);
    };

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: capturing,
      host,
    });

    const toolTurn = seen[1]!.find((m) => m.role === "tool");
    expect(toolTurn?.content ?? "").not.toBe("");
    expect(toolTurn?.content).toContain("read_file");
  });

  it("pairs the result with the declared id even when the provider omits one", async () => {
    // `manifest-interpreter` emits `id: undefined` when a provider identifies no call (or the
    // manifest maps none). The assistant turn and the tool result must still agree — a result
    // naming a call the turn never declared is rejected with HTTP 400, which is the failure
    // that surfaced as "the router stops working after a tool call".
    const seen: ChatMessage[][] = [];
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    const model = fakeModel([
      { text: "doing", calls: [{ name: "read_file", arguments: '{"path":"a"}' }] },
      { text: "final" },
    ]);
    const capturing: GenerateFn = async (req) => {
      seen.push(JSON.parse(JSON.stringify(req.messages)));
      return model(req);
    };

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: capturing,
      host,
    });

    const second = seen[1];
    expect(second).toBeDefined();
    const assistantTurn = second.find((m) => m.role === "assistant");
    const declared = (assistantTurn?.tool_calls as Array<Record<string, unknown>>)[0];
    const toolTurn = second.find((m) => m.role === "tool");

    expect(typeof declared?.id).toBe("string");
    expect(declared?.id).not.toBe("");
    expect(toolTurn?.tool_call_id).toBe(declared?.id);

    // And the entry is OpenAI's wire shape, not the flat internal `{id,name,arguments}`.
    expect(declared?.type).toBe("function");
    expect(declared?.function).toMatchObject({ name: "read_file" });
  });
});

describe("clampIterations", () => {
  // The ceiling is user-set, so these are the values a hand on a keyboard actually produces —
  // not the ones the type system allows.

  it("leaves a sane value alone", () => {
    for (const n of [1, 2, 8, 25, MAX_ITERATIONS_CAP]) {
      expect(clampIterations(n)).toBe(n);
    }
  });

  it("caps a value that would be a slow way to burn tokens", () => {
    // 5000 is not a different setting from 50, it is 50 with the answer arriving later.
    expect(clampIterations(5000)).toBe(MAX_ITERATIONS_CAP);
    expect(clampIterations(Number.MAX_SAFE_INTEGER)).toBe(MAX_ITERATIONS_CAP);
  });

  it("floors a value below one rather than running zero rounds", () => {
    // A zero-step loop would return an empty answer and report success.
    expect(clampIterations(0)).toBe(1);
    expect(clampIterations(-12)).toBe(1);
  });

  it("rounds a fractional value down", () => {
    expect(clampIterations(7.9)).toBe(7);
  });

  it("falls back to the default for input that is not a number at all", () => {
    // A corrupted setting should degrade to the value that works, not to a loop that gives up
    // immediately — 1 and "give up" look identical from the outside.
    for (const v of [NaN, Infinity, -Infinity, undefined, null, "twelve", {}, [], true]) {
      expect(clampIterations(v)).toBe(DEFAULT_MAX_ITERATIONS);
    }
  });

  it("accepts a numeric string, because that is what a text field produces", () => {
    expect(clampIterations("12")).toBe(12);
    expect(clampIterations("999")).toBe(MAX_ITERATIONS_CAP);
  });
});

describe("the tool-step ceiling has one source", () => {
  // The gateway bounds its own loop with the same number. Those were two separate `= 8`
  // constants kept in step by a comment — the kind of duplication that survives exactly until
  // someone edits one of them, at which point the gateway and the Assistant disagree about how
  // much a turn may spend and nothing fails.
  //
  // **Retargeted in 25f.** The gateway loop used to be `gateway-bridge.ts`, which imported
  // `DEFAULT_MAX_ITERATIONS` and so could not drift. 25f moved the loop into Rust
  // (`core/router_bridge.rs`, bounded by `core/bridge_policy.rs`), and a Rust `const` cannot
  // import a TypeScript one — so the guard becomes the comparison the import used to make for
  // free: read the Rust literal and require it to equal the Assistant's.
  const bridgePolicy = readFileSync(
    new URL("../../../src-tauri/src/core/bridge_policy.rs", import.meta.url),
    "utf8",
  );

  it("the Rust gateway's tool-step ceiling equals the Assistant's default", () => {
    const declared = [
      ...bridgePolicy.matchAll(/const MAX_TOOL_ITERATIONS\s*:\s*usize\s*=\s*(\d+);/g),
    ].map((m) => Number(m[1]));
    expect(declared).toHaveLength(1);
    expect(declared[0]).toBe(DEFAULT_MAX_ITERATIONS);
  });
});
