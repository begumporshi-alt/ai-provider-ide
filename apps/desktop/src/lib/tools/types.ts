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
import type { ChatMessage, TextRequest, TextStream, UsageTokens } from "@aiprovider/router-core";

/** What a tool does to the workspace. Declared per tool so the approval policy can be a function
 *  of the declaration instead of a second hardcoded list that drifts away from this one. */
export type ToolEffect = "read" | "mutate";

/**
 * One delegated child's live state, as the parent loop sees it. Emitted while a
 * `dispatch_agent` / `fan_out` call runs so the UI can show a delegation working instead of
 * sitting on a silent "calling" row — a child's transcript is deliberately invisible (isolation
 * is the point of delegating), but *that it is alive and roughly where it is* costs nothing to
 * report and is the difference between "watching work" and "wondering if it hung".
 */
export interface SubagentChildProgress {
  /** What to call this child: the task's label (`fan_out`), the specialist's name, or `research`. */
  label: string;
  state: "queued" | "running" | "done" | "failed";
  /** Tool calls the child has made so far. */
  toolCalls: number;
  /** The child's most recent tool, when it has made one. */
  lastTool?: string;
}

/** A tool the agent may call. Most entries map 1:1 to a handler in the Rust sandbox. A handful do
 *  not: `web_ask`, `dispatch_agent`, `generate_image`, `load_skill`, the notebook composites and
 *  the plan-mode pair are answered by the loop itself (a model call, a nested run, the image
 *  route, the skill store, the approval surface) and never reach the sandbox. */
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
   * A full snapshot of one delegation call's children. Carries the whole list, not a delta, so
   * the fold is idempotent and a UI that missed an earlier event is corrected by the next one.
   * `callId` is the `dispatch_agent` / `fan_out` call the children belong to.
   */
  | { type: "subagent_progress"; callId: string; children: SubagentChildProgress[] }
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
   * The turn's final answer claimed the work was done, the turn changed the workspace, and
   * nothing ran that proves either — so the loop pushed the claim onto the transcript, followed
   * it with the automatic verification demand, and is giving the model another round WITH its
   * tools to produce evidence (see `VERIFICATION_NUDGE_MAX` in agentLoop.ts). At most one per
   * turn; the transcript carries the claim, the demand, and whatever came after, so a reader
   * can always see a claim that was never backed.
   */
  | { type: "verification_nudge" }
  /**
   * The loop ended. `truncated` is the provider-side cut (a declared-finish stream closed early);
   * `hitCeiling` is the loop-side stop: the step budget ran out while the model was still calling
   * tools, so the turn ended mid-work and its final text is often empty. The two say different
   * things and the UI owes the reader a different sentence for each — measured 2026-10-06, where
   * a ceiling exit appended an empty assistant turn and the transcript showed a bare bubble.
   */
  | { type: "done"; text: string; iterations: number; truncated?: boolean; hitCeiling?: boolean };

/**
 * Everything the two plan-mode control tools need from their owner (the screen, in production).
 *
 * Grouped rather than five loose fields because the five are one conversation: the mode is read
 * live (the gate reads the same ref), flipped through a port that must write through to that ref
 * before the loop's next call, and the two interactions are what the plan tools exist to raise.
 * `exit_plan_mode` is deliberately not routed through `confirm`: as a `read` tool the generic gate
 * would auto-allow it under "auto-approve reads" or a remembered grant — no modal, no review — and
 * as a `mutate` tool plan mode would refuse the very call that ends it.
 */
export interface PlanPorts {
  /** Whether this run is in plan mode **right now**. Read live, like the approval gate's own state. */
  isPlanMode: () => boolean;
  /**
   * Whether this run STARTED with plan-mode framing in its system turn (the screen's `planPass`).
   *
   * The system turn is built once per pass and cannot be rebuilt mid-run, so the loop compares this
   * with the live `isPlanMode()` and states the difference in every request it sends — a mode that
   * changed inside a pass is otherwise invisible to the model, or worse, contradicted by a stale
   * paragraph. It covers both directions: an approved `exit_plan_mode` or the user switching the
   * mode off (the framing must be superseded), and the user switching it on mid-pass (the framing
   * was never there and must be supplied). See the `PLAN_MODE_*_NOTE` constants in agentLoop.ts.
   */
  startedInPlanMode: () => boolean;
  /**
   * Flip it for the rest of this run. The implementation must write through to whatever the gate
   * reads — `setState` alone is not enough: the flip would land after the loop has already asked
   * the gate about the next write, and a just-approved run would watch its first edit be refused.
   */
  setPlanMode: (on: boolean) => void;
  /**
   * Show the plan and wait for the user's decision. Must resolve when `signal` aborts (Stop while
   * parked) rather than leaving the loop parked on a modal nobody will ever answer.
   */
  requestApproval: (
    plan: string,
    signal?: AbortSignal,
  ) => Promise<{ approved: boolean; feedback?: string }>;
  /** Ask the user to switch plan mode on. Resolves false when they decline or the run is stopped. */
  requestEntry: (signal?: AbortSignal) => Promise<boolean>;
  /**
   * Persist the plan document where the user can find it later, returning the path. Best-effort:
   * null means "not written", and an approval stands either way.
   */
  persist: (plan: string) => Promise<string | null>;
}

