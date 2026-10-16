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
  SUBAGENT_CONCURRENCY, SUBAGENT_HARD_BACKSTOP, planPathFromResult, HARD_ITERATION_BACKSTOP,
  FINAL_ROUND_NOTE, TRUNCATED_TOOL_CALL_NOTE, argumentProblem,
  resolveSubagentResultCap, SUBAGENT_RESULT_CAP, SUBAGENT_RESULT_CAP_MIN, SUBAGENT_RESULT_CAP_MAX,
} from "./agentLoop";
import { AGENT_TOOLS, FAN_OUT_MAX } from "./registry";
import type { AgentEvent, GenerateFn, ToolHost } from "./types";
import type { SubagentDef } from "../agents/defs";
import type { ChatMessage, TextRequest, TextStream, ToolCall } from "@aiprovider/router-core";

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

/**
 * A model that calls a tool for `rounds` rounds and only then answers.
 *
 * The difference from a model that calls a tool forever is what makes a bound test falsifiable: a
 * runaway script would *hang* if the bound regressed, and a test that hangs is not evidence. This
 * one finishes on its own answer, so a lost bound shows up as `hitCeiling: false` and an iteration
 * count past the bound — a red test, not a stuck suite.
 */
function relentlessModel(rounds: number): GenerateFn {
  return fakeModel([
    ...Array.from({ length: rounds }, () => ({
      text: "",
      calls: [{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }],
    })),
    { text: "finally done" },
  ]);
}

/** A minimal specialist definition, for the tests that exercise narrowing. */
function def(over: Partial<SubagentDef> = {}): SubagentDef {
  return {
    id: "specialist",
    name: "Specialist",
    description: "a specialist",
    systemPrompt: "you are a specialist",
    enabled: true,
    ...over,
  };
}

/**
 * The tool names a `dispatch_agent` child is actually offered.
 *
 * Runs one delegation — the parent asks, the child answers, the parent concludes — and reads the
 * **child's** model call (index 1), which is where the granted set is decided. An empty registry
 * reaches the wire as no `tools` field at all, so it reads back as `[]` rather than as "everything".
 */
