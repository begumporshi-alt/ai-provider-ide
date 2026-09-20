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

/** A tool the agent may call. Every entry maps 1:1 to a handler in the Rust sandbox — a name
 *  the host does not implement is a call that can only ever fail. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON-schema fragment: { properties, required }. `additionalProperties:false` is forced. */
  parameters: { properties: Record<string, unknown>; required?: string[] };
}

/** Execution boundary. `run` returns a result, never throws on model input. */
export interface ToolHost {
  run(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string }>;
}

/** The router facade's `generateText`, typed stand-alone so it can be faked in tests. */
export type GenerateFn = (
  req: TextRequest,
  opts?: { signal?: AbortSignal },
) => Promise<TextStream>;

export type AgentEvent =
  | { type: "assistant"; text: string }
  | { type: "tool_call"; call: import("@aiprovider/router-core").ToolCall }
  | { type: "tool_result"; call: import("@aiprovider/router-core").ToolCall; result: string; ok: boolean }
  | { type: "done"; text: string; iterations: number };

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
   */
  confirm?: (call: import("@aiprovider/router-core").ToolCall, args: Record<string, unknown>) => Promise<boolean>;
  /** Streaming + lifecycle events for the UI. */
  onEvent?: (ev: AgentEvent) => void;
  signal?: AbortSignal;
}
