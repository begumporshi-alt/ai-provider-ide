/**
 * Sources — the human-facing management surface for cross-agent session discovery.
 *
 * The backend has read-only adapters over every AI coding agent's session store on this machine
 * (zcode, Claude, Codex, Qoder, this app's own transcripts) plus two empty stubs. Until now the
 * only UI was the Assistant's per-turn related list (capped at 8 and hidden behind a memory
 * entry); this screen lists every adapter with its real count, browses and searches their
 * sessions, filters by workspace or adapter, and imports one with an explicit, idempotent write.
 *
 * The host treats `q` as a cross-source search: when a query is present the route fans out to
 * every adapter and ignores the source/root parameters. The screen therefore applies the source
 * and root filters to those hits locally, so the controls compose the way the user expects while
 * discovery still searches everywhere.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  EmptyState,
  Spinner,
  StatusDot,
  inputCls,
  inputStyle,
} from "../components/atoms";
import type { RelatedSourceSession } from "../lib/memory/manifest";
import {
  importSourceSession,
  listAgentSources,
  listSourceSessions,
  type AgentSourceInfo,
} from "../store";
import { useUi } from "../ui-state";

/** How long typing settles before the list refetches, the same beat the Memory search uses. */
const SEARCH_DEBOUNCE_MS = 180;
/** The listing cap. The management view is for browsing a machine, not paging an archive. */
const LIST_LIMIT = 100;

