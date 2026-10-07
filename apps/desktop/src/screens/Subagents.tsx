/**
 * Subagent dashboard.
 *
 * `dispatch_agent` runs a nested agent with its own fresh context; until now the run vanished
 * when its summary came back — the Agents screen showed the delegation as one "tool_call" step
 * of the parent, with nothing about what the child actually did. This screen is where the child
 * runs live: each has its own ledger row (`parent_run_id` names the delegating run), its own
 * step list, and its own ending.
 *
 * The tree reads top-down: a child run's row names the parent task it was cut from, so "why did
 * the agent spend three minutes reading files?" is answerable after the fact. Budgeted runs —
 * ended `stopped` by the step ceiling — are called out, because an unfinished delegation is the
 * one outcome a user must not misread as a clean answer.
 */
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../components/atoms";
import { useUi } from "../ui-state";
import { agentRunSteps, listAgentRuns, type AgentRun, type AgentStep } from "../store";

const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function statusColor(status: string): string {
  if (status === "ok") return "var(--success)";
  if (status === "running") return "var(--info)";
  if (status === "stopped") return "var(--warn)";
  return "var(--danger)";
}

function stepMark(kind: string, ok: boolean | null): string {
  if (kind === "denied") return "⊘";
  if (kind === "tool_call") return "→";
  if (kind === "tool_result") return ok ? "✓" : "✕";
  if (kind === "done") return "■";
  return "·";
}

const shortId = (id: string) => id.replace(/^run-/, "").slice(0, 8);

export function SubagentsScreen() {
  const tick = useUi((s) => s.tick);
  const bump = useUi((s) => s.bump);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);

  useEffect(() => {
    listAgentRuns(200).then(setRuns).catch(() => undefined);
  }, [tick]);

  useEffect(() => {
    if (!selected) {
      setSteps([]);
      return;
    }
    agentRunSteps(selected).then(setSteps).catch(() => undefined);
  }, [selected, tick]);

  // Live while a child (or its parent) still runs, same polling rule the Agents screen keeps.
  const anyRunning = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => bump(), 1500);
    return () => clearInterval(t);
  }, [anyRunning, bump]);

  // Children only, newest first. The parent's own row is in the Agents screen's ledger; here a
  // parent is looked up only to name the run that cut this task loose.
  const children = useMemo(() => runs.filter((r) => r.parent_run_id != null), [runs]);
  const byId = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);

  const counts = useMemo(
    () => ({
      total: children.length,
      running: children.filter((r) => r.status === "running").length,
      stopped: children.filter((r) => r.status === "stopped").length,
      error: children.filter((r) => r.status === "error").length,
    }),
    [children],
  );

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="text-[20px] font-semibold">Subagents</h1>
        <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>
          {counts.total} delegated runs · {counts.running} running · {counts.stopped} hit budget ·{" "}
          {counts.error} failed
        </span>
      </div>

      {children.length === 0 ? (
        <EmptyState
          title={
            "No delegated runs yet. When the agent uses dispatch_agent, each sub-agent is recorded " +
            "here under the run that delegated it — its task, the tools it used, and how it ended."
          }
        />
      ) : (
        <div className="min-w-0">
          <table className="w-full">
            <thead>
              <tr
                className="h-[30px] text-left text-[11px] uppercase tracking-wide"
                style={{ color: "var(--text-faint)" }}
              >
                <th className="w-20 font-medium">Started</th>
                <th className="font-medium">Task</th>
                <th className="w-48 font-medium">Delegated by</th>
                <th className="w-14 font-medium">Rounds</th>
                <th className="w-14 font-medium">Tools</th>
                <th className="w-24 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {children.map((r) => {
                const parent = r.parent_run_id ? byId.get(r.parent_run_id) : undefined;
                return (
                  <tr
                    key={r.id}
                    className="h-[34px] cursor-pointer border-t hover:brightness-110"
                    style={{
                      borderColor: "var(--border)",
                      background: selected === r.id ? "var(--surface)" : undefined,
                    }}
                    onClick={() => setSelected(selected === r.id ? null : r.id)}
                  >
                    <td className="mono text-[11px]" style={{ color: "var(--text-dim)" }}>
                      {fmtTime(r.started_at)}
                    </td>
                    <td className="max-w-[260px] truncate text-[12px]">{r.prompt ?? "—"}</td>
                    <td className="max-w-[190px] truncate text-[12px]" style={{ color: "var(--text-dim)" }}>
                      <span className="mono text-[10px]">{parent ? shortId(parent.id) : (r.parent_run_id ?? "").slice(0, 8)}</span>
                      {parent?.prompt ? ` · ${parent.prompt}` : ""}
                    </td>
                    <td className="mono text-[12px]">{r.iterations}</td>
                    <td className="mono text-[12px]">{r.tool_calls}</td>
                    <td>
                      <span className="text-[12px]" style={{ color: statusColor(r.status) }}>
                        {r.status === "running" ? "● running" : r.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {selected && (
            <div className="mt-3 rounded border" style={{ borderColor: "var(--border)" }} data-testid="subagent-steps">
              <div
                className="border-b px-3 py-2 text-[11px] uppercase tracking-wide"
                style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}
              >
                {steps.length} steps
              </div>
              <div className="max-h-[320px] overflow-y-auto px-3 py-2">
                {steps.length === 0 ? (
                  <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>
                    No steps recorded.
                  </p>
                ) : (
                  steps.map((s) => (
                    <div key={s.seq} className="flex gap-2 py-0.5 text-[12px]">
                      <span className="mono w-4 shrink-0" style={{ color: "var(--text-faint)" }}>
                        {stepMark(s.kind, s.ok)}
                      </span>
                      <span className="w-24 shrink-0 mono truncate" style={{ color: "var(--text-dim)" }}>
                        {s.kind}
                      </span>
                      <span className="w-32 shrink-0 truncate">{s.label ?? "—"}</span>
                      <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text-faint)" }}>
                        {s.detail ?? ""}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <p className="mt-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
            A sub-agent's <b>rounds</b> are its model round-trips; its tools are counted separately. A run
            ended <b style={{ color: "var(--warn)" }}>stopped</b> reached its step budget — its summary may
            describe unfinished work. Sub-agents get only read-effect tools, inherit this session's
            approval prompts, and return a summary to the delegating run; their full transcripts live
            nowhere else but here.
          </p>
        </div>
      )}
    </div>
  );
}
