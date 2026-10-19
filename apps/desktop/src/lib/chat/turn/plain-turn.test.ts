import { describe, it, expect, vi } from "vitest";
import { runPlainTurn, REASONING_PAINT_MS, type PlainTurnRequest } from "./plain-turn";
import type { Trace, TranscriptEntry, TurnPorts } from "./ports";
import type { ServedBy } from "../../gateway-turn";
import type { Memory } from "../../../store";
import type { ChatMessage, CompressResult } from "@aiprovider/router-core";

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
  const charged: { tokensIn: number | undefined; tokensOut: number | undefined; provider?: string; model?: string }[] = [];
  /** Every transcript append, in call order — the durable copy the turn produced (0027). */
  const appended: TranscriptEntry[][] = [];
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
    transcript: { append: (entries: TranscriptEntry[]) => appended.push(entries) },
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
  return { ports, patches, traces, charged, recorder, appended, lastReq: () => lastReq };
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
  it("coalesces content patches and flushes the final text", async () => {
    const { ports, patches, lastReq } = makePorts({ chunks: ["hel", "lo w", "orld"] });
    const run = runPlainTurn(makeRequest(), ports);
    // Deltas arrive mid-stream in the real wire; drive reasoning the same way.
    // (lastReq is set synchronously by the generate call inside the running turn.)
    await new Promise((r) => setTimeout(r, 0));
    (lastReq()!.onReasoning as (t: string) => void)("thinking hard");
    await run;
    const contentPatches = patches.filter((p) => "content" in p.patch);
    // The first delta paints; the rest of a fast burst is coalesced, then the tail is flushed.
    expect(contentPatches.map((p) => p.patch.content)).toEqual(["hel", "hello world"]);
    expect(patches[patches.length - 1]!.patch).toHaveProperty("reasoning", "thinking hard");
  });

  it("coalesces a long stream instead of painting every delta", async () => {
    const chunks = Array.from({ length: 5_000 }, (_, i) => `t${i} `);
    const { ports, patches } = makePorts({ chunks });
    await runPlainTurn(makeRequest(), ports);
    const contentPatches = patches.filter((p) => "content" in p.patch);
    // The first delta paints, the rest of the burst coalesces, and the tail flushes.
    expect(contentPatches.length).toBeLessThan(200);
    expect(contentPatches[contentPatches.length - 1]!.patch.content).toBe(chunks.join(""));
  });

  it("auto-compacts the replayed history before the request", async () => {
    const compacted = [
      { role: "system" as const, content: "summary of earlier turns" },
      { role: "user" as const, content: "hello there" },
    ];
    const compact = vi.fn(async () => ({
      messages: compacted,
      dropped: 2,
      droppedMessages: [],
      beforeTokens: 900,
      afterTokens: 300,
      budget: 400,
      compressed: true,
    }));
    const onCompacted = vi.fn();
    const { ports, lastReq } = makePorts({ chunks: ["ok"] });
    await runPlainTurn(makeRequest({ compact, compactBudget: 400, onCompacted }), ports);

    expect(compact).toHaveBeenCalledOnce();
    expect(onCompacted).toHaveBeenCalledWith({ dropped: 2, beforeTokens: 900, afterTokens: 300 });
    const messages = lastReq()!.messages as { role: string; content: string }[];
    expect(messages).toContainEqual({ role: "system", content: "summary of earlier turns" });
  });

  it("does not announce compaction when the history fits", async () => {
    const compact = vi.fn(
      async (messages: readonly ChatMessage[], budget: number): Promise<CompressResult> => ({
        messages: [...messages],
        dropped: 0,
        droppedMessages: [],
        beforeTokens: 100,
        afterTokens: 100,
        budget,
        compressed: false,
      }),
    );
    const onCompacted = vi.fn();
    const { ports } = makePorts({ chunks: ["ok"] });
    await runPlainTurn(makeRequest({ compact, compactBudget: 400, onCompacted }), ports);
    expect(compact).toHaveBeenCalledOnce();
    expect(onCompacted).not.toHaveBeenCalled();
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

  it("carries the gateway's failover chain into the trace, not a hardcoded []", async () => {
    const { ports, traces } = makePorts({
      chunks: ["answer"],
      served: {
        provider: "prov-1",
        model: "model-x",
        key: "k1",
        fallbacks: [{ provider: "first-try", key: "key-00", cls: "SERVER" }],
      },
    });
    await runPlainTurn(makeRequest(), ports);
    expect(traces[0]!.fallbacks).toEqual([{ provider: "first-try", key: "key-00", cls: "SERVER" }]);
  });

  /**
   * The durable transcript (0027). This path used to leave nothing behind but the graph, whose
   * message nodes are clipped — which is why a resumed plain chat came back shortened.
   */
  it("records both turns in the durable transcript, with the answer as streamed", async () => {
    const { ports, appended } = makePorts({ chunks: ["a", "b"] });
    await runPlainTurn(makeRequest({ text: "hi there" }), ports);

    expect(appended, "one append per turn").toHaveLength(1);
    expect(appended[0]).toEqual([
      { role: "user", content: "hi there", attachments: null },
      { role: "assistant", content: "ab", reasoning: null, model: "prov-1/model-x", memoryRefs: null },
    ]);
  });

  /**
   * The row records that something was attached and never *what* it was: an image's base64 is
   * megabytes of payload that already lives where the user put it, and duplicating it into the
   * database on every turn is both a size problem and a needless copy of user content.
   */
  it("stores attachment metadata without the image bytes", async () => {
    const { ports, appended } = makePorts({ chunks: ["ok"] });
    await runPlainTurn(
      makeRequest({
        text: "what is this",
        attachments: [
          { id: "a1", name: "shot.png", mediaType: "image/png", dataBase64: "BASE64PAYLOAD", bytes: 12 },
        ],
      }),
      ports,
    );

    const stored = appended[0]![0]!.attachments ?? "";
    expect(stored).toContain("shot.png");
    expect(stored).toContain("image/png");
    expect(stored, "the bytes must not be in the row").not.toContain("BASE64PAYLOAD");
  });

  /**
   * A failed turn is still a turn, and the row must say what the bubble says. Recording `streamed`
   * here would store an empty assistant message while the user reads `⚠ boom` — the durable copy
   * disagreeing with the conversation, which is worse than not storing it.
   */
  it("records a failed turn as the text the bubble shows, not as the empty stream", async () => {
    const { ports, appended } = makePorts({ failWith: new Error("boom") });
    await runPlainTurn(makeRequest({ text: "hi" }), ports);

    expect(appended[0]![1]).toEqual({
      role: "assistant",
      content: "⚠ boom",
      reasoning: null,
      model: "prov-1/model-x",
      memoryRefs: null,
    });
  });

  /**
   * The visible half of recall. The prompt-side block is silent by design, so the bubble patch and
   * the durable row are the two places the turn says what it knew — and they must agree with each
   * other, or a resumed session would show a card the live one did not (or the reverse).
   */
  it("attaches the recall record to the bubble and the durable row, as a light copy", async () => {
    const remembered: Memory = {
      id: "m-9",
      layer: "L1",
      text: "Tushu lives in Dhaka",
      session_id: "s-old",
      subject: null,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
      pinned: true,
      scope: { user: "local", project: null, agent: null, global: false },
      score: -1,
      superseded_at: null,
    };
    const { ports, patches, appended } = makePorts({ chunks: ["got it"], recalled: [remembered] });
    await runPlainTurn(makeRequest(), ports);

    // The optimistic bubble got the light copy (id, layer, text, age, pinned) — not the store row.
    const patch = patches.find((p) => "recalledMemories" in p.patch);
    expect(patch).toMatchObject({ id: "assistant-1", patch: { recalledMemories: [{ id: "m-9", layer: "L1", text: "Tushu lives in Dhaka", at: 1_700_000_000_000, pinned: true }] } });

    // The durable row carries the same record, serialized, for the resume path to restore.
    const row = appended[0]![1]!;
    expect(row.memoryRefs).toBeTypeOf("string");
    expect(JSON.parse(row.memoryRefs!)).toEqual([{ id: "m-9", layer: "L1", text: "Tushu lives in Dhaka", at: 1_700_000_000_000, pinned: true }]);
  });

  it("writes no recall record when the turn recalled nothing", async () => {
    const { ports, patches, appended } = makePorts({ chunks: ["ok"] });
    await runPlainTurn(makeRequest(), ports);
    expect(patches.some((p) => "recalledMemories" in p.patch)).toBe(false);
    expect(appended[0]![1]!.memoryRefs).toBeNull();
  });
});

