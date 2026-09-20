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
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../components/atoms";
import { useUi } from "../ui-state";
import {
  loadHistorySessions,
  loadHistoryTimeline,
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

  useEffect(() => {
    loadHistorySessions(300).then(setSessions).catch((e: unknown) => setError(String(e)));
  }, [tick]);

  // Open on the newest session. A history screen that starts blank on the right answers
  // nothing until you click, and the newest run is what you came back for.
  useEffect(() => {
    if (selected === null && sessions.length > 0) setSelected(sessions[0].session_id);
  }, [sessions, selected]);

  useEffect(() => {
    if (selected === null) {
      setTimeline(null);
      return;
    }
    setError(null);
    loadHistoryTimeline(selected).then(setTimeline).catch((e: unknown) => setError(String(e)));
  }, [selected]);

  const grouped = useMemo(() => {
    const out: { label: string; items: HistorySession[] }[] = [];
    for (const s of sessions) {
      const label = dayLabel(s.started_ts);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(s);
      else out.push({ label, items: [s] });
    }
    return out;
  }, [sessions]);

  const turns = useMemo(() => toTurns(timeline?.entries ?? []), [timeline]);
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
          <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="overflow-y-auto pr-1" style={{ maxHeight: "calc(100vh - 160px)" }}>
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
                      <span className="truncate text-[12px]" style={{ color: "var(--text)" }}>
                        {s.preview || "(no text)"}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Chip>{s.turns} turns</Chip>
                      {s.tool_calls > 0 && <Chip>{s.tool_calls} tools</Chip>}
                      <Chip>{durationMs(s.started_ts, s.ended_ts)}</Chip>
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
            <h2 className="text-[15px] font-semibold">
              {current.preview || "Session"}
            </h2>
            <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
              {new Date(current.started_ts).toLocaleString()} · {current.turns} turns
              {current.tool_calls > 0 ? ` · ${current.tool_calls} tool calls` : ""}
              {current.model ? ` · ${current.model}` : ""}
            </span>
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
                      <div className="rounded border px-2 py-1.5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
                        <div className="flex items-center gap-2">
                          <span className="mono text-[11px]" style={{ color: KIND_COLOR.tool }}>
                            {e.text}
                          </span>
                          <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                            {KIND_LABEL.tool}
                          </span>
                        </div>
                        {e.detail && (
                          <pre
                            className="mono mt-1 max-h-52 overflow-auto whitespace-pre-wrap text-[11px]"
                            style={{ color: "var(--text-dim)" }}
                          >
                            {e.detail}
                          </pre>
                        )}
                      </div>
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
