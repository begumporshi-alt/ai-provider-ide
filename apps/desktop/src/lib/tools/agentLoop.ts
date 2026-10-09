/**
 * Agent loop (2026-09-17).
 *
 * The orchestration core of agent mode. It is deliberately ignorant of Tauri and of any
 * specific provider: it is handed a `generate` function (the router facade) and a `ToolHost`
 * (the sandbox bridge), both injectable, so the whole loop is a pure function of its inputs
 * and is fully unit-testable.
 *
 * Shape of one iteration:
 *   1. call the model with the running message list, the tools, and an `onToolCall` sink;
 *   2. stream the text back through `onEvent({type:"assistant"})`;
 *   3. if the model emitted no tool calls, return the text (terminal turn);
 *   4. otherwise append the assistant turn WITH its `tool_calls` (providers reject a dangling
 *      tool result without the originating call), execute each call through the host — pausing
 *      for `confirm` per call — and append the results as `tool` role messages;
 *   5. repeat until the model stops calling or `maxIterations` is hit.
 *
 * The returned `messages` is the conversation only (the system turn is NOT included, so the
 * caller can persist it and feed it back next turn without duplicating the system prompt).
 */
import type { ChatMessage, ToolCall } from "@aiprovider/router-core";
import { registryToOpenAI, SUBAGENT_TOOLS } from "./registry";
import { runNotebookEdit, runNotebookRead } from "./notebook";
import { toWireToolCalls } from "./wire";
import type { AgentEvent, AgentLoopOptions, ToolHost } from "./types";

/**
 * Ceiling on model round-trips in one agent turn. A model that will not stop calling tools
 * must not be able to spend without limit; 8 is enough for real work and bounded when
 * something goes wrong.
 *
 * Exported because the gateway path bounds its own loop with the same number. Those used to be
 * two separate `= 8` constants kept in step by a comment — the kind of duplication that survives
 * exactly until someone edits one of them.
 */
export const DEFAULT_MAX_ITERATIONS = 40;

/** Upper bound when the ceiling is user-set. Not a security control — a value of 5000 would just
 *  be a slow way to burn tokens. */
export const MAX_ITERATIONS_CAP = 50;

/**
 * How many tool calls a turn may make before the loop starts reminding the model to wrap up — and
 * how many reminders one turn may carry.
 *
 * **A long turn is paced by a nudge, not by a guillotine.** The measured incident (2026-10-06,
 * "make the prompt library a desktop app"): a real task needed more than the configured 40 rounds,
 * and the hard ceiling cut the turn off mid-work — the user's report was "assistant suddenly
 * stopped". A client that paces instead of aborting is the shape a mature agent uses: ZCode runs
 * its main turn with no step cap at all and injects at most three of these per turn ("This turn has
 * already made N tool calls. Do not keep calling tools reflexively. Use the gathered results to
 * choose a different next step, summarize the blocker, or ask the user for guidance if you are
 * stuck."). The wording here is the same instruction, sized to this loop.
 *
 * The reminder rides the **system turn** of the next request only — never the transcript — so it
 * steers the model without appearing as a message the person did not write, and it is capped so a
 * model that ignores it still hears the same thing at most three times rather than every round.
 */
export const TOOL_CALL_NUDGE_AFTER = 25;
export const TOOL_CALL_NUDGE_MAX = 3;

/**
 * How many times a NO_OUTPUT turn — the model reasoned through its whole output budget and sent
 * no answer (`NO_OUTPUT`, measured twice 2026-10-03 on agentrouter/deepseek-v4-flash: ~8180
 * thinking deltas, zero text) — is re-asked with **thinking forced off** before the turn is
 * given up as an error. This is LiteLLM's fallback pattern applied to our own failure class: the
 * engine already classifies the failure with evidence, so the loop can react to it. One fallback
 * only: a model that answers nothing even without thinking is not answering today.
 */
export const NO_OUTPUT_RETRIES = 1;

/**
 * How many times a truncated stream is re-asked before the turn is accepted and flagged.
 *
 * A stream whose manifest declares a finish selector but ends without one is a provider cutting
 * the response short. Measured 2026-10-03 on `vice/deepseek-v4-flash`: the model streamed
 * "First, let me check", the tool call never arrived, and the old loop recorded the turn as a
 * clean one-iteration success — the user saw intent and then silence. Each retry is a full model
 * call, so the cap keeps a flaky reseller from tripling every turn's cost.
 */
export const TRUNCATION_RETRIES = 2;

/**
 * The sub-agent's default step budget: **none** — and that is the measured answer, not a
 * relaxation.
 *
 * This was a hard 12 (then briefly 30), and the evidence that any low number is wrong is
 * recorded on this machine: across 433 completed ZCode sub-agent runs, the median is 24 tool
 * uses, p90 is 55, and the largest is 152 — every one finishing `completed`, with **zero**
 * budget-related failures. A 12-round ceiling guillotined ordinary work (the "sub-agent hit its
 * step budget" complaint); a 30 would still cut off the p90 case. Our loop's own measurement
 * agrees: the models make roughly one tool call per round, so a step cap *is* a tool-call cap.
 *
 * So the bound is not a step count. Four things actually bound a child here:
 *   1. the pacing nudge (`TOOL_CALL_NUDGE_AFTER`) — it asks the child to wrap up rather than
 *      being cut off, and a child is exactly where a long turn is legitimate;
 *   2. the parent's abort signal — the user's Stop, checked every iteration;
 *   3. its obligation to end with a summary (see `SUBAGENT_PROTOCOL`), which is what the
 *      delegation is for;
 *   4. `SUBAGENT_CONCURRENCY`, which bounds how many children run at once — the runaway that
 *      actually matters, and the one ZCode enforces too.
 *
 * A user who wants a firm ceiling still sets one: Router Settings → defaults → subagent
 * iterations, or `maxIterations` on a specialist definition. `SUBAGENT_HARD_BACKSTOP` is the
 * only unconditional bound.
 */
