/**
 * Subagents drawer — a collapsible panel pinned to the transcript's right edge (the same mount
 * point and precedent as `AssistantCapsule`) showing what delegated sub-agents are doing, live.
 *
 * **Delegated runs only.** The ledger's parent rows are the main agent's own turns — already
 * visible in the transcript itself — so listing them here would read as a second transcript
 * (the mixing-up-the-agent-with-its-sub-agents failure, measured 2026-10-07). This drawer reads
 * only `parent_run_id != null` rows, and it summarizes the way ZCode's capsule does: a compact
 * running/ended count up top, then the child runs, each expanding to its steps.
 *
 * It is a reader over the runs ledger, not a second record: `listAgentRuns` / `agentRunSteps`
 * are the same reads the Subagents screen makes, polled with the same 1.5s-while-anything-runs
 * rule. Nothing here writes a step; the drawer only watches. A run stopped elsewhere shows its
 * new status on the next poll like any other change.
 *
 * Collapsed, the rail is visible only once a delegation exists — before that it is noise — and
 * it names the count of running sub-agents, so live work is visible without spending width.
 */
import { useEffect, useMemo, useState } from "react";
import { useUi } from "../ui-state";
import { agentRunSteps, listAgentRuns, type AgentRun, type AgentStep } from "../store";
import { RUN_CHANGED_EVENT, liveRunIds, stopRun } from "../lib/agent/orchestrator";

function statusColor(status: string): string {
  if (status === "ok") return "var(--success)";
  if (status === "running") return "var(--info)";
  if (status === "stopped") return "var(--warn)";
  return "var(--danger)";
}

/**
 * The ledger's step list is a wire format — `tool_call` and `tool_result` rows for the same
 * call, in sequence. The drawer renders *activity*, not the ledger: pairs collapse to one row
 * (the result's status carries the mark), denials say so in words, and the raw kinds never
 * reach the screen.
 */
function compactSteps(steps: AgentStep[]): Array<{ mark: string; text: string }> {
  const out: Array<{ mark: string; text: string }> = [];
  for (const s of steps) {
    if (s.kind === "tool_call") continue; // its result row renders the pair
    if (s.kind === "tool_result") {
      out.push({ mark: s.ok ? "✓" : "✕", text: s.label ?? "tool" });
    } else if (s.kind === "denied") {
      out.push({ mark: "⊘", text: `${s.label ?? "tool"} — denied` });
    } else if (s.kind === "done") {
      // The label carries the outcome ("12 iterations", "… — step ceiling, the model was still
      // calling tools") and is the one line that says how the run *ended*; keep it.
      out.push({ mark: "■", text: s.label ?? "finished" });
    } else {
      out.push({ mark: "·", text: s.label ?? s.kind });
    }
  }
  return out;
}

