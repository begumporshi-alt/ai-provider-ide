/**
 * The turn engine's port surface — what an extracted turn needs from its host, injected so the
 * engine is node-testable and the screen keeps only rendering.
 *
 * Phase 2 of the turn-engine extraction defines the plain-chat ports here; the agent branch and
 * the TurnController join in later phases, extending this module rather than forking it.
 */
import type { Msg } from "./messages";
import type { Recorder } from "../../context/recorder";
import type { Memory } from "../../../store";
import type { GatewayGenerateRequest, GatewayExec } from "../../gateway-turn";
import type { AgentEvent, ToolHost } from "../../tools";
import type { RunChangeSet } from "../../tools/changeset";
import type { RunStatus, StepKind } from "../../agent/orchestrator";

/** One failed attempt before the winner — the ledger chain's shape, with the two names optional
 *  exactly where the ledger omits them (an unlabelled attempt must not grow a fake name). */
export interface FallbackAttempt {
  provider?: string;
  key?: string;
  cls: string;
  reason?: string;
}

/** The trace panel's line. Built by whichever branch served the turn; rendered by the screen. */
export interface Trace {
  ms: number;
  provider?: string;
  key?: string;
  model?: string;
  fallbacks: FallbackAttempt[];
  error?: string;
  finishReason?: string;
}

/** The generate port — the gateway client's exec shape both branches consume. */
export type GeneratePort = (
  req: GatewayGenerateRequest,
  opts?: { signal?: AbortSignal },
) => Promise<GatewayExec>;

/** The memory seam — the engine never imports the memory module directly, so tests can stub recall. */
export interface MemoryPorts {
  recall(text: string): Promise<Memory[]>;
  block(memories: Memory[]): string;
  recordRecall(nodeId: string, memories: Memory[]): void;
  remember(sessionId: string, userText: string, reply: string): Promise<unknown>;
  distil(sessionId: string, model: string): Promise<unknown>;
}

/** Inputs shared by both turn branches. `startedAt` feeds the trace's ms; the clock is injectable. */
export interface TurnRequestBase {
  text: string;
  baseMsgs: Msg[];
  attachments: import("../../../components/Composer").Attachment[];
  model: string;
  perTurn: string;
  useMemory: boolean;
  signal: AbortSignal;
  /** `Date.now()` at turn start — the screen owns the t0 so send/retry share one clock read. */
  startedAt: number;
  /** The assistant bubble the screen optimistically appended; patches address it by id. */
  assistantMsgId: string;
}

/**
 * What the engine calls back into the screen for. Every member mirrors a `set*` the inline code
 * used to make, one-for-one — the sink is a renaming of the existing boundary, not a new design.
 */
export interface TurnEventSink {
  /** Patch one transcript message (content/reasoning streaming, the error fill). */
  patchMsg(id: string, patch: Partial<Msg>): void;
  onTrace(trace: Trace): void;
  /** The wire's optional finish reason — optional because it only rides when reported. */
  onFinishReason(reason?: string): void;
  onLastUsage(usage: { prompt_tokens: number; completion_tokens: number }): void;
  onBusy(busy: boolean): void;
  onStopping(stopping: boolean): void;
  /** The screen's abortRef is cleared when the turn settles; ownership moves in phase 4. */
  clearAbort(): void;
  /** `undefined` for a call that reported no usage at all — see `SessionUsageCharge`, where that
   *  distinction is what keeps the session totals from reading `0 in · 0 out` for a billed call. */
  chargeUsage(
    tokensIn: number | undefined,
    tokensOut: number | undefined,
    provider?: string,
    model?: string,
  ): void;
}

/** Everything a turn needs besides its request: its callbacks and its dependencies. */
export interface TurnDeps {
  generate: GeneratePort;
  /** The recorder captured at turn start — not re-read from the screen, so a session switched
   *  mid-turn cannot flush nodes into the wrong session's graph. */
  recorder: Recorder;
  /** Where the graph's "follows" chain currently ends; the engine appends the assistant node. */
  lastNode: { current: string | null };
  memory: MemoryPorts;
  /** Provider display name for the trace, from the registry. */
  providerName(providerId: string): string | undefined;
  /** Injectable clock for the throttle and the trace's duration. */
  now(): number;
}

export interface TurnPorts extends TurnEventSink, TurnDeps {}

/** The run-record seam (P6). A port rather than an import so node tests can record runs in memory
 *  and so the engine does not pull the host-boundary module into every importer. */
export interface RunRecordPorts {
  newRunId(): string;
  startRun(args: { runId: string; sessionId?: string | null; parentRunId?: string | null; model: string; prompt?: string }): void;
  registerAbort(runId: string, ac: AbortController): void;
  recordStep(runId: string, kind: StepKind, label?: string, detail?: string, ok?: boolean): void;
  /**
   * Close the run's row. `promptTokens`/`completionTokens` are this run's own model calls,
   * summed; absent means the provider reported no usage, which the host stores as 0 rather than
   * treating as an error. Positional because they travel straight to the host command.
   */
  endRun(
    runId: string,
    status: RunStatus,
    iterations: number,
    error?: string,
    promptTokens?: number,
    completionTokens?: number,
  ): void;
}

/** The agent turn's extra paint events, beyond what the plain turn emits. */
export interface AgentTurnSink extends TurnEventSink {
  /** Replace the whole transcript (agent runs return the full conversation; the root guard undoes
   *  the optimistic append with it). */
  onReplaceTranscript(msgs: Msg[]): void;
  /** Fill an assistant bubble only while it is still empty (the failure-path wording). */
  fillIfEmpty(id: string, note: string): void;
  /** Every loop event, forwarded raw — the screen owns the paint half, the engine the recording. */
  onAgentEvent(ev: AgentEvent): void;
  /** Start-of-run resets: the streamed panels, the agent items, and the run's usage counter. */
  onAgentStart(): void;
  /** The run's live usage counter, summed across the loop's model calls. */
  onRunUsageAdded(tokensIn: number, tokensOut: number): void;
  onRunChanges(changes: RunChangeSet | null): void;
  /** Clear the run-specific UI state (confirm modal, agent items, streamed panels) on settle. */
  clearRunUi(): void;
}

export interface AgentTurnPorts extends AgentTurnSink, TurnDeps {
  orchestrator: RunRecordPorts;
  /** The un-checkpointed tool host for a workspace root; the engine wraps it with the run's
   *  checkpoint so the change-set review stays engine-owned. */
  makeBaseHost(root: string): ToolHost;
}