export const SUBAGENT_MAX_ITERATIONS: number | null = null;

/**
 * Insurance against a pathological loop, far above any real work: the largest honest sub-agent
 * run measured is 152 tool calls, so a child that reaches 250 is not working, it is stuck.
 * Reaching it reports `hitCeiling` and the ceiling-exit summary — the same honest ending a
 * user-set budget produces. This is deliberately not a budget; teams that want a real one set
 * `subagentIterations` in Router Settings.
 */
export const SUBAGENT_HARD_BACKSTOP = 250;

/**
 * How many `dispatch_agent` children may run at once.
 *
 * The real runaway is *parallel* delegation, not a long single child: a model that emits five
 * `dispatch_agent` calls in one batch would, with no step cap, start five unbounded runs at the
 * same moment. ZCode bounds this the same way and reports "user concurrency limit exceeded" when
 * it is hit (the only limit-related failure in its entire run history on this machine). Queued
 * rather than refused, so the model's intent still executes — it just executes in waves.
 */
export const SUBAGENT_CONCURRENCY = 3;

/** Characters of a sub-agent's summary that reach the parent transcript. The point of delegation
 *  is context isolation; a summary the size of the survey it replaced would undo it. */
export const SUBAGENT_RESULT_CAP = 4000;

/**
 * The protocol every sub-agent runs under, appended to its role prompt (its own definition's
 * `systemPrompt`, or `SUBAGENT_SYSTEM` below).
 *
 * Two halves, both load-bearing:
 *
 * **Isolation** — only the final message survives, so a model that ends with "I looked at
 * several files" delegates nothing.
 *
 * **Batching** — a round is a *turn*, not a tool call, and independent calls in one turn run
 * concurrently (`Promise.all` below). Measured against our own ledger: sub-agents that batch
 * made 19–37 tool calls inside 6–12 rounds, while one that did not spent its whole budget on
 * single calls. ZCode's sub-agents work the same way and its prompt says so outright ("Launch up
 * to N agents IN PARALLEL (single message, multiple tool calls)"). Asking for it explicitly is
 * the difference between a budget measured in turns and one measured in tool calls.
 */
const SUBAGENT_PROTOCOL =
  "Nobody sees your intermediate steps or tool output: ONLY your final message is returned to " +
  "the main conversation. Work the task thoroughly, then end with a self-contained summary: the " +
  "findings, the exact file paths or URLs they came from, and anything that changes what the " +
  "main agent should do next.\n\n" +
  "Batch independent tool calls into ONE message — several reads or searches per turn run at " +
  "once, and a turn is not a tool call. Do not spend a turn on a single read when you already " +
  "know the next three things to look at.";

const SUBAGENT_SYSTEM =
  "You are a research sub-agent spawned by a main agent. You have the read-only tools only — " +
  "you cannot modify the workspace. " + SUBAGENT_PROTOCOL;

/**
 * How long a sub-agent may go **without a single event** before it is treated as hung and
 * aborted — ZCode's inactivity watchdog, at the value ZCode ships (`inactivityTimeoutMs =
 * 600000`). This is the bound that actually protects a delegation: the failure mode is not a
 * child working for a long time (that is the job), it is a child wedged on a provider stream
 * that will never end. A step-count ceiling cannot see the difference; a clock can.
 */
export const SUBAGENT_INACTIVITY_TIMEOUT_MS = 600_000;

/** Clamp a user-supplied ceiling into `[1, MAX_ITERATIONS_CAP]`, or `null` for no ceiling.
 *
 *  Non-finite and non-numeric input — and a blank string, which is what a cleared field holds —
 *  fall back to no ceiling rather than to 1 or to some default: a corrupted setting should degrade
 *  to the value that works, and an unbounded turn is the one the pacing nudge was built for. */
export function clampIterations(value: unknown): number | null {
  // Numbers and numeric strings only. A blanket `Number(value)` would coerce `null`, `[]` and
  // `true` into 0, 0 and 1 — a JSON blob that lost its field would then read as "run one step",
  // which is indistinguishable from a broken agent rather than a missing setting.
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  // **Blank, and anything unparseable, mean no ceiling** — the same reading the field's own blank
  // state has. It used to mean the default 8, which was right while the ceiling was mandatory and
  // is wrong now that the ceiling is the user's option: a cleared box asks for no limit, and a
  // corrupted setting should degrade to the value that always works, which is the unbounded one
  // the nudge paces (see `TOOL_CALL_NUDGE_AFTER`).
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(MAX_ITERATIONS_CAP, Math.floor(n)));
}

