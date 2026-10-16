/**
 * Mind Atlas — the Memory screen's picture of itself.
 *
 * The list below it answers "what does this row say"; the atlas answers "what shape does the
 * whole mind have": which conversations taught the store the most, which facts are pinned into
 * the skeleton, what has been superseded but kept. The graph only draws relationships the store
 * records (memory → the session that produced it); see lib/memory/atlas.ts for the builder and
 * its honesty rules.
 *
 * Everything actionable in the list is actionable here: selecting a node opens the same pin,
 * scope, restore and forget controls the row has, against the same handlers.
 */
import { useMemo, useState } from "react";
import { buildAtlasGraph, ATLAS_CAP } from "../lib/memory/atlas";
import { ago } from "../lib/memory/timeline";
import type { Memory } from "../store";
import { ForceGraph } from "./ForceGraph";
import { ScopeSelect, type MemoryScopeChoice } from "./ScopeSelect";

const LEGEND: { dot: string; label: string }[] = [
  { dot: "var(--text-faint)", label: "L0 raw" },
  { dot: "var(--info)", label: "L1 atoms" },
  { dot: "var(--ai)", label: "L2 scenarios" },
  { dot: "var(--success)", label: "L3 core" },
  { dot: "var(--text-dim)", label: "session" },
];

export function MindAtlas({
  memories,
  sessionTitles,
  projectKey,
  onPin,
  onScope,
  onForget,
  onUnsupersede,
}: {
  memories: Memory[];
  sessionTitles: Map<string, string>;
  projectKey: string | null;
  onPin: (m: Memory, pinned: boolean) => void;
  onScope: (m: Memory, scope: MemoryScopeChoice) => void;
  onForget: (id: string) => void;
  onUnsupersede: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { graph, sessionCount, unfiled, capped } = useMemo(
    () => buildAtlasGraph(memories, sessionTitles),
    [memories, sessionTitles],
  );

  const selected = useMemo(() => {
    const node = graph.nodes.find((n) => n.id === selectedId);
    if (!node) return null;
    const memoryId = node.meta?.memoryId as string | undefined;
    if (memoryId) return { node, memory: memories.find((m) => m.id === memoryId) ?? null };
    return { node, memory: null };
  }, [graph, selectedId, memories]);

  const sessionMembers = useMemo(() => {
    if (!selected || selected.memory || !selected.node.meta) return [];
    const ids = selected.node.meta.memberIds as string[];
    return ids.map((id) => memories.find((m) => m.id === id)).filter((m): m is Memory => Boolean(m));
  }, [selected, memories]);

  if (memories.length === 0) return null;

  return (
    <section
      className="mb-4 rounded border p-3"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      data-testid="mind-atlas"
    >
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold">Mind Atlas</h2>
        <span className="text-[11px]" style={{ color: "var(--text-dim)" }} data-testid="atlas-counts">
          {memories.length} {memories.length === 1 ? "memory" : "memories"}
          {" · "}
          {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
          {unfiled > 0 ? ` · ${unfiled} unfiled` : ""}
          {capped ? ` · showing the most recent ${ATLAS_CAP}` : ""}
        </span>
        <button
          className="text-[11px]"
          style={{ color: "var(--text-dim)" }}
          data-testid="atlas-toggle"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "hide" : "show"}
        </button>
      </div>
      <p className="mb-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
        What the store looks like as a shape. A memory sits in the conversation that produced it;
        pinned and core facts are the heavy dots; a faded dot was superseded — kept, not deleted.
        Only recorded relationships are drawn: no line means no stored link.
      </p>

      {open && (
        <>
          <div className="mb-1 flex flex-wrap items-center gap-3 text-[10px]" style={{ color: "var(--text-dim)" }} data-testid="atlas-legend">
            {LEGEND.map((l) => (
              <span key={l.label} className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: l.dot }} />
                {l.label}
              </span>
            ))}
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full opacity-30" style={{ background: "var(--text-dim)" }} />
              superseded
            </span>
          </div>
          <div data-testid="atlas-canvas">
            <ForceGraph
              graph={graph}
              height={420}
              selectedId={selectedId}
              onSelect={(n) => setSelectedId(n?.id ?? null)}
            />
          </div>

          {selected && (
            <div
              className="mt-1 rounded border px-3 py-2"
              style={{ borderColor: "var(--border)", background: "var(--background)" }}
              data-testid="atlas-detail"
            >
              {selected.memory ? (
                <AtlasMemoryDetail
                  m={selected.memory}
                  projectKey={projectKey}
                  onPin={onPin}
                  onScope={onScope}
                  onForget={onForget}
                  onUnsupersede={onUnsupersede}
                />
              ) : (
                <div>
                  <div className="text-[12px] font-medium">{selected.node.label}</div>
                  <div className="mt-1 text-[11px]" style={{ color: "var(--text-dim)" }}>
                    {selected.node.detail}
                  </div>
                  <ul className="mt-1.5 space-y-0.5">
                    {sessionMembers.slice(0, 8).map((m) => (
                      <li key={m.id} className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                        <span className="mono mr-1.5" style={{ color: "var(--text-faint)" }}>{m.layer}</span>
                        {m.text.length > 70 ? `${m.text.slice(0, 69)}…` : m.text}
                      </li>
                    ))}
                  </ul>
                  {sessionMembers.length > 8 && (
                    <div className="mt-1 text-[10px]" style={{ color: "var(--text-faint)" }}>
                      and {sessionMembers.length - 8} more
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function AtlasMemoryDetail({
  m,
  projectKey,
  onPin,
  onScope,
  onForget,
  onUnsupersede,
}: {
  m: Memory;
  projectKey: string | null;
  onPin: (m: Memory, pinned: boolean) => void;
  onScope: (m: Memory, scope: MemoryScopeChoice) => void;
  onForget: (id: string) => void;
  onUnsupersede: (id: string) => void;
}) {
  const gone = m.superseded_at != null;
  return (
    <div className="flex items-start gap-2">
      <span
        className="mono mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px]"
        style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}
      >
        {m.layer}
      </span>
      <div className="min-w-0 flex-1">
        <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed">{m.text}</div>
        <div className="mt-0.5 text-[10px]" style={{ color: "var(--text-faint)" }}>
          {m.subject ? `${m.subject} · ` : ""}
          <span title={new Date(m.updated_at).toLocaleString()}>{ago(m.updated_at)}</span>
          {m.pinned ? " · pinned" : ""}
          {gone ? " · superseded, no longer injected" : ""}
        </div>
      </div>
      <ScopeSelect m={m} projectKey={projectKey} onChange={onScope} />
      <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px]" style={{ color: "var(--text-dim)" }}>
        <input type="checkbox" checked={m.pinned} onChange={(e) => onPin(m, e.target.checked)} />
        pin
      </label>
      {gone && (
        <button
          className="shrink-0 text-[11px]"
          style={{ color: "var(--accent)" }}
          onClick={() => onUnsupersede(m.id)}
          title="the row was never deleted — this only makes it reachable again"
        >
          restore
        </button>
      )}
      <button className="shrink-0 text-[11px]" style={{ color: "var(--danger)" }} onClick={() => onForget(m.id)}>
        forget
      </button>
    </div>
  );
}
