/**
 * Context — one graph, three readings (P4).
 *
 * The same drawn object answers three different questions, so they are modes of one screen
 * rather than three screens: how a conversation hangs together, how a requested model resolves,
 * and what just happened. Switching modes should feel like changing what you are asking, not
 * changing tools.
 */
import { useEffect, useMemo, useState } from "react";
import {
  buildConversationGraph,
  buildLiveGraph,
  buildRoutingGraph,
  type Graph,
  type GraphNode,
} from "../lib/context/engine";
import { ForceGraph } from "../components/ForceGraph";
import { EmptyState } from "../components/atoms";
import { useUi } from "../ui-state";
import {
  catalog,
  clearContextGraph,
  listLedger,
  loadContextGraph,
  loadRecentLedger,
  registry,
  type HostContextEdge,
  type HostContextNode,
  type HostLedgerRow,
} from "../store";

type Mode = "conversation" | "routing" | "live";

const MODES: { id: Mode; label: string; blurb: string }[] = [
  { id: "conversation", label: "Conversation", blurb: "messages, artifacts, skills and memories as the context helper recorded them" },
  { id: "routing", label: "Routing", blurb: "what was requested, what actually served it, and the keys and aliases in between" },
  { id: "live", label: "Live flow", blurb: "recent requests and every provider they touched, including fallback attempts" },
];

/** One normalised ledger row, whether it came from this session or from disk. */
interface Row {
  ts: number;
  requestedModel: string;
  model: string;
  providerId: string | null;
  providerName: string | null;
  status: string;
  errorClass: string | null;
  latencyMs: number | null;
  fallbacks: string[];
}

