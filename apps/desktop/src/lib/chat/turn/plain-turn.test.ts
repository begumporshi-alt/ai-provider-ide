import { describe, it, expect, vi } from "vitest";
import { runPlainTurn, REASONING_PAINT_MS, type PlainTurnRequest } from "./plain-turn";
import type { Trace, TurnPorts } from "./ports";
import type { ServedBy } from "../../gateway-turn";
import type { Memory } from "../../../store";

/** A recording fake of the Recorder interface. */
function fakeRecorder() {
  const nodes: { id: string; kind: string; label: string; meta?: Record<string, unknown> }[] = [];
  const edges: { from: string; to: string; kind: string }[] = [];
  let seq = 0;
  const self = {
    nodes,
    edges,
    flushed: 0,
    sessionId: "session-1",
    node(kind: string, label: string, meta?: Record<string, unknown>) {
      const id = `n${seq++}`;
      nodes.push({ id, kind, label, meta });
      return id;
    },
    edge(from: string, to: string, kind: string) {
      edges.push({ from, to, kind });
    },
    flush: async () => {
      self.flushed += 1;
    },
  };
  return self;
}

interface FakeOpts {
  chunks?: string[];
  failWith?: Error;
  served?: ServedBy;
  recalled?: Memory[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  /** Fires mid-stream, before the generator completes — a stop mid-stream. */
  abortAfterFirstChunk?: AbortController;
  now?: () => number;
}

function makePorts(opts: FakeOpts = {}) {
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  const traces: Trace[] = [];
  const charged: { tokensIn: number; tokensOut: number; provider?: string; model?: string }[] = [];
  const recorder = fakeRecorder();
  const ports: TurnPorts = {
    generate: async () => {
      return {
        chunks: (async function* () {
          if (opts.failWith) throw opts.failWith;
          let first = true;
          for (const c of opts.chunks ?? ["hello"]) {
            yield c;
            if (first && opts.abortAfterFirstChunk) {
              opts.abortAfterFirstChunk.abort();
              if (opts.abortAfterFirstChunk.signal.aborted) return; // the loop returns, not raises
            }
            first = false;
          }
        })(),
        reasoning: () => "",
        served: () => opts.served,
      };
    },
    recorder,
    lastNode: { current: "prev-node" },
    memory: {
      recall: vi.fn().mockResolvedValue(opts.recalled ?? []),
      block: vi.fn((mems: Memory[]) => (mems.length > 0 ? "MEM-BLOCK" : "")),
      recordRecall: vi.fn(),
      remember: vi.fn().mockResolvedValue(undefined),
      distil: vi.fn().mockResolvedValue(undefined),
    },
    providerName: (id) => (id === "prov-1" ? "Provider One" : undefined),
    patchMsg: (id, patch) => patches.push({ id, patch: patch as Record<string, unknown> }),
    onTrace: (t) => traces.push(t),
    onFinishReason: vi.fn(),
    onLastUsage: vi.fn(),
    onBusy: vi.fn(),
    onStopping: vi.fn(),
    clearAbort: vi.fn(),
    chargeUsage: (tokensIn, tokensOut, provider, model) => charged.push({ tokensIn, tokensOut, provider, model }),
    now: opts.now ?? vi.fn(() => 1_000),
    // Give the engine a hook to the request's callbacks so tests can drive them mid-stream.
    ...({} as Record<string, never>),
  };
  // Wrap generate so tests can reach the req the engine built (onUsage / onReasoning).
  let lastReq: Record<string, unknown> | undefined;
  const inner = ports.generate;
  ports.generate = async (req, o) => {
    lastReq = req as unknown as Record<string, unknown>;
    if (opts.usage) (req.onUsage as (u: FakeOpts["usage"]) => void)(opts.usage);
    return inner(req, o);
  };
  return { ports, patches, traces, charged, recorder, lastReq: () => lastReq };
}

function makeRequest(over: Partial<PlainTurnRequest> = {}): PlainTurnRequest {
  const ac = new AbortController();
  return {
    text: "hello there",
    baseMsgs: [],
    attachments: [],
    model: "prov-1/model-x",
    perTurn: "",
    useMemory: true,
    signal: ac.signal,
    startedAt: 500,
    assistantMsgId: "assistant-1",
    systemPromptText: "be terse",
    ...over,
  };
}

describe("runPlainTurn", () => {
  it("patches the transcript per chunk with the accumulated content, and flushes the final reasoning", async () => {
    const { ports, patches, lastReq } = makePorts({ chunks: ["hel", "lo w", "orld"] });
    const run = runPlainTurn(makeRequest(), ports);
    // Deltas arrive mid-stream in the real wire; drive reasoning the same way.
    // (lastReq is set synchronously by the generate call inside the running turn.)
    await new Promise((r) => setTimeout(r, 0));
    (lastReq()!.onReasoning as (t: string) => void)("thinking hard");
    await run;
    const contentPatches = patches.filter((p) => "content" in p.patch);
    expect(contentPatches.map((p) => p.patch.content)).toEqual(["hel", "hello w", "hello world"]);
    expect(patches[patches.length - 1]!.patch).toHaveProperty("reasoning", "thinking hard");
  });

  it("paints reasoning on the throttle interval, not per delta", async () => {
    let clock = 5_000;
    const { ports, patches, lastReq } = makePorts({ now: () => clock, chunks: ["answer"] });
    const run = runPlainTurn(makeRequest(), ports);
    await new Promise((r) => setTimeout(r, 0));
    const onReasoning = lastReq()!.onReasoning as (t: string) => void;
    onReasoning("first"); // first delta: lastPaint is 0, so this paints at once
    clock = 5_000 + REASONING_PAINT_MS - 1;
    onReasoning(" second"); // within the interval → no paint
    clock = 5_000 + REASONING_PAINT_MS;
    onReasoning(" third"); // crosses the interval → paints
    await run;
    const reasoningPatches = patches.filter((p) => "reasoning" in p.patch);
    expect(reasoningPatches).toHaveLength(2);
    expect(reasoningPatches[1]!.patch.reasoning).toBe("first second third");
  });

  it("charges the session once from the terminal usage report, priced by the served ids", async () => {
    const { ports, charged } = makePorts({
      chunks: ["hi"],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
      served: { provider: "prov-1", model: "model-x", key: "k1" },
    });
    await runPlainTurn(makeRequest(), ports);
    expect(charged).toEqual([{ tokensIn: 5, tokensOut: 3, provider: "prov-1", model: "model-x" }]);
  });

  it("does not charge a stream that never reported usage (stopped before the usage chunk)", async () => {
    const { ports, charged } = makePorts({ chunks: ["hi"] });
    await runPlainTurn(makeRequest(), ports);
    expect(charged).toEqual([]);
  });

  it("marks a stream the user stopped as 'stopped by you', keeping the partial text", async () => {
    const ac = new AbortController();
    const { ports, traces, patches } = makePorts({
      chunks: ["par", "tial"],
      abortAfterFirstChunk: ac,
      served: { provider: "prov-1", model: "model-x", key: "k1" },
    });
    await runPlainTurn(makeRequest({ signal: ac.signal }), ports);
    expect(traces[0]).toMatchObject({ error: "stopped by you", model: "model-x" });
    expect(patches[patches.length - 1]!.patch).toMatchObject({ content: "par" });
  });

  it("fills the bubble with a warning on a non-abort failure", async () => {
    const { ports, traces, patches } = makePorts({ failWith: new Error("provider exploded") });
    await runPlainTurn(makeRequest(), ports);
    expect(traces[0]).toMatchObject({ error: "provider exploded" });
    expect(patches[patches.length - 1]!.patch).toMatchObject({ content: "⚠ provider exploded" });
  });

  it("always flushes the recorder and remembers the exchange — even on failure", async () => {
    const { ports, recorder } = makePorts({ failWith: new Error("boom") });
    await runPlainTurn(makeRequest(), ports);
    expect(recorder.flushed).toBe(1);
    // Nothing streamed before the failure: the remembered reply is the empty string, which is
    // still an exchange in the record (the abandoned-turn policy).
    expect(ports.memory.remember).toHaveBeenCalledWith("session-1", "hello there", "");
    expect(ports.memory.distil).toHaveBeenCalled();
  });

  it("skips recall and remember when memory is off", async () => {
    const { ports } = makePorts({ recalled: [{ id: "m1" } as Memory] });
    await runPlainTurn(makeRequest({ useMemory: false }), ports);
    expect(ports.memory.recall).not.toHaveBeenCalled();
    expect(ports.memory.remember).not.toHaveBeenCalled();
  });

  it("records the user and assistant graph nodes, recall edges, and advances the follows chain", async () => {
    const { ports, recorder } = makePorts({
      chunks: ["answer"],
      served: { provider: "prov-1", model: "model-x", key: "k1" },
      recalled: [{ id: "m1" } as Memory],
    });
    await runPlainTurn(makeRequest(), ports);
    expect(ports.memory.recordRecall).toHaveBeenCalledWith("n0", [{ id: "m1" }]);
    expect(recorder.nodes.map((n) => n.kind)).toEqual(["message", "message"]);
    expect(recorder.edges[0]).toEqual({ from: "prev-node", to: "n0", kind: "follows" });
    expect(recorder.edges[1]).toEqual({ from: "n0", to: "n1", kind: "follows" });
    expect(ports.lastNode.current).toBe("n1");
    expect(recorder.nodes[1]!.meta).toMatchObject({ model: "model-x", provider: "prov-1", text: "answer" });
  });

  it("resets busy and stopping through the sink, and clears the screen's abort handle", async () => {
    const { ports } = makePorts({ chunks: ["ok"] });
    await runPlainTurn(makeRequest(), ports);
    expect(ports.onBusy).toHaveBeenLastCalledWith(false);
    expect(ports.onStopping).toHaveBeenLastCalledWith(false);
    expect(ports.clearAbort).toHaveBeenCalledTimes(1);
  });
});
