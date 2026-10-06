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

/** The trace panel's line. Built by whichever branch served the turn; rendered by the screen. */
export interface Trace {
  ms: number;
  provider?: string;
  key?: string;
  model?: string;
  fallbacks: { provider: string; key: string; cls: string }[];
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
  chargeUsage(tokensIn: number, tokensOut: number, provider?: string, model?: string): void;
}

/** Everything a turn needs besides its request: its callbacks and its dependencies. */
export interface TurnPorts extends TurnEventSink {
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
