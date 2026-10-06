import { describe, it, expect, vi } from "vitest";
import { runAgentTurn, type AgentTurnRequest } from "./agent-turn";
import type { AgentTurnPorts, Trace } from "./ports";
import type { AgentEvent, ToolHost } from "../../tools";
import type { ServedBy } from "../../gateway-turn";

/** A model script like agentLoop.test.ts's, wrapped in the gateway exec shape the engine's
 *  generate wrapper produces (chunks + reasoning + served), with the usage hook the loop offers. */
function fakeGenerate(
  steps: Array<{ text: string; calls?: { id: string; name: string; arguments: string }[]; usage?: { prompt_tokens: number; completion_tokens: number }; served?: ServedBy }>,
  hooks: { onModelReq?: (req: Record<string, unknown>) => void } = {},
): AgentTurnPorts["generate"] {
  void steps;
  let i = 0;
  return (async (req: Record<string, unknown>) => {
    hooks.onModelReq?.(req);
    const step = steps[Math.min(i, steps.length - 1)];
    i += 1;
    step.calls?.forEach((c) => (req.onToolCall as (c: unknown) => void)?.(c));
    if (step.usage) (req.onUsage as (u: { prompt_tokens: number; completion_tokens: number }) => void)(step.usage);
    return {
      chunks: (async function* () {
        for (const c of step.text) yield c;
      })(),
      reasoning: () => "",
      served: () => step.served,
    };
  }) as unknown as AgentTurnPorts["generate"];
}

function makePorts(opts: {
  steps?: Parameters<typeof fakeGenerate>[0];
  aborted?: boolean;
}) {
  const events: AgentEvent[] = [];
  const traces: Trace[] = [];
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  const charged: { tokensIn: number; tokensOut: number; provider?: string; model?: string }[] = [];
  const recorded: { kind: string; label?: string }[] = [];
  const runs: { started: unknown[]; ended: unknown[] } = { started: [], ended: [] };
  let nodeSeq = 0;
  const controller = new AbortController();
  if (opts.aborted) controller.abort();
  const ports: AgentTurnPorts = {
    generate: fakeGenerate(opts.steps ?? [{ text: "done", served: { provider: "prov-1", model: "model-x", key: "k1" } }]),
    recorder: {
      sessionId: "session-1",
      node: (kind: string, label: string, meta?: Record<string, unknown>) => {
        const id = `n${nodeSeq++}`;
        void kind;
        void label;
        void meta;
        return id;
      },
      edge: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
    } as never,
    lastNode: { current: "prev" },
    memory: {
      recall: vi.fn().mockResolvedValue([]),
      block: vi.fn(() => ""),
      recordRecall: vi.fn(),
      remember: vi.fn().mockResolvedValue(undefined),
      distil: vi.fn().mockResolvedValue(undefined),
    },
    providerName: () => undefined,
    patchMsg: (id, patch) => patches.push({ id, patch: patch as Record<string, unknown> }),
    onTrace: vi.fn((t: Trace) => traces.push(t)),
    onFinishReason: vi.fn(),
    onLastUsage: vi.fn(),
    onBusy: vi.fn(),
    onStopping: vi.fn(),
    clearAbort: vi.fn(),
    chargeUsage: (tokensIn, tokensOut, provider, model) => charged.push({ tokensIn, tokensOut, provider, model }),
    now: () => 1_000,
    orchestrator: {
      newRunId: () => "run-1",
      startRun: vi.fn((...a: unknown[]) => runs.started.push(a)),
      registerAbort: vi.fn(),
      recordStep: vi.fn((_runId: string, kind: string, label?: string) => recorded.push({ kind, label })),
      endRun: vi.fn((...a: unknown[]) => runs.ended.push(a)),
    },
    makeBaseHost: (): ToolHost => ({ run: async () => ({ ok: true, output: "tool-output" }) }),
    onAgentEvent: (ev) => events.push(ev),
    onAgentStart: vi.fn(),
    onRunUsageAdded: vi.fn(),
    onReplaceTranscript: vi.fn(),
    fillIfEmpty: vi.fn((id: string, note: string) => patches.push({ id, patch: { content: note } })),
    onRunChanges: vi.fn(),
    clearRunUi: vi.fn(),
  };
  return { ports, events, traces, patches, charged, recorded, runs, controller };
}

function makeRequest(over: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  const controller = new AbortController();
  return {
    text: "do the thing",
    baseMsgs: [],
    attachments: [],
    model: "prov-1/model-x",
    perTurn: "",
    useMemory: true,
    signal: controller.signal,
    startedAt: 500,
    assistantMsgId: "assistant-1",
    root: "/tmp/ws",
    skillsBlock: "",
    planMode: false,
    maxIterations: 8,
    controller,
    confirm: async () => ({ allow: true }),
    ...over,
  };
}