/** `12.3k` — a token count at a glance. Thousands only; the exact number is not a decision input. */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** How long a run has been going, or took. Seconds under a minute, then `4m 12s`. */
function elapsed(run: AgentRun, now: number): string {
  const ms = (run.ended_at ?? now) - run.started_at;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Newest first, capped: the drawer is a live view of *now*, not a ledger — the full history
 *  stays on the Subagents screen. */
const MAX_ROWS = 12;

export function SubagentsDrawer() {
  const tick = useUi((s) => s.tick);
  const bump = useUi((s) => s.bump);
  const open = useUi((s) => s.runsDrawerOpen);
  const toggle = useUi((s) => s.toggleRunsDrawer);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  // A ticking clock, not a data read: a running run's elapsed time must advance between ledger
  // reads (which happen only on events), or the row freezes at "3s" for a whole minute.
  const [tickNow, setTickNow] = useState(() => Date.now());

  // Re-read on `tick` (user actions), on open, AND on the orchestrator's run-changed event —
  // that event is what makes a delegation that starts, runs, and ends *between two ticks*
  // visible: tick moves on user actions alone, and an interval can miss a short turn entirely
  // (measured 2026-10-07). The read is *not* gated on `open`: the collapsed rail must show a
  // live running-count too.
  useEffect(() => {
    listAgentRuns(MAX_ROWS).then(setRuns).catch(() => undefined);
  }, [tick, open]);

  useEffect(() => {
    const onChanged = () => {
      listAgentRuns(MAX_ROWS).then(setRuns).catch(() => undefined);
    };
    window.addEventListener(RUN_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(RUN_CHANGED_EVENT, onChanged);
  }, []);

  useEffect(() => {
    if (!selected) {
      setSteps([]);
      return;
    }
    agentRunSteps(selected).then(setSteps).catch(() => undefined);
  }, [selected, tick]);

  // Delegated runs only, newest first. Parent rows are the main agent's own turns — the
  // transcript already shows those, and a drawer that repeated them is a second transcript.
  const children = useMemo(() => runs.filter((r) => r.parent_run_id != null), [runs]);

  // Live while anything runs. The poll is what makes "live" true — and `tick` alone cannot
  // carry it: a turn that starts while the Chat tab just sits there moves no tick (the same
  // tick-bump-on-user-actions rule every screen keeps), so the drawer would never learn a run
  // began. The orchestrator's live-run registry is the real-time signal: it is module-level
  // state updated at startRun/endRun, and the interval is a no-op array check while nothing
  // runs.
  useEffect(() => {
    const t = setInterval(() => {
      if (liveRunIds().length > 0) bump();
    }, 1500);
    return () => clearInterval(t);
  }, [bump]);

  // ⌘⇧B: the drawer is the transcript's other sidebar, so its shortcut is the sidebar's with
  // Shift. Local to this component: it is only meaningful where the drawer is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const runningCount = children.filter((r) => r.status === "running").length;
  const endedCount = children.length - runningCount;

  useEffect(() => {
    if (runningCount === 0) return;
    const t = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [runningCount]);

  // Before the first delegation there is nothing this drawer can say that the transcript does
  // not already say better — render nothing rather than a permanent chip.
  if (children.length === 0) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label="Open subagents drawer"
        title={runningCount ? `${runningCount} running — open the subagents drawer (⌘⇧B)` : "Open the subagents drawer (⌘⇧B)"}
        data-testid="runs-drawer-rail"
        className="absolute right-2 top-2 z-30 flex h-7 items-center gap-1 rounded-full border px-2 text-[11px] transition-opacity hover:opacity-90"
        style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text-dim)" }}
      >
        {runningCount > 0 && (
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--info)" }} aria-hidden="true" />
        )}
        <span className="mono">
          {runningCount > 0
            ? `${runningCount} running${endedCount > 0 ? ` · ${endedCount} ended` : ""}`
            : `${endedCount} ended`}
        </span>
      </button>
    );
  }

  return (
    <aside
      className="absolute bottom-2 right-2 top-2 z-30 flex w-72 flex-col overflow-hidden rounded-xl border shadow-xl"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      data-testid="runs-drawer"
      aria-label="Subagents"
    >
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
        <span className="text-[11px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
          Subagents
        </span>
        <button
          type="button"
          onClick={toggle}
          aria-label="Close subagents drawer"
          title="Close (⌘⇧B)"
          className="rounded px-1 text-[11px] transition-opacity hover:opacity-80"
          style={{ color: "var(--text-faint)" }}
        >
          ✕
        </button>
      </div>
      {/* The summary line first, capsule-style: "how many are working right now" is the one fact
          a glance owes, before any run is clicked. */}
      <div className="shrink-0 border-b px-3 py-1.5 text-[11px]" style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}>
        {runningCount > 0 ? (
          <span style={{ color: "var(--info)" }}>● {runningCount} running</span>
        ) : (
          <span>idle</span>
        )}
        {endedCount > 0 && <span> · {endedCount} ended</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {children.map((r) => (
          <div key={r.id} className="mb-1">
            <button
              type="button"
              onClick={() => setSelected(selected === r.id ? null : r.id)}
              aria-expanded={selected === r.id}
              data-testid="runs-drawer-row"
              className="w-full rounded-md border px-2 py-1.5 text-left transition-colors"
              style={{
                borderColor: selected === r.id ? "var(--border)" : "transparent",
                background: selected === r.id ? "var(--surface-2)" : "transparent",
              }}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: statusColor(r.status) }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-[12px]">{r.prompt || "(no prompt recorded)"}</span>
                {r.status === "running" && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      stopRun(r.id);
                      bump();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        stopRun(r.id);
                        bump();
                      }
                    }}
                    aria-label={`Stop sub-agent ${r.prompt || r.id}`}
                    className="shrink-0 text-[10px] transition-opacity hover:opacity-80"
                    style={{ color: "var(--danger)" }}
                  >
                    ■ stop
                  </span>
                )}
              </span>
              {/* The run's shape, ZCode-card style: how much work it did, and what it cost. The
                  token figure is the run's OWN model calls — the number that was previously
                  invisible because a sub-agent's spend was folded into the session meter. */}
              <span className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px]" style={{ color: "var(--text-faint)" }}>
                <span className="mono">{r.tool_calls} tools</span>
                <span className="mono">{r.iterations} rounds</span>
                {r.prompt_tokens + r.completion_tokens > 0 && (
                  <span className="mono" title={`${r.prompt_tokens} prompt + ${r.completion_tokens} completion`}>
                    {compactTokens(r.prompt_tokens + r.completion_tokens)} tok
                  </span>
                )}
                <span className="mono">{elapsed(r, tickNow)}</span>
                <span style={{ color: statusColor(r.status) }}>{r.status}</span>
              </span>
            </button>
            {selected === r.id && (
              <div
                className="mb-1 ml-2 rounded-md border px-2 py-1.5"
                style={{ borderColor: "var(--border)" }}
                data-testid="runs-drawer-steps"
              >
                {steps.length === 0 ? (
                  <p className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                    No steps recorded.
                  </p>
                ) : (
                  compactSteps(steps).map((row, i) => (
                    <div key={i} className="flex gap-1.5 py-0.5 text-[11px]">
                      <span className="mono w-3 shrink-0" style={{ color: "var(--text-faint)" }}>
                        {row.mark}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{row.text}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="shrink-0 border-t px-3 py-1.5 text-[10px]" style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}>
        Live view · full ledger on the Subagents screen
      </p>
    </aside>
  );
}
