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
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, EmptyState, inputCls, inputStyle } from "../components/atoms";
import { useUi } from "../ui-state";
import { captureCore, editCore } from "../lib/memory/engine";
import { drainOnce } from "../lib/memory/drain";
import { ago, clock, groupByDay, RANGES, since } from "../lib/memory/timeline";
import {
  assignMemoryScope,
  captureQueueStatus,
  clearMemories,
  forgetMemory,
  gatewayMemoryEnabled,
  gatewayProjectKey,
  listMemories,
  memoryConflicts,
  memoryPrincipalList,
  memoryStats,
  modelContextCount,
  recallMemories,
  setGatewayMemoryEnabled,
  setMemoryPinned,
  setMemoryPrincipal,
  supersedeMemory,
  systemAiModel,
  unsupersedeMemory,
  type Memory,
  type MemoryConflict,
  type MemoryLayer,
  type MemoryStats,
  type PrincipalRow,
  type QueueStatus,
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

/**
 * Shown on every visit because the default is the surprising half: a memory is recorded but never
 * injected until it is scoped. Anything that says "the model did not remember this" otherwise gets
 * blamed on recall, which is working correctly.
 */
const SCOPE_NOTE =
  "Scope decides whether a memory is injected when an agent IDE calls the gateway. Every memory "
  + "starts “capture only” — recorded, but never sent with a request. Set one to “this project” to "
  + "make it available to agents working in this workspace, or “everywhere” for a fact that should "
  + "always apply. A memory is never global by default, so one project's context cannot leak into "
  + "another's.";

/**
 * Why the master switch is off by default, in the operator's terms rather than the design's.
 *
 * The switch is not a preference — it is the ship-blocking acceptance criterion. With it off the
 * gateway performs no memory reads and no writes, so behaviour is byte-identical to a build with
 * no memory layer at all. Saying that here is cheaper than having someone discover it in a log.
 */
const MEMORY_NOTE =
  "The memory layer is off until you turn it on. With it off the gateway does nothing extra: no context is "
  + "injected into a request and no turn is recorded, so an agent IDE's traffic is handled exactly "
  + "as it was before this feature existed. Turning it on makes the gateway record the tail of each "
  + "plain-prose request and, off to the side, distil it into the atoms listed below.";

/**
 * The write path, made observable.
 *
 * Everything below the atoms on this screen is derived work, and derived work that cannot be seen
 * is indistinguishable from work that never happened. So the queue depth and a manual drain are
 * both here: without them, "memory is not learning anything" has no first diagnostic step.
 */
/**
 * Per-client policy (§4a). Kept here rather than in the Gateway screen because the question it
 * answers is a memory question: not "who is connected" but "who is allowed to learn".
 *
 * The tri-state is the design, not a nicety. `inherit` is the default for every client that has
 * ever connected, and it has to stay visible as a choice — collapsing it into "on" would make an
 * unlisted client look explicitly enabled, which is the difference between a policy and a
 * checkbox nobody remembers setting.
 */
function PrincipalList({
  rows,
  bump,
  setError,
}: {
  rows: PrincipalRow[];
  bump: () => void;
  setError: (e: string | null) => void;
}) {
  const [draft, setDraft] = useState("");

  async function setPolicy(principal: string, value: boolean | null) {
    setError(null);
    try {
      await setMemoryPrincipal(principal, value);
      bump();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--border)" }}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] font-medium">Per client</span>
        <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>
          a client cannot switch on what you switch off here
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="mb-2 text-[11px]" style={{ color: "var(--text-faint)" }}>
          No client has identified itself yet. Add one by the label it sends as{" "}
          <span className="mono">AIP-Agent</span>.
        </p>
      ) : (
        <div data-testid="principal-list">
          {rows.map((r) => (
            <div key={r.principal} className="mb-1 flex items-center gap-2">
              <span className="mono text-[11px]" style={{ minWidth: "9rem" }}>{r.principal}</span>
              <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>
                {r.last_seen_at ? `seen ${ago(r.last_seen_at)}` : "never seen"}
              </span>
              <select
                className="ml-auto rounded border px-1 py-0.5 text-[10px]"
                style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text-dim)" }}
                value={r.enabled === null ? "inherit" : r.enabled ? "on" : "off"}
                onChange={(e) => {
                  const v = e.target.value;
                  void setPolicy(r.principal, v === "inherit" ? null : v === "on");
                }}
              >
                <option value="inherit">inherit</option>
                <option value="on">allow</option>
                <option value="off">deny</option>
              </select>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="agent label…"
          className={`${inputCls} mono flex-1`}
          style={inputStyle}
        />
        <Button
          onClick={() => {
            const name = draft.trim();
            if (!name) return;
            setDraft("");
            void setPolicy(name, false);
          }}
          disabled={!draft.trim()}
        >
          deny on arrival
        </Button>
      </div>
    </div>
  );
}

function MemoryLayerSection({
  tick,
  bump,
  setError,
}: {
  tick: number;
  bump: () => void;
  setError: (e: string | null) => void;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [principals, setPrincipals] = useState<PrincipalRow[]>([]);
  const [models, setModels] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      gatewayMemoryEnabled(),
      captureQueueStatus(),
      memoryPrincipalList(),
      modelContextCount(),
    ])
      .then(([on, q, ps, mc]) => {
        setEnabled(on);
        setQueue(q);
        setPrincipals(ps);
        setModels(mc);
      })
      .catch(() => undefined);
  }, []);

  useEffect(load, [load, tick]);

  async function doToggle(next: boolean) {
    setError(null);
    setNote(null);
    try {
      // Read the value back rather than assuming: the host is the authority, and a toggle that
      // shows "on" when the request path disagrees is worse than one that shows nothing.
      setEnabled(await setGatewayMemoryEnabled(next));
    } catch (e) {
      setError(String(e));
    }
  }

  async function doDrain() {
    setError(null);
    setBusy(true);
    try {
      const r = await drainOnce(systemAiModel());
      if (r.skipped) setNote("already distilling, or no system model is configured");
      else if (r.claimed === 0) setNote("nothing queued");
      else {
        setNote(
          `distilled ${r.distilled}/${r.claimed} · ${r.atoms} atoms written`
            + (r.released > 0 ? ` · ${r.released} failed, will retry` : "")
            + (r.requeued > 0 ? ` · ${r.requeued} recovered from an interrupted batch` : ""),
        );
      }
      load();
      bump();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Older hosts do not report the budget; `undefined` must render as "unknown", not as zero —
  // showing "0 left" on a host that has no cap would be a lie about work being withheld.
  const budget = queue?.budget_left ?? null;
  const held = budget === 0 && (queue?.outstanding ?? 0) > 0;

  return (
    <section
      className="mb-4 rounded border p-3"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      data-testid="memory-layer-section"
    >
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold">Memory layer</h2>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px]" style={{ color: "var(--text-dim)" }}>
          <input
            type="checkbox"
            checked={enabled ?? false}
            disabled={enabled === null}
            onChange={(e) => void doToggle(e.target.checked)}
            aria-label="Memory layer"
          />
          {enabled ? "on" : "off"}
        </label>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed" style={{ color: "var(--text-faint)" }}>
        {MEMORY_NOTE}
      </p>
      <div className="flex flex-wrap items-center gap-3 text-[11px]" style={{ color: "var(--text-dim)" }}>
        <span>
          {queue ? `${queue.outstanding} awaiting distillation` : "queue —"}
          {queue && queue.outstanding > 0 ? ` (${queue.queued} queued · ${queue.processing} in flight)` : ""}
        </span>
        {/* §10(2). A queue that is holding because the hourly budget is spent has to say so: without
            this, "5 awaiting distillation" that never moves reads as a stuck drain rather than as a
            cap doing its job. Optional because an older host does not report it. */}
        {budget !== null && (
          <span
            data-testid="distill-budget"
            style={held ? { color: "var(--warning)" } : undefined}
          >
            {held
              ? "holding — hourly distillation budget spent"
              : `${budget} distillations left this hour`}
          </span>
        )}
        <Button onClick={doDrain} disabled={busy}>
          {busy ? "distilling…" : "distil now"}
        </Button>
        {note && <span style={{ color: "var(--text-faint)" }}>{note}</span>}
      </div>

      {/* How much memory gets injected is sized against the model's context window (§3.4). At zero
          every request plans against a flat 8k default, which on a 200k model is a rounding error —
          so this is the first thing to check when recall looks starved. */}
      <p className="mt-1.5 text-[10px]" style={{ color: "var(--text-faint)" }}>
        {models === null
          ? "context windows —"
          : models === 0
            ? "no model context windows published — every request is budgeted against a flat 8k default"
            : `${models} model ${models === 1 ? "window" : "windows"} known — the injection budget is sized per model`}
      </p>

      <PrincipalList rows={principals} bump={bump} setError={setError} />
    </section>
  );
}

/**
 * When a memory was written and when it last came up.
 *
 * `dated` is set when a day header already supplies the date, in which case the exact clock time
 * is the useful half and a relative age would only repeat the header. In the ranked search list
 * there is no header, so the relative age is what you read.
 *
 * Both timestamps are worth seeing and they are usually the same, so the second only appears when
 * the two would *read* differently. Comparing the rendered strings rather than the raw delta is
 * what makes that correct: a re-record a few seconds after the first would otherwise print
 * "just now · first just now", which is noise, while a re-record an hour later prints
 * "1h ago · first 3d ago", which is the thing worth knowing.
 *
 * The distinction matters because a deduped atom is refreshed in place rather than duplicated, so
 * `updated_at` drifts away from `created_at` with no other visible trace. Showing only
 * `updated_at` would report when we last *saw* a fact as if it were when we learned it.
 */
const CONFLICT_NOTE =
  "Conflicts are the one judgment this app will not make for you. A pinned or core memory keeps "
  + "being injected because you said so, not because it is recent — so when a newer atom on the "
  + "same subject says something different, both stay and you decide. Nothing here is resolved "
  + "automatically, and superseding a pinned or core memory is refused outright.";

/**
 * §6.4.5: the human's step in conflict resolution.
 *
 * Deliberately the only place a contradiction is decided. The host refuses to supersede a pinned or
 * L3 row, which is what keeps this list meaningful — if the gateway resolved these itself, a stale
 * pin would silently poison retrieval and nothing would ever surface.
 */
function ConflictSection({
  tick,
  bump,
  setError,
}: {
  tick: number;
  bump: () => void;
  setError: (e: string | null) => void;
}) {
  const [conflicts, setConflicts] = useState<MemoryConflict[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    memoryConflicts()
      .then(setConflicts)
      .catch(() => undefined);
  }, []);

  useEffect(load, [load, tick]);

  async function newerWins(held: Memory, newer: Memory) {
    setError(null);
    setBusy(held.id);
    try {
      // A pin guarantees survival, not truth, so the human's "the newer one is right" first has to
      // release the guarantee. The host would refuse otherwise.
      if (held.pinned) await setMemoryPinned(held.id, false);
      await supersedeMemory(held.id, newer.id);
      bump();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function keepHeld(newer: Memory) {
    setError(null);
    setBusy(newer.id);
    try {
      await forgetMemory(newer.id);
      bump();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  if (conflicts.length === 0) return null;

  return (
    <section
      className="mb-4 rounded border p-3"
      style={{ borderColor: "var(--warning, var(--border))", background: "var(--surface)" }}
      data-testid="conflict-section"
    >
      <h2 className="mb-1 text-[13px] font-semibold">
        Conflicts <span style={{ color: "var(--text-dim)" }}>({conflicts.length})</span>
      </h2>
      <p className="mb-2.5 text-[11px] leading-relaxed" style={{ color: "var(--text-dim)" }}>
        {CONFLICT_NOTE}
      </p>
      {conflicts.map((c) => {
        // An L3 row cannot be superseded at all, so "newer wins" is not an available answer — only
        // forgetting the core fact is, and that is a bigger act than a button should take.
        const core = c.held.layer === "L3";
        return (
          <div
            key={`${c.held.id}:${c.newer.id}`}
            className="mb-2 rounded border px-3 py-2"
            style={{ borderColor: "var(--border)" }}
          >
            <div className="text-[12px] leading-relaxed">
              <span
                className="mono rounded px-1 py-0.5 text-[10px]"
                style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}
              >
                {c.held.pinned ? "pinned" : c.held.layer}
              </span>{" "}
              {c.held.text}
            </div>
            <div className="mt-1 text-[12px] leading-relaxed">
              <span
                className="mono rounded px-1 py-0.5 text-[10px]"
                style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}
              >
                newer
              </span>{" "}
              {c.newer.text}
            </div>
            <div className="mt-1.5 flex items-center gap-3">
              <button
                className="text-[11px]"
                style={{ color: core ? "var(--text-faint)" : "var(--accent)" }}
                disabled={core || busy !== null}
                title={core ? "a core fact is replaced by forgetting it, not by a newer atom" : undefined}
                onClick={() => void newerWins(c.held, c.newer)}
              >
                {core ? "core — not supersedable" : "the newer one is right"}
              </button>
              <button
                className="text-[11px]"
                style={{ color: "var(--danger)" }}
                disabled={busy !== null}
                onClick={() => void keepHeld(c.newer)}
              >
                {c.held.pinned ? "the pin is still right" : "keep the core fact"}
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function MemoryWhen({ m, dated }: { m: Memory; dated: boolean }) {
  const seen = dated ? clock(m.updated_at) : ago(m.updated_at);
  const first = ago(m.created_at);
  return (
    <>
      <span title={new Date(m.updated_at).toLocaleString()}>{seen}</span>
      {first !== ago(m.updated_at) && (
        <>
          {" · first "}
          <span title={new Date(m.created_at).toLocaleString()}>{first}</span>
        </>
      )}
    </>
  );
}

/** One memory. Extracted so the ranked list and the day-grouped timeline cannot drift apart. */
/**
 * Where a memory may be injected. Every row starts `off`; nothing is injected until someone
 * scopes it on purpose.
 *
 * `project` is disabled when the host has no workspace root, because there is then no project to
 * bind to — offering it would produce a scope that can never match a request.
 */
function ScopeSelect({
  m,
  projectKey,
  onChange,
}: {
  m: Memory;
  projectKey: string | null;
  onChange: (
    m: Memory,
    scope: { kind: "project"; project: string } | { kind: "global" } | { kind: "unscoped" },
  ) => void;
}) {
  const value = m.scope.global ? "global" : m.scope.project ? "project" : "off";
  return (
    <select
      className="shrink-0 rounded border px-1 py-0.5 text-[10px]"
      style={{ borderColor: "var(--border)", background: "var(--surface-2)", color: "var(--text-dim)" }}
      title={
        value === "off"
          ? "Capture-only. Never injected into any request."
          : value === "global"
            ? "Injected into every request, in every project."
            : "Injected into requests from this project."
      }
      value={value}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "global") onChange(m, { kind: "global" });
        else if (v === "project" && projectKey) onChange(m, { kind: "project", project: projectKey });
        else onChange(m, { kind: "unscoped" });
      }}
    >
      <option value="off">capture only</option>
      <option value="project" disabled={!projectKey}>
        this project{projectKey ? "" : " (no root)"}
      </option>
      <option value="global">everywhere</option>
    </select>
  );
}

function MemoryRow({
  m,
  dated,
  projectKey,
  onPin,
  onScope,
  onForget,
  onUnsupersede,
}: {
  m: Memory;
  dated: boolean;
  projectKey: string | null;
  onPin: (m: Memory, pinned: boolean) => void;
  onScope: (
    m: Memory,
    scope: { kind: "project"; project: string } | { kind: "global" } | { kind: "unscoped" },
  ) => void;
  onForget: (id: string) => void;
  onUnsupersede: (id: string) => void;
}) {
  // Loose `!=` (not `!==`): the shim and any row older than the §6.4 migration arrives with
  // `superseded_at` undefined, and those rows are live — only a real timestamp means superseded.
  const gone = m.superseded_at != null;
  return (
    <div
      className="mb-1.5 flex items-start gap-2 rounded border px-3 py-2"
      style={{
        borderColor: "var(--border)",
        background: "var(--surface)",
        opacity: gone ? 0.5 : 1,
      }}
    >
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
          <MemoryWhen m={m} dated={dated} />
          {m.score !== undefined ? ` · bm25 ${m.score.toFixed(2)}` : ""}
          {gone && " · superseded, no longer injected"}
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

export function MemoryScreen() {
  const tick = useUi((s) => s.tick);
  const bump = useUi((s) => s.bump);
  const [all, setAll] = useState<Memory[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [layer, setLayer] = useState<MemoryLayer | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Memory[] | null>(null);
  const [range, setRange] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([listMemories(null, 300), memoryStats(), gatewayProjectKey()])
      .then(([list, st, key]) => {
        setAll(list);
        setStats(st);
        setProjectKey(key);
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
    const byLayer = layer ? base.filter((m) => m.layer === layer) : base;
    // The range cuts on `updated_at` because that is the same timestamp the list is ordered by and
    // the rows display. Filtering on a different one would make a row's own label contradict why
    // it is on screen.
    const cutoff = since(range);
    return cutoff > 0 ? byLayer.filter((m) => m.updated_at >= cutoff) : byLayer;
  }, [hits, all, layer, range]);

  // Browse mode gets a date axis; the ranked search list does not. Grouping search results by day
  // would fight the ranking they came back in.
  const groups = useMemo(
    () => (hits ? null : groupByDay(shown, (m) => m.updated_at)),
    [hits, shown],
  );

  async function doForget(id: string) {
    setError(null);
    try {
      await forgetMemory(id);
      bump();
    } catch (e) {
      setError(String(e));
    }
  }

  async function doUnsupersede(id: string) {
    setError(null);
    try {
      await unsupersedeMemory(id);
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

  async function doScope(
    m: Memory,
    scope: { kind: "project"; project: string } | { kind: "global" } | { kind: "unscoped" },
  ) {
    setError(null);
    try {
      await assignMemoryScope(m.id, scope);
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
          {stats
            ? `${stats.l0} raw · ${stats.l1} atoms · ${stats.l2} scenarios · ${stats.l3} core`
            : "—"}
        </span>
        {stats && stats.injectable !== stats.total && (
          <span
            className="text-[11px]"
            style={{ color: "var(--text-faint)" }}
            title="rows that can actually be injected; the rest are capture-only"
          >
            {stats.injectable} injectable
          </span>
        )}
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

      <p className="mb-4 rounded border p-2.5 text-[11px] leading-relaxed" style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text-dim)" }}>
        {SCOPE_NOTE}
      </p>

      {error && <p className="mb-3 text-[12px]" style={{ color: "var(--danger)" }}>{error}</p>}

      <MemoryLayerSection tick={tick} bump={bump} setError={setError} />

      <ConflictSection tick={tick} bump={bump} setError={setError} />

      <CoreSection all={all} bump={bump} setError={setError} />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search memory…"
          className={`${inputCls} min-w-[200px] flex-1`}
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
        {/* A rule between the two filter groups: without it the "range" label sits flush against
            the last layer chip and the two read as one control group. */}
        <div className="flex items-center gap-2 border-l pl-3" style={{ borderColor: "var(--border)" }}>
          <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
            range
          </span>
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <button
                key={r.label}
                onClick={() => setRange(r.days)}
                title={r.days === 0 ? "everything recorded" : `recorded in the last ${r.label}`}
                className="rounded px-2 py-1 text-[11px]"
                style={{
                  background: range === r.days ? "var(--accent)" : "var(--surface)",
                  color: range === r.days ? "var(--accent-fg, #fff)" : "var(--text-dim)",
                  border: "1px solid var(--border)",
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title={
            hits
              ? "Nothing matches that query."
              : range > 0
                ? `Nothing recorded in the last ${range === 1 ? "24 hours" : `${range} days`}.`
                : "No memories yet. Chat with memory enabled in the Assistant and durable facts will be distilled here."
          }
        />
      ) : groups ? (
        // Browsing: the date is the axis, so it gets headers, and each row shows the clock time
        // rather than a relative age that would only restate the header above it.
        <div data-testid="memory-list">
          {groups.map((g) => (
            <section key={g.key} className="mb-3">
              <div
                data-testid="memory-day"
                className="mb-1.5 text-[10px] uppercase tracking-wide"
                style={{ color: "var(--text-faint)" }}
              >
                {g.label} · {g.items.length}
              </div>
              {g.items.map((m) => (
                <MemoryRow
                  key={m.id}
                  m={m}
                  dated
                  projectKey={projectKey}
                  onPin={doPin}
                  onScope={doScope}
                  onForget={doForget}
                  onUnsupersede={doUnsupersede}
                />
              ))}
            </section>
          ))}
        </div>
      ) : (
        // Ranked results: a flat list. Grouping by day would contradict the ranking.
        <div data-testid="memory-list">
          {shown.map((m) => (
            <MemoryRow
              key={m.id}
              m={m}
              dated={false}
              projectKey={projectKey}
              onPin={doPin}
              onScope={doScope}
              onForget={doForget}
                  onUnsupersede={doUnsupersede}
            />
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
                  {/* The core profile is not day-grouped — it is a standing set of facts, not a
                      stream — so these keep the relative age. */}
                  <MemoryWhen m={m} dated={false} />
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
