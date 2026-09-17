/**
 * Agent-loop unit tests (2026-09-17).
 *
 * The loop is pure: a fake `generate` (model) and a fake `ToolHost` drive it, so this tests
 * the orchestration — round-trips, denial, iteration cap — with no Tauri and no network.
 */
import { describe, it, expect } from "vitest";
import { runAgentLoop } from "./agentLoop";
import { AGENT_TOOLS } from "./registry";
import type { AgentEvent, GenerateFn, ToolHost } from "./types";
import type { ChatMessage, TextStream, ToolCall } from "@aiprovider/router";

function streamOf(...chunks: string[]): TextStream {
  return {
    chunks: (async function* () {
      for (const c of chunks) yield c;
    })(),
  };
}

/** A model script: each call to `generate` consumes one step. `calls` are emitted via onToolCall. */
function fakeModel(steps: Array<{ text: string; calls?: ToolCall[] }>): GenerateFn {
  let i = 0;
  return async (req) => {
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    step.calls?.forEach((c) => req.onToolCall?.(c));
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
});