/**
 * The session knowledge the `list_sessions` / `search_sessions` / `read_session` tools serve.
 *
 * These summaries are the loop's own normalized shape (camelCase), not the raw Tauri wire shape —
 * the port implementation maps, exactly as `web_ask`'s port hides the fetch. One shape here means
 * the loop formats for the model without knowing which backend served the rows.
 */
export interface SessionSummary {
  sessionId: string;
  title: string | null;
  preview: string;
  startedTs: number;
  endedTs: number;
  turns: number;
  toolCalls: number;
  model: string | null;
}

export interface SessionSearchHit {
  sessionId: string;
  title: string | null;
  preview: string;
  seq: number;
  role: string;
  ts: number;
  snippet: string;
}

export interface SessionTurn {
  seq: number;
  role: string;
  content: string;
  ts: number;
  model: string | null;
  /** Serialized `tool_calls` array on an assistant row; null otherwise. */
  toolCalls: string | null;
  /** The answered call's id on a tool row; null otherwise. */
  toolCallId: string | null;
}

/**
 * Read-only access to past conversation sessions — the index, a full-text search over every
 * stored transcript, and one session's turns. Absent — tests, the gateway bridge, AXIOM's own
 * eval loops — all three tools refuse with that sentence rather than pretending to look: a
 * caller with no session store must not receive an empty result that reads as "no history".
 */
