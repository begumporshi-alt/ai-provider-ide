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
  | { type: "done"; text: string; iterations: number; truncated?: boolean };

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
  /** Hard ceiling on model round-trips; guards against a model that never stops calling. */
  maxIterations?: number;
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
  signal?: AbortSignal;
}