export function ContextScreen() {
  const tick = useUi((s) => s.tick);
  const bump = useUi((s) => s.bump);
  const [mode, setMode] = useState<Mode>("conversation");
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [persisted, setPersisted] = useState<{ nodes: HostContextNode[]; edges: HostContextEdge[] } | null>(null);
  const [diskRows, setDiskRows] = useState<HostLedgerRow[]>([]);

  useEffect(() => {
    loadContextGraph(400).then(setPersisted).catch(() => undefined);
    loadRecentLedger().then(setDiskRows).catch(() => undefined);
  }, [tick]);

  const rows: Row[] = useMemo(() => {
    const live = listLedger().map((e) => ({
      ts: e.ts,
      requestedModel: e.requestedModel ?? e.model,
      model: e.model,
      providerId: e.providerId ?? null,
      providerName: e.providerId ? registry.getProvider(e.providerId)?.name ?? e.providerId : null,
      status: e.status,
      errorClass: e.errorClass ?? null,
      latencyMs: e.latencyMs ?? null,
      fallbacks: (e.fallbackChain ?? []).map(
        (a) => `${a.candidate.provider.name ?? a.candidate.provider.slug} · ${a.candidate.key.label} → ${a.cls}`,
      ),
    }));
    const disk = diskRows
      .filter((p) => !live.some((l) => Math.abs(l.ts - p.ts) < 1000 && l.model === p.model))
      .map((p) => ({
        ts: p.ts,
        requestedModel: p.requestedModel ?? p.model,
        model: p.model,
        providerId: p.providerId,
        providerName: p.providerId ? registry.getProvider(p.providerId)?.name ?? p.providerId : null,
        status: p.status,
        errorClass: p.errorClass,
        latencyMs: p.latencyMs,
        fallbacks: (() => {
          try {
            const arr = JSON.parse(p.fallbackChainJson ?? "[]") as { provider: string; key: string; cls: string }[];
            return arr.map((a) => `${a.provider} · ${a.key} → ${a.cls}`);
          } catch {
            return [];
          }
        })(),
      }));
    return [...live, ...disk].sort((a, b) => b.ts - a.ts);
  }, [tick, diskRows]);

  const graph: Graph = useMemo(() => {
    if (mode === "conversation") {
      return buildConversationGraph(persisted?.nodes ?? [], persisted?.edges ?? []);
    }
    if (mode === "routing") {
      const served = new Map<string, { requestedModel: string; model: string; providerId: string | null; count: number }>();
      for (const r of rows) {
        const key = `${r.requestedModel}|${r.providerId ?? "?"}|${r.model}`;
        const hit = served.get(key);
        if (hit) hit.count += 1;
        else served.set(key, { requestedModel: r.requestedModel, model: r.model, providerId: r.providerId, count: 1 });
      }
      return buildRoutingGraph({
        providers: registry.listProviders().map((p) => ({ id: p.id, name: p.name, status: p.status })),
        keysOf: (pid) => registry.keysOf(pid).map((k) => ({ id: k.id, label: k.label, status: k.status })),
        aliases: catalog.aliases.map((a) => ({ alias: a.alias, providerId: a.providerId, nativeModelId: a.nativeModelId, priority: a.priority })),
        served: Array.from(served.values()),
      });
    }
    return buildLiveGraph(rows);
  }, [mode, persisted, rows]);

  const kinds = useMemo(() => Array.from(new Set(graph.nodes.map((n) => n.kind))).sort(), [graph]);

  const visible = useMemo(() => {
    if (hidden.size === 0) return graph;
    const nodes = graph.nodes.filter((n) => !hidden.has(n.kind));
    const ok = new Set(nodes.map((n) => n.id));
    return { nodes, edges: graph.edges.filter((e) => ok.has(e.from) && ok.has(e.to)) };
  }, [graph, hidden]);

  const neighbours = useMemo(() => {
    if (!selected) return [];
    const out: { edge: string; other: GraphNode }[] = [];
    for (const e of graph.edges) {
      const otherId = e.from === selected.id ? e.to : e.to === selected.id ? e.from : null;
      if (!otherId) continue;
      const other = graph.nodes.find((n) => n.id === otherId);
      if (other) out.push({ edge: `${e.kind}${e.label ? ` (${e.label})` : ""}`, other });
    }
    return out;
  }, [graph, selected]);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="text-[20px] font-semibold">Context</h1>
        <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>
          {visible.nodes.length} nodes · {visible.edges.length} edges
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => {
              setMode(m.id);
              setSelected(null);
              setHidden(new Set());
            }}
            className="rounded px-2.5 py-1 text-[12px]"
            style={
              mode === m.id
                ? { background: "var(--surface-2)", color: "var(--text)" }
                : { color: "var(--text-dim)" }
            }
          >
            {m.label}
          </button>
        ))}
        <span className="ml-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
          {MODES.find((m) => m.id === mode)?.blurb}
        </span>
        {mode === "conversation" && (
          <button
            className="ml-auto rounded px-2 py-1 text-[11px]"
            style={{ color: "var(--danger)" }}
            onClick={() => {
              clearContextGraph().then(() => {
                setPersisted(null);
                setSelected(null);
                bump();
              }).catch(() => undefined);
            }}
          >
            clear graph
          </button>
        )}
      </div>

      {kinds.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {kinds.map((k) => {
            const off = hidden.has(k);
            return (
              <button
                key={k}
                onClick={() => {
                  const next = new Set(hidden);
                  if (off) next.delete(k);
                  else next.add(k);
                  setHidden(next);
                }}
                className="rounded px-1.5 py-0.5 text-[10px]"
                style={
                  off
                    ? { background: "transparent", color: "var(--text-faint)", border: "1px solid var(--border)" }
                    : { background: "var(--surface-2)", color: "var(--text-dim)" }
                }
              >
                {k}
              </button>
            );
          })}
        </div>
      )}

      {visible.nodes.length === 0 ? (
        <EmptyState
          title={
            mode === "conversation"
              ? "No context recorded yet. Messages, artifacts, skills and memories appear here as the Playground records them."
              : mode === "routing"
                ? "No routing data yet. Send a request in the Playground and the requested-to-served chain appears here."
                : "No requests yet. The last 60 requests and the providers they touched appear here."
          }
        />
      ) : (
        <div className="flex gap-3">
          <div className="min-w-0 flex-1 rounded border" style={{ borderColor: "var(--border)" }}>
            <ForceGraph graph={visible} selectedId={selected?.id ?? null} onSelect={setSelected} />
          </div>
          <aside className="w-[240px] shrink-0">
            {selected ? (
              <div className="rounded border p-3" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>{selected.kind}</div>
                <div className="mb-2 break-words text-[13px]">{selected.label}</div>
                {selected.detail && <div className="mb-2 text-[11px]" style={{ color: "var(--text-dim)" }}>{selected.detail}</div>}
                <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                  {neighbours.length} relation{neighbours.length === 1 ? "" : "s"}
                </div>
                <div className="max-h-[260px] overflow-y-auto">
                  {neighbours.map((n, i) => (
                    <button
                      key={i}
                      onClick={() => setSelected(n.other)}
                      className="mb-1 block w-full rounded px-1.5 py-1 text-left text-[11px] hover:brightness-110"
                      style={{ background: "var(--surface-2)" }}
                    >
                      <span style={{ color: "var(--text-faint)" }}>{n.edge}</span>
                      <br />
                      {n.other.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                Click a node to inspect it. Drag to pan, scroll to zoom, drag a node to pull the layout around.
              </p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