export interface SessionPorts {
  list(limit: number): Promise<SessionSummary[]>;
  search(query: string, limit: number): Promise<SessionSearchHit[]>;
  read(sessionId: string): Promise<SessionTurn[]>;
}

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
   * The session image cache behind the marker receipt: at attach time the loop deposits a copy of
   * the image bytes app-side so a replayed transcript can still show its picture after the
   * workspace file is cleaned. Best-effort by contract — an implementation returns the cache
   * name, or null (and the receipt simply carries no cache line) on any failure. Absent in tests
   * and bridges; the preview then degrades to nothing once the workspace copy is gone, which is
   * the behaviour this port exists to fix.
   */
  cacheImage?: (mediaType: string, base64: string) => Promise<string | null>;
  /**
   * The session store behind `list_sessions` / `search_sessions` / `read_session`: the index of
   * past conversations, a full-text search over their transcripts, and one transcript read back.
   * Absent (tests, the gateway bridge) all three refuse with a sentence saying so — the same
   * contract `generateImage` has — because an empty list and "no store" are different facts.
   */
  sessions?: SessionPorts;
  /**
   * The plan-mode facilities behind `enter_plan_mode` / `exit_plan_mode`. Absent — tests, the
   * gateway bridge — both tools refuse with a sentence telling the model to present the plan in
   * its answer instead: a planning pass with no approval surface must not pretend it got one.
   */
  plan?: PlanPorts;
  /**
   * The user's budget for model round-trips in this turn, or `null`/absent for **no step budget at
   * all**. A turn with no budget is bounded by the user's Stop, by the loop's pacing reminder (see
   * `TOOL_CALL_NUDGE_AFTER` in `agentLoop.ts`), and by the context window each round grows — not by
   * a counter. That is the interactive shape Claude Code documents for its own agent loop
   * (`--max-turns` is *"print mode only … No limit by default"*) and the one `dsh-agent-loop` ships,
   * which has no turn budget at all and expects a policy to cancel a runaway turn instead. A wrong
   * stop is worse than a late one: a step count cannot tell "still working" from "stuck", and the
   * measured failure of a low one (2026-10-06) was a legitimate task cut off mid-work.
   *
   * A number still bounds the turn, is clamped to `MAX_ITERATIONS_CAP`, and reaching it is reported
   * as `hitCeiling` rather than passed off as an answer.
   *
   * The gateway's loop is a different caller with the opposite rule: external clients that this app
   * cannot see have no Stop button, so it passes `DEFAULT_MAX_ITERATIONS` — the same
   * headless-only bound that Claude Code's `--max-turns` is.
   */
  maxIterations?: number | null;
  /**
   * How many times this turn may be held open by the verification gate — the loop's automatic
   * demand for evidence when a turn changed the workspace, claimed completion, and ran nothing that
   * checks either. Absent means `VERIFICATION_NUDGE_MAX`.
   *
   * An option rather than the constant it overrides because AXIOM (`@aiprovider/axiom-core`) can
   * promote a configuration that raises it: `premature-success` is the detector that fires on an
   * unverified completion claim, and the bounded change it proposes is one more demand. Clamped to
   * `VERIFICATION_NUDGE_MAX_CAP` in the loop, so a hand-edited row in `axiom_versions` cannot make a
   * turn nag forever.
   *
   * Note what is *not* an option here: `maxIterations` above stays `null` for an interactive turn no
   * matter what a promoted version says. D119's rule is that a step bound is justified only where
   * nobody can press Stop, and the Assistant's user can. AXIOM's own eval runs are the unattended
   * caller, and they are where its `loop.maxIterations` is applied.
   */
  verificationNudgeMax?: number;
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
  /**
   * Token usage for the model calls **this loop** makes.
   *
   * The loop forwards whatever the caller's `generate` reports for each of its own round-trips,
   * which is what lets a nested run be costed on its own: the child's dispatch passes a handler
   * here, so a sub-agent's spend lands on its ledger row instead of only being folded into the
   * session meter. (`generate` receives it as `TextRequest.onUsage`; a caller that already
   * counts usage for the whole turn — `agent-turn.ts` — keeps doing so, and the two are additive
   * because each fires for the calls the loop in question actually made.)
   */
  onUsage?: (usage: UsageTokens) => void;
  /** Finish reason callback, forwarded to `generateText` on each agent round-trip. */
  onFinish?: (reason: string | undefined) => void;
  /**
   * The id of the agent run this loop serves, when the caller keeps a run ledger. Recorded on
   * the runs `dispatch_agent` spawns, so the Subagents screen can draw the delegation tree.
   */
  runId?: string;
  /**
   * The recorder behind `dispatch_agent`'s nested runs: the child's row is started with
   * `parentRunId: runId`, one `tool_call` step lands per tool the sub-agent uses and one
   * `tool_result` step per result that comes back (denials recorded as `denied`), and the row
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
    /** `promptTokens`/`completionTokens` are the run's own model calls, summed. */
    endRun(
      runId: string,
      status: string,
      iterations: number,
      error?: string,
      promptTokens?: number,
      completionTokens?: number,
    ): void;
  };
  /**
   * The sub-agent's step budget. **Absent means no ceiling** (see `SUBAGENT_MAX_ITERATIONS` in
   * agentLoop.ts): the child is paced by the nudge and bounded by the concurrency cap and its
   * inactivity watchdog, not by a step count — the same rule the main turn follows. A number here is
   * the user's explicit ceiling from Router Settings → defaults, clamped to `MAX_ITERATIONS_CAP`.
   */
  subagentMaxIterations?: number;
  /**
   * Whether a `dispatch_agent` child may modify the workspace. **Absent means read-only**, which is
   * the shipped posture and the safe reading of an option nobody set.
   *
   * This is the user's decision and the only thing that widens a child's tool set: a specialist
   * definition's `tools` list is applied as a filter *over* whatever this grants, so a definition —
   * or a model — can never reach the write tools on its own. A write-capable child inherits the
   * parent's `confirm` gate, so its mutations ask exactly as the parent's would.
   */
  subagentCanWrite?: boolean;
  /**
   * Characters of a child's summary that reach the parent transcript. Defaults to
   * `SUBAGENT_RESULT_CAP` (4000); clamped to `[SUBAGENT_RESULT_CAP_MIN, SUBAGENT_RESULT_CAP_MAX]`
   * by `resolveSubagentResultCap`, because a child's whole survey landing in the parent's context is
   * the one thing delegation exists to prevent.
   */
  subagentSummaryCap?: number;
  /**
   * The enabled user-authored specialists `dispatch_agent` may pick from (parsed by
   * `lib/agents/defs.ts`). Absent — tests, the gateway bridge — the tool dispatches the
   * built-in researcher exactly as before. A type-only import: the defs module pulls the
   * registry, and this file must stay a leaf.
   */
  subagentDefs?: import("../agents/defs").SubagentDef[];
  /**
   * How long a sub-agent may go without an event before it is treated as hung and aborted.
   * Defaults to `SUBAGENT_INACTIVITY_TIMEOUT_MS` (10 minutes, the value ZCode ships);
   * injectable so the watchdog is testable without waiting ten real minutes.
   */
  subagentInactivityTimeoutMs?: number;
  signal?: AbortSignal;
}