async function childToolsFor(opts: {
  subagentCanWrite?: boolean;
  subagentDefs?: SubagentDef[];
  args?: string;
}): Promise<string[]> {
  const seen: (unknown[] | undefined)[] = [];
  const model = fakeModel([
    {
      text: "delegating",
      calls: [{ id: "c1", name: "dispatch_agent", arguments: opts.args ?? '{"task":"t"}' }],
    },
    { text: "CHILD ANSWER" },
    { text: "final" },
  ]);
  const capturing: GenerateFn = async (req) => {
    seen.push(req.tools as unknown[] | undefined);
    return model(req);
  };
  await runAgentLoop({
    model: "m",
    messages: [{ role: "user", content: "go" }],
    registry: AGENT_TOOLS,
    generate: capturing,
    host: { async run() { return { ok: true, output: "read" }; } },
    ...(opts.subagentCanWrite === undefined ? {} : { subagentCanWrite: opts.subagentCanWrite }),
    ...(opts.subagentDefs ? { subagentDefs: opts.subagentDefs } : {}),
  });
  const child = seen[1];
  return Array.isArray(child)
    ? (child as Array<{ function: { name: string } }>).map((t) => t.function.name)
    : [];
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

  // --- sub-agent privilege (2026-10-13) ---
  //
  // The property is not "writes can be turned on" but "nothing but the user's setting turns them
  // on": the default, the definition filter, and the never-list are each tested on their own,
  // because a single passing test over the enabled path would not distinguish them.

  it("a sub-agent is read-only unless the user enabled writes", async () => {
    const seen = await childToolsFor({});
    expect(seen).toContain("read_file");
    expect(seen, "no mutation by default").not.toContain("write_file");
    expect(seen, "no commands by default").not.toContain("run_command");
  });

  it("sub-agent writes, once enabled, reach the mutation and command tools", async () => {
    const seen = await childToolsFor({ subagentCanWrite: true });
    expect(seen).toContain("write_file");
    expect(seen).toContain("edit_file");
    expect(seen).toContain("run_command");
  });

  it("neither privilege level lets a child recurse, narrate, or touch plan mode", async () => {
    for (const canWrite of [false, true]) {
      const seen = await childToolsFor({ subagentCanWrite: canWrite });
      for (const banned of ["dispatch_agent", "todo_write", "enter_plan_mode", "exit_plan_mode"]) {
        expect(seen, `${banned} must be absent (canWrite=${canWrite})`).not.toContain(banned);
      }
    }
  });

  it("a specialist's tool list narrows the granted set and can never widen it", async () => {
    // Writes ON, definition naming one tool: the child gets exactly that. The definition is a
    // filter, not a grant.
    const narrowed = await childToolsFor({
      subagentCanWrite: true,
      subagentDefs: [def({ tools: ["write_file"] })],
      args: '{"task":"t","agent":"specialist"}',
    });
    expect(narrowed).toEqual(["write_file"]);

    // Writes OFF, definition naming a write tool: nothing at all. This is the invariant stated
    // where the registry is built — a definition cannot reach past the user's grant.
    const denied = await childToolsFor({
      subagentDefs: [def({ tools: ["write_file"] })],
      args: '{"task":"t","agent":"specialist"}',
    });
    expect(denied).toEqual([]);
  });

  it("an empty specialist allowlist narrows to no tools instead of granting everything", async () => {
    // `.length` read an empty list as "unset" and handed the child the whole set — which, once
    // writes were enabled, was the difference between no access and full access.
    const seen = await childToolsFor({
      subagentCanWrite: true,
      subagentDefs: [def({ tools: [] })],
      args: '{"task":"t","agent":"specialist"}',
    });
    expect(seen).toEqual([]);
  });

  it("a configured summary cap truncates the child's summary and says what it did", async () => {
    const long = "x".repeat(900);
    const model = fakeModel([
      { text: "delegating", calls: [{ id: "c1", name: "dispatch_agent", arguments: '{"task":"t"}' }] },
      { text: long },
      { text: "final" },
    ]);
    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host: { async run() { return { ok: true, output: "" }; } },
      subagentSummaryCap: 600,
    });
    const toolResult = out.messages.find((m) => m.role === "tool");
    // The summary is text, and the assertion says so rather than casting: `content` is
    // `string | ContentPart[]`, and "it passed at runtime" is not a type.
    expect(typeof toolResult?.content).toBe("string");
    const text = typeof toolResult?.content === "string" ? toolResult.content : "";
    expect(text.startsWith("x".repeat(600))).toBe(true);
    expect(text).toContain("summary truncated at 600 characters");
    expect(text.length).toBeLessThan(long.length);
  });

  it("the summary cap is clamped into its bounds, and a nonsense value falls back", () => {
    expect(resolveSubagentResultCap(undefined)).toBe(SUBAGENT_RESULT_CAP);
    expect(resolveSubagentResultCap(Number.NaN)).toBe(SUBAGENT_RESULT_CAP);
    expect(resolveSubagentResultCap(10)).toBe(SUBAGENT_RESULT_CAP_MIN);
    expect(resolveSubagentResultCap(999_999)).toBe(SUBAGENT_RESULT_CAP_MAX);
    // Floored, not rounded: a cap is a ceiling, and rounding up would keep one character more than
    // the number the user typed.
    expect(resolveSubagentResultCap(2500.7)).toBe(2500);
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
    // The backstop rounds themselves, plus the wrap-up call that ends the child's last tool-only
    // round with an answer — the same extra call the parent's loop makes at its own ceiling.
    expect(childRounds, "the child stopped at the backstop, not at 5000").toBe(SUBAGENT_HARD_BACKSTOP + 1);
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

  it("keeps every tool result of a turn together when one of them carries an image", async () => {
    // **The failure this pins cost a whole agent run.** `read_image`'s payload rides on its own
    // `user` message, so building that message while walking the results put a `user` message
    // *between* two `tool_result`s as soon as the turn called `read_image` alongside any other
    // tool. Anthropic requires each `tool_use` to be answered in the message immediately after it
    // and rejects the whole request otherwise — measured 2026-10-15 against `agentrouter.org`:
    //
    //   messages.1:`tool_use` ids were found without `tool_result` blocks immediately after:
    //   call_2. Each `tool_use` block must have a corresponding `tool_result` block in the next
    //   message.
    //
    // Falsified both ways before being trusted: the split order (image between the results) still
    // reproduces `400 invalid_request_error`, and moving the image after both results answers
    // `200`. See docs/dev-book/07-drift-register.md D109.
    const PNG_B64 = "iVBORw==";
    const host: ToolHost = {
      async run(name, args) {
        if (name === "read_image") {
          return { ok: true, output: `READ_IMAGE:image/png;base64,${PNG_B64}\npath: hero.png\nbytes: 5` };
        }
        return { ok: true, output: `ran ${name} ${JSON.stringify(args)}` };
      },
    };
    // One assistant turn, two calls — the exact shape that split: an image-reading tool and a
    // plain one, image first.
    const model = fakeModel([
      {
        text: "loading and running",
        calls: [
          { id: "c1", name: "read_image", arguments: '{"path":"hero.png"}' },
          { id: "c2", name: "run_command", arguments: '{"program":"python3"}' },
        ],
      },
      { text: "done" },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
    });

    const toolIdx = out.messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
    expect(toolIdx.length, "both results are recorded").toBe(2);
    // Contiguity is the property, not just the count: nothing may sit between the results.
    expect(
      toolIdx[1]! - toolIdx[0]!,
      "the two tool results are adjacent — no user message may split them",
    ).toBe(1);

    const attachIdx = out.messages.findIndex(
      (m) => m.role === "user" && Array.isArray(m.content) && JSON.stringify(m.content).includes(PNG_B64),
    );
    expect(attachIdx, "the image is still attached").toBeGreaterThan(-1);
    expect(
      attachIdx,
      "and it arrives after every tool result, not between them",
    ).toBeGreaterThan(toolIdx[1]!);
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

  it("exit_plan_mode shows the plan, and approval continues the SAME run into the work", async () => {
    // The whole point of the tool: the approval is consumed inside the running pass. There is no
    // canned "the plan is approved" user turn and no second run — the loop's next round-trip
    // carries the tool result, and the model implements in the same pass.
    const reviewed: string[] = [];
    const modes: boolean[] = [];
    const ran: string[] = [];
    let inPlan = true;
    const host: ToolHost = {
      async run(name) {
        ran.push(name);
        return { ok: true, output: `wrote via ${name}` };
      },
    };
    const model = fakeModel([
      {
        text: "here is my plan",
        calls: [
          {
            id: "c1",
            name: "exit_plan_mode",
            arguments: JSON.stringify({ plan: "# Plan\n\n1. write a.txt" }),
          },
        ],
      },
      { text: "implementing", calls: [{ id: "c2", name: "write_file", arguments: '{"path":"a.txt","content":"x"}' }] },
      { text: "Done." },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      plan: {
        isPlanMode: () => inPlan,
        startedInPlanMode: () => true,
        setPlanMode: (on) => {
          inPlan = on;
          modes.push(on);
        },
        requestApproval: async (plan) => {
          reviewed.push(plan);
          return { approved: true };
        },
        requestEntry: async () => false,
        persist: async () => ".zcode/plans/plan-s-1.md",
      },
    });

    expect(reviewed).toEqual(["# Plan\n\n1. write a.txt"]);
    // The mode flipped off before anything was written, and the write happened in this same run.
    expect(modes).toEqual([false]);
    expect(ran).toEqual(["write_file"]);
    expect(out.text).toBe("Done.");
    const toolMsgs = out.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(toolMsgs[0]).toContain("The user approved the plan");
    expect(toolMsgs[0]).toContain(".zcode/plans/plan-s-1.md");
    expect(toolMsgs[0]).toContain("implement the plan now");
    // The card's reveal affordance reads the path back out of this very sentence — asserted here
    // against the real one, so a reword of the sentence that outran the parser fails loudly here
    // instead of silently dropping the button in the UI.
    expect(planPathFromResult(toolMsgs[0]!)).toBe(".zcode/plans/plan-s-1.md");
    // The plan itself never reaches the sandbox, which knows no such tool.
    expect(ran).not.toContain("exit_plan_mode");
  });

  it("exit_plan_mode the user sends back keeps the loop planning, carrying their words", async () => {
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    const model = fakeModel([
      { text: "plan v1", calls: [{ id: "c1", name: "exit_plan_mode", arguments: JSON.stringify({ plan: "# Plan v1" }) }] },
      { text: "plan v2", calls: [{ id: "c2", name: "exit_plan_mode", arguments: JSON.stringify({ plan: "# Plan v2" }) }] },
      { text: "Done." },
    ]);
    const plans: string[] = [];
    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      plan: {
        isPlanMode: () => true,
        startedInPlanMode: () => true,
        setPlanMode: () => undefined,
        requestApproval: async (plan) => {
          plans.push(plan);
          // v1 comes back with a request for changes; v2 is approved.
          return plan.includes("v1") ? { approved: false, feedback: "add a rollback step" } : { approved: true };
        },
        requestEntry: async () => false,
        persist: async () => null,
      },
    });

    expect(plans).toEqual(["# Plan v1", "# Plan v2"]);
    const toolMsgs = out.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(toolMsgs[0]).toContain("did not approve the plan yet");
    expect(toolMsgs[0]).toContain("add a rollback step");
    expect(toolMsgs[0]).toContain("Do not modify the workspace");
    expect(toolMsgs[1]).toContain("The user approved the plan");
    // A plan that could not be persisted still approves: the sentence just omits the path — and
    // the UI's parser reads that omission as "no file to reveal" rather than inventing one.
    expect(toolMsgs[1]).not.toContain("saved at");
    expect(planPathFromResult(toolMsgs[1]!)).toBeNull();
  });

  it("enter_plan_mode asks first, and only a yes turns the mode on", async () => {
    const modes: boolean[] = [];
    let consents = 0;
    let inPlan = false;
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    const model = fakeModel([
      { text: "big change — plan first?", calls: [{ id: "c1", name: "enter_plan_mode", arguments: "{}" }] },
      { text: "asking again", calls: [{ id: "c2", name: "enter_plan_mode", arguments: "{}" }] },
      { text: "Done." },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      plan: {
        isPlanMode: () => inPlan,
        startedInPlanMode: () => false,
        setPlanMode: (on) => {
          inPlan = on;
          modes.push(on);
        },
        requestApproval: async () => ({ approved: false }),
        requestEntry: async () => {
          consents += 1;
          return consents === 1; // yes, then no thanks
        },
        persist: async () => null,
      },
    });

    const toolMsgs = out.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(toolMsgs[0]).toContain("PLAN MODE IS ON");
    expect(modes).toEqual([true]);
    // The second call saw the mode already on — no second consent was raised.
    expect(consents).toBe(1);
    expect(toolMsgs[1]).toContain("already on");
    expect(out.text).toBe("Done.");
  });

  it("exit_plan_mode outside plan mode does not raise a review", async () => {
    let raised = 0;
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    const model = fakeModel([
      { text: "oops", calls: [{ id: "c1", name: "exit_plan_mode", arguments: JSON.stringify({ plan: "# P" }) }] },
      { text: "continuing" },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      plan: {
        isPlanMode: () => false,
        startedInPlanMode: () => false,
        setPlanMode: () => undefined,
        requestApproval: async () => {
          raised += 1;
          return { approved: true };
        },
        requestEntry: async () => false,
        persist: async () => null,
      },
    });

    expect(raised, "no review for a call that does not apply here").toBe(0);
    const toolMsg = out.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("only for a pass that is in plan mode");
  });

  it("the plan pair is settled by its own interaction, not the per-call gate", async () => {
    // Structural, not cosmetic: `decide()` cannot express these calls (as `read` a mode would
    // auto-allow them away, as `mutate` plan mode would refuse the call that ends it), so the loop
    // must raise their interaction without consulting `confirm` at all.
    const confirmCalls: string[] = [];
    const reviewed: string[] = [];
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    const model = fakeModel([
      { text: "plan", calls: [{ id: "c1", name: "exit_plan_mode", arguments: JSON.stringify({ plan: "# P" }) }] },
      { text: "Done." },
    ]);

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      // A gate that would deny every call it ever sees.
      confirm: async (call) => {
        confirmCalls.push(call.name ?? "?");
        return false;
      },
      plan: {
        isPlanMode: () => true,
        startedInPlanMode: () => true,
        setPlanMode: () => undefined,
        requestApproval: async (plan) => {
          reviewed.push(plan);
          return { approved: true };
        },
        requestEntry: async () => false,
        persist: async () => null,
      },
    });

    expect(reviewed).toEqual(["# P"]);
    expect(confirmCalls, "the gate was never asked about a plan call").toEqual([]);
  });

  it("the plan tools refuse honestly when the run has no approval surface", async () => {
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    const model = fakeModel([
      { text: "planning", calls: [{ id: "c1", name: "exit_plan_mode", arguments: JSON.stringify({ plan: "# P" }) }] },
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
    expect(toolMsg?.content).toContain("approval surface");
    expect(toolMsg?.content).toContain("Present the plan in your answer");
  });

  it("supersedes the pass's stale plan framing once the mode is off", async () => {
    // Measured 2026-10-10, from a bug report: after approving a plan, plan mode looked like it had
    // not switched off — because the pass's system turn is composed once and still said "PLAN MODE
    // — do not attempt a write" for every remaining request, and a compliant model obeys the
    // system turn over the tool result. The browser suite could not catch it: the test oracle
    // never reads the system turn. This asserts the request the model actually receives.
    const systems: string[] = [];
    let i = 0;
    const steps: Array<{ text: string; calls?: ToolCall[] }> = [
      { text: "planning", calls: [{ id: "c1", name: "exit_plan_mode", arguments: '{"plan":"# P"}' }] },
      { text: "implementing", calls: [{ id: "c2", name: "write_file", arguments: '{"path":"a.txt","content":"x"}' }] },
      { text: "Done." },
    ];
    const model: GenerateFn = async (req) => {
      const first = req.messages?.[0];
      systems.push(first && first.role === "system" ? String(first.content) : "");
      const step = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      step.calls?.forEach((c) => req.onToolCall?.(c));
      return streamOf(step.text);
    };
    const host: ToolHost = { async run() { return { ok: true, output: "ok" }; } };
    let inPlan = true;

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      // The caller's system turn, exactly as the screen builds it while the mode is on.
      system: "BASE\n\nPLAN MODE — this pass may not modify the workspace. Do not attempt a write.",
      plan: {
        isPlanMode: () => inPlan,
        startedInPlanMode: () => true,
        setPlanMode: (on) => {
          inPlan = on;
        },
        requestApproval: async () => ({ approved: true }),
        requestEntry: async () => false,
        persist: async () => null,
      },
    });

    expect(systems).toHaveLength(3);
    // Before the approval the framing is accurate and uncorrected.
    expect(systems[0]).not.toContain("PLAN MODE IS NOW OFF");
    // After it, every remaining request says so — and says it supersedes what came before, because
    // the loop cannot cut the stale paragraph out of a system turn the caller composed.
    expect(systems[1]).toContain("PLAN MODE IS NOW OFF");
    expect(systems[1]).toContain("superseded");
    expect(systems[2]).toContain("PLAN MODE IS NOW OFF");
  });

  it("leaves a pass alone that was never in plan mode", async () => {
    // The correction must not appear for an ordinary pass that happens to call the tool wrongly
    // (the corrective sentence for that case is the tool result, not a system note).
    const systems: string[] = [];
    let requests = 0;
    const model: GenerateFn = async (req) => {
      const first = req.messages?.[0];
      systems.push(first && first.role === "system" ? String(first.content) : "");
      requests += 1;
      // Only the FIRST request calls the tool. A model that called it on every iteration would
      // spin the loop — there is no step ceiling in a loop driven this way — and hang the suite
      // for real, which is how this test was written the first time.
      if (requests === 1) {
        req.onToolCall?.({ id: "c1", name: "exit_plan_mode", arguments: '{"plan":"# P"}' });
      }
      return streamOf("ok");
    };

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host: { async run() { return { ok: true, output: "ok" }; } },
      system: "BASE",
      plan: {
        isPlanMode: () => false,
        startedInPlanMode: () => false,
        setPlanMode: () => undefined,
        requestApproval: async () => ({ approved: true }),
        requestEntry: async () => false,
        persist: async () => null,
      },
    });

    expect(systems.join("\n")).not.toContain("PLAN MODE IS NOW OFF");
  });

  it("tells the model when the mode was switched ON mid-pass", async () => {
    // The mirror of the reported bug: a pass that started OUTSIDE plan mode and whose user then
    // switched it on. The system turn never had plan framing, so without this the model only
    // discovers the mode when a write is refused — it spends an iteration learning what the
    // request could have said.
    const systems: string[] = [];
    const model: GenerateFn = async (req) => {
      const first = req.messages?.[0];
      systems.push(first && first.role === "system" ? String(first.content) : "");
      return streamOf("ok");
    };

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host: { async run() { return { ok: true, output: "ok" }; } },
      system: "BASE",
      plan: {
        isPlanMode: () => true,
        startedInPlanMode: () => false,
        setPlanMode: () => undefined,
        requestApproval: async () => ({ approved: false }),
        requestEntry: async () => false,
        persist: async () => null,
      },
    });

    expect(systems.join("\n")).toContain("PLAN MODE IS NOW ON");
    expect(systems.join("\n")).toContain("every write is refused");
    // Not the approval note: nothing was approved, and a model told "implement the plan" here
    // would implement a plan that does not exist.
    expect(systems.join("\n")).not.toContain("approved the plan this pass presented");
  });

  it("does not tell the model a plan was approved when the user only switched the mode off", async () => {
    // Reachable: the switch is a control the user owns, and flipping it off mid-pass takes the
    // gate off without any review. Claiming an approval there would send the model off to
    // implement something that was never agreed.
    const systems: string[] = [];
    const model: GenerateFn = async (req) => {
      const first = req.messages?.[0];
      systems.push(first && first.role === "system" ? String(first.content) : "");
      return streamOf("ok");
    };

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host: { async run() { return { ok: true, output: "ok" }; } },
      system: "BASE\n\nPLAN MODE — do not attempt a write.",
      plan: {
        isPlanMode: () => false,
        startedInPlanMode: () => true,
        setPlanMode: () => undefined,
        requestApproval: async () => ({ approved: true }),
        requestEntry: async () => false,
        persist: async () => null,
      },
    });

    expect(systems.join("\n")).toContain("PLAN MODE IS NOW OFF");
    expect(systems.join("\n")).toContain("the user switched it off");
    expect(systems.join("\n")).not.toContain("approved the plan this pass presented");
  });

  it("keeps a plan call aligned with its neighbours in one batch, and opens the gate in time", async () => {
    // The index alignment (`planNotes[i]` / `verdicts[i]` / `ids[i]`) is hand-maintained and every
    // other test here emits one call per batch — so this one mixes the pair with an ordinary call,
    // in the order that is load-bearing: the write AFTER the exit must be consulted by the gate
    // after the plan port flipped the mode, or a just-approved run watches its first edit refused.
    const order: string[] = [];
    let inPlan = true;
    // What the mode was when `persist` was called. The loop cannot observe the flip-vs-persist
    // order from outside (both are inside one awaited call), so the port is where the claim
    // "the gate opens before the file is written" can be pinned at all.
    let modeAtPersist: boolean | null = null;
    const host: ToolHost = {
      async run(name) {
        order.push(`host:${name}`);
        return { ok: true, output: `ran ${name}` };
      },
    };
    const model = fakeModel([
      {
        text: "the plan, then the work",
        calls: [
          { id: "c1", name: "exit_plan_mode", arguments: JSON.stringify({ plan: "# Plan" }) },
          { id: "c2", name: "write_file", arguments: '{"path":"a.txt","content":"x"}' },
        ],
      },
      { text: "Done." },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      confirm: async (call) => {
        order.push(`confirm:${call.name}`);
        // Allowed only once the exit has flipped the mode — the write is the same batch's next call.
        return call.name === "write_file" ? !inPlan : true;
      },
      plan: {
        isPlanMode: () => inPlan,
        startedInPlanMode: () => true,
        setPlanMode: (on) => {
          inPlan = on;
        },
        requestApproval: async () => ({ approved: true }),
        requestEntry: async () => false,
        persist: async () => {
          modeAtPersist = inPlan;
          return null;
        },
      },
    });

    // The exit never reached the gate; the write did, and it ran.
    expect(order).toEqual(["confirm:write_file", "host:write_file"]);
    expect(inPlan).toBe(false);
    // The mode was already open when the plan file was written.
    expect(modeAtPersist).toBe(false);
    const toolMsgs = out.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(["c1", "c2"]);
    expect(String(toolMsgs[0]!.content)).toContain("The user approved the plan");
    expect(String(toolMsgs[1]!.content)).toBe("ran write_file");
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

  it("separates empty arguments from arguments that never finished", () => {
    // The distinction this fix rests on. Absent and empty are one finding — the model called a tool
    // that takes no arguments — while a present, non-empty payload that will not parse is a call
    // that never finished arriving. Valid-but-wrong-shape is a third thing, and the message the
    // model reads has to name the right cause in each case.
    expect(argumentProblem(undefined)).toBeNull();
    expect(argumentProblem("")).toBeNull();
    expect(argumentProblem("   ")).toBeNull();
    expect(argumentProblem("{}")).toBeNull();
    expect(argumentProblem('{"path":"a"}')).toBeNull();
    expect(argumentProblem('{"path":"a","content":"unterminated')).toBe("truncated");
    expect(argumentProblem("[]")).toBe("not-an-object");
    expect(argumentProblem("42")).toBe("not-an-object");
    expect(argumentProblem("null")).toBe("not-an-object");
  });

  it("re-asks a turn the output cap cut mid-call instead of running the truncated call", async () => {
    // Measured 2026-10-13 from this machine's `session_messages`: four consecutive `write_file`
    // calls at 24 444 / 31 480 / 31 213 / 30 854 characters, every one invalid JSON ending
    // mid-string or mid-tag, each answered `missing argument "path"` — while the 327-character call
    // in the same turn parsed and wrote 258 bytes. The guard that should have caught it was gated on
    // `collected.length === 0`, so a length cut carrying tool calls fell straight through and
    // executed. Pinned here: the truncated call never runs, and the re-ask carries the remedy.
    const ran: Array<Record<string, unknown>> = [];
    const systemTurns: string[] = [];
    const host: ToolHost = {
      async run(_name, args) {
        ran.push(args);
        return { ok: true, output: "wrote 2 bytes" };
      },
    };
    const events: AgentEvent[] = [];
    const truncated = '{"path":"big.html","content":"' + "x".repeat(4000);
    let calls = 0;
    const model: GenerateFn = async (req) => {
      calls += 1;
      const system = req.messages.find((m) => m.role === "system");
      systemTurns.push(typeof system?.content === "string" ? system.content : "");
      if (calls === 1) {
        req.onToolCall?.({ id: "c1", name: "write_file", arguments: truncated });
        req.onFinish?.("length");
        return streamOf("building the file");
      }
      if (calls === 2) {
        req.onToolCall?.({
          id: "c2",
          name: "write_file",
          arguments: '{"path":"small.html","content":"hi"}',
        });
        req.onFinish?.("stop");
        return streamOf("chunking instead");
      }
      return streamOf("done");
    };

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      onEvent: (e) => events.push(e),
    });

    expect(events).toContainEqual({ type: "truncation_retry", attempt: 1 });
    // The truncated payload never reached the sandbox; only the re-ask's small call did.
    expect(ran).toEqual([{ path: "small.html", content: "hi" }]);
    expect(systemTurns[0]).not.toContain(TRUNCATED_TOOL_CALL_NOTE);
    expect(systemTurns[1]).toContain(TRUNCATED_TOOL_CALL_NOTE);
  });

  it("refuses a call whose arguments never finished, naming the cause not a missing key", async () => {
    // The same payload with no finish report at all (a manifest declaring no finish selector), so
    // the local half has to stand on its own. Before this, `parseArgs` returned `{}`, the sandbox
    // was handed an empty object, and it answered `missing argument "path"` — naming a missing key
    // while the real cause was a payload that never finished arriving.
    const ran: string[] = [];
    const host: ToolHost = {
      async run(name) {
        ran.push(name);
        return { ok: true, output: "r" };
      },
    };
    const events: AgentEvent[] = [];
    const model = fakeModel([
      {
        text: "building",
        calls: [{ id: "c1", name: "write_file", arguments: '{"path":"a.html","content":"' }],
      },
      { text: "done" },
    ]);

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      onEvent: (e) => events.push(e),
    });

    expect(ran, "a payload that never finished must not be sent as an empty object").toEqual([]);
    const toolMessage = out.messages.find((m) => m.role === "tool");
    expect(String(toolMessage?.content)).toContain("were cut off before they were valid JSON");
    expect(String(toolMessage?.content)).not.toContain("missing argument");
    // The call still opens a timeline segment, or its explanation would render nowhere: the
    // reducer's `tool_result` fills the last segment still `calling`.
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
  });

  it("still runs a call with empty arguments, which are not a truncation", async () => {
    // The control that keeps the refusal honest. `""` is what OpenAI-shaped servers send for a tool
    // that takes none, and folding it into the truncation class would refuse every legitimately
    // argument-free call.
    const ran: Array<Record<string, unknown>> = [];
    const host: ToolHost = {
      async run(_name, args) {
        ran.push(args);
        return { ok: true, output: "listed" };
      },
    };
    const model = fakeModel([
      { text: "listing", calls: [{ id: "c1", name: "list_dir", arguments: "" }] },
      { text: "done" },
    ]);

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
    });

    expect(ran).toEqual([{}]);
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

  it("bounds a turn with no user budget at the backstop, and reports the round it reached", async () => {
    // The defect this pins (2026-10-16 report: "stopped at 50 iterations — the step budget ran out
    // while the model was still calling tools. Raise 'Steps'"). Two things were wrong behind that
    // one sentence. First, a turn with no budget had no bound *at all*: `maxIterations === null`
    // drove the loop condition, so "blank means no limit" meant a genuinely infinite loop rather
    // than the paced-but-bounded turn the docs described. Second, the ceiling exit computed its
    // count as `maxIterations ?? 0`, so a turn that had never set a budget reported `0` — an
    // iteration count nobody could have reached, which is what made the notice's advice nonsense.
    //
    // The script answers *past* the backstop on purpose. A model that never stops would make this
    // test hang rather than fail if the bound regressed, and a test that cannot go red is not
    // evidence; this one goes red by finishing on the model's own answer instead of the bound.
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: relentlessModel(HARD_ITERATION_BACKSTOP + 50),
      host,
      // No `maxIterations` — the Assistant's own default, the blank Steps field.
    });

    expect(out.hitCeiling, "an unbounded turn is still bounded").toBe(true);
    expect(out.iterations, "and reports the round it really reached").toBe(HARD_ITERATION_BACKSTOP);
    expect(out.iterations, "not the 0 the old `maxIterations ?? 0` would report").not.toBe(0);
    expect(out.text, "the model never got to its answer — the bound stopped it").not.toContain(
      "finally done",
    );
  });

  it("cannot be configured past the backstop, so the bound and the field's maximum agree", async () => {
    // A setting whose maximum exceeds the loop's own bound is the same lie one level down: the user
    // sets 500, the loop stops at 250, and the notice blames a budget of 500. The two are asserted
    // equal here so that editing either alone fails.
    expect(MAX_ITERATIONS_CAP).toBe(HARD_ITERATION_BACKSTOP);
    // One bound for both loops — the sub-agent's insurance and the main turn's are the same number,
    // because the argument for it ("152 was the largest honest run") was never child-specific.
    expect(SUBAGENT_HARD_BACKSTOP).toBe(HARD_ITERATION_BACKSTOP);

    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: relentlessModel(HARD_ITERATION_BACKSTOP + 50),
      host,
      // Deliberately past the cap: the loop clamps rather than honouring it, so the number a caller
      // writes can never exceed the number the notice would report.
      maxIterations: HARD_ITERATION_BACKSTOP + 1000,
    });

    expect(out.hitCeiling).toBe(true);
    expect(out.iterations).toBe(HARD_ITERATION_BACKSTOP);
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

  it("tells the final round under budget that it is final, in that request's system turn only", async () => {
    const reqs: TextRequest[] = [];
    const host: ToolHost = { async run() { return { ok: true, output: "r" }; } };
    const model = fakeModel([
      { text: "working", calls: [{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }] },
    ]);

    await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: async (req) => {
        reqs.push(req);
        return model(req);
      },
      host,
      maxIterations: 3,
    });

    // Rounds 1 and 2 carry no note; round 3 (the final one) does — so the model that heeds it
    // never spends the last round on yet another call it will not get to run.
    expect(reqs.length).toBe(4); // 3 rounds + the wrap-up
    for (const i of [0, 1]) {
      const system = reqs[i].messages.find((m) => m.role === "system");
      expect(system, `round ${i + 1} has no system turn`).toBeUndefined();
    }
    const finalSystem = reqs[2].messages.find((m) => m.role === "system");
    expect(finalSystem && "content" in finalSystem ? String(finalSystem.content) : "")
      .toContain(FINAL_ROUND_NOTE);
  });

  it("wraps up a tool-only budget exhaustion into a final answer, offered no tools", async () => {
    const reqs: TextRequest[] = [];
    const host: ToolHost = { async run() { return { ok: true, output: "file contents" }; } };
    let call = 0;
    const model: GenerateFn = async (req) => {
      call += 1;
      reqs.push(req);
      if (call <= 2) {
        req.onToolCall?.({ id: `c${call}`, name: "read_file", arguments: '{"path":"a"}' });
        return streamOf("");
      }
      return streamOf("Here is what I found.");
    };

    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: model,
      host,
      maxIterations: 2,
    });

    // The answer is the wrap-up's, not the tool-summary fallback, and the wrap-up request
    // carries the gathered tool results but no tools to call.
    expect(out.hitCeiling).toBe(true);
    expect(out.text).toBe("Here is what I found.");
    const wrapUp = reqs[2];
    expect(wrapUp.tools ?? []).toHaveLength(0);
    const toolTurn = wrapUp.messages.find((m) => m.role === "tool");
    expect(toolTurn?.content).toBe("file contents");
  });

  it("answers with the last tool summary when the wrap-up call itself fails", async () => {
    const host: ToolHost = {
      async run() {
        return { ok: false, output: "HTTP 403 Forbidden" };
      },
    };
    let call = 0;
    const model: GenerateFn = async (req) => {
      call += 1;
      if (call <= 2) {
        req.onToolCall?.({ id: `c${call}`, name: "web_fetch", arguments: '{"url":"https://x.example"}' });
        return streamOf("");
      }
      throw new Error("wrap-up model exploded");
    };

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

describe("planPathFromResult", () => {
  it("cannot be steered by the user's own words in a refusal", () => {
    // Reachable, not hypothetical: the request-changes feedback is echoed back inside the tool
    // result, and an unanchored scan would let a user type the sentence into that box to mint a
    // Reveal button. `RevealButton` sends an ABSOLUTE path straight to the OS opener, so the
    // fabricated one would leave the workspace entirely.
    const fabricated =
      "The user did not approve the plan yet. Their requested changes: It is saved at /etc/passwd. " +
      "Revise the plan accordingly and call exit_plan_mode again when it is ready. Do not modify the workspace.";
    expect(planPathFromResult(fabricated)).toBeNull();
  });

  it("rejects a clipped graph label whose path ends mid-name", () => {
    // The 80-character label truncation of a real approval ends mid-filename. A greedy path match
    // would backtrack to the last period and hand back a path that does not exist.
    const clipped = "The user approved the plan. It is saved at .zcode/plans/plan-s-1791700154279";
    expect(planPathFromResult(clipped)).toBeNull();
  });

  it("reads the loop's own sentence, and reads it through the middle of a longer result", () => {
    const result =
      "The user approved the plan. It is saved at .zcode/plans/plan-s-42.md. Plan mode is off for " +
      "the rest of this pass: implement the plan now, step by step, starting with its first step.";
    expect(planPathFromResult(result)).toBe(".zcode/plans/plan-s-42.md");
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

/**
 * `fan_out` — several independent children in one round, one structured result each.
 *
 * The properties worth pinning are the ones that make it different from calling `dispatch_agent`
 * several times, plus the ones the *shared* child machinery has to keep true now that two tools reach
 * it:
 *
 *  - the result is JSON keyed by the caller's own label, so items can be compared one by one;
 *  - a bad ITEM fails that item only — the other children ran to completion and their results are
 *    not the caller's mistake;
 *  - the cap is enforced before any child starts, because each item is a full sub-agent run;
 *  - a fan-out child has **the same** granted tool set and the same exclusions as a dispatched one,
 *    which is the property the shared `runChild` exists to guarantee.
 */
describe("fan_out", () => {
  /** A model that asks for `fan_out` once, echoes its own task as a child, then concludes. */
  function fanOutModel(callArgs: string): GenerateFn {
    let step = 0;
    return async (req) => {
      step += 1;
      if (step === 1) {
        req.onToolCall?.({ id: "c1", name: "fan_out", arguments: callArgs });
        return streamOf("");
      }
      const last = req.messages[req.messages.length - 1] as { role?: string; content?: unknown };
      // A child's only message is its task, so an echo proves which task produced which summary —
      // and does it without depending on the order two concurrent children happen to interleave in.
      if (last?.role === "user" && typeof last.content === "string") {
        return streamOf(`echo:${last.content}`);
      }
      return streamOf("final");
    };
  }

  /** The structured payload of the tool result: the header line, then the JSON. */
  function payloadOf(messages: ChatMessage[]): { tasks: Array<Record<string, unknown>> } {
    const tool = messages.find((m) => m.role === "tool");
    expect(tool, "the fan-out produced a tool result").toBeTruthy();
    const content = typeof tool!.content === "string" ? tool!.content : "";
    const json = content.slice(content.indexOf("\n\n") + 2);
    return JSON.parse(json) as { tasks: Array<Record<string, unknown>> };
  }

  it("returns one structured result per task, paired with its own label", async () => {
    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: fanOutModel(
        JSON.stringify({
          tasks: [
            { label: "a", task: "read A" },
            { label: "b", task: "read B" },
          ],
        }),
      ),
      host: { async run() { return { ok: true, output: "x" }; } },
    });

    const { tasks } = payloadOf(out.messages);
    expect(tasks).toHaveLength(2);
    // Order-preserving and paired: the label came from the caller, the summary from THAT child.
    expect(tasks.map((t) => [t.label, t.summary])).toEqual([
      ["a", "echo:read A"],
      ["b", "echo:read B"],
    ]);
    expect(tasks[0]!.ok).toBe(true);
    expect(tasks[0]!.iterations).toBe(1);
    expect(tasks[0]).toHaveProperty("tokensIn");
  });

  it("defaults a missing label to the item's position", async () => {
    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: fanOutModel(JSON.stringify({ tasks: [{ task: "read A" }, { task: "read B" }] })),
      host: { async run() { return { ok: true, output: "x" }; } },
    });
    expect(payloadOf(out.messages).tasks.map((t) => t.label)).toEqual(["task-1", "task-2"]);
  });

  it("fails only the item whose specialist does not exist, and names the ones that do", async () => {
    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: fanOutModel(
        JSON.stringify({
          tasks: [
            { label: "fine", task: "read A" },
            { label: "bad", task: "read B", agent: "nope" },
          ],
        }),
      ),
      host: { async run() { return { ok: true, output: "x" }; } },
      subagentDefs: [def({ id: "locator", name: "Locator", description: "finds things" })],
    });

    const { tasks } = payloadOf(out.messages);
    expect(tasks[0]).toMatchObject({ label: "fine", ok: true, summary: "echo:read A" });
    // The good item still ran: a batch is not failed by one malformed entry.
    expect(tasks[1]).toMatchObject({ label: "bad", ok: false });
    expect(String(tasks[1]!.error)).toContain('no sub-agent named "nope"');
    expect(String(tasks[1]!.error), "the error names what is available").toContain("locator");
  });

  it("refuses more tasks than the cap, before any child starts", async () => {
    let generateCalls = 0;
    const inner = fanOutModel(
      JSON.stringify({ tasks: Array.from({ length: FAN_OUT_MAX + 1 }, (_, i) => ({ task: `t${i}` })) }),
    );
    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: async (req, o) => {
        generateCalls += 1;
        return inner(req, o);
      },
      host: { async run() { return { ok: true, output: "x" }; } },
    });

    const tool = out.messages.find((m) => m.role === "tool");
    expect(String(tool?.content)).toContain(`at most ${FAN_OUT_MAX} tasks`);
    // Two calls: the parent's request, and its turn after the refusal. No child ever ran.
    expect(generateCalls).toBe(2);
  });

  it("refuses an empty list, pointing at the tool for a single task", async () => {
    const out = await runAgentLoop({
      model: "m",
      messages: [{ role: "user", content: "go" }],
      registry: AGENT_TOOLS,
      generate: fanOutModel(JSON.stringify({ tasks: [] })),
      host: { async run() { return { ok: true, output: "x" }; } },
    });
    expect(String(out.messages.find((m) => m.role === "tool")?.content)).toContain(
      "`dispatch_agent` for a single task",
    );
  });

  /**
   * The property the shared `runChild` exists for: a fan-out child is granted exactly what a
   * dispatched one is — the user's `subagentCanWrite` decision, narrowed by the definition, and
   * never the delegation tools themselves.
   */
  it("gives a fan-out child the same granted set, and never the delegation tools", async () => {
    async function childToolsFor(canWrite: boolean): Promise<string[][]> {
      // A child's request is the only one whose last message is the user turn *after* the first
      // call, so this captures children and not the parent's own two calls.
      const seen: { tools: unknown[] | undefined; isChild: boolean }[] = [];
      let calls = 0;
      const inner = fanOutModel(
        JSON.stringify({ tasks: [{ task: "read A" }, { task: "read B" }] }),
      );
      await runAgentLoop({
        model: "m",
        messages: [{ role: "user", content: "go" }],
        registry: AGENT_TOOLS,
        generate: async (req, o) => {
          calls += 1;
          const last = req.messages[req.messages.length - 1] as { role?: string };
          seen.push({
            tools: (req as { tools?: unknown }).tools as unknown[] | undefined,
            isChild: calls > 1 && last?.role === "user",
          });
          return inner(req, o);
        },
        host: { async run() { return { ok: true, output: "x" }; } },
        subagentCanWrite: canWrite,
      });
      return seen
        .filter((s) => s.isChild)
        .map((s) =>
          Array.isArray(s.tools)
            ? (s.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
            : [],
        );
    }

    const readOnly = await childToolsFor(false);
    expect(readOnly).toHaveLength(2);
    for (const tools of readOnly) {
      expect(tools).toContain("read_file");
      expect(tools, "no mutation unless the user enabled it").not.toContain("write_file");
    }

    const writing = await childToolsFor(true);
    for (const tools of writing) {
      expect(tools).toContain("write_file");
      // A child that could delegate is recursion with no bound, and `fan_out` is the newest route
      // to it — hence its place in the exclusion set rather than only in the description.
      expect(tools).not.toContain("fan_out");
      expect(tools).not.toContain("dispatch_agent");
    }
  });
});
