/**
 * Agent-loop unit tests (2026-09-17).
 *
 * The loop is pure: a fake `generate` (model) and a fake `ToolHost` drive it, so this tests
 * the orchestration — round-trips, denial, iteration cap — with no Tauri and no network.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  runAgentLoop, clampIterations, DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS_CAP,
  SUBAGENT_CONCURRENCY, SUBAGENT_HARD_BACKSTOP,
} from "./agentLoop";
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

  it("executes a batch of tool calls concurrently, not one at a time", async () => {
    // The batch the model emits in one turn is independent by construction; running it one call
    // at a time multiplies the wall clock by the batch size. This pins overlap: the second call
    // must already have started before the first one finished.
    const started: string[] = [];
    let overlapped = false;
    const host: ToolHost = {
      async run(name) {
        started.push(name);
        if (name === "read_file") {
          await Promise.resolve(); // yield once: a sequential loop has not started call 2 yet
          overlapped = started.includes("list_dir");
          return { ok: true, output: "slow-done" };
        }
        return { ok: true, output: "fast-done" };
      },
    };
    const model = fakeModel([
      {
        text: "batching",
        calls: [
          { id: "c1", name: "read_file", arguments: "{}" },
          { id: "c2", name: "list_dir", arguments: "{}" },
        ],
      },
      { text: "final" },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
    });

    expect(out.text).toBe("final");
    expect(overlapped, "the second call started before the first finished").toBe(true);
  });

  it("appends batch results in call order even when the later call finishes first", async () => {
    // A result belongs under the tool_call it answers, so the transcript is built in call order
    // — not in the order executions happened to complete. The first call here is held until the
    // second has long finished; the second model call must still see c1's result before c2's.
    let releaseFirst: () => void = () => {};
    const firstReleased = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const host: ToolHost = {
      async run(name) {
        if (name === "read_file") {
          await firstReleased;
          return { ok: true, output: "first-result" };
        }
        queueMicrotask(releaseFirst); // the fast call finishes first, then frees the slow one
        return { ok: true, output: "second-result" };
      },
    };
    const seen: ChatMessage[][] = [];
    const model = fakeModel([
      {
        text: "batching",
        calls: [
          { id: "c1", name: "read_file", arguments: "{}" },
          { id: "c2", name: "list_dir", arguments: "{}" },
        ],
      },
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

    const toolMsgs = seen[1]!.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
    expect(toolMsgs.map((m) => m.content)).toEqual(["first-result", "second-result"]);
  });

  it("still asks for approvals one at a time even in a batch", async () => {
    // Concurrency is for execution only. The confirm gate is the user's modal; two dialogs at
    // once is how approvals get rubber-stamped, so the gate must never be entered twice at once.
    let inConfirm = false;
    let overlapped = false;
    const confirm = async () => {
      if (inConfirm) overlapped = true;
      inConfirm = true;
      await Promise.resolve();
      inConfirm = false;
      return true;
    };
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    const model = fakeModel([
      {
        text: "batching",
        calls: [
          { id: "c1", name: "read_file", arguments: "{}" },
          { id: "c2", name: "list_dir", arguments: "{}" },
        ],
      },
      { text: "final" },
    ]);

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      confirm,
    });

    expect(overlapped, "the gate held one dialog at a time").toBe(false);
  });

  it("denies one call of a batch without blocking the others", async () => {
    const ran: string[] = [];
    const host: ToolHost = {
      async run(name) {
        ran.push(name);
        return { ok: true, output: `r-${name}` };
      },
    };
    const denied: string[] = [];
    const model = fakeModel([
      {
        text: "batching",
        calls: [
          { id: "c1", name: "write_file", arguments: '{"path":"a","content":"x"}' },
          { id: "c2", name: "read_file", arguments: "{}" },
        ],
      },
      { text: "final" },
    ]);

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      confirm: async (call) => {
        if (call.name === "write_file") {
          denied.push(call.name);
          return false;
        }
        return true;
      },
    });

    expect(denied).toEqual(["write_file"]);
    expect(ran, "the denied call never reached the host; its sibling ran").toEqual(["read_file"]);
  });

  it("delegates to a read-only sub-agent and keeps only its summary", async () => {
    // One shared model script serves both loops (fakeModel consumes steps in call order):
    // outer turn calls dispatch_agent, the sub-agent reads a file and answers, the outer turn
    // concludes on the summary. Everything the sub-agent did in between must stay out of the
    // parent's transcript — isolation is the entire point of delegating.
    const seenTools: (unknown[] | undefined)[] = [];
    const host: ToolHost = {
      async run(name, args) {
        expect(name, "only the sub-agent's read reached the host").toBe("read_file");
        expect(args).toEqual({ path: "a.txt" });
        return { ok: true, output: "file body" };
      },
    };
    const model = fakeModel([
      { text: "delegating", calls: [{ id: "c1", name: "dispatch_agent", arguments: '{"task":"find the answer"}' }] },
      { text: "looking", calls: [{ id: "s1", name: "read_file", arguments: '{"path":"a.txt"}' }] },
      { text: "SUB ANSWER" },
      { text: "final answer" },
    ]);
    const capturing: GenerateFn = async (req) => {
      seenTools.push(req.tools as unknown[] | undefined);
      return model(req);
    };

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: capturing,
      host,
    });

    expect(out.text).toBe("final answer");
    const toolResult = out.messages.find((m) => m.role === "tool");
    expect(toolResult?.content).toBe("SUB ANSWER");
    const dump = JSON.stringify(out.messages);
    expect(dump, "the sub-agent's intermediate turns never reached the parent").not.toContain("looking");
    expect(dump, "its tool output never reached the parent either").not.toContain("file body");
    // The sub-agent's registry is read-only and cannot recurse.
    const subTools = (seenTools[1] as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(subTools).toContain("read_file");
    expect(subTools, "no mutation in a sub-agent").not.toContain("write_file");
    expect(subTools, "no run_command in a sub-agent").not.toContain("run_command");
    expect(subTools, "a sub-agent cannot spawn sub-agents").not.toContain("dispatch_agent");
  });

  it("records a delegation as a child run under the parent's run id", async () => {
    // The Subagents screen is drawn from the ledger, so dispatch_agent must write rows, not just
    // run: the child's row names its parent, one tool_call step lands per sandbox call, and the
    // row ends with the child's real outcome.
    const started: Array<{ runId: string; parentRunId: string | null; prompt: string }> = [];
    const ended: Array<{ runId: string; status: string; iterations: number; error?: string }> = [];
    const steps: Array<{ runId: string; kind: string; label?: string }> = [];
    let childSeq = 0;
    const recorder = {
      newRunId: () => `child-${++childSeq}`,
      startRun: (a: { runId: string; parentRunId?: string | null; prompt?: string }) =>
        started.push({ runId: a.runId, parentRunId: a.parentRunId ?? null, prompt: a.prompt ?? "" }),
      recordStep: (runId: string, kind: string, label?: string) => steps.push({ runId, kind, label }),
      endRun: (runId: string, status: string, iterations: number, error?: string) =>
        ended.push({ runId, status, iterations, error }),
    };
    const host: ToolHost = { async run(name) { return { ok: true, output: `r-${name}` }; } };
    const model = fakeModel([
      { text: "delegating", calls: [{ id: "c1", name: "dispatch_agent", arguments: '{"task":"survey the files"}' }] },
      { text: "looking", calls: [{ id: "s1", name: "read_file", arguments: "{}" }] },
      { text: "SUB ANSWER" },
      { text: "final" },
    ]);

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      runId: "parent-1",
      subagentRecorder: recorder,
    });

    expect(started).toEqual([
      { runId: "child-1", parentRunId: "parent-1", prompt: "survey the files" },
    ]);
    // The child's read reached the sandbox through the recording host — one `tool_call` step,
    // and its outcome as a `tool_result` step (both halves, so the ledger answers "what came
    // back" and not only "what was called").
    expect(steps).toEqual([
      { runId: "child-1", kind: "tool_call", label: "read_file" },
      { runId: "child-1", kind: "tool_result", label: "read_file" },
    ]);
    // Two model round-trips (the tool turn and the answer) — the row's iterations.
    expect(ended).toEqual([{ runId: "child-1", status: "ok", iterations: 2, error: undefined }]);
  });

  it("records a failed delegation as an error row, not silence", async () => {
    const ended: Array<{ runId: string; status: string; error?: string }> = [];
    const recorder = {
      newRunId: () => "child-x",
      startRun: () => undefined,
      recordStep: () => undefined,
      endRun: (runId: string, status: string, _iterations: number, error?: string) =>
        ended.push({ runId, status, error }),
    };
    const model = fakeModel([
      { text: "delegating", calls: [{ id: "c1", name: "dispatch_agent", arguments: '{"task":"t"}' }] },
      { text: "final" },
    ]);
    // The sub-agent's own model call throws — the child run ends "error" and the parent still
    // gets a tool result it can read, rather than the turn collapsing.
    const generate: GenerateFn = async (req) => {
      const system = req.messages.find((m) => m.role === "system");
      if (system && /cannot modify the workspace/.test(String(system.content))) {
        throw new Error("model exploded");
      }
      return model(req);
    };

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate,
      host: { async run() { return { ok: true, output: "r" }; } },
      runId: "parent-1",
      subagentRecorder: recorder,
    });

    expect(out.text).toBe("final");
    expect(ended[0]?.status).toBe("error");
    expect(ended[0]?.error, "the row names the failure").toBeTruthy();
  });

  it("records a denied child call as a denied step, not a failed result", async () => {
    const steps: Array<{ runId: string; kind: string; label?: string; ok?: boolean }> = [];
    const recorder = {
      newRunId: () => "child-1",
      startRun: () => undefined,
      recordStep: (runId: string, kind: string, label?: string, _detail?: string, ok?: boolean) =>
        steps.push({ runId, kind, label, ok }),
      endRun: () => undefined,
    };
    const model = fakeModel([
      { text: "delegating", calls: [{ id: "c1", name: "dispatch_agent", arguments: '{"task":"t"}' }] },
      { text: "looking", calls: [{ id: "s1", name: "read_file", arguments: "{}" }] },
      { text: "SUB ANSWER" },
      { text: "final" },
    ]);

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host: { async run() { return { ok: true, output: "r" }; } },
      runId: "parent-1",
      subagentRecorder: recorder,
      // The gate rides into the child; a denial the child receives is recorded as `denied` —
      // the same word the parent's own recorder uses — rather than as a failed tool result.
      // The delegation itself is allowed, or the child would never run.
      confirm: async (call) => call.name === "dispatch_agent",
    });

    expect(steps).toEqual([{ runId: "child-1", kind: "denied", label: "read_file", ok: false }]);
  });

  it("dispatches a named specialist with its prompt, model, and narrowed toolset", async () => {
    // Capture what the child's round-trips asked for, then script the child to answer at once.
    const childRequests: Array<{ model: string; system: string; toolNames: string[] }> = [];
    const script = fakeModel([
      { text: "delegating", calls: [{ id: "c1", name: "dispatch_agent", arguments: '{"task":"t","agent":"locator"}' }] },
      { text: "final" },
    ]);
    const generate: GenerateFn = async (req, opts) => {
      if (req.model === "cheap/model") {
        childRequests.push({
          model: req.model,
          system: String(req.messages.find((m) => m.role === "system")?.content ?? ""),
          toolNames: ((req.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name),
        });
      }
      return script(req, opts);
    };
    const host: ToolHost = { async run(name) { return { ok: true, output: `r-${name}` }; } };

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate,
      host,
      subagentDefs: [
        {
          id: "locator",
          name: "Locator",
          description: "finds files fast",
          systemPrompt: "You locate files and nothing else.",
          tools: ["read_file"],
          model: "cheap/model",
          maxIterations: 3,
          enabled: true,
        },
      ],
    });

    expect(childRequests).toHaveLength(1);
    const child = childRequests[0]!;
    // The specialist's model override is used.
    expect(child.model).toBe("cheap/model");
    expect(child.system).toContain("You locate files and nothing else.");
    // The isolation half is the loop's, not the definition's to lose.
    expect(child.system).toContain("ONLY your final message is returned");
    // …and so is the batching instruction: a round is a turn, not a tool call, and asking for
    // several calls per turn is what keeps a turn budget from being a tool-call budget.
    expect(child.system).toContain("Batch independent tool calls into ONE message");
    // The allowlist narrows the toolset.
    expect(child.toolNames).toEqual(["read_file"]);
  });

  it("answers an unknown specialist id with the valid names instead of silently degrading", async () => {
    const events: AgentEvent[] = [];
    const model = fakeModel([
      { text: "delegating", calls: [{ id: "c1", name: "dispatch_agent", arguments: '{"task":"t","agent":"nope"}' }] },
      { text: "final" },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host: { async run() { return { ok: true, output: "r" }; } },
      onEvent: (e) => events.push(e),
      subagentDefs: [{ id: "locator", name: "Locator", description: "d", systemPrompt: "sp", enabled: true }],
    });

    const result = events.find((e) => e.type === "tool_result");
    expect(result && result.type === "tool_result" && result.ok).toBe(false);
    expect(result && result.type === "tool_result" && result.result).toContain("No sub-agent named");
    expect(result && result.type === "tool_result" && result.result).toContain("locator");
    expect(out.text).toBe("final");
  });

  it("lets a sub-agent run past the old twelve-round ceiling", async () => {
    // The child's default is **no ceiling**, and this pins the regression that motivated it:
    // every delegation reported "hit its step budget", because 12 rounds is ~12 tool calls in
    // this loop (one call per round) while real sub-agent work measures median 24 tool calls
    // and p90 55 across 433 recorded runs. A child that needs 16 rounds must finish.
    let childRounds = 0;
    const generate: GenerateFn = async (req) => {
      const system = String(req.messages.find((m) => m.role === "system")?.content ?? "");
      if (system.includes("ONLY your final message is returned")) {
        childRounds += 1;
        if (childRounds <= 15) {
          req.onToolCall?.({ id: `k${childRounds}`, name: "read_file", arguments: "{}" });
          return streamOf("sweeping");
        }
        return streamOf("SUB SUMMARY");
      }
      // The parent: delegate once, then answer on the round that carries the tool result.
      if (!req.messages.some((m) => m.role === "tool")) {
        req.onToolCall?.({ id: "c1", name: "dispatch_agent", arguments: '{"task":"sweep"}' });
        return streamOf("delegating");
      }
      return streamOf("final");
    };
    const events: AgentEvent[] = [];

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate,
      host: { async run() { return { ok: true, output: "r" }; } },
      onEvent: (e) => events.push(e),
    });

    expect(childRounds, "the child ran 16 rounds — past the old ceiling of 12").toBe(16);
    expect(out.text).toBe("final");
    const result = events.find((e) => e.type === "tool_result");
    expect(result && result.type === "tool_result" && result.result).toContain("SUB SUMMARY");
    expect(
      result && result.type === "tool_result" && result.result,
      "no budget warning — the work finished, it was not cut off",
    ).not.toContain("step budget");
  });

  it("caps how many sub-agents run at once, and still returns every summary", async () => {
    // The runaway that matters is *parallel* delegation, so the pool holds at most
    // `SUBAGENT_CONCURRENCY` children in flight — the bound ZCode also enforces (its only
    // limit-related failure in its whole run history is "user concurrency limit exceeded").
    // Five delegations in one batch must run in waves, and every summary must still come back.
    let inFlight = 0;
    let peak = 0;
    const generate: GenerateFn = async (req) => {
      const system = String(req.messages.find((m) => m.role === "system")?.content ?? "");
      if (system.includes("ONLY your final message is returned")) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20)); // hold the slot so overlap is observable
        inFlight -= 1;
        return streamOf("SUB DONE");
      }
      if (!req.messages.some((m) => m.role === "tool")) {
        const calls = Array.from({ length: 5 }, (_, i) => ({
          id: `c${i}`,
          name: "dispatch_agent",
          arguments: JSON.stringify({ task: `survey ${i}` }),
        }));
        calls.forEach((c) => req.onToolCall?.(c));
        return streamOf("delegating");
      }
      return streamOf("final");
    };
    const events: AgentEvent[] = [];

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate,
      host: { async run() { return { ok: true, output: "r" }; } },
      onEvent: (e) => events.push(e),
    });

    expect(peak, `never more than ${SUBAGENT_CONCURRENCY} children at once`).toBe(SUBAGENT_CONCURRENCY);
    expect(out.text).toBe("final");
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(5);
    for (const r of results) {
      expect(r.type === "tool_result" && r.result).toContain("SUB DONE");
    }
  });

  it("aborts a wedged sub-agent on the inactivity watchdog, and says so distinctly", async () => {
    // The failure a step ceiling cannot see: the child's request never returns, so no round ever
    // completes and no iteration is ever counted. ZCode arms the same watchdog (10 min); the
    // timeout is injected here so the test does not wait for it.
    const events: AgentEvent[] = [];
    const generate: GenerateFn = async (req, opts) => {
      const system = String(req.messages.find((m) => m.role === "system")?.content ?? "");
      if (system.includes("ONLY your final message is returned")) {
        // The child's model call hangs — a provider stream that never ends. It produces nothing
        // and only the abort ends it, which is what a real stream does when the signal fires
        // (the watchdog's abort is the only thing that can free it).
        return new Promise<never>((_, reject) => {
          const onAbort = () => reject(new DOMException("Agent loop aborted", "AbortError"));
          if (opts?.signal?.aborted) onAbort();
          else opts?.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (!req.messages.some((m) => m.role === "tool")) {
        req.onToolCall?.({ id: "c1", name: "dispatch_agent", arguments: '{"task":"hang"}' });
        return streamOf("delegating");
      }
      return streamOf("final");
    };

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate,
      host: { async run() { return { ok: true, output: "r" }; } },
      onEvent: (e) => events.push(e),
      subagentInactivityTimeoutMs: 60,
    });

    expect(out.text).toBe("final");
    const result = events.find((e) => e.type === "tool_result");
    expect(result && result.type === "tool_result" && result.ok).toBe(false);
    expect(
      result && result.type === "tool_result" && result.result,
      "the model is told it was wedged, not that it failed generically",
    ).toContain("made no progress");
  });

  it("caps a runaway sub-agent budget at the hard backstop, whatever its source", async () => {
    // Audit 2026-10-09: the backstop was applied only to the `null` default, so a typo of 5000 in
    // Router Settings produced a 5000-round child that nothing could bound — while the same value
    // in a specialist definition was clamped to 50. It is a ceiling on every path now.
    let childRounds = 0;
    const generate: GenerateFn = async (req) => {
      const system = String(req.messages.find((m) => m.role === "system")?.content ?? "");
      if (system.includes("ONLY your final message is returned")) {
        childRounds += 1;
        req.onToolCall?.({ id: `k${childRounds}`, name: "read_file", arguments: "{}" });
        return streamOf("working");
      }
      if (!req.messages.some((m) => m.role === "tool")) {
        req.onToolCall?.({ id: "c1", name: "dispatch_agent", arguments: '{"task":"t"}' });
        return streamOf("delegating");
      }
      return streamOf("final");
    };

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate,
      host: { async run() { return { ok: true, output: "r" }; } },
      // Absurd on purpose: this is the Router Settings typo the audit describes.
      subagentMaxIterations: 5000,
    });

    expect(out.text).toBe("final");
    expect(childRounds, "the child stopped at the backstop, not at 5000").toBe(SUBAGENT_HARD_BACKSTOP);
  }, 60_000);

  it("delegates without a recorder exactly as before", async () => {
    // Tests and the gateway bridge pass no recorder; the tool must not require one.
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    const model = fakeModel([
      { text: "delegating", calls: [{ id: "c1", name: "dispatch_agent", arguments: '{"task":"t"}' }] },
      { text: "SUB ANSWER" },
      { text: "final" },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
    });

    expect(out.text).toBe("final");
  });

  it("hands the parent's confirm gate to the sub-agent's calls", async () => {
    // In "ask every time" a sub-agent's reads must prompt exactly as the main loop's would —
    // a nested run must not be a permission upgrade.
    const asked: string[] = [];
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    const model = fakeModel([
      { text: "delegating", calls: [{ id: "c1", name: "dispatch_agent", arguments: '{"task":"t"}' }] },
      { text: "looking", calls: [{ id: "s1", name: "read_file", arguments: "{}" }] },
      { text: "SUB ANSWER" },
      { text: "final" },
    ]);

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      confirm: async (call) => {
        asked.push(call.name ?? "?");
        return true;
      },
    });

    expect(asked).toEqual(["dispatch_agent", "read_file"]);
  });

  it("rejects a dispatch_agent call with no task", async () => {
    const ran: string[] = [];
    const host: ToolHost = {
      async run(name) {
        ran.push(name);
        return { ok: true, output: "r" };
      },
    };
    const model = fakeModel([
      { text: "delegating", calls: [{ id: "c1", name: "dispatch_agent", arguments: "{}" }] },
      { text: "final" },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
    });

    expect(ran, "nothing ran without a task").toEqual([]);
    const toolResult = out.messages.find((m) => m.role === "tool");
    expect(toolResult?.content).toContain('needs a "task"');
  });

  it("generates an image, saves it base64-decoded through write_file, and attaches it", async () => {
    // The bytes the model sees must be attached as a content part (the read_image protocol), and
    // the bytes on disk must come from the sandbox decoding base64 — the loop writes with
    // `encoding: "base64"` and never treats the payload as text.
    const PNG_B64 = "iVBORw==";
    const writes: Array<{ name: string; args: Record<string, unknown> }> = [];
    const host: ToolHost = {
      async run(name, args) {
        writes.push({ name, args });
        return { ok: true, output: `wrote to ${String(args.path)}` };
      },
    };
    const model = fakeModel([
      { text: "drawing", calls: [{ id: "c1", name: "generate_image", arguments: '{"prompt":"a red circle"}' }] },
      { text: "done" },
    ]);
    const events: AgentEvent[] = [];

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      onEvent: (e) => events.push(e),
      generateImage: async () => ({ base64: PNG_B64 }),
    });

    const w = writes[0]!;
    expect(w.name).toBe("write_file");
    expect(w.args.encoding).toBe("base64");
    expect(w.args.content).toBe(PNG_B64);
    expect(String(w.args.path)).toMatch(/^images\/generated-\d+\.png$/);
    // The transcript carries the receipt plus a real image part, not the base64 as text.
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("generated and saved");
    const attach = out.messages.find((m) => m.role === "user" && Array.isArray(m.content));
    expect(JSON.stringify(attach)).toContain(PNG_B64);
    expect(JSON.stringify(out.messages)).not.toContain("READ_IMAGE:");
  });

  it("generate_image refuses with guidance when no image port exists", async () => {
    const ran: string[] = [];
    const host: ToolHost = {
      async run(name) {
        ran.push(name);
        return { ok: true, output: "r" };
      },
    };
    const model = fakeModel([
      { text: "drawing", calls: [{ id: "c1", name: "generate_image", arguments: '{"prompt":"x"}' }] },
      { text: "done" },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
    });

    expect(ran, "nothing ran without an image route").toEqual([]);
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("no image route is configured");
  });

  it("load_skill fetches the body on demand and reports a miss honestly", async () => {
    const requested: string[] = [];
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    const loadSkill = async (name: string) => {
      requested.push(name);
      return name === "review-checklist" ? "1. read the diff\n2. run the tests" : null;
    };
    const model = fakeModel([
      { text: "loading", calls: [{ id: "c1", name: "load_skill", arguments: '{"name":"review-checklist"}' }] },
      { text: "loading again", calls: [{ id: "c2", name: "load_skill", arguments: '{"name":"missing-skill"}' }] },
      { text: "done" },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      loadSkill,
    });

    expect(requested).toEqual(["review-checklist", "missing-skill"]);
    const toolMsgs = out.messages.filter((m) => m.role === "tool");
    expect(toolMsgs[0]!.content).toContain("1. read the diff");
    expect(toolMsgs[1]!.content).toContain('no enabled skill named "missing-skill"');
  });

  it("load_skill says there are no skills rather than failing opaquely without a port", async () => {
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    const model = fakeModel([
      { text: "loading", calls: [{ id: "c1", name: "load_skill", arguments: '{"name":"anything"}' }] },
      { text: "done" },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
    });

    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("no skills are installed");
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

  it("re-asks a reasoning-only answer even when the provider never reported a finish", async () => {
    // The same NO_OUTPUT shape as the test above, minus the finish report — a manifest that
    // declares no finish selector. Requiring the report left this shape accepted as an empty
    // answer: no flag, no retry, nothing on screen (found while fixing the 2026-10-06 incident,
    // where the blank bubble came from the ceiling instead). The reversal is the point: an empty
    // answer is not an answer, and what the provider says about stopping cannot change that.
    const events: AgentEvent[] = [];
    const reasoningFor: string[] = [];
    let calls = 0;
    const model: GenerateFn = async (req) => {
      calls += 1;
      reasoningFor.push(req.reasoning ?? "(unset)");
      if (calls === 1) {
        req.onReasoning?.("thinking hard");
        // No `onFinish` at all: the manifest declares no selector, so the callback never fires.
        return streamOf("");
      }
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

  it("summarizes the last tool activity when the ceiling hits on a tool-only turn", async () => {
    // The shape every real ceiling exit takes: the budget ran out mid tool_use, so the final
    // turn has no text. That used to return an empty answer — a dispatch_agent parent saw
    // "(the sub-agent returned an empty summary)" and could not tell where the budget went
    // (2026-10-06: a child spent 12 iterations on fetches that kept 403-ing and said nothing).
    const host: ToolHost = {
      async run() {
        return { ok: false, output: "HTTP 403 Forbidden" };
      },
    };
    const model = fakeModel([
      { text: "trying", calls: [{ id: "c1", name: "web_fetch", arguments: '{"url":"https://x.example"}' }] },
      { text: "", calls: [{ id: "c2", name: "web_fetch", arguments: '{"url":"https://y.example"}' }] },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      maxIterations: 2,
    });

    expect(out.hitCeiling).toBe(true);
    expect(out.text).toContain("step budget ran out during tool calls");
    expect(out.text).toContain("- web_fetch (FAILED): HTTP 403 Forbidden");
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

  it("hands the sandbox the same id the wire carries, synthesized when the model sent none", async () => {
    // **The Stop defect this pins.** The host call used `call.id`, which is `undefined` for a
    // provider that omits ids — while `toWireToolCalls` had already synthesized one for the wire.
    // With no id the host never invoked `tool_cancel` and the sandbox never registered the child,
    // so Stop reported "stopped by you" while a 60-second command kept running. One call, one id.
    const seen: ChatMessage[][] = [];
    const opts: { callId?: string }[] = [];
    const host: ToolHost = {
      async run(_name, _args, o) {
        if (o?.callId) opts.push({ callId: o.callId });
        return { ok: true, output: "r" };
      },
    };
    // A call with NO id, which is the shape this provider sends.
    const model: GenerateFn = fakeModel([
      { text: "", calls: [{ id: "", name: "read_file", arguments: "{}" }] },
      { text: "done" },
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

    const wireId = (seen[1]!.find((m) => m.role === "assistant")?.tool_calls as { id: string }[])[0]!.id;
    expect(wireId, "the wire id was synthesized").toBeTruthy();
    expect(opts.map((o) => o.callId), "the sandbox got the wire id, not undefined").toEqual([wireId]);
  });

  it("runs past the old eight-round default and ends on the model's own answer", async () => {
    // The default is no ceiling: a real task is not a fixed number of rounds, and the measured
    // failure of the alternative (2026-10-06) was a legitimate long task — "make the prompt library
    // a desktop app" — cut off mid-work by one. Twelve rounds proves the eight-round default is
    // gone; the ceiling machinery is still tested above, with an explicit budget.
    let calls = 0;
    const model: GenerateFn = async (req) => {
      calls += 1;
      if (calls <= 12) {
        req.onToolCall?.({ id: `c${calls}`, name: "read_file", arguments: "{}" });
        return streamOf("working");
      }
      return streamOf("finally, the answer");
    };
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
    });

    expect(calls, "twelve rounds ran").toBe(13);
    expect(out.text).toBe("finally, the answer");
    expect(out.hitCeiling, "and it ended on the answer, not a ceiling").toBe(false);
  });

  it("paces a long turn with a reminder on the system turn, three at most", async () => {
    // 110 rounds is past all three reminder thresholds (25, 50, 75) — a model that ignores every
    // reminder must hear the same thing at most three times rather than every round.
    const seen: ChatMessage[][] = [];
    let calls = 0;
    const model: GenerateFn = async (req) => {
      calls += 1;
      seen.push(JSON.parse(JSON.stringify(req.messages)));
      if (calls <= 110) {
        req.onToolCall?.({ id: `c${calls}`, name: "read_file", arguments: "{}" });
        return streamOf("working");
      }
      return streamOf("done");
    };
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      system: "You are an agent.",
    });

    const askedForMore = (messages: ChatMessage[]): boolean =>
      String(messages[0]?.content ?? "").includes("reflexively");
    const nudgedRounds = seen.map((m, i) => (askedForMore(m) ? i + 1 : 0)).filter(Boolean);
    // The 26th request is the first one made *after* the 25th call, so that is where the reminder
    // rides — then every 25 calls after it, capped at three.
    expect(nudgedRounds, "the first reminder rides the request after the 25th call").toEqual([26, 51, 76]);
    expect(seen.filter(askedForMore)).toHaveLength(3);
    // The reminder is a steering note, not a turn: it never enters the conversation the caller gets
    // back, so it cannot surface in the transcript or be replayed as if the user had said it.
    expect(
      seen[seen.length - 1]!.filter((m) => m.role === "user").map((m) => String(m.content)),
      "no synthetic user turn",
    ).toEqual(["go"]);
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

  it("reads input that is not a number at all as no ceiling, which is what a blank field means", () => {
    // The ceiling is the user's option now, and the field's blank state is how "no limit" is
    // asked for — so unparseable input degrades to the same place. It used to fall back to the
    // default 8, which was right while the ceiling was mandatory: back then, "no answer" and
    // "give up immediately" had to be told apart, and now there is a third state that is the
    // honest one. A corrupted setting should degrade to the value that works, and an unbounded
    // turn is the one the pacing nudge exists for.
    for (const v of [NaN, Infinity, -Infinity, undefined, null, "twelve", {}, [], true, ""]) {
      expect(clampIterations(v)).toBeNull();
    }
  });

  it("accepts a numeric string, because that is what a text field produces", () => {
    expect(clampIterations("12")).toBe(12);
    expect(clampIterations("999")).toBe(MAX_ITERATIONS_CAP);
  });
});

describe("the gateway's tool-step ceiling has one source", () => {
  // A number that is now the GATEWAY's alone: the Assistant's loop runs without a ceiling by
  // default (see `AgentLoopOptions.maxIterations`), while a client this app cannot see must never
  // be unbounded. The constant stayed because the cross-language pin is worth more than the
  // naming: those were two separate `= 8` constants kept in step by a comment — the kind of
  // duplication that survives exactly until someone edits one of them, at which point the gateway
  // and the desktop app disagree about how much a turn may spend and nothing fails.
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
