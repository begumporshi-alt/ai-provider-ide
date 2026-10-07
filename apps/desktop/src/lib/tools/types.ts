/**
 * Agent-mode shared types (2026-09-17).
 *
 * The agent loop orchestrates: call the model -> collect real tool calls over `onToolCall`
 * -> execute them through a `ToolHost` (which forwards to the Rust sandbox) -> feed results
 * back as `tool` role messages -> repeat until the model stops calling.
 *
 * Nothing here imports Tauri. `ToolHost` is the single seam: production injects
 * `createTauriToolHost` (host.ts); unit tests inject a fake. That is what makes the loop
 * deterministic and testable without a desktop shell.
 */
import type { ChatMessage, TextRequest, TextStream } from "@aiprovider/router-core";

/** What a tool does to the workspace. Declared per tool so the approval policy can be a function
 *  of the declaration instead of a second hardcoded list that drifts away from this one. */
export type ToolEffect = "read" | "mutate";

/** A tool the agent may call. Every entry maps 1:1 to a handler in the Rust sandbox — a name
 *  the host does not implement is a call that can only ever fail. */
export interface ToolSpec {
  name: string;
  description: string;
  /** `read` never changes the workspace; `mutate` can. Drives approval modes and plan mode. */
  effect: ToolEffect;
  /** JSON-schema fragment: { properties, required }. `additionalProperties:false` is forced. */
  parameters: { properties: Record<string, unknown>; required?: string[] };
}

/** Execution boundary. `run` returns a result, never throws on model input.
 *
 *  `opts.callId` is the model's tool-call id, carried so a running call can be stopped: the host
 *  forwards it to the sandbox (which registers long `run_command` children for `tool_cancel`) and
 *  fires the cancel itself when `opts.signal` aborts. Both are optional, so a plain call — a test,
 *  a tool run outside a cancellable turn — keeps working unchanged. */
export interface ToolHost {
  run(
    name: string,
    args: Record<string, unknown>,
    opts?: { callId?: string; signal?: AbortSignal },
  ): Promise<{ ok: boolean; output: string }>;
}

/** The router facade's `generateText`, typed stand-alone so it can be faked in tests. */
export type GenerateFn = (
  req: TextRequest,
  opts?: { signal?: AbortSignal },
) => Promise<TextStream>;

export type AgentEvent =
  | { type: "assistant"; text: string }
  /**
   * The model's reasoning for the round-trip in flight. Its own event, never folded into
   * `assistant`: reasoning is the model's notes, and a UI that rendered it as prose would be
   * quoting the notes as the answer. See `TextRequest.onReasoning`.
   */
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: import("@aiprovider/router-core").ToolCall }
  | { type: "tool_result"; call: import("@aiprovider/router-core").ToolCall; result: string; ok: boolean }
  /**
   * The model's stream ended before it declared a finish (the provider cut a declared-finish
   * stream short) and the loop is re-asking the same iteration. `attempt` counts re-asks.
   */
  | { type: "truncation_retry"; attempt: number }
  /**
   * The model reasoned (its thinking channel carried text) but sent no answer at all — its
   * entire output budget went to thinking — and the loop is re-asking the same iteration with
   * thinking forced off. `attempt` counts fallbacks.
   */
  | { type: "no_output_retry"; attempt: number }
  /**
   * The loop ended. `truncated` is the provider-side cut (a declared-finish stream closed early);
   * `hitCeiling` is the loop-side stop: the step budget ran out while the model was still calling
   * tools, so the turn ended mid-work and its final text is often empty. The two say different
   * things and the UI owes the reader a different sentence for each — measured 2026-10-06, where
   * a ceiling exit appended an empty assistant turn and the transcript showed a bare bubble.
   */
  | { type: "done"; text: string; iterations: number; truncated?: boolean; hitCeiling?: boolean };