describe("runAgentTurn", () => {
  it("refuses the run without a workspace root, undoing the optimistic append", async () => {
    const { ports } = makePorts({});
    await runAgentTurn(makeRequest({ root: "   " }), ports);
    expect(ports.onReplaceTranscript).toHaveBeenCalledWith(makeRequest({ root: "   " }).baseMsgs);
    expect(ports.onTrace).toHaveBeenCalledWith({ ms: 0, fallbacks: [], error: "set a workspace root before using agent mode" });
    expect(ports.orchestrator.startRun).not.toHaveBeenCalled();
    expect(ports.onBusy).toHaveBeenCalledWith(false);
    expect(ports.clearAbort).toHaveBeenCalled();
  });

  it("opens the run record, records the done step, and ends ok on a tool-less run", async () => {
    const { ports, runs, recorded } = makePorts({ steps: [{ text: "Here is the answer." }] });
    await runAgentTurn(makeRequest(), ports);
    expect(ports.orchestrator.startRun).toHaveBeenCalledWith({ runId: "run-1", sessionId: "session-1", model: "prov-1/model-x", prompt: "do the thing" });
    expect(recorded.map((r) => r.kind)).toEqual(["done"]);
    expect(runs.ended[0]).toEqual(["run-1", "ok", 1]);
    expect(ports.onTrace).toHaveBeenCalledWith(expect.objectContaining({ provider: "agent", fallbacks: [] }));
    expect(ports.memory.remember).toHaveBeenCalledWith("session-1", "do the thing", "Here is the answer.");
  });

  it("executes a tool call through the checkpointing host and records tool_call → tool_result → done", async () => {
    const hostRuns: { name: string; args: Record<string, unknown> }[] = [];
    const { ports, recorded, runs, charged } = makePorts({
      steps: [
        { text: "Reading it.", calls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' }], usage: { prompt_tokens: 10, completion_tokens: 2 }, served: { provider: "prov-1", model: "model-x", key: "k1" } },
        { text: "Here is the answer." },
      ],
    });
    ports.makeBaseHost = (): ToolHost => ({
      run: async (name, args) => {
        hostRuns.push({ name, args });
        return { ok: true, output: `result-for-${name}` };
      },
    });
    await runAgentTurn(makeRequest(), ports);
    expect(hostRuns).toEqual([{ name: "read_file", args: { path: "a.txt" } }]);
    expect(recorded.map((r) => r.kind)).toEqual(["tool_call", "tool_result", "done"]);
    expect(runs.ended[0]).toEqual(["run-1", "ok", 2]);
    // Charged once per completed model call: the first with its reported usage, the second with
    // none — a row with zero tokens, exactly like the screen's own wrapper did.
    expect(charged).toEqual([
      { tokensIn: 10, tokensOut: 2, provider: "prov-1", model: "model-x" },
      // the second call's fake never reported served ids, so it charges unpriced — honest
      { tokensIn: 0, tokensOut: 0, provider: undefined, model: undefined },
    ]);
    // The transcript was replaced with the full loop transcript plus the final assistant turn.
    const transcript = vi.mocked(ports.onReplaceTranscript).mock.calls[0]![0];
    expect(transcript.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("records a denial when the confirm gate refuses, and still finishes", async () => {
    const { ports, recorded, runs } = makePorts({
      steps: [
        { text: "Writing.", calls: [{ id: "c1", name: "write_file", arguments: '{"path":"a"}' }] },
        { text: "Understood, not writing." },
      ],
    });
    // The deny reason becomes the tool result text verbatim, so the recorded step is "denied"
    // only when the wording says refused/denied — the screen's own gate words it that way.
    await runAgentTurn(makeRequest({ confirm: async () => ({ allow: false, reason: "refused: not today" }) }), ports);
    expect(recorded.map((r) => r.kind)).toEqual(["tool_call", "denied", "done"]);
    expect(runs.ended[0]).toEqual(["run-1", "ok", 2]);
  });

  it("ends a stopped run as stopped and fills the empty bubble", async () => {
    // A pre-aborted controller + a generate that throws drives the catch path the way a cancelled
    // stream does: endRun "stopped", the trace, and the bubble fill (the run left an empty turn).
    const aborted = new AbortController();
    aborted.abort();
    const { ports, runs, patches } = makePorts({ steps: [{ text: "partial" }] });
    ports.generate = (async () => {
      throw new Error("aborted stream");
    }) as never;
    await runAgentTurn(makeRequest({ controller: aborted }), ports);
    expect(runs.ended[0]).toEqual(["run-1", "stopped", 0]);
    expect(ports.onTrace).toHaveBeenLastCalledWith(expect.objectContaining({ error: "stopped by you" }));
    expect(patches.some((p) => String(p.patch.content).startsWith("⚠ stopped by you"))).toBe(true);
  });

  it("accumulates each model call's failover chain into the run's trace", async () => {
    // Two model calls, each served after its own failed attempt: the trace's chain is the
    // whole run's, in order — not the hardcoded `[]` the pre-wire trace carried.
    const { ports, traces } = makePorts({
      steps: [
        {
          text: "trying",
          calls: [{ id: "c1", name: "list_dir", arguments: "{}" }],
          served: { provider: "prov-1", model: "model-x", key: "k1", fallbacks: [{ provider: "first", key: "k0", cls: "SERVER" }] },
        },
        {
          text: "done",
          served: { provider: "prov-1", model: "model-x", key: "k1", fallbacks: [{ cls: "RATE_LIMITED", reason: "429" }] },
        },
      ],
    });
    await runAgentTurn(makeRequest(), ports);
    expect(traces[traces.length - 1]!.fallbacks).toEqual([
      { provider: "first", key: "k0", cls: "SERVER" },
      { cls: "RATE_LIMITED", reason: "429" },
    ]);
  });

  it("resets the run UI and publishes a null change set on settle", async () => {
    const { ports } = makePorts({ steps: [{ text: "done" }] });
    await runAgentTurn(makeRequest(), ports);
    expect(ports.onAgentStart).toHaveBeenCalled();
    expect(ports.clearRunUi).toHaveBeenCalled();
    expect(ports.onRunChanges).toHaveBeenLastCalledWith(null);
    expect(ports.onBusy).toHaveBeenLastCalledWith(false);
    expect(ports.clearAbort).toHaveBeenCalled();
  });
});
