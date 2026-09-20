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
 * The registry is module-level, not React state, because the run outlives the component that
 * started it — you can navigate to the dashboard and stop a run that the Assistant began.
 */
import {
  agentRunFinish,
  agentRunStart,
  agentStepAppend,
} from "../../store";

const controllers = new Map<string, AbortController>();

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
  }).catch(() => undefined);
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
  }).catch(() => undefined);
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
  }).catch(() => undefined);
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
