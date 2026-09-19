/**
 * Context graph engine (P4).
 *
 * Three views share one shape, because a force layout, a hit-tester and an inspector are
 * already enough work without three variants of them:
 *
 *   conversation — what the context helper recorded: messages, artifacts, skills, memories
 *   routing      — how a requested model resolves: aliases, providers, keys, served models
 *   live         — what just happened: requests, the providers they touched, fallback hops
 *
 * Only `conversation` is persisted (see src-tauri/src/context.rs). The other two are derived
 * from state the UI already holds, so they carry no schema and can change shape freely.
 */

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  /** Rendered as the node's second line. */
  detail?: string;
  ts?: number;
  /** Degree or count; drives radius and stroke weight. */
  weight?: number;
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: string;
  weight: number;
  label?: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Persisted context node kinds — the closed set from the schema. */
export type ContextNodeKind = "artifact" | "memory" | "skill" | "message";
export type ContextEdgeKind =
  | "produced" | "used" | "recalled" | "follows" | "references"
  | "routes_to" | "served_by" | "aliases" | "backed_by";

/** Wire shape mirroring src-tauri/src/context.rs (snake_case across the IPC boundary). */
export interface HostContextNode {
  id: string; kind: string; label: string; source: string;
  session_id: string | null; ts: number; meta_json: string | null;
}
export interface HostContextEdge {
  id: string; from_id: string; to_id: string; kind: string;
  weight: number; ts: number; meta_json: string | null;
}

function parseMeta<T>(v: string | null | undefined): T | undefined {
  if (!v) return undefined;
  try {
    return JSON.parse(v) as T;
  } catch {
    return undefined;
  }
}

/**
 * The persisted conversation graph.
 *
 * Edges whose endpoints are missing are dropped rather than drawn to nowhere. They should not
 * exist — `context::record` rejects them — but the graph is a file on disk and can be handed
 * to us by an older build, and a dangling line is worse than a missing one.
 */
export function buildConversationGraph(nodes: HostContextNode[], edges: HostContextEdge[]): Graph {
  const out: GraphNode[] = nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    label: n.label,
    detail: n.kind === "message" ? "turn" : n.kind,
    ts: n.ts,
    meta: parseMeta(n.meta_json),
  }));
  const known = new Set(nodes.map((n) => n.id));
  const links: GraphEdge[] = edges
    .filter((e) => known.has(e.from_id) && known.has(e.to_id))
    .map((e) => ({
      id: e.id,
      from: e.from_id,
      to: e.to_id,
      kind: e.kind,
      weight: e.weight,
      label: e.kind,
    }));
  return withDegrees({ nodes: out, edges: links });
}

export interface RoutingInput {
  providers: { id: string; name: string; status: string }[];
  keysOf: (providerId: string) => { id: string; label: string; status: string }[];
  aliases: { alias: string; providerId: string; nativeModelId: string; priority: number }[];
  /** One row per distinct (requested, served, provider) triple, already aggregated. */
  served: { requestedModel: string; model: string; providerId: string | null; count: number }[];
}

/**
 * Routing topology: what you asked for, what actually answered, and what connects them.
 *
 * The interesting relation is requested-vs-served, so those are separate nodes even when the
 * ids match — a request that resolved to exactly what it named is a fact worth seeing, not a
 * case to collapse away.
 */
