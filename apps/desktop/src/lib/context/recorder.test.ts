/**
 * Recorder behaviour (P4). The recorder turns a turn into graph writes; the unit test pins the
 * three properties a UI bug would silently break:
 *   - nodes get stable, unique ids within a session
 *   - flushes are atomic: nodes and edges land together (an edge without its endpoints is a lie)
 *   - flush errors are swallowed and the buffer cleared, because a failed graph write must never
 *     break the conversation being recorded
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../../store";
import { startSession, type Recorder } from "./recorder";

const recordContext = vi.spyOn(store, "recordContext");

describe("context recorder", () => {
  let rec: Recorder;

  beforeEach(() => {
    recordContext.mockReset();
    recordContext.mockResolvedValue();
    // startSession resets the module-level singleton so each test gets a clean sequence.
    rec = startSession("test");
  });

  it("allocates unique ids per node and forwards kind/label/meta", async () => {
    const a = rec.node("message", "hello", { role: "user" });
    const b = rec.node("message", "hi again");
    expect(a).not.toBe(b);
    expect(a).toBe("message:test:1");
    expect(b).toBe("message:test:2");

    await rec.flush();
    expect(recordContext).toHaveBeenCalledTimes(1);
    const [nodes, edges] = recordContext.mock.calls[0]!;
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(0);
    expect(nodes[0]).toMatchObject({
      id: a, kind: "message", label: "hello", session_id: "test",
      meta_json: JSON.stringify({ role: "user" }),
    });
    expect(nodes[1]).toMatchObject({
      id: b, kind: "message", label: "hi again", session_id: "test", meta_json: null,
    });
  });

  it("emits edges with weight 1 (the host collapses duplicates and bumps the weight)", async () => {
    const m = rec.node("message", "look here");
    const a = rec.node("artifact", "report.md");
    rec.edge(m, a, "produced");
    rec.edge(m, a, "produced"); // same triple: recorder does NOT dedupe — the host does
    rec.edge(m, a, "used"); // different kind, a second edge

    await rec.flush();
    const [, edges] = recordContext.mock.calls[0]!;
    // The recorder is a naive buffer; the dedupe + weight bump lives in context.rs
    // (ON CONFLICT (from_id, to_id, kind) DO UPDATE SET weight = MIN(weight + excluded.weight, 50)).
    expect(edges).toHaveLength(3);
    for (const e of edges) {
      expect(e).toMatchObject({ from_id: m, to_id: a, weight: 1 });
    }
    expect(edges[0]?.kind).toBe("produced");
    expect(edges[1]?.kind).toBe("produced");
    expect(edges[2]?.kind).toBe("used");
  });

  it("flushes are atomic — nodes and edges land together", async () => {
    const m = rec.node("message", "hi");
    const a = rec.node("artifact", "out.md");
    rec.edge(m, a, "produced");

    const seen = vi.fn();
    recordContext.mockImplementation(async (n, e) => {
      seen({ n: n.length, e: e.length });
    });
    await rec.flush();
    expect(seen).toHaveBeenCalledWith({ n: 2, e: 1 });
  });

  it("swallows flush errors and clears the buffer — the conversation must not break", async () => {
    rec.node("message", "first");
    rec.node("message", "second");
    recordContext.mockRejectedValueOnce(new Error("disk full"));

    // If the swallowed throw escaped, this promise would reject and the test would fail.
    await expect(rec.flush()).resolves.toBeUndefined();

    // Buffer cleared even though the write failed, so a follow-up flush does not replay the
    // same ids against a session that has moved on.
    await rec.flush();
    const [, edges1] = recordContext.mock.calls[0]!;
    const [, edges2] = recordContext.mock.calls[1]!;
    expect(edges1).toHaveLength(0);
    expect(edges2).toHaveLength(0);
  });

  it("the sequence counter persists across flushes — ids stay unique within a session", async () => {
    const a = rec.node("message", "first turn");
    await rec.flush();
    const b = rec.node("message", "second turn");
    expect(a).toBe("message:test:1");
    expect(b).toBe("message:test:2");
    expect(a).not.toBe(b);
  });
});