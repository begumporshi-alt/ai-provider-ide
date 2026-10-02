/**
 * History — every recorded chat session, and one session read as a timeline.
 *
 * This is a second reading of the context graph, not a new store: a session is whatever
 * `session_id` the Assistant stamped on its nodes, so the transcript already exists and this
 * screen only has to assemble it. The host does the assembly (context.rs `sessions`/`timeline`)
 * because two of its rules are not reproducible from the rows alone:
 *
 *   1. Order is the sequence number in the node id, not `ts`. An agent run is recorded in one
 *      batch, so every node in it can share a timestamp and sorting by time scrambles the turns.
 *   2. A tool's result is reached through its `produced` edge. Calls are batched ahead of
 *      results, so "the next node" is not "what this call returned".
 *
 * The screen therefore renders, never reconstructs.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, inputCls, inputStyle } from "../components/atoms";
import { DiffView } from "../components/DiffView";
import {
  fileChangeFor,
  groupSearchMatches,
  isSearchResult,
  parseStoredToolCalls,
  type ToolCallRef,
} from "../lib/tools/render";
import { useUi } from "../ui-state";
import {
  loadHistorySessions,
  loadHistoryTimeline,
  setSessionTitle,
  deleteSession,
  type HistorySession,
  type HistoryTimeline,
  type TimelineEntry,
} from "../store";

/** One user turn plus everything the assistant did in response. */
interface Turn {
  user: TimelineEntry | null;
  items: TimelineEntry[];
}