export interface AgentLoopOptions {
  model: string;
  /** Initial conversation (user turns). The loop appends assistant/tool turns internally. */
  messages: ChatMessage[];
  /** Optional system prompt prepended to the conversation. */
  system?: string;
  /** Tools the model may call. Always non-empty in agent mode. */
  registry: ToolSpec[];
  /** Injected model client (router facade). */
  generate: GenerateFn;
  /** Injected tool executor (Tauri sandbox in prod, fake in tests). */
  host: ToolHost;
  /**
   * The image-generation port behind `generate_image`: the gateway's `/v1/images/generations`
   * route, resolved to bytes by the injected implementation (a provider that answers with a URL
   * has those bytes fetched host-side before returning). Absent means the tool refuses with that
   * sentence rather than failing opaquely — agent mode works without an image model configured,
   * and the model should be told the difference.
   */
  generateImage?: (
    prompt: string,
    model: string | undefined,
    signal?: AbortSignal,
  ) => Promise<{ base64: string }>;
  /**
   * The skill port behind `load_skill`: resolves an installed, enabled skill's full body by
   * name (or slug), or null when nothing matches. The system prompt carries only the skill
   * index — name and description — so the body is fetched on demand instead of riding every
   * turn whether or not the task matches.
   */
  loadSkill?: (name: string, signal?: AbortSignal) => Promise<string | null>;
  /**
   * The user's budget for model round-trips in this turn, or `null`/absent for **no ceiling**.
   *
   * The Assistant's screen leaves this unset by default: a real task is not a fixed number of
   * rounds, and the measured failure of the alternative (2026-10-06) was a legitimate long task cut
   * off mid-work by a hard cap. A turn without a ceiling is paced by the loop's own reminder (see
   * `TOOL_CALL_NUDGE_AFTER` in `agentLoop.ts`) and ended by the user's Stop. A number still bounds
   * a turn, and reaching it is reported as `hitCeiling` rather than passed off as an answer.
   *
   * The gateway's loop is a different caller with the opposite default: external clients that this
   * app cannot see must never be unbounded, so it passes `DEFAULT_MAX_ITERATIONS`.
   */
  maxIterations?: number | null;
  /**
   * Per-call confirmation gate. Return true to execute, false to deny (the UI shows the
   * user an allow/deny prompt). When omitted, every call executes (non-interactive use).
   *
   * A refusal may carry a `reason`, which is what the model is told. That matters whenever the
   * refusal is not the user's doing — plan mode refuses mutations on its own, and the model has
   * to know it should propose a plan rather than rephrase the same call and try again. The
   * default reason blames the user, which is a lie in that case.
   */
  confirm?: (
    call: import("@aiprovider/router-core").ToolCall,
    args: Record<string, unknown>,
  ) => Promise<boolean | { allow: boolean; reason?: string }>;
  /** Streaming + lifecycle events for the UI. */
  onEvent?: (ev: AgentEvent) => void;
  /** Finish reason callback, forwarded to `generateText` on each agent round-trip. */
  onFinish?: (reason: string | undefined) => void;
  /**
   * The id of the agent run this loop serves, when the caller keeps a run ledger. Recorded on
   * the runs `dispatch_agent` spawns, so the Subagents screen can draw the delegation tree.
   */
  runId?: string;
  /**
   * The recorder behind `dispatch_agent`'s nested runs: the child's row is started with
   * `parentRunId: runId`, one `tool_call` step lands per tool the sub-agent uses, and the row
   * is closed with the outcome. Absent (tests, the gateway bridge) the tool works exactly as
   * before — delegation without a ledger.
   */
  subagentRecorder?: {
    newRunId(): string;
    startRun(args: {
      runId: string;
      sessionId?: string | null;
      parentRunId?: string | null;
      model: string;
      prompt?: string;
    }): void;
    recordStep(runId: string, kind: string, label?: string, detail?: string, ok?: boolean): void;
    endRun(runId: string, status: string, iterations: number, error?: string): void;
  };
  /** The sub-agent's step budget. Defaults to `SUBAGENT_MAX_ITERATIONS`. */
  subagentMaxIterations?: number;
  signal?: AbortSignal;
}
