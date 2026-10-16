/**
 * Mind Atlas — the graph the Memory screen draws.
 *
 * The list below it is for reading one memory; this is for seeing the shape of the whole store:
 * which conversations learned things, how the atoms cluster, what is pinned, what has been
 * superseded. Only relationships the store actually records are drawn — a memory to the session
 * that produced it — because an atlas that invents links between atoms that merely share a word
 * would be a lie with a legend.
 *
 * Pure and DOM-free so vitest can pin the builder directly (same rule as timeline.ts).
 */
import type { Graph, GraphNode } from "../context/engine";
import { ago } from "./timeline";

/** The fields of a memory row the atlas reads. A superset is fine. */
export interface AtlasMemory {
  id: string;
  layer: string;
  text: string;
  session_id: string | null;
  subject: string | null;
  pinned: boolean;
  created_at: number;
  updated_at: number;
  superseded_at: number | null;
}

/**
 * The simulation is O(n²) per tick, so past a few hundred nodes it stops being a picture and
 * starts being a heater. The cap keeps the most recent rows — the same rows the screen's own
 * list loads first — and the header says when it bit.
 */
export const ATLAS_CAP = 260;

export interface AtlasResult {
  graph: Graph;
  /** Distinct sessions that produced at least one kept memory. The unfiled hub is not counted. */
  sessionCount: number;
  /** Memories with no session at all, gathered under the "unfiled" hub. */
  unfiled: number;
  /** True when the cap dropped rows — the header owes the reader that honesty. */
  capped: boolean;
}

const LAYER_LABEL: Record<string, string> = {
  L0: "raw",
  L1: "atom",
  L2: "scenario",
  L3: "core",
};

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function buildAtlasGraph(
  memories: readonly AtlasMemory[],
  sessionTitles: ReadonlyMap<string, string> = new Map(),
  now: number = Date.now(),
): AtlasResult {
  const kept = [...memories]
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, ATLAS_CAP);

  const nodes: GraphNode[] = [];
  const edges: Graph["edges"] = [];
  const members = new Map<string, string[]>();

  for (const m of kept) {
    const superseded = m.superseded_at != null;
    nodes.push({
      id: `mem:${m.id}`,
      kind: m.layer,
      label: clip(m.text, 44),
      detail: `${m.subject ?? LAYER_LABEL[m.layer] ?? m.layer} · ${ago(m.updated_at, now)}${superseded ? " · superseded" : ""}${m.pinned ? " · pinned" : ""}`,
      ts: m.updated_at,
      // Pinned and core facts are the stable skeleton of the mind; they read heavier, the
      // way they read in recall — always there, whatever is recent.
      weight: superseded ? 1 : m.pinned ? 3.5 : m.layer === "L3" ? 3 : 1.5,
      dim: superseded || undefined,
      meta: { memoryId: m.id },
    });
    const sid = m.session_id ?? "unfiled";
    const list = members.get(sid);
    if (list) list.push(m.id);
    else members.set(sid, [m.id]);
    edges.push({
      id: `atlas:${m.id}`,
      from: `ses:${sid}`,
      to: `mem:${m.id}`,
      kind: "learned_in",
      weight: 1,
    });
  }

  let sessionCount = 0;
  let unfiled = 0;
  for (const [sid, ids] of members) {
    const isUnfiled = sid === "unfiled";
    if (isUnfiled) unfiled = ids.length;
    else sessionCount += 1;
    nodes.push({
      id: `ses:${sid}`,
      kind: "session",
      label: isUnfiled
        ? "unfiled"
        : clip(sessionTitles.get(sid) ?? `session ${clip(sid, 10)}`, 30),
      detail: isUnfiled
        ? `${ids.length} ${ids.length === 1 ? "memory" : "memories"} not tied to a session`
        : `${ids.length} ${ids.length === 1 ? "memory" : "memories"}`,
      weight: ids.length,
      meta: { sessionId: sid, memberIds: ids },
    });
  }

  return { graph: { nodes, edges }, sessionCount, unfiled, capped: memories.length > kept.length };
}
