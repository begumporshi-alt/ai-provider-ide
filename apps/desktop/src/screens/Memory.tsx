/**
 * Memory (P7) — the four layers, made inspectable.
 *
 * A memory store that cannot be read back is just a place things disappear into. So this screen
 * shows the raw layer alongside the distilled ones, because the whole reason L0 exists is that
 * an atom can be checked against what was actually said. Hiding L0 would make the distillation
 * unfalsifiable.
 *
 * Retrieval is BM25, not embeddings — no embedding model, no vector index, no second process.
 * That is why search here is keyword search, and why it is honest about being keyword search.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, inputCls, inputStyle } from "../components/atoms";
import { useUi } from "../ui-state";
import {
  clearMemories,
  forgetMemory,
  listMemories,
  memoryStats,
  recallMemories,
  setMemoryPinned,
  type Memory,
  type MemoryLayer,
  type MemoryStats,
} from "../store";

const LAYERS: { id: MemoryLayer | null; label: string; blurb: string }[] = [
  { id: null, label: "all", blurb: "every layer" },
  { id: "L0", label: "L0 raw", blurb: "what was actually said" },
  { id: "L1", label: "L1 atoms", blurb: "facts, preferences, constraints" },
  { id: "L2", label: "L2 scenarios", blurb: "knowledge blocks per subject" },
  { id: "L3", label: "L3 core", blurb: "stable long-term profile" },
];

const SEARCH_NOTE =
  "Search is BM25 keyword ranking over SQLite's full-text index — not semantic search. It stems, "
  + "so “routed” matches “routing”, but it will not find a memory that shares no words with your "
  + "query. There is no embedding model in this app, and that is deliberate.";

export function MemoryScreen() {
  const tick = useUi((s) => s.tick);
  const bump = useUi((s) => s.bump);
  const [all, setAll] = useState<Memory[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [layer, setLayer] = useState<MemoryLayer | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Memory[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listMemories(null, 300), memoryStats()])
      .then(([list, st]) => {
        setAll(list);
        setStats(st);
      })
      .catch(() => undefined);
  }, [tick]);

  // Search is debounced by hand: recall is a synchronous FTS query on the host, and running it
  // on every keystroke of a long query is wasted work for a result the user has not read yet.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    const t = setTimeout(() => {
      recallMemories(q, 20, layer ? [layer] : undefined)
        .then(setHits)
        .catch(() => setHits([]));
    }, 180);
    return () => clearTimeout(t);
  }, [query, layer, tick]);

  const shown = useMemo(() => {
    const base = hits ?? all;
    return layer ? base.filter((m) => m.layer === layer) : base;
  }, [hits, all, layer]);

  async function doForget(id: string) {
    setError(null);
    try {
      await forgetMemory(id);
      bump();
    } catch (e) {
      setError(String(e));
    }
  }

  async function doPin(m: Memory, pinned: boolean) {
    setError(null);
    try {
      await setMemoryPinned(m.id, pinned);
      bump();
    } catch (e) {
      setError(String(e));
    }
  }

  async function doClear() {
    setError(null);
    try {
      await clearMemories();
      bump();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="text-[20px] font-semibold">Memory</h1>
        <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>
          {stats ? `${stats.l0} raw · ${stats.l1} atoms · ${stats.l2} scenarios · ${stats.l3} core` : "—"}
        </span>
        <button
          className="ml-auto text-[11px]"
          style={{ color: "var(--danger)" }}
          onClick={doClear}
          disabled={!stats || stats.total === 0}
        >
          forget everything
        </button>
      </div>

      <p className="mb-4 rounded border p-2.5 text-[11px] leading-relaxed" style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text-dim)" }}>
        {SEARCH_NOTE}
      </p>

      {error && <p className="mb-3 text-[12px]" style={{ color: "var(--danger)" }}>{error}</p>}

      <div className="mb-3 flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search memory…"
          className={`${inputCls} flex-1`}
          style={inputStyle}
        />
        <div className="flex gap-1">
          {LAYERS.map((l) => (
            <button
              key={l.label}
              onClick={() => setLayer(l.id)}
              title={l.blurb}
              className="rounded px-2 py-1 text-[11px]"
              style={{
                background: layer === l.id ? "var(--accent)" : "var(--surface)",
                color: layer === l.id ? "var(--accent-fg, #fff)" : "var(--text-dim)",
                border: "1px solid var(--border)",
              }}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title={
            hits
              ? "Nothing matches that query."
              : "No memories yet. Chat with memory enabled in the Playground and durable facts will be distilled here."
          }
        />
      ) : (
        <div>
          {shown.map((m) => (
            <div key={m.id} className="mb-1.5 flex items-start gap-2 rounded border px-3 py-2" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
              <span className="mono mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}>
                {m.layer}
              </span>
              <div className="min-w-0 flex-1">
                <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed">{m.text}</div>
                <div className="mt-0.5 text-[10px]" style={{ color: "var(--text-faint)" }}>
                  {m.subject ? `${m.subject} · ` : ""}
                  {new Date(m.updated_at).toLocaleString()}
                  {m.score !== undefined ? ` · bm25 ${m.score.toFixed(2)}` : ""}
                </div>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[11px]" style={{ color: "var(--text-dim)" }}>
                <input type="checkbox" checked={m.pinned} onChange={(e) => doPin(m, e.target.checked)} />
                pin
              </label>
              <button className="shrink-0 text-[11px]" style={{ color: "var(--danger)" }} onClick={() => doForget(m.id)}>
                forget
              </button>
            </div>
          ))}
        </div>
      )}

      {hits && hits.length > 0 && (
        <div className="mt-2">
          <Button onClick={() => setQuery("")}>clear search</Button>
        </div>
      )}
    </div>
  );
}