export function buildRoutingGraph(input: RoutingInput): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (n: GraphNode) => {
    if (!seen.has(n.id)) {
      seen.add(n.id);
      nodes.push(n);
    }
  };

  for (const p of input.providers) {
    add({ id: `provider:${p.id}`, kind: "provider", label: p.name, detail: p.status });
    for (const k of input.keysOf(p.id)) {
      add({ id: `key:${k.id}`, kind: "key", label: k.label, detail: k.status });
      edges.push({ id: `e:backed:${p.id}:${k.id}`, from: `provider:${p.id}`, to: `key:${k.id}`, kind: "backed_by", weight: 1, label: "key" });
    }
  }

  for (const a of input.aliases) {
    const modelId = `model:${a.providerId}/${a.nativeModelId}`;
    add({ id: `alias:${a.alias}`, kind: "alias", label: a.alias, detail: "alias" });
    add({ id: modelId, kind: "model", label: a.nativeModelId, detail: a.providerId });
    edges.push({ id: `e:alias:${a.alias}:${a.providerId}/${a.nativeModelId}`, from: `alias:${a.alias}`, to: modelId, kind: "aliases", weight: 1, label: "alias" });
  }

  for (const s of input.served) {
    const reqId = `requested:${s.requestedModel}`;
    add({ id: reqId, kind: "requested", label: s.requestedModel, detail: "requested", weight: s.count });
    const modelId = `model:${s.providerId ?? "?"}/${s.model}`;
    add({ id: modelId, kind: "model", label: s.model, detail: s.providerId ?? "unknown", weight: s.count });
    edges.push({
      id: `e:route:${s.requestedModel}->${s.providerId}/${s.model}`,
      from: reqId,
      to: modelId,
      kind: "routes_to",
      weight: Math.max(1, Math.min(s.count, 50)),
      label: s.requestedModel === s.model ? "served" : "resolved to",
    });
    if (s.providerId) {
      edges.push({ id: `e:served:${s.providerId}/${s.model}`, from: modelId, to: `provider:${s.providerId}`, kind: "served_by", weight: 1, label: "served by" });
    }
  }

  return withDegrees({ nodes, edges });
}

export interface LiveRow {
  ts: number;
  model: string;
  requestedModel: string | null;
  providerId: string | null;
  providerName: string | null;
  status: string;
  errorClass: string | null;
  latencyMs: number | null;
  fallbacks: string[];
}

/**
 * Live request flow. Each request is a node; the providers it touched are nodes too, so a
 * fallback is visible as a request fanning out rather than as a single coloured dot.
 */
export function buildLiveGraph(rows: LiveRow[], limit = 60): Graph {
  const recent = rows.slice(0, limit);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const add = (n: GraphNode) => {
    if (!seen.has(n.id)) {
      seen.add(n.id);
      nodes.push(n);
    }
  };

  recent.forEach((r, i) => {
    const id = `req:${r.ts}:${i}`;
    add({
      id,
      kind: r.status === "ok" ? "request-ok" : "request-failed",
      label: r.requestedModel ?? r.model,
      detail: r.latencyMs != null ? `${r.latencyMs}ms` : r.status,
      ts: r.ts,
    });

    const touched: string[] = r.providerId ? [r.providerId] : [];
    for (const f of r.fallbacks) {
      const m = /(?:^|\s)([^·]+)·/.exec(f);
      if (m) touched.push(m[1].trim());
    }
    const unique = Array.from(new Set(touched.filter(Boolean)));

    unique.forEach((pid, order) => {
      const providerNode = `provider:${pid}`;
      add({ id: providerNode, kind: "provider", label: r.providerName && pid === r.providerId ? r.providerName : pid });
      const isFinal = pid === r.providerId;
      edges.push({
        id: `e:req:${id}:${pid}:${order}`,
        from: id,
        to: providerNode,
        kind: isFinal ? (r.status === "ok" ? "served_by" : "failed_on") : "fallback",
        weight: 1,
        label: isFinal ? (r.status === "ok" ? "served" : r.errorClass ?? "failed") : `attempt ${order + 1}`,
      });
    });

    if (r.requestedModel && r.requestedModel !== r.model) {
      const modelId = `model:${r.providerId ?? "?"}/${r.model}`;
      add({ id: modelId, kind: "model", label: r.model });
      edges.push({ id: `e:resolve:${id}`, from: id, to: modelId, kind: "routes_to", weight: 1, label: "resolved to" });
    }
  });

  return withDegrees({ nodes, edges });
}

/**
 * Degree as node weight. A hub should look like a hub before the layout even runs — it gives
 * the simulation a sensible starting radius and makes the result readable at a glance.
 */
export function withDegrees(g: Graph): Graph {
  const deg = new Map<string, number>();
  for (const e of g.edges) {
    deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
    deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
  }
  return {
    edges: g.edges,
    nodes: g.nodes.map((n) => ({ ...n, weight: n.weight ?? deg.get(n.id) ?? 0 })),
  };
}

/** Deterministic id for a recorded thing, so re-recording the same turn is idempotent. */
export function contextId(kind: ContextNodeKind, sessionId: string, seq: number): string {
  return `${kind}:${sessionId}:${seq}`;
}
