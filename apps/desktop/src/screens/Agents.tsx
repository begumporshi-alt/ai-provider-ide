/**
 * Agent orchestrator dashboard (P6).
 *
 * Answers the two questions the Assistant cannot, because it discards the run when the turn
 * ends: what did the agent actually do, and can I stop it.
 *
 * Stop works across screens on purpose. The run is started by the Assistant but registered in
 * a module-level controller map, so this dashboard can abort a run it did not begin — which is
 * the whole point of an orchestrator view.
 *
 * A run left `running` is shown as running. It is not quietly relabelled as failed: we did not
 * observe a failure, and inventing one would make the dashboard less trustworthy, not more.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState } from "../components/atoms";
import { useUi } from "../ui-state";
import {
  agentRunSteps,
  listAgentRuns,
  type AgentRun,
  type AgentStep,
} from "../store";
import { liveRunIds, stopRun } from "../lib/agent/orchestrator";

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

export function AgentsScreen() {
  const tick = useUi((s) => s.tick);
  const bump = useUi((s) => s.bump);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [stopping, setStopping] = useState<string | null>(null);

  useEffect(() => {
    listAgentRuns(50).then(setRuns).catch(() => undefined);
  }, [tick]);

  useEffect(() => {
    if (!selected) {
      setSteps([]);
      return;
    }
    agentRunSteps(selected).then(setSteps).catch(() => undefined);
  }, [selected, tick]);

  // Poll while something is live: a running run's step list grows, and a dashboard that only
  // updates when you navigate to it is not a dashboard.
  const live = liveRunIds();
  useEffect(() => {
    if (live.length === 0) return;
    const t = setInterval(() => bump(), 1500);
    return () => clearInterval(t);
  }, [live.length, bump]);

  const counts = useMemo(() => {
    const c = { running: 0, ok: 0, error: 0, stopped: 0 };
    for (const r of runs) {
      if (r.status in c) c[r.status as keyof typeof c] += 1;
    }
    return c;
  }, [runs]);

  function doStop(id: string) {
    setStopping(id);
    const asked = stopRun(id);
    // The loop clears the registration when it reports back; bump so the record catches up.
    // Clear the label either way — a stop that was not observed must not read "stopping…"
    // forever, which is what a run with no controller would otherwise do.
    setTimeout(() => {
      setStopping(null);
      bump();
    }, asked ? 600 : 0);
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="text-[20px] font-semibold">Agents</h1>
        <span className="text-[12px]" style={{ color: "var(--text-dim)" }}>
          {runs.length} runs · {counts.running} running · {counts.ok} ok · {counts.error} failed · {counts.stopped} stopped
        </span>
      </div>

      {runs.length === 0 ? (
        <EmptyState title="No agent runs yet. Turn on agent mode in the Assistant, set a workspace root, and give it a task — every run is recorded here step by step." />
      ) : (
        <div className="flex gap-3">
          <div className="min-w-0 flex-1">
            <table className="w-full">
              <thead>
                <tr className="h-[30px] text-left text-[11px] uppercase tracking-wide" style={{ color: "var(--text-faint)" }}>
                  <th className="w-20 font-medium">Started</th>
                  <th className="font-medium">Task</th>
                  <th className="w-40 font-medium">Model</th>
                  <th className="w-16 font-medium">Tools</th>
                  <th className="w-24 font-medium">Status</th>
                  <th className="w-20 font-medium" />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    className="h-[34px] cursor-pointer border-t hover:brightness-110"
                    style={{ borderColor: "var(--border)", background: selected === r.id ? "var(--surface)" : undefined }}
                    onClick={() => setSelected(selected === r.id ? null : r.id)}
                  >
                    <td className="mono text-[11px]" style={{ color: "var(--text-dim)" }}>{fmtTime(r.started_at)}</td>
                    <td className="max-w-[280px] truncate text-[12px]">{r.prompt ?? "—"}</td>
                    <td className="mono truncate text-[11px]" style={{ color: "var(--text-dim)" }}>{r.model}</td>
                    <td className="mono text-[12px]">{r.tool_calls}</td>
                    <td>
                      <span className="text-[12px]" style={{ color: statusColor(r.status) }}>
                        {r.status === "running" ? "● running" : r.status}
                      </span>
                    </td>
                    <td>
                      {r.status === "running" &&
                        (live.includes(r.id) ? (
                          <Button onClick={() => doStop(r.id)} disabled={stopping === r.id}>
                            {stopping === r.id ? "stopping…" : "stop"}
                          </Button>
                        ) : (
                          // Running but not live: this process has no handle on it (a previous
                          // session was closed mid-run). Offer nothing rather than a stop button
                          // that cannot work.
                          <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
                            no handle
                          </span>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {selected && (
              <div className="mt-3 rounded border" style={{ borderColor: "var(--border)" }}>
                <div className="border-b px-3 py-2 text-[11px] uppercase tracking-wide" style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}>
                  {steps.length} steps
                </div>
                <div className="max-h-[320px] overflow-y-auto px-3 py-2">
                  {steps.length === 0 ? (
                    <p className="text-[12px]" style={{ color: "var(--text-faint)" }}>No steps recorded.</p>
                  ) : (
                    steps.map((s) => (
                      <div key={s.seq} className="flex gap-2 py-0.5 text-[12px]">
                        <span className="mono w-4 shrink-0" style={{ color: "var(--text-faint)" }}>{stepMark(s.kind, s.ok)}</span>
                        <span className="w-24 shrink-0 mono truncate" style={{ color: "var(--text-dim)" }}>{s.kind}</span>
                        <span className="w-32 shrink-0 truncate">{s.label ?? "—"}</span>
                        <span className="min-w-0 flex-1 truncate" style={{ color: "var(--text-faint)" }}>{s.detail ?? ""}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <p className="mt-3 text-[11px]" style={{ color: "var(--text-faint)" }}>
        Steps are appended as they happen, so a run you stop is still fully inspectable. A run left
        <b> running</b> means the app was closed mid-run — it is not marked failed, because no failure was observed.
      </p>
    </div>
  );
}
