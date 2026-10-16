/**
 * The atlas builder is the whole visualization's honesty: nodes and edges only for relationships
 * the store records. These tests pin what it draws and, just as much, what it refuses to invent.
 */
import { describe, expect, it } from "vitest";
import { ATLAS_CAP, buildAtlasGraph, type AtlasMemory } from "./atlas";

const NOW = 1_800_000_000_000;

function mem(over: Partial<AtlasMemory> = {}): AtlasMemory {
  return {
    id: "m-1",
    layer: "L1",
    text: "Uses Postgres for the store",
    session_id: "s-1",
    subject: null,
    pinned: false,
    created_at: NOW - 60_000,
    updated_at: NOW - 60_000,
    superseded_at: null,
    ...over,
  };
}

describe("buildAtlasGraph", () => {
  it("draws one node per memory, kinded by layer, labelled by text", () => {
    const { graph } = buildAtlasGraph([mem({ id: "a", layer: "L1" }), mem({ id: "b", layer: "L3" })], new Map(), NOW);
    const memNodes = graph.nodes.filter((n) => n.id.startsWith("mem:"));
    expect(memNodes).toHaveLength(2);
    expect(memNodes.map((n) => n.kind).sort()).toEqual(["L1", "L3"]);
    const b = memNodes.find((n) => n.id === "mem:b")!;
    expect(b.label).toBe("Uses Postgres for the store");
  });

  it("clusters memories by session with one edge each, and counts the sessions", () => {
    const { graph, sessionCount, unfiled } = buildAtlasGraph(
      [mem({ id: "a" }), mem({ id: "b" }), mem({ id: "c", session_id: "s-2" })],
      new Map(),
      NOW,
    );
    expect(sessionCount).toBe(2);
    expect(unfiled).toBe(0);
    const ses = graph.nodes.filter((n) => n.kind === "session");
    expect(ses.map((n) => n.id).sort()).toEqual(["ses:s-1", "ses:s-2"]);
    // Session weight is how much it taught — the member count.
    expect(ses.find((n) => n.id === "ses:s-1")!.weight).toBe(2);
    expect(graph.edges.filter((e) => e.kind === "learned_in")).toHaveLength(3);
  });

  it("gathers session-less memories under one unfiled hub, and does not count it as a session", () => {
    const { graph, sessionCount, unfiled } = buildAtlasGraph(
      [mem({ id: "a", session_id: null }), mem({ id: "b", session_id: null }), mem({ id: "c" })],
      new Map(),
      NOW,
    );
    expect(sessionCount).toBe(1);
    expect(unfiled).toBe(2);
    const hub = graph.nodes.find((n) => n.id === "ses:unfiled")!;
    expect(hub.kind).toBe("session");
    expect(hub.label).toBe("unfiled");
    expect(hub.weight).toBe(2);
    expect(graph.edges.find((e) => e.to === "mem:a")!.from).toBe("ses:unfiled");
  });

  it("dims superseded memories instead of dropping them — kept, not deleted", () => {
    const { graph } = buildAtlasGraph(
      [
        mem({ id: "live" }),
        mem({ id: "old", superseded_at: NOW - 1000 }),
      ],
      new Map(),
      NOW,
    );
    const old = graph.nodes.find((n) => n.id === "mem:old")!;
    expect(old.dim).toBe(true);
    expect(old.weight, "a superseded row is no skeleton").toBe(1);
    expect(graph.nodes.find((n) => n.id === "mem:live")!.dim).toBeUndefined();
    // Still attached to its session: the provenance of a replaced fact is part of the shape.
    expect(graph.edges.find((e) => e.to === "mem:old")).toBeTruthy();
  });

  it("makes pinned and core facts the heavy nodes", () => {
    const { graph } = buildAtlasGraph(
      [
        mem({ id: "plain" }),
        mem({ id: "pin", pinned: true }),
        mem({ id: "core", layer: "L3" }),
      ],
      new Map(),
      NOW,
    );
    const w = (id: string) => graph.nodes.find((n) => n.id === `mem:${id}`)!.weight!;
    expect(w("pin")).toBeGreaterThan(w("core"));
    expect(w("core")).toBeGreaterThan(w("plain"));
  });

  it("names session clusters after the conversation when a title is known", () => {
    const { graph } = buildAtlasGraph(
      [mem({ session_id: "s-9" })],
      new Map([["s-9", "Refactoring the gateway"]]),
      NOW,
    );
    expect(graph.nodes.find((n) => n.id === "ses:s-9")!.label).toBe("Refactoring the gateway");
  });

  it("keeps the most recent rows when the cap bites, and says so", () => {
    const many: AtlasMemory[] = Array.from({ length: ATLAS_CAP + 10 }, (_, i) =>
      mem({ id: `m-${i}`, updated_at: NOW - i * 1000 }),
    );
    const { graph, capped } = buildAtlasGraph(many, new Map(), NOW);
    expect(capped).toBe(true);
    expect(graph.nodes.filter((n) => n.id.startsWith("mem:"))).toHaveLength(ATLAS_CAP);
    // The dropped rows are the oldest, not a random cut.
    expect(graph.nodes.find((n) => n.id === "mem:m-0")).toBeTruthy();
    expect(graph.nodes.find((n) => n.id === `mem:m-${ATLAS_CAP}`)).toBeUndefined();
  });

  it("carries subject into the detail line, with an honest age", () => {
    const { graph } = buildAtlasGraph([mem({ subject: "storage" })], new Map(), NOW);
    expect(graph.nodes[0]!.detail).toContain("storage");
    expect(graph.nodes[0]!.detail).toContain("ago");
  });
});