export function SourcesScreen() {
  const tick = useUi((s) => s.tick);
  const [sources, setSources] = useState<AgentSourceInfo[]>([]);
  const [sessions, setSessions] = useState<RelatedSourceSession[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [root, setRoot] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [debouncedRoot, setDebouncedRoot] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // A refetch is not instantaneous and the filters can change mid-flight; only the newest
  // request may write state, or a slow earlier response overwrites a newer list.
  const requestSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQuery(query.trim());
      setDebouncedRoot(root.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, root]);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setError(null);
    try {
      const [list, hits] = await Promise.all([
        listAgentSources(),
        debouncedQuery
          ? // A query is a cross-source search on the host; the filters compose below.
            listSourceSessions({ query: debouncedQuery, limit: LIST_LIMIT })
          : listSourceSessions({
              source: source ?? undefined,
              root: debouncedRoot || undefined,
              limit: LIST_LIMIT,
            }),
      ]);
      if (seq !== requestSeq.current) return;
      setSources(list);
      setSessions(
        debouncedQuery
          ? hits.filter(
              (h) =>
                (!source || h.source === source) &&
                (!debouncedRoot || h.root === debouncedRoot),
            )
          : hits,
      );
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setSessions([]);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [debouncedQuery, debouncedRoot, source]);

  // `tick` is the app's "something changed" signal (imports, other screens' writes); a bump
  // refetches rather than leaving a stale list on screen.
  useEffect(() => {
    void load();
  }, [load, tick]);

  async function doImport(hit: RelatedSourceSession) {
    const key = `${hit.source}:${hit.nativeId}`;
    setBusyKey(key);
    setError(null);
    setNote(null);
    try {
      const result = await importSourceSession(hit.source, hit.nativeId);
      setNote(
        `Imported ${result.turns} turn(s) from ${hit.source} as ${result.sessionId}. ` +
          "The original session is untouched.",
      );
      // The listing marks imported rows by their deterministic id, so a refetch is what turns
      // the button into the "imported" label.
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  }

  const totalSessions = sources.reduce((n, s) => n + s.sessionCount, 0);
  const filtered = Boolean(debouncedQuery || debouncedRoot || source);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold">Sources</h1>
          <p className="mt-1 text-[12px]" style={{ color: "var(--text-dim)" }}>
            Conversations from other AI coding agents on this machine. Read-only until you
            import one.
          </p>
        </div>
        <Button onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      </div>

      {/* One card per adapter (and "all"). The dot is availability, the count is what the
          adapter's store actually holds, and the note explains the empty stubs. */}
      <div className="mb-3 flex flex-wrap gap-2" data-testid="source-adapters">
        <AdapterChip
          label="all"
          count={totalSessions}
          active={source === null}
          onClick={() => setSource(null)}
        />
        {sources.map((s) => (
          <AdapterChip
            key={s.name}
            label={s.name}
            count={s.sessionCount}
            available={s.available}
            note={s.note ?? undefined}
            active={source === s.name}
            onClick={() => setSource(source === s.name ? null : s.name)}
          />
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className={`${inputCls} max-w-[380px]`}
          style={inputStyle}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setQuery("");
              e.stopPropagation();
            }
          }}
          placeholder="Search sessions, workspaces and previews…"
          aria-label="Search sessions"
        />
        <input
          className={`${inputCls} mono max-w-[300px]`}
          style={inputStyle}
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setRoot("");
              e.stopPropagation();
            }
          }}
          placeholder="/absolute/path (optional)"
          aria-label="Workspace root filter"
        />
        {filtered ? (
          <Button
            variant="ghost"
            onClick={() => {
              setQuery("");
              setRoot("");
              setSource(null);
            }}
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {note ? (
        <p
          className="mb-3 text-[12px]"
          style={{ color: "var(--text-dim)" }}
          data-testid="source-status"
        >
          {note}
        </p>
      ) : null}

      {error ? (
        <div
          className="mb-3 rounded border p-3 text-[12px]"
          style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
          data-testid="source-error"
        >
          <p>{error}</p>
          <p className="mt-1" style={{ color: "var(--text-dim)" }}>
            Source data comes from the local gateway. Start it under Control → Local Gateway,
            then Refresh.
          </p>
        </div>
      ) : null}

      {loading ? (
        <Spinner label="Loading sessions…" />
      ) : sessions.length === 0 ? (
        <EmptyState
          title={
            !filtered && totalSessions === 0
              ? "No agent session stores found on this machine."
              : "No sessions match these filters."
          }
        />
      ) : (
        <ul
          className="overflow-hidden rounded-lg border"
          style={{ borderColor: "var(--border)" }}
          data-testid="source-list"
        >
          {sessions.map((s) => {
            const key = `${s.source}:${s.nativeId}`;
            const title = s.title || s.preview || s.nativeId;
            const showPreview = Boolean(s.preview && s.title && s.preview !== s.title);
            return (
              <li
                key={key}
                data-testid="source-session"
                data-source={s.source}
                data-native-id={s.nativeId}
                className="flex items-start gap-3 border-t px-3 py-2.5 first:border-t-0"
                style={{ borderColor: "var(--border)", background: "var(--surface)" }}
              >
                <span
                  className="mono mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                  style={{ background: "var(--surface-2)" }}
                >
                  {s.source}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{title}</div>
                  {showPreview ? (
                    <div
                      className="truncate text-[11px]"
                      style={{ color: "var(--text-dim)" }}
                    >
                      {s.preview}
                    </div>
                  ) : null}
                  <div
                    className="mono mt-0.5 truncate text-[10px]"
                    style={{ color: "var(--text-faint)" }}
                  >
                    {s.root ?? "no workspace"} · {s.turns} turn(s) · {s.nativePath}
                  </div>
                </div>
                <div className="shrink-0">
                  {s.importId ? (
                    <span
                      className="mono text-[10px]"
                      style={{ color: "var(--text-faint)" }}
                      title={`Imported as ${s.importId}`}
                    >
                      imported
                    </span>
                  ) : (
                    <Button
                      onClick={() => void doImport(s)}
                      disabled={busyKey === key}
                      ariaLabel={`Import ${s.nativeId} from ${s.source}`}
                    >
                      {busyKey === key ? "importing…" : "Import"}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AdapterChip({
  label,
  count,
  active,
  available,
  note,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  available?: boolean;
  note?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="source-adapter"
      data-source={label}
      onClick={onClick}
      title={note}
      className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors"
      style={{
        borderColor: active ? "var(--accent)" : "var(--border)",
        background: active ? "var(--surface-2)" : "var(--surface)",
      }}
    >
      {available === undefined ? null : (
        <StatusDot health={available ? "healthy" : "unknown"} />
      )}
      <span className="mono text-[12px]">{label}</span>
      <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
        {count}
      </span>
      {note ? (
        <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>
          {note}
        </span>
      ) : null}
    </button>
  );
}