function toTurns(entries: TimelineEntry[]): Turn[] {
  const turns: Turn[] = [];
  for (const e of entries) {
    if (e.kind === "user") {
      turns.push({ user: e, items: [] });
      continue;
    }
    const last = turns[turns.length - 1];
    if (last) last.items.push(e);
    else turns.push({ user: null, items: [e] });
  }
  return turns;
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (dayKey(ts) === dayKey(today.getTime())) return "Today";
  if (dayKey(ts) === dayKey(yesterday.getTime())) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

function durationMs(a: number, b: number): string {
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const KIND_COLOR: Record<string, string> = {
  user: "var(--accent)",
  assistant: "var(--ai)",
  tool: "var(--warn)",
};

const KIND_LABEL: Record<string, string> = {
  user: "You",
  assistant: "Assistant",
  tool: "tool",
};

export function HistoryScreen() {
  const tick = useUi((s) => s.tick);
  const [sessions, setSessions] = useState<HistorySession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<HistoryTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState<string>("");
  // P8: conversation search. Client-side over the loaded page of sessions — `history_sessions`
  // returns 300 rows and there is no host-side search, so filtering here is what makes the list
  // answerable at all. It searches what the list actually shows (title, preview, model, id), not the
  // node text of a session: matching a word that is nowhere on screen would produce a result the
  // user cannot explain.
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    loadHistorySessions(300).then(setSessions).catch((e: unknown) => setError(String(e)));
  }, [tick]);

  // Open on the newest session. A history screen that starts blank on the right answers
  // nothing until you click, and the newest run is what you came back for.
  useEffect(() => {
    if (selected === null && sessions.length > 0) setSelected(sessions[0].session_id);
  }, [sessions, selected]);

  const displayTitle = (s: HistorySession) => s.title || s.preview || "(no text)";

  function startRename(s: HistorySession) {
    setEditingId(s.session_id);
    setDraftTitle(s.title ?? "");
  }

  async function commitRename(sid: string) {
    const trimmed = draftTitle.trim();
    try {
      await setSessionTitle(sid, trimmed);
      setSessions((prev) =>
        prev.map((s) =>
          s.session_id === sid ? { ...s, title: trimmed ? trimmed : null } : s
        )
      );
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setEditingId(null);
    }
  }

  function cancelRename() {
    setEditingId(null);
    setDraftTitle("");
  }

  async function continueInAssistant(sid: string) {
    // The id, not a pre-fetched transcript: the Assistant owns session adoption (it must point its
    // recorder and session bar at the same session), so it fetches the turns itself.
    useUi.getState().setResumeSessionId(sid);
    useUi.getState().go("assistant");
  }

  async function removeSession(sid: string) {
    if (!confirm("Delete this session and all its nodes from the context graph? This cannot be undone.")) {
      return;
    }
    try {
      await deleteSession(sid);
      setSessions((prev) => prev.filter((s) => s.session_id !== sid));
      if (selected === sid) {
        setSelected(sessions.find((s) => s.session_id !== sid)?.session_id ?? null);
      }
    } catch (e: unknown) {
      setError(String(e));
    }
  }

  // Keep Escape from leaving edit mode stranded.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && editingId) cancelRename();
    };
    if (editingId) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingId]);

  useEffect(() => {
    if (selected === null) {
      setTimeline(null);
      return;
    }
    setError(null);
    loadHistoryTimeline(selected).then(setTimeline).catch((e: unknown) => setError(String(e)));
  }, [selected]);

  // P8: the search filter, applied before grouping so the day headings describe what is visible
  // rather than the whole store.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((s) =>
      [s.title ?? "", s.preview, s.model ?? "", s.session_id].some((f) => f.toLowerCase().includes(needle)),
    );
  }, [sessions, q]);

  // Keep the selection inside the visible list. Without this, filtering to one session leaves the
  // detail pane showing a different, now-hidden one — the list would say "this is what matched" and
  // the pane beside it would contradict that.
  useEffect(() => {
    if (filtered.length === 0) return;
    if (selected !== null && filtered.some((s) => s.session_id === selected)) return;
    setSelected(filtered[0]!.session_id);
  }, [filtered, selected]);

  // P8: the palette's "Search conversations" lands here and focuses the box (⌘K → type → Enter).
  // The request is claimed here, so it survives the mount that the navigation causes.
  //
  // It is NOT claimed until the box exists, which is what `sessions` in the dependency list is
  // about: on the frame this screen mounts, the list has not loaded, so it renders the empty state
  // and there is no input to focus. Consuming the intent then would drop the request on the floor —
  // the command would navigate and silently not focus anything, which is the exact failure the
  // pending/consume shape was chosen to avoid.
  const pendingIntent = useUi((s) => s.pendingIntent);
  const consumeIntent = useUi((s) => s.consumeIntent);
  useEffect(() => {
    if (pendingIntent?.kind !== "focus-history-search") return;
    if (!searchRef.current) return;
    consumeIntent();
    searchRef.current.focus();
  }, [pendingIntent, consumeIntent, sessions]);

  const grouped = useMemo(() => {
    const out: { label: string; items: HistorySession[] }[] = [];
    for (const s of filtered) {
      const label = dayLabel(s.started_ts);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(s);
      else out.push({ label, items: [s] });
    }
    return out;
  }, [filtered]);

  const turns = useMemo(() => toTurns(timeline?.entries ?? []), [timeline]);
  // Join each tool entry to the call that declared it. The timeline stores the assistant turn's
  // `tool_calls` as JSON, so its arguments are recoverable — which is what lets a past `edit_file`
  // be shown as the diff it was, not as an opaque result line.
  const callById = useMemo(() => {
    const m = new Map<string, ToolCallRef>();
    for (const e of timeline?.entries ?? []) {
      if (e.kind !== "assistant" || !e.tool_calls) continue;
      for (const { id, ref } of parseStoredToolCalls(e.tool_calls)) m.set(id, ref);
    }
    return m;
  }, [timeline]);
  const current = sessions.find((s) => s.session_id === selected) ?? null;

  if (sessions.length === 0 && !error) {
    return (
      <div className="mx-auto max-w-6xl">
        <h1 className="mb-3 text-[20px] font-semibold">History</h1>
        <EmptyState title="No sessions recorded yet. Chat in the Assistant and each session appears here with its full timeline." />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl gap-4">
      <div className="w-[290px] shrink-0">
        <div className="mb-3 flex items-baseline gap-3">
          <h1 className="text-[20px] font-semibold">History</h1>
          {/* "3 of 41" while filtering, because the count is what makes the filter honest: it says
              both what is shown and how much is hidden, where a bare "3" would read as a store that
              lost rows. */}
          <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>
            {q.trim() ? `${filtered.length} of ${sessions.length}` : sessions.length} session{sessions.length === 1 ? "" : "s"}
          </span>
        </div>

        <input
          ref={searchRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && q) {
              e.stopPropagation();
              setQ("");
            }
          }}
          placeholder="Search titles, text and models…"
          aria-label="Search conversations"
          className={`${inputCls} mb-3`}
          style={inputStyle}
        />

        <div className="overflow-y-auto pr-1" style={{ maxHeight: "calc(100vh - 210px)" }}>
          {grouped.length === 0 && (
            <p className="text-[12px]" style={{ color: "var(--text-dim)" }}>
              No session matches “{q.trim()}”. Search covers the titles, the preview text and the
              model of each session.
            </p>
          )}
          {grouped.map((g) => (
            <div key={g.label} className="mb-3">
              <div
                className="sticky top-0 z-10 py-1 text-[10px] font-semibold uppercase tracking-widest"
                style={{ background: "var(--bg)", color: "var(--text-faint)" }}
              >
                {g.label}
              </div>
              {g.items.map((s) => {
                const on = s.session_id === selected;
                return (
                  <button
                    key={s.session_id}
                    onClick={() => setSelected(s.session_id)}
                    data-testid="history-session"
                    data-session={s.session_id}
                    className="mb-1 block w-full rounded border px-2.5 py-2 text-left"
                    style={{
                      background: on ? "var(--surface-2)" : "var(--surface)",
                      borderColor: on ? "var(--accent)" : "var(--border)",
                    }}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                        {clock(s.started_ts)}
                      </span>
                      {editingId === s.session_id ? (
                        <input
                          className="flex-1 truncate border-b bg-transparent text-[12px] outline-none"
                          style={{
                            borderColor: "var(--accent)",
                            color: "var(--text)",
                          }}
                          value={draftTitle}
                          onChange={(e) => setDraftTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(s.session_id);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          autoFocus
                        />
                      ) : (
                        <span
                          className="truncate text-[12px] cursor-pointer"
                          style={{ color: s.title ? "var(--text)" : "var(--text-dim)" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(s);
                          }}
                          title={s.title ? "Click to edit title" : "No custom title — click to add one"}
                        >
                          {displayTitle(s)}
                        </span>
                      )}
                    </div>
                    {editingId !== s.session_id && s.title && (
                      <span
                        className="ml-auto cursor-pointer text-[10px] opacity-50 hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          startRename(s);
                        }}
                        title="Rename"
                      >
                        ✎
                      </span>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Chip>{s.turns} turns</Chip>
                      {s.tool_calls > 0 && <Chip>{s.tool_calls} tools</Chip>}
                      <Chip>{durationMs(s.started_ts, s.ended_ts)}</Chip>
                      {editingId !== s.session_id && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            removeSession(s.session_id);
                          }}
                          className="ml-1 text-[10px] opacity-40 hover:opacity-100"
                          title="Delete session"
                          style={{ color: "var(--danger)" }}
                        >
                          🗑
                        </button>
                      )}
                      {editingId === s.session_id && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            commitRename(s.session_id);
                          }}
                          className="ml-1 text-[10px] opacity-60 hover:opacity-100"
                          style={{ color: "var(--accent)" }}
                        >
                          ✓
                        </button>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        {current && (
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {editingId === current.session_id ? (
              <input
                className="border-b bg-transparent text-[15px] font-semibold outline-none"
                style={{
                  borderColor: "var(--accent)",
                  color: "var(--text)",
                }}
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(current.session_id);
                }}
                autoFocus
              />
            ) : (
              <h2 className="text-[15px] font-semibold">
                {displayTitle(current)}
              </h2>
            )}
            {editingId !== current.session_id && (
              <button
                onClick={() => startRename(current)}
                className="text-[10px] opacity-40 hover:opacity-100"
                title="Rename session"
                style={{ color: "var(--text-faint)" }}
              >
                ✎
              </button>
            )}
            <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
              {new Date(current.started_ts).toLocaleString()} · {current.turns} turns
              {current.tool_calls > 0 ? ` · ${current.tool_calls} tool calls` : ""}
              {current.model ? ` · ${current.model}` : ""}
            </span>
            {editingId !== current.session_id && (
              <button
                onClick={() => continueInAssistant(current.session_id)}
                className="text-[10px] opacity-40 hover:opacity-100"
                title="Continue this session in Assistant"
                style={{ color: "var(--accent)" }}
              >
                ↻
              </button>
            )}
            {editingId !== current.session_id && (
              <button
                onClick={() => removeSession(current.session_id)}
                className="text-[10px] opacity-40 hover:opacity-100"
                title="Delete session"
                style={{ color: "var(--danger)" }}
              >
                🗑
              </button>
            )}
          </div>
        )}

        {error && (
          <div className="rounded border p-3 text-[12px]" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
            {error}
          </div>
        )}

        {timeline && turns.length === 0 && (
          <EmptyState title="This session recorded no messages." />
        )}

        <ol className="relative">
          {turns.map((t, i) => (
            <li key={i} className="relative pb-5 pl-6">
              {/* The rail: one continuous line behind the dots, so the eye reads the session
                  as one thread rather than a list of cards. */}
              <span
                aria-hidden
                className="absolute left-[5px] top-3 bottom-0 w-px"
                style={{ background: "var(--border)" }}
              />
              {t.user && (
                <Dot kind="user" />
              )}
              {t.user && (
                <div className="mb-2" data-kind="user">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: KIND_COLOR.user }}>
                      You
                    </span>
                    <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>
                      {clock(t.user.ts)}
                    </span>
                    {t.user.memories > 0 && (
                      <Chip title="memories recalled for this turn">
                        {t.user.memories} recalled
                      </Chip>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-[13px]" style={{ color: "var(--text)" }}>
                    {t.user.text}
                  </div>
                </div>
              )}

              {t.items.map((e, j) => (
                <div key={j} className="mb-2" data-kind={e.kind}>
                  {e.kind === "assistant" ? (
                    <>
                      <Dot kind="assistant" />
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span
                          className="text-[11px] font-semibold uppercase tracking-wide"
                          style={{ color: KIND_COLOR.assistant }}
                        >
                          Assistant
                        </span>
                        {e.model && (
                          <span className="text-[10px]" style={{ color: "var(--text-faint)" }}>
                            {e.model}
                          </span>
                        )}
                      </div>
                      {/* A tool-call turn is recorded with empty text. Rendering that as a
                          bubble puts a blank card above every run, so it is skipped — the
                          tool chips below are the answer, not an empty preamble. */}
                      {e.text.trim() !== "" && (
                        <div className="whitespace-pre-wrap break-words text-[13px]" style={{ color: "var(--text)" }}>
                          {e.text}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <Dot kind="tool" />
                      <HistoryTool entry={e} call={e.tool_call_id ? callById.get(e.tool_call_id) : undefined} />
                    </>
                  )}
                </div>
              ))}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/**
 * One tool entry in the timeline. A file mutation is shown as the change itself, the same
 * rendering the Assistant uses — the timeline stores the assistant turn's `tool_calls`, so the
 * arguments survive and the diff is reconstructible from a past session.
 */
function HistoryTool({ entry, call }: { entry: TimelineEntry; call?: ToolCallRef }) {
  const change = call ? fileChangeFor(call.name, call.args) : null;
  if (change) return <DiffView change={change} defaultOpen={false} />;

  const groups = call && isSearchResult(call.name) && entry.detail ? groupSearchMatches(entry.detail) : [];

  return (
    <div className="rounded border px-2 py-1.5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="flex items-center gap-2">
        <span className="mono text-[11px]" style={{ color: KIND_COLOR.tool }}>
          {entry.text}
        </span>
        <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
          {KIND_LABEL.tool}
        </span>
      </div>
      {entry.detail &&
        (groups.length > 0 ? (
          <div className="mono mt-1 text-[11px]" style={{ color: "var(--text-dim)" }}>
            {groups.map((g) => (
              <div key={g.file}>
                <div>
                  {g.file} <span style={{ color: "var(--text-faint)" }}>({g.hits.length})</span>
                </div>
                {g.hits.map((h, i) => (
                  <div key={i} className="break-all pl-3">{h}</div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <pre
            className="mono mt-1 max-h-52 overflow-auto whitespace-pre-wrap text-[11px]"
            style={{ color: "var(--text-dim)" }}
          >
            {entry.detail}
          </pre>
        ))}
    </div>
  );
}

function Dot({ kind }: { kind: string }) {
  return (
    <span
      aria-hidden
      className="absolute left-0 top-[7px] h-[11px] w-[11px] rounded-full"
      style={{ background: KIND_COLOR[kind] ?? "var(--text-faint)", border: "2px solid var(--bg)" }}
    />
  );
}

function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="rounded px-1.5 py-0.5 text-[10px]"
      style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}
    >
      {children}
    </span>
  );
}
