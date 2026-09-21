/**
 * Orchestrator client (P6).
 *
 * Two jobs that are usually conflated, kept apart here:
 *
 *   record — append what a run did, as it does it, so a killed run is still inspectable
 *   abort  — hold the AbortController for a running run so another screen can stop it
 *
 * The record side is fire-and-forget on purpose. A dashboard is a diagnostic; if writing to it
 * fails, the agent must keep working. The abort side is the opposite: it is the only part of
 * this module that is allowed to change what the agent does.
 *
 * One consequence of that is not obvious and is handled in `endRun`: the controller is dropped
 * *before* the finish write, so a write that fails leaves a row that is `running` with no handle —
 * the same picture a session closed mid-run leaves. The ending is still reported, via `trail-health`.
 *
 * The start is the opposite failure and the worse one. `agentRunStart` failing means the run is
 * absent from the dashboard entirely — no row, no status, nothing to which an ending could be
 * attached — and every step append for it then fails too, for the same reason. `trail-health` counts
 * that as **one** lost run, not one per write: see the module doc there.
 *
 * The registry is module-level, not React state, because the run outlives the component that
 * started it — you can navigate to the dashboard and stop a run that the Assistant began.
 */
import {
  agentRunFinish,
  agentRunStart,
  agentStepAppend,
} from "../../store";
import { noteTrailFailure, noteUnrecordedEnd } from "../trail-health";

const controllers = new Map<string, AbortController>();
/**
 * Runs whose *start* did not land. Never cleared on purpose: an append from a run that has since
 * ended can still be in flight, and clearing on end would let that late failure be counted for a run
 * the channel already reported. Bounded by the runs of one session — the channel's own lifetime.
 */
const unrecordedStarts = new Set<string>();

export type RunStatus = "running" | "ok" | "error" | "stopped";
export type StepKind = "assistant" | "tool_call" | "tool_result" | "done" | "denied";

export function newRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function startRun(args: {
  runId: string; sessionId?: string | null; model: string; prompt?: string;
}): void {
  void agentRunStart({
    id: args.runId,
    sessionId: args.sessionId ?? null,
    model: args.model,
    prompt: args.prompt ?? null,
  }).catch((e: unknown) => {
    // The swallow stays — a run that cannot be recorded must still run. But the dashboard's list is
    // *the* record of runs, and a start that did not land means this run will never appear in it at
    // all: not as running, not as failed. Silence here is not "the run is fine", it is "there is no
    // run". Remember the id too, so its step appends are not counted as further failures of their own
    // — see `recordStep`.
    unrecordedStarts.add(args.runId);
    noteTrailFailure("agent_run", e instanceof Error ? e.message : String(e));
  });
}

export function recordStep(
  runId: string,
  kind: StepKind,
  label?: string,
  detail?: string,
  ok?: boolean,
): void {
  void agentStepAppend({
    runId,
    kind,
    label: label ?? null,
    detail: detail ?? null,
    ok: ok ?? null,
  }).catch((e: unknown) => {
    // Reported only when the run itself was recorded. A step of a run that never landed cannot be
    // appended for the same reason the run could not be inserted — one cause, so one count. Counting
    // it again would report "4 writes could not be recorded" for a single lost run with three steps.
    if (unrecordedStarts.has(runId)) return;
    noteTrailFailure("agent_run", e instanceof Error ? e.message : String(e));
  });
}

export function endRun(
  runId: string,
  status: RunStatus,
  iterations: number,
  error?: string,
): void {
  controllers.delete(runId);
  void agentRunFinish({
    runId,
    status,
    iterations,
    error: error ?? null,
  }).catch(() => {
    // The swallow stays — the run is over either way, and a lost record must not become a lost run.
    // But this ending *was* observed, and the controller is already gone, so the row left behind
    // reads exactly like one from a session closed mid-run. Keep the observation so the dashboard can
    // report what happened instead of naming a cause it cannot know.
    noteUnrecordedEnd(runId, status);
  });
}

/** Attach a controller so the run can be stopped from anywhere. */
export function registerAbort(runId: string, ac: AbortController): void {
  controllers.set(runId, ac);
}

/**
 * Stop a running run. Returns false when there is nothing live under that id, so the caller can
 * say "already finished" instead of implying a stop that did not happen.
 */
export function stopRun(runId: string): boolean {
  const ac = controllers.get(runId);
  if (!ac) return false;
  ac.abort();
  // Leave it registered: `endRun` clears it when the loop reports back, which is how we know
  // the stop was observed rather than merely requested.
  return true;
}

export function liveRunIds(): string[] {
  return Array.from(controllers.keys());
}
