import { describe, expect, it } from "vitest";
import {
  buildConversationGraph,
  buildLiveGraph,
  buildRoutingGraph,
  withDegrees,
} from "./engine";

describe("conversation graph", () => {
  it("carries recorded nodes and edges through", () => {
    const g = buildConversationGraph(
      [
        { id: "m1", kind: "message", label: "hello", source: "ui", session_id: "s", ts: 1, meta_json: null },
        { id: "a1", kind: "artifact", label: "report.md", source: "ui", session_id: "s", ts: 2, meta_json: null },
      ],
      [{ id: "e1", from_id: "m1", to_id: "a1", kind: "produced", weight: 1, ts: 2, meta_json: null }],
    );
    expect(g.nodes.map((n) => n.id)).toEqual(["m1", "a1"]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].kind).toBe("produced");
  });

  it("drops an edge whose endpoint is missing rather than drawing to nowhere", () => {
    const g = buildConversationGraph(
      [{ id: "m1", kind: "message", label: "hi", source: "ui", session_id: "s", ts: 1, meta_json: null }],
      [{ id: "e1", from_id: "m1", to_id: "ghost", kind: "produced", weight: 1, ts: 1, meta_json: null }],
    );
    expect(g.edges).toHaveLength(0);
  });
});

describe("routing graph", () => {
  it("relates a requested model to what actually served it", () => {
    const g = buildRoutingGraph({
      providers: [{ id: "p1", name: "OpenRouter", status: "enabled" }],
      keysOf: () => [{ id: "k1", label: "key-01", status: "enabled" }],
      aliases: [{ alias: "fast", providerId: "p1", nativeModelId: "m/fast", priority: 1 }],
      served: [{ requestedModel: "auto", model: "m/fast", providerId: "p1", count: 3 }],
    });
    expect(g.nodes.some((n) => n.kind === "requested")).toBe(true);
    const route = g.edges.find((e) => e.kind === "routes_to");
    expect(route).toBeDefined();
    expect(route!.weight).toBe(3);
    expect(g.edges.some((e) => e.kind === "backed_by")).toBe(true);
    expect(g.edges.some((e) => e.kind === "aliases")).toBe(true);
  });

  it("keeps requested and served apart even when they resolve to the same id", () => {
    const g = buildRoutingGraph({
      providers: [{ id: "p1", name: "P", status: "enabled" }],
      keysOf: () => [],
      aliases: [],
      served: [{ requestedModel: "gpt", model: "gpt", providerId: "p1", count: 1 }],
    });
    const route = g.edges.find((e) => e.kind === "routes_to")!;
    expect(route.from).toBe("requested:gpt");
    expect(route.to).toBe("model:p1/gpt");
    expect(route.label).toBe("served");
  });
});

describe("live graph", () => {
  it("fans a request out to every provider it touched", () => {
    const g = buildLiveGraph([
      {
        ts: 1,
        model: "m/fast",
        requestedModel: "auto",
        providerId: "p2",
        providerName: "Fallback Co",
        status: "ok",
        errorClass: null,
        latencyMs: 120,
        fallbacks: ["Primary Co · key-01 → RATE_LIMITED"],
      },
    ]);
    const from = g.edges.filter((e) => e.from.startsWith("req:"));
    expect(from.some((e) => e.kind === "fallback")).toBe(true);
    expect(from.some((e) => e.kind === "served_by")).toBe(true);
  });

  it("marks a failed request rather than hiding it", () => {
    const g = buildLiveGraph([
      {
        ts: 1, model: "m", requestedModel: "m", providerId: "p1", providerName: "P",
        status: "error", errorClass: "SERVER_ERROR", latencyMs: null, fallbacks: [],
      },
    ]);
    expect(g.nodes.some((n) => n.kind === "request-failed")).toBe(true);
    expect(g.edges.some((e) => e.kind === "failed_on")).toBe(true);
  });
});

describe("withDegrees", () => {
  it("gives a hub a bigger weight than a leaf", () => {
    const g = withDegrees({
      nodes: [
        { id: "hub", kind: "provider", label: "hub" },
        { id: "a", kind: "model", label: "a" },
        { id: "b", kind: "model", label: "b" },
      ],
      edges: [
        { id: "e1", from: "hub", to: "a", kind: "serves", weight: 1 },
        { id: "e2", from: "hub", to: "b", kind: "serves", weight: 1 },
      ],
    });
    const w = Object.fromEntries(g.nodes.map((n) => [n.id, n.weight]));
    expect(w.hub).toBe(2);
    expect(w.a).toBe(1);
  });
});
