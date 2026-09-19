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
import { captureCore, editCore } from "../lib/memory/engine";
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

/** L3 has a dedicated editor above the main list, so it is excluded here to avoid duplication.
 *  Selecting L3 from the filter would show nothing — the chip is removed for the same reason. */
const LAYERS: { id: MemoryLayer | null; label: string; blurb: string }[] = [
  { id: null, label: "derived", blurb: "L0 raw, L1 atoms, L2 scenarios" },
  { id: "L0", label: "L0 raw", blurb: "what was actually said" },
  { id: "L1", label: "L1 atoms", blurb: "facts, preferences, constraints" },
  { id: "L2", label: "L2 scenarios", blurb: "knowledge blocks per subject" },
];

const SEARCH_NOTE =
  "Search is BM25 keyword ranking over SQLite's full-text index — not semantic search. It stems, "
  + "so “routed” matches “routing”, but it will not find a memory that shares no words with your "
  + "query. There is no embedding model in this app, and that is deliberate. Ties are broken "
  + "toward the more recent memory.";

/** Coarse relative age. Precision is not the point — "3d ago" is what you read to judge recency. */
function ago(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/**
 * When a memory was written and when it last came up.
 *
 * Both are worth seeing and they are usually the same, so the second only appears when the two
 * would *read* differently. Comparing the rendered strings rather than the raw delta is what makes
 * that correct: a re-record a few seconds after the first would otherwise print
 * "just now · first just now", which is noise, while a re-record an hour later prints
 * "1h ago · first 3d ago", which is the thing worth knowing.
 *
 * The distinction matters because a deduped atom is refreshed in place rather than duplicated, so
 * `updated_at` drifts away from `created_at` with no other visible trace. Showing only
 * `updated_at` would report when we last *saw* a fact as if it were when we learned it.
 */
function MemoryAge({ m }: { m: Memory }) {
  const seen = ago(m.updated_at);
  const first = ago(m.created_at);
  return (
    <>
      <span title={new Date(m.updated_at).toLocaleString()}>{seen}</span>
      {first !== seen && (
        <>
          {" · first "}
          <span title={new Date(m.created_at).toLocaleString()}>{first}</span>
        </>
      )}
    </>
  );
}

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
    // L3 is owned by CoreSection — excluded from the derived list to keep one source of truth.
    const base = (hits ?? all).filter((m) => m.layer !== "L3");
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

      <CoreSection all={all} bump={bump} setError={setError} />

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
        <div data-testid="memory-list">
          {shown.map((m) => (
            <div key={m.id} className="mb-1.5 flex items-start gap-2 rounded border px-3 py-2" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
              <span className="mono mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}>
                {m.layer}
              </span>
              <div className="min-w-0 flex-1">
                <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed">{m.text}</div>
                <div className="mt-0.5 text-[10px]" style={{ color: "var(--text-faint)" }}>
                  {m.subject ? `${m.subject} · ` : ""}
                  <MemoryAge m={m} />
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

/**
 * Core profile editor. L3 is the only layer the user authors directly — everything else is
 * derived from chat — because the stable things about a person are the things the person
 * knows. Pinning is implicit on save so a new fact always rides along in recall.
 */
function CoreSection({
  all,
  bump,
  setError,
}: {
  all: Memory[];
  bump: () => void;
  setError: (e: string | null) => void;
}) {
  const core = useMemo(
    () => all.filter((m) => m.layer === "L3").sort((a, b) => a.created_at - b.created_at),
    [all],
  );
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  async function doAdd() {
    const text = draft.trim();
    if (!text) return;
    setError(null);
    try {
      await captureCore(text);
      setDraft("");
      bump();
    } catch (e) {
      setError(String(e));
    }
  }

  async function doSaveEdit() {
    if (!editingId) return;
    const text = editDraft.trim();
    if (!text) return;
    setError(null);
    try {
      await editCore(editingId, text);
      setEditingId(null);
      setEditDraft("");
      bump();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section
      className="mb-5 rounded border p-3"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      data-testid="core-profile"
    >
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold">Core profile</h2>
        <span className="text-[11px]" style={{ color: "var(--text-dim)" }}>
          {core.length} {core.length === 1 ? "fact" : "facts"} · always injected into recall
        </span>
      </div>
      <p className="mb-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
        L3 is yours to author. The other layers are derived from chat; this one is the stable
        stuff about you that the model should never ask twice. Pinned on save.
      </p>
      {core.length > 0 && (
        <div className="mb-3">
          {core.map((m) => (
            <div
              key={m.id}
              className="mb-1.5 flex items-start gap-2 rounded border px-3 py-2"
              style={{ borderColor: "var(--border)", background: "var(--background)" }}
            >
              <span
                className="mono mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}
              >
                L3
              </span>
              <div className="min-w-0 flex-1">
                {editingId === m.id ? (
                  <textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    rows={3}
                    className={`${inputCls} mono w-full`}
                    style={{ ...inputStyle, resize: "vertical" }}
                  />
                ) : (
                  <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed">
                    {m.text}
                  </div>
                )}
                <div className="mt-0.5 text-[10px]" style={{ color: "var(--text-faint)" }}>
                  <MemoryAge m={m} />
                </div>
              </div>
              {editingId === m.id ? (
                <>
                  <button
                    className="shrink-0 text-[11px]"
                    style={{ color: "var(--text-dim)" }}
                    onClick={() => {
                      setEditingId(null);
                      setEditDraft("");
                    }}
                  >
                    cancel
                  </button>
                  <button
                    className="shrink-0 text-[11px]"
                    style={{ color: "var(--accent)" }}
                    onClick={doSaveEdit}
                    disabled={!editDraft.trim()}
                  >
                    save
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="shrink-0 text-[11px]"
                    style={{ color: "var(--text-dim)" }}
                    onClick={() => {
                      setEditingId(m.id);
                      setEditDraft(m.text);
                    }}
                  >
                    edit
                  </button>
                  <button
                    className="shrink-0 text-[11px]"
                    style={{ color: "var(--danger)" }}
                    onClick={async () => {
                      setError(null);
                      try {
                        await forgetMemory(m.id);
                        bump();
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    forget
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        placeholder="add a stable fact about you…"
        className={`${inputCls} mono w-full`}
        style={{ ...inputStyle, resize: "vertical" }}
      />
      <div className="mt-2 flex justify-end">
        <Button onClick={doAdd} disabled={!draft.trim()}>save as core</Button>
      </div>
    </section>
  );
}