/** Best-effort parse of a model-supplied arguments string into a plain object. A malformed
 *  payload yields {} — the host will see unfamiliar/empty args and the model gets a clear
 *  error back as the tool result, rather than the loop crashing. */
function parseArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface AgentLoopResult {
  text: string;
  /** True when the accepted final turn's stream was truncated — the provider closed a
   *  declared-finish stream without a finish reason and every re-ask truncated too. The text is
   *  the model's last partial answer, not a complete one; the UI is expected to say so. */
  truncated: boolean;
  /** True when the loop ended on the step ceiling rather than on an answer — the model was still
   *  calling tools when the budget ran out, so the turn ended mid-work and `text` is often empty.
   *  The UI is expected to say that instead of appending an empty bubble (measured 2026-10-06:
   *  a 20-iteration run ended on two `run_command` verifications, and the transcript showed an
   *  assistant turn with nothing in it). */
  hitCeiling: boolean;
  /** Full conversation after this turn, conversation-only (no system turn). Feed back as the
   *  next turn's `messages` to replay tool calls correctly. */
  messages: ChatMessage[];
  /** Model round-trips the loop actually made — the sub-agent ledger row's iterations. */
  iterations: number;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    model,
    registry,
    generate,
    host,
    // `null` — and absent — mean **no ceiling**: the turn ends when the model stops calling tools,
    // which is what a real task needs and what the nudge above paces. A number is the user's own
    // budget from the run configuration, and it still ends the turn with the ceiling notice.
    // (`DEFAULT_MAX_ITERATIONS` is not the default here on purpose: it is the *gateway loop's*
    // bound, pinned against the Rust constant `bridge_policy.rs::MAX_TOOL_ITERATIONS` — a client
    // the app cannot see must never be left unbounded, while the Assistant's user can watch it and
    // press Stop.)
    maxIterations = null,
    confirm,
    onEvent,
    signal,
    generateImage,
    loadSkill,
    runId,
    subagentRecorder,
    subagentMaxIterations,
    subagentDefs,
    subagentInactivityTimeoutMs = SUBAGENT_INACTIVITY_TIMEOUT_MS,
  } = opts;

  // Conversation only — the system turn is prepended at each model call, never stored here.
  const messages: ChatMessage[] = [...opts.messages];

  const tools = registryToOpenAI(registry);

  let lastText = "";
  // The most recent iteration's tool results, kept so a ceiling exit can hand back progress
  // instead of silence: the final iteration is pure tool_use and its text is empty, so without
  // this the caller (a dispatch_agent parent, or the UI) receives an empty answer and cannot
  // tell where the budget went — the 2026-10-06 sub-agent incident, where a child spent its
  // whole budget on fetches that kept 403-ing and reported nothing.
  let lastTools: { name: string; ok: boolean; resultText: string }[] = [];
  let truncationRetries = 0;
  let noOutputRetries = 0;
  // The pacing counter (see `TOOL_CALL_NUDGE_AFTER`): calls made this turn, and reminders sent.
  let toolCallsThisTurn = 0;
  let nudgesSent = 0;
  // Set once the NO_OUTPUT fallback has fired: every attempt afterwards asks for thinking off,
  // so the knob's level never re-arms mid-turn.
  let forceNoReasoning = false;

  for (let iter = 1; maxIterations === null || iter <= maxIterations; iter++) {
    if (signal?.aborted) throw new DOMException("Agent loop aborted", "AbortError");

    // Pace a long turn: once it has made enough calls, every request carries a reminder to wrap up
    // or ask — at most `TOOL_CALL_NUDGE_MAX` times, so a model that ignores it is not nagged
    // forever and a model that heeds it is not told twice.
    const dueForNudge =
      toolCallsThisTurn >= TOOL_CALL_NUDGE_AFTER * (nudgesSent + 1) && nudgesSent < TOOL_CALL_NUDGE_MAX;
    const systemForThisRequest = !opts.system && !dueForNudge
      ? ""
      : [opts.system, dueForNudge ? nudgeText(toolCallsThisTurn) : ""].filter(Boolean).join("\n\n");
    if (dueForNudge) nudgesSent += 1;

    const collected: ToolCall[] = [];
    let text = "";
    // The finish signal, captured at its single report point. `finishReported` is the load-bearing
    // half: the interpreter fires `onFinish` only when the stream declares a finish selector, so
    // *reported with undefined* means the provider cut a declared stream short, while *never
    // reported* means this manifest gives the loop no way to judge — accepted as before.
    let finishReported = false;
    let finishReason: string | undefined;
    // The same predicate the engine's NO_OUTPUT classification uses (`exec.reasoning()` non-empty
    // exactly when the model composed something it never turned into an answer): the thinking
    // channel carried text and the answer's did not.
    let reasoningSeen = false;
    const stream = await generate(
      {
        model,
        // The pace reminder joins the system turn for this request only (see
        // `TOOL_CALL_NUDGE_AFTER`): appended after the caller's own instructions so it is the last
        // thing the model reads, and never written into `messages` — it is a steering note, not a
        // turn the transcript should show or the next turn should replay.
        messages: systemForThisRequest
          ? [{ role: "system" as const, content: systemForThisRequest }, ...messages]
          : messages,
        tools,
        toolChoice: tools ? "auto" : undefined,
        ...(forceNoReasoning ? { reasoning: "off" as const } : {}),
        // The run's own token usage, reported to whoever owns this loop's ledger row. The
        // parent's turn wrapper counts it for the session as it always has; a child's dispatch
        // passes a handler here, so a sub-agent's spend lands on ITS row instead of only being
        // folded into the session meter. Both readings are correct because this fires only for
        // the calls THIS loop made.
        onUsage: (u) => opts.onUsage?.(u),
        onToolCall: (call) => {
          collected.push(call);
        },
        onFinish: (reason) => {
          finishReported = true;
          finishReason = reason;
          opts.onFinish?.(reason);
        },
        // Forwarded as its own event rather than appended to `text`: an agent turn's reasoning
        // must not land in the transcript, where it would be replayed to the provider on the next
        // round-trip as if the model had already said it.
        onReasoning: (t) => {
          if (t) reasoningSeen = true;
          onEvent?.({ type: "reasoning", text: t });
        },
      },
      { signal },
    );

    for await (const chunk of stream.chunks) {
      if (signal?.aborted) break;
      text += chunk;
      onEvent?.({ type: "assistant", text: chunk });
    }
    lastText = text;

    // Terminal turn: the model produced a final answer with no tool calls — unless the stream was
    // cut, or the model never answered at all. A declared-finish stream that ended without a
    // finish reason is a truncation: re-ask the same iteration. A turn that is all reasoning and
    // no answer is the NO_OUTPUT class: re-ask with thinking forced off, which is the one lever
    // that works even against a provider that ignores budget tokens. After the caps, accept the
    // text but flag it (truncation) or fail loudly (no answer after the fallback), so the UI can
    // say what happened instead of going silent.
    if (collected.length === 0) {
      const truncated = finishReported && finishReason === undefined;
      // **The finish report is not part of the no-answer test, and that is deliberate.** A turn
      // that reasoned and produced neither text nor a call has no answer *whatever* the provider
      // said about how it stopped — requiring a reported finish left a silent hole: a manifest with
      // no finish selector plus a reasoning-only round-trip fell past both guards and was accepted
      // as an empty answer, the same blank bubble by a different road (the same shape as the
      // 2026-10-06 ceiling incident). Re-asking with thinking off is the remedy the class has, and
      // it is bounded by NO_OUTPUT_RETRIES either way.
      const noAnswer = text === "" && reasoningSeen;
      if (truncated && truncationRetries < TRUNCATION_RETRIES) {
        truncationRetries += 1;
        iter -= 1; // the for's increment restores it: the retry re-runs this iteration number
        onEvent?.({ type: "truncation_retry", attempt: truncationRetries });
        continue;
      }
      if (noAnswer && noOutputRetries < NO_OUTPUT_RETRIES) {
        noOutputRetries += 1;
        forceNoReasoning = true;
        iter -= 1;
        onEvent?.({ type: "no_output_retry", attempt: noOutputRetries });
        continue;
      }
      if (noAnswer && noOutputRetries >= NO_OUTPUT_RETRIES) {
        throw new Error(
          "the model spent its output budget on reasoning and still answered nothing — " +
            "re-asked once with thinking off and it happened again. Raise the model's output " +
            "cap in its manifest, or pick a model that answers without thinking.",
        );
      }
      onEvent?.({ type: "done", text, iterations: iter, truncated });
      return { text, messages, truncated, hitCeiling: false, iterations: iter };
    }

    // Replay the assistant turn with its tool_calls so the provider accepts the results.
    // The wire entries and the ids come from ONE decision (`toWireToolCalls`), so the results
    // appended below are guaranteed to name a call this turn actually declared — the pairing
    // providers check before accepting a continuation.
    const { wire, ids } = toWireToolCalls(collected);
    messages.push({ role: "assistant", content: text, tool_calls: wire });

    // Two phases, deliberately. **Approvals are asked one at a time** — the confirm gate is the
    // user's modal, and stacking one dialog per call in a three-call batch is how approvals get
    // rubber-stamped. **Execution is concurrent** — the calls in one batch are independent by
    // construction (the model chose them together), so running them one at a time multiplies the
    // wall clock by the batch size for no safety gain; reads under "auto-approve reads" need no
    // dialog at all and are the common case. The transcript appends stay in call order in the
    // third loop, so a result always lands under the tool_call it answers regardless of which
    // execution finished first.
    const parsed = collected.map((call) => ({ call, args: parseArgs(call.arguments) }));

    const verdicts: { allow: boolean; denyReason: string }[] = [];
    for (const { call, args } of parsed) {
      if (signal?.aborted) throw new DOMException("Agent loop aborted", "AbortError");
      onEvent?.({ type: "tool_call", call });
      const name = call.name ?? "(unknown)";

      let allow = true;
      // A refusal the gate made on its own behalf (plan mode) carries its own wording. The default
      // blames the user, and telling the model "the user denied this" when the user never saw the
      // call teaches it to retry the same edit with different phrasing instead of proposing a plan.
      let denyReason = `Tool call "${name}" was denied by the user.`;
      if (confirm) {
        const verdict = await confirm(call, args);
        if (typeof verdict === "boolean") {
          allow = verdict;
        } else {
          allow = verdict.allow;
          if (verdict.reason) denyReason = verdict.reason;
        }
      }
      verdicts.push({ allow, denyReason });
    }
    if (signal?.aborted) throw new DOMException("Agent loop aborted", "AbortError");

    // Batch execution, with the one real bound: **how many children run at once**. Everything
    // else in a batch is a cheap tool call; a `dispatch_agent` is an unbounded nested run, so a
    // model that emits five of them would start five at the same instant (see
    // `SUBAGENT_CONCURRENCY`). The permits are taken in call order and released as each child
    // settles, so the batch still finishes and the results stay in call order below.
    const childPermits = (() => {
      let free = SUBAGENT_CONCURRENCY;
      const waiters: Array<() => void> = [];
      return {
        async take(): Promise<void> {
          if (free > 0) {
            free -= 1;
            return;
          }
          await new Promise<void>((resolve) => waiters.push(resolve));
        },
        release(): void {
          const next = waiters.shift();
          // A waiter inherits the permit rather than the counter being bumped: whoever wakes
          // takes the freed slot directly, so the count never transiently exceeds the cap.
          if (next) next();
          else free += 1;
        },
      };
    })();
    const executed: { name: string; resultText: string; ok: boolean }[] = await Promise.all(
      parsed.map(async ({ call, args }, i) => {
        const name = call.name ?? "(unknown)";
        const { allow, denyReason } = verdicts[i]!;
        let resultText: string;
        let ok = true;

        if (!allow) {
          resultText = denyReason;
          ok = false;
        } else {
          try {
            // `dispatch_agent` never reaches the sandbox either: it is a nested run of THIS loop,
            // with a fresh context (the task is all it sees) and the read-only `SUBAGENT_TOOLS`.
            // Its step budget is normally *none* — see `SUBAGENT_MAX_ITERATIONS` — and the only
            // unconditional bound is `SUBAGENT_HARD_BACKSTOP`. How many children run at once is
            // capped by the permits taken below. The parent's confirm gate rides along — in
            // "ask every time" the sub-agent's reads prompt exactly as the main loop's would, so
            // a nested run is never a permission upgrade. Its events are not forwarded to the UI
            // and its transcript deliberately discarded — isolation is the entire point of
            // delegating; only the ledger keeps a filtered half (see `childOnEvent` below).
            if (name === "dispatch_agent") {
              const task = typeof args.task === "string" ? args.task.trim() : "";
              // A named specialist, if the model asked for one and the definitions carry it.
              // An unknown name errors back as the tool result — naming the valid ids — rather
              // than silently degrading: a silent fallback would read as a routing success
              // while running the wrong prompt.
              const requested = typeof args.agent === "string" ? args.agent.trim() : "";
              const def = requested ? (subagentDefs ?? []).find((d) => d.id === requested) : undefined;
              if (!task) {
                resultText =
                  'dispatch_agent needs a "task": the sub-agent sees nothing else of this conversation.';
                ok = false;
              } else if (requested && !def) {
                const known = (subagentDefs ?? []).map((d) => d.id).join(", ") || "(none)";
                resultText =
                  `No sub-agent named "${requested}". Available specialists: ${known}. ` +
                  'Omit "agent" for the general researcher.';
                ok = false;
              } else {
                // The delegation is a real run, not just a function call: with a recorder on
                // board the child gets its own ledger row under this run's id, one tool_call
                // step per sandbox call it makes, one tool_result step per call that came back
                // (denials included — see `childOnEvent`), and an honest ending — "stopped"
                // when it ran out of budget, "error" when it threw. Recording wraps the child's
                // host and filters its events; the child loop itself stays oblivious.
                // The specialist's overrides, resolved once: its own prompt (the isolation half
                // stays the loop's — it is what makes delegation isolation, not a suggestion),
                // a narrowed tool allowlist, an optional model, and its own step budget. A
                // definition can only narrow: its allowlist is intersected with the read-effect
                // set at parse time, so a custom agent is never a permission upgrade.
                const childModel = def?.model || model;
                const childSystem = def ? `${def.systemPrompt}\n\n${SUBAGENT_PROTOCOL}` : SUBAGENT_SYSTEM;
                const childRegistry = def?.tools?.length
                  ? SUBAGENT_TOOLS.filter((t) => def.tools!.includes(t.name))
                  : SUBAGENT_TOOLS;
                // Three sources, in priority order: the specialist's own budget, the user's
                // global one (Router Settings → defaults), then the loop's default — which is
                // **no ceiling**. The backstop is a ceiling on **every** path (`Math.min`), not
                // only on the `null` default: it is documented as unconditional, and while it was
                // an either/or, a typo of `5000` in Router Settings produced a 5000-round child
                // that nothing could bound — the specialist path clamps to 50 and this one did not
                // (audit 2026-10-09).
                const requestedBudget = def?.maxIterations ?? subagentMaxIterations ?? SUBAGENT_MAX_ITERATIONS;
                const childBudget =
                  requestedBudget === null ? SUBAGENT_HARD_BACKSTOP : Math.min(requestedBudget, SUBAGENT_HARD_BACKSTOP);
                const recorder = subagentRecorder;
                const childRunId = recorder ? recorder.newRunId() : null;
                if (recorder && childRunId) {
                  try {
                    recorder.startRun({
                      runId: childRunId,
                      parentRunId: runId ?? null,
                      model: childModel,
                      prompt: task,
                    });
                  } catch {
                    /* a lost record must not become a lost run */
                  }
                }
                const childHost: ToolHost =
                  recorder && childRunId
                    ? {
                        run: (n, a, o) => {
                          recorder.recordStep(childRunId, "tool_call", n);
                          return host.run(n, a, o);
                        },
                      }
                    : host;
                // The result half of the child's ledger. The child's events are still not
                // forwarded to the UI — isolation is the point of delegating — but a filtered
                // half lands in the ledger, because a steps list that shows what a sub-agent
                // *called* without what came back answers "what is it doing" with half a
                // sentence. Denied/refused calls are named `denied` here by the same regex the
                // parent's own recorder applies to its results (agent-turn.ts), so both ledgers
                // mean the same thing by the word.
                const childOnEvent: ((ev: AgentEvent) => void) | undefined =
                  recorder && childRunId
                    ? (ev) => {
                        if (ev.type !== "tool_result") return;
                        const name = ev.call.name ?? "(unknown)";
                        const denied = /denied|refused/i.test(ev.result);
                        recorder.recordStep(
                          childRunId,
                          denied ? "denied" : "tool_result",
                          name,
                          ev.result.slice(0, 500),
                          ev.ok,
                        );
                      }
                    : undefined;
                // The watchdog: a child that produces no event for `SUBAGENT_INACTIVITY_TIMEOUT_MS`
                // is wedged, not working, and is aborted. It covers the case a step ceiling
                // cannot see — a provider stream that never ends, where no round is ever
                // completed and therefore no iteration is ever counted. Armed from the start,
                // reset on every child event.
                // The child's own spend, summed over its round-trips — the number ZCode reports
                // as `totalTokens` and the one our ledger could not answer before.
                let childIn = 0;
                let childOut = 0;
                const watchdog = new AbortController();
                let lastActivity = Date.now();
                let watchdogFired = false;
                const onParentAbort = () => watchdog.abort();
                signal?.addEventListener("abort", onParentAbort, { once: true });
                const pollMs = Math.max(10, Math.min(30_000, Math.floor(subagentInactivityTimeoutMs / 4)));
                const timer = setInterval(() => {
                  if (Date.now() - lastActivity < subagentInactivityTimeoutMs) return;
                  watchdogFired = true;
                  watchdog.abort();
                }, pollMs);
                const childOnEventWatched = (ev: AgentEvent) => {
                  lastActivity = Date.now();
                  childOnEvent?.(ev);
                };
                try {
                  // Queue behind the concurrency cap *before* the child starts, and release in
                  // the `finally` so a throw cannot strand a permit and deadlock later children.
                  await childPermits.take();
                  let sub: Awaited<ReturnType<typeof runAgentLoop>>;
                  try {
                    sub = await runAgentLoop({
                      model: childModel,
                      messages: [{ role: "user", content: task }],
                      system: childSystem,
                      registry: childRegistry,
                      generate,
                      host: childHost,
                      confirm,
                      loadSkill,
                      runId: childRunId ?? undefined,
                      subagentRecorder: recorder,
                      maxIterations: childBudget,
                      onEvent: childOnEventWatched,
                      onUsage: (u) => {
                        childIn += u.prompt_tokens ?? 0;
                        childOut += u.completion_tokens ?? 0;
                      },
                      signal: watchdog.signal,
                    });
                  } finally {
                    childPermits.release();
                    clearInterval(timer);
                    signal?.removeEventListener("abort", onParentAbort);
                  }
                  const summary = sub.text.trim();
                  const capped =
                    summary.length > SUBAGENT_RESULT_CAP
                      ? summary.slice(0, SUBAGENT_RESULT_CAP) + "\n\n(summary truncated)"
                      : summary || "(the sub-agent returned an empty summary)";
                  resultText = sub.hitCeiling
                    ? "The sub-agent hit its step budget with work possibly unfinished.\n\n" + capped
                    : capped;
                  ok = true;
                  if (recorder && childRunId) {
                    recorder.endRun(
                      childRunId,
                      sub.hitCeiling ? "stopped" : "ok",
                      sub.iterations,
                      undefined,
                      childIn,
                      childOut,
                    );
                  }
                } catch (e) {
                  // A watchdog abort and a user Stop both arrive as AbortError; only the clock
                  // knows which one this was, and the model must be told the right story — one
                  // is "your sub-agent hung", the other is "the human stopped you".
                  resultText = watchdogFired
                    ? `The sub-agent made no progress for ${Math.round(subagentInactivityTimeoutMs / 60_000)} ` +
                      "minutes and was stopped — it was wedged on a request that never returned. " +
                      "Retry the task, or narrow it."
                    : `Sub-agent failed: ${e instanceof Error ? e.message : String(e)}`;
                  ok = false;
                  if (recorder && childRunId) {
                    recorder.endRun(
                      childRunId,
                      "error",
                      0,
                      e instanceof Error ? e.message : String(e),
                      childIn,
                      childOut,
                    );
                  }
                }
              }
            } else if (name === "web_ask") {
              // `web_ask` never reaches the sandbox: it is answered HERE, by the same model, in a
              // side conversation — fetch the page (cache included) through the host, then ask the
              // question against the text. The 32 KB of page content stays out of the main
              // transcript, which is the whole point of the tool. The backend has no handler on
              // purpose: the gateway path has no aux-model mechanism, so the tool is
              // Assistant-only, and the sandbox would refuse the name if it ever saw it.
              const pageUrl = typeof args.url === "string" ? args.url : "";
              const question = typeof args.question === "string" ? args.question : "";
              if (!pageUrl || !question) {
                resultText = 'web_ask needs a "url" and a "question".';
                ok = false;
              } else {
                const page = await host.run("web_fetch", { url: pageUrl }, { signal });
                if (!page.ok) {
                  resultText = `could not fetch the page: ${page.output}`;
                  ok = false;
                } else {
                  const aux = await generate(
                    {
                      model,
                      messages: [
                        {
                          role: "user" as const,
                          content:
                            `Answer the question using only the page content below. ` +
                            `If the page does not answer it, say exactly that.\n\n` +
                            `URL: ${pageUrl}\nQUESTION: ${question}\n\nPAGE CONTENT:\n${page.output}`,
                        },
                      ],
                    },
                    { signal },
                  );
                  let answer = "";
                  for await (const chunk of aux.chunks) {
                    if (signal?.aborted) break;
                    answer += chunk;
                  }
                  resultText = answer.trim() || "(the model returned no answer)";
                  ok = true;
                }
              }
            } else if (name === "generate_image") {
              // `generate_image` is a composite too: the port (the gateway's image route, injected
              // so the loop never imports the gateway) produces the bytes, and the sandbox's
              // write_file with `encoding: "base64"` lands them in the workspace. The result rides
              // the READ_IMAGE marker protocol, so the generated image is attached as a real
              // content part and a vision-capable model can see and iterate on what it made.
              const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
              if (!prompt) {
                resultText = 'generate_image needs a "prompt".';
                ok = false;
              } else if (!generateImage) {
                resultText =
                  "no image route is configured — pick an image model in Router Settings → defaults " +
                  "(or pass this tool's \"model\" once one exists) and make sure the gateway is running.";
                ok = false;
              } else {
                try {
                  const override =
                    typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
                  const img = await generateImage(prompt, override, signal);
                  const path =
                    typeof args.path === "string" && args.path.trim()
                      ? args.path.trim()
                      : `images/generated-${Date.now()}.png`;
                  const w = await host.run(
                    "write_file",
                    { path, content: img.base64, encoding: "base64" },
                    { callId: ids[i], signal },
                  );
                  if (!w.ok) {
                    resultText = `the image was generated but could not be saved: ${w.output}`;
                    ok = false;
                  } else {
                    const bytes = Math.round((img.base64.length * 3) / 4);
                    resultText = `READ_IMAGE:image/png;base64,${img.base64}\npath: ${path}\nbytes: ${bytes}`;
                    ok = true;
                  }
                } catch (e) {
                  resultText = `Image generation failed: ${e instanceof Error ? e.message : String(e)}`;
                  ok = false;
                }
              }
            } else if (name === "load_skill") {
              // Skill bodies arrive on demand: the system prompt lists names and descriptions
              // only (the screen builds that index), and the full procedure is fetched here, in
              // the turn where the model decided it matches the task. No port means no skills —
              // said plainly so the model stops trying rather than retrying.
              const skillName = typeof args.name === "string" ? args.name.trim() : "";
              if (!skillName) {
                resultText = 'load_skill needs a "name": the skill name as the system prompt lists it.';
                ok = false;
              } else if (!loadSkill) {
                resultText = "no skills are installed or available in this run.";
                ok = false;
              } else {
                try {
                  const body = await loadSkill(skillName, signal);
                  if (body === null) {
                    resultText = `no enabled skill named "${skillName}" — the system prompt's skill list is the authoritative set.`;
                    ok = false;
                  } else {
                    resultText = body;
                    ok = true;
                  }
                } catch (e) {
                  resultText = `Skill load failed: ${e instanceof Error ? e.message : String(e)}`;
                  ok = false;
                }
              }
            } else if (name === "read_notebook" || name === "edit_notebook") {
              // Notebook composites: read_file + parse + (mutate) + write_file, assembled here so
              // the model edits cells it can actually see instead of hand-writing notebook JSON.
              // Each is approved once under its declared effect; the composite's inner file calls
              // are part of that one logical edit and run without their own prompts.
              const r =
                name === "read_notebook"
                  ? await runNotebookRead(host, args, { callId: ids[i], signal })
                  : await runNotebookEdit(host, args, { callId: ids[i], signal });
              resultText = r.output;
              ok = r.ok;
            } else {
              // **The id that travels is `ids[i]`, not `call.id`, and the difference is a Stop that
              // works.** `toWireToolCalls` above synthesizes an id when the provider sent none, and
              // `ids[i]` is what the assistant turn and the tool result both name; `call.id` is
              // `undefined` for exactly that provider (the case `wire.ts` documents as real). Handing
              // the sandbox `undefined` meant `tool_cancel` was never invoked and the child was never
              // registered for cancellation — so Stop reported "stopped by you" while a 60-second
              // command ran to completion in the background. The wire id and the sandbox id are one
              // decision or they are two ids for one call.
              //
              // The signal rides along with it: it is what fires the cancel when the user hits Stop
              // mid-tool. Without both, Stop could only take effect at the next tool boundary — which
              // for a 60-second command is exactly the "stop doesn't work" complaint this path exists
              // to answer.
              const r = await host.run(name, args, { callId: ids[i], signal });
              resultText = r.output;
              ok = r.ok;
              // Belt and braces: `ToolHost` is an interface, and a host that reports a failure with
              // an empty string sends the model a blank tool result — it cannot tell "nothing to
              // report" from "something went wrong", and answers as if the tool had no output.
              // A failure must always carry a reason.
              if (!ok && !resultText.trim()) {
                resultText = `Tool "${name}" failed and reported no reason.`;
              }
            }
          } catch (e) {
            resultText = `Tool execution error: ${e instanceof Error ? e.message : String(e)}`;
            ok = false;
          }
        }

        onEvent?.({ type: "tool_result", call, result: resultText, ok });
        return { name, resultText, ok };
      }),
    );
    lastTools = executed;

    for (let i = 0; i < executed.length; i++) {
      const r = executed[i]!;
      // `read_image` (and `generate_image`, which lands its result in the same marker format)
      // return their payload under a marker: the tool message itself stays a short text receipt,
      // and the image rides as a real content part on a following user message — the same wire
      // shape chat attachments use. Without this, the base64 would flood the transcript as text
      // no model can see.
      const imageData =
        (r.name === "read_image" || r.name === "generate_image") && r.ok
          ? extractReadImage(r.resultText)
          : null;
      if (imageData) {
        const verb = r.name === "generate_image" ? "generated and saved" : "loaded";
        const receipt = `image ${verb}: ${imageData.path} (${Math.round(imageData.bytes / 1024)} KB) — attached as an image part below`;
        messages.push({ role: "tool", content: receipt, tool_call_id: ids[i]! });
        messages.push({
          role: "user",
          content: [
            { type: "text", text: `[image you just loaded with read_image: ${imageData.path}]` },
            { type: "image", mediaType: imageData.mediaType, dataBase64: imageData.base64 },
          ],
        });
        continue;
      }

      messages.push({ role: "tool", content: r.resultText, tool_call_id: ids[i]! });
    }
    toolCallsThisTurn += collected.length;
  }

  // Hit the iteration ceiling: hand back the last answer rather than spinning forever. The ceiling
  // exit is not a truncation — every stream here declared its own finish — so that flag stays off.
  // It is its own outcome, named: the model was still calling tools when the budget ran out, and
  // the last iteration's text is typically empty (that turn was pure tool_use). The caller reads
  // `hitCeiling` and says so, rather than appending an empty assistant turn that reads as a hang.
  // Only reachable with an explicit budget: with no ceiling the loop exits through the terminal
  // branch above, on an answer.
  //
  // An empty ceiling answer is worse than nothing for a dispatch_agent parent: it reads "(the
  // sub-agent returned an empty summary)" and cannot tell what the child did with its budget.
  // When the final turn produced no text, summarize its tool activity instead — names, ok/fail,
  // the first line of each result — so the parent learns where the steps went.
  const ceiling = maxIterations ?? 0;
  const text =
    lastText.trim() ||
    (lastTools.length
      ? "No final answer — the step budget ran out during tool calls. Last tool results:\n" +
        lastTools
          .map((t) => {
            const line = t.resultText.replace(/\s+/g, " ").trim().slice(0, 200);
            return `- ${t.name} (${t.ok ? "ok" : "FAILED"}): ${line || "(no output)"}`;
          })
          .join("\n")
      : "(no output — the step budget ran out before any tool ran)");
  onEvent?.({ type: "done", text, iterations: ceiling, hitCeiling: true });
  return { text, messages, truncated: false, hitCeiling: true, iterations: ceiling };
}

/** What the pace reminder says. Phrased as instruction rather than scolding — the loop has no
 *  view of whether the work is nearly done, and "you have made N calls" is the only fact it can
 *  honestly add. Mirrors the wording a mature client uses; see `TOOL_CALL_NUDGE_AFTER`. */
function nudgeText(calls: number): string {
  return (
    `This turn has already made ${calls} tool calls. Do not keep calling tools reflexively — ` +
    "use the results you have. Finish the task if it is done, summarise what is done and what " +
    "remains if it is not, or ask the user if you are stuck."
  );
}

/** The marker `read_image` writes: `READ_IMAGE:<media>;base64,<payload>` then `path:`/`bytes:` lines. */
function extractReadImage(resultText: string): { mediaType: string; base64: string; path: string; bytes: number } | null {
  const marker = resultText.match(/^READ_IMAGE:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)/);
  if (!marker) return null;
  const path = resultText.match(/^path: (.+)$/m)?.[1] ?? "(unknown)";
  const bytes = Number(resultText.match(/^bytes: (\d+)$/m)?.[1] ?? 0);
  return { mediaType: marker[1], base64: marker[2], path, bytes };
}
