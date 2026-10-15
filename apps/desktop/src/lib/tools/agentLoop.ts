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
 *   5. repeat until the model stops calling or `maxIterations` is hit — and when the budget is
 *      hit, the turn is *wrapped up*, not cut: the final round is told in advance, and a round
 *      that still ends in tool calls is followed by one no-tools round that produces the answer
 *      (see `FINAL_ROUND_NOTE` / `WRAP_UP_NOTE`).
 *
 * The returned `messages` is the conversation only (the system turn is NOT included, so the
 * caller can persist it and feed it back next turn without duplicating the system prompt).
 */
import type { ChatMessage, ToolCall } from "@aiprovider/router-core";
import { FAN_OUT_MAX, registryToOpenAI, subagentTools } from "./registry";
import { runNotebookEdit, runNotebookRead } from "./notebook";
import { toWireToolCalls } from "./wire";
import type { AgentEvent, AgentLoopOptions, PlanPorts, ToolHost } from "./types";

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
 * What the **final allowed round** is told before it starts, when the turn runs under an explicit
 * step budget.
 *
 * The pacing nudge above asks a long turn to consider wrapping up; it cannot say *when*. The one
 * fact the loop holds that the model does not is the round number, so the last round under budget
 * says it: after this round, no further tool calls run. Told in advance rather than after, because
 * the measured failure (2026-10-12, "stopped at 40 iterations — the step budget ran out while the
 * model was still calling tools") is a model that spent its last round on tool_use and was then
 * cut — everything it had gathered was in the transcript and none of it reached the user.
 *
 * It rides the system turn of that one request only, like the nudge — steering, never transcript.
 * A model that heeds it ends the turn through the ordinary terminal branch and the ceiling is
 * never felt; one that does not is caught by `WRAP_UP_NOTE` below.
 */
export const FINAL_ROUND_NOTE =
  "THIS IS THE FINAL ROUND of this turn's step budget: after it, no further tool calls run. " +
  "Do not call tools now — use everything you have gathered and give your final answer. If the " +
  "work is not finished, say exactly what is done, what it produced, and what remains.";

/**
 * What the wrap-up round is told, when the final round ended in tool calls anyway.
 *
 * **One extra model round-trip outside the budget, and that is the point.** Executing the final
 * round's calls is correct — the results land in the transcript, the approvals gate them exactly
 * as any round's — and then the honest ending is not the tool-dump fallback, it is the model's own
 * summary of them. The wrap-up call carries **no tools**, so a call cannot be attempted, and its
 * instruction names that rather than hoping the model infers it. If it answers nothing or errors,
 * the ceiling exit below answers with the last tool activity instead — the fallback is the
 * backstop, not the plan.
 */
export const WRAP_UP_NOTE =
  "The step budget is exhausted and the tool loop has ended: this request has NO tools, and any " +
  "tool call will not run. Using everything gathered above, give the final answer now: what was " +
  "done, what it produced, and what remains.";

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
 * How many times a turn the provider cut at the **output cap** (`finish_reason: "length"`) while
 * carrying tool calls is re-asked before its calls are allowed through.
 *
 * **Why this is neither `TRUNCATION_RETRIES` nor zero.** A length cut with a call in flight is the
 * one truncation whose damage lands in the *arguments*: the call the model was composing is the
 * thing that ran out of budget, so its arguments stop mid-JSON. Measured 2026-10-13 from this
 * machine's own `session_messages`: four consecutive `write_file` calls at 24 444 / 31 480 / 31 213
 * / 30 854 characters, every one invalid JSON ending mid-string or mid-tag, each answered
 * `missing argument "path"` — while the 327-character call in the same turn parsed and wrote
 * 258 bytes. Re-asking is cheap and it lands, **but only because the re-ask says what went wrong**:
 * the same loop re-asked blind four times and produced four identical failures. One guided retry,
 * not two, for exactly that reason.
 *
 * It is also deliberately not a hard failure: a second truncation falls through to
 * `argumentProblem`, which refuses the call with the reason and lets the model adapt inside the
 * turn rather than killing work that has already succeeded.
 */
export const TRUNCATED_TOOL_CALL_RETRIES = 1;

/**
 * What a re-ask after a length cut carrying tool calls is told.
 *
 * It names the cut, the consequence (the call did not run) and the remedy the measured case
 * actually needed — which the model found for itself by experiment: *"Short writes work — the long
 * one was too big. I'll build the file in chunks."* The loop should not make it rediscover that
 * over four failed round-trips.
 */
export const TRUNCATED_TOOL_CALL_NOTE =
  "Your LAST tool call was cut off by the model's output limit before its arguments finished, so " +
  "it did not run. Do not resend the same payload. Send smaller calls: write a short file first " +
  "and grow it with edit_file, or split the content across several calls.";

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

/** The largest summary cap a setting may ask for, and the smallest that still carries a finding.
 *  Raised caps are a real trade — a child's whole survey can land in the parent's context — so the
 *  ceiling is explicit rather than whatever the field happens to contain. */
export const SUBAGENT_RESULT_CAP_MAX = 16_000;
export const SUBAGENT_RESULT_CAP_MIN = 500;

/** A configured summary cap, clamped. Absent, non-finite or non-numeric means the default; the
 *  clamp runs on the number, never on a pre-parsed string (`Number("")` is `0`, which would floor
 *  every summary to nothing). */
export function resolveSubagentResultCap(configured?: number): number {
  if (typeof configured !== "number" || !Number.isFinite(configured)) return SUBAGENT_RESULT_CAP;
  return Math.min(Math.max(Math.floor(configured), SUBAGENT_RESULT_CAP_MIN), SUBAGENT_RESULT_CAP_MAX);
}

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
 * The same role prompt when the user has enabled sub-agent writes.
 *
 * It states the gate explicitly, because the child cannot see the parent's approval UI and would
 * otherwise read a refusal as its own failure — or worse, keep retrying it. The change set is
 * mentioned for the same reason: a child's writes are the *parent run's* writes, so they are
 * revertible together.
 */
const SUBAGENT_SYSTEM_WRITE =
  "You are a task sub-agent spawned by a main agent. You have the full tool set, including file " +
  "writes, edits and commands, and you work in the same workspace the main agent does. Every " +
  "mutation you attempt passes through the main agent's approval gate: a refusal comes back to you " +
  "as a refusal, and the right response is to report it, not to retry it. Your changes belong to " +
  "the main agent's run and are reverted with it. " + SUBAGENT_PROTOCOL;

/** Appended to a specialist's own prompt when sub-agent writes are on, so a definition does not have
 *  to know about the setting to behave correctly under it. */
const SUBAGENT_WRITE_NOTE =
  "\n\nSub-agent writes are enabled for this run: you may modify the workspace, and each mutation " +
  "passes through the main agent's approval gate. A refusal is reported back to you as a refusal — " +
  "report it in your summary rather than retrying it.";

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

/**
 * Why a call's arguments cannot be run — or `null` when they are usable.
 *
 * **The distinction `parseArgs` alone destroys.** `parseArgs` returns `{}` for anything it cannot
 * parse, which is right for the *executor* (it always needs an object) and wrong for the
 * *transcript*: an absent or empty `arguments` is a legitimate no-argument call, while an
 * `arguments` that is present, non-empty and unparseable is a call that never finished arriving.
 * Collapsing the two sent `{}` to the sandbox, which answered `missing argument "path"` — a message
 * naming a missing key while the real cause was a truncated payload, so the model had to find the
 * difference by failing four times.
 */
export function argumentProblem(raw: string | undefined): "truncated" | "not-an-object" | null {
  // Absent and empty are the same finding, and it is not a defect: `undefined` is what a dialect
  // with no `arguments` field sends, `""` is what OpenAI-shaped servers send for a call that takes
  // none. Treating these as truncation would refuse every legitimately argument-free call.
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return "truncated";
  }
  // Valid JSON, wrong shape — a provider that sent `[]` or a bare scalar. Not a truncation, so the
  // message must not call it one; equally unusable as an argument object.
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "not-an-object";
  return null;
}

/**
 * The sentence a call with unusable arguments is answered with, in place of a blind `{}`.
 *
 * It is phrased for the model, which is the reader that can still act on it: name the call, say it
 * did not run, give the cause, and give the remedy. The remedy is the measured one — a `write_file`
 * whose content does not fit in a single response is the shape that produced the 24-31 KB truncated
 * arguments above, and chunking is what worked.
 */
export function argumentProblemMessage(
  name: string,
  problem: "truncated" | "not-an-object",
): string {
  if (problem === "not-an-object") {
    return (
      `Tool "${name}" was not run: its arguments parsed as JSON but were not an object. ` +
      "Send this tool's arguments as a JSON object."
    );
  }
  return (
    `Tool "${name}" was not run: its arguments were cut off before they were valid JSON, so the ` +
    "call never finished arriving — almost always the model's output limit reached mid-call, which " +
    "is what a write whose content does not fit in one response looks like. Send a smaller call: " +
    "write a short file first and grow it with edit_file, or split the content across several calls."
  );
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

/** What a plan-mode control call settles to: the sentence the model reads as the tool's result. */
interface PlanNote {
  text: string;
  ok: boolean;
  /** The plan was approved by this call: plan mode is now off, and the user said yes. */
  planApproved?: boolean;
}

/**
 * Settle `enter_plan_mode` / `exit_plan_mode` — the two calls whose approval is not the generic
 * per-call gate but their own conversation with the user.
 *
 * They are settled in the approval phase, one at a time with every other call, and for a reason
 * that is structural: the generic gate cannot express them. Declared `read`, `decide()` would
 * auto-allow them under "auto-approve reads", "yolo" or a remembered grant — the review would
 * never appear — and declared `mutate`, plan mode would refuse the very call that ends it. So the
 * pair is intercepted before `confirm` and their outcome rides as an already-allowed verdict.
 *
 * The result is a sentence, not an execution: `planNotes` is checked before every execution
 * branch below, and `persist` is the only side effect — the plan document itself.
 *
 * Returns null for every other tool, leaving the ordinary path untouched.
 */
async function settlePlanTool(
  name: string,
  args: Record<string, unknown>,
  plan: PlanPorts | undefined,
  signal: AbortSignal | undefined,
): Promise<PlanNote | null> {
  if (name !== "enter_plan_mode" && name !== "exit_plan_mode") return null;
  if (!plan) {
    return {
      ok: false,
      text:
        `"${name}" needs the plan-mode approval surface, which this run does not have. Present the ` +
        "plan in your answer instead — the user can then ask for it to be carried out.",
    };
  }

  if (name === "enter_plan_mode") {
    if (plan.isPlanMode()) {
      return {
        ok: false,
        text:
          "Plan mode is already on: every write is refused until a plan is approved. Investigate " +
          "what the plan needs, then call exit_plan_mode with it.",
      };
    }
    if (!(await plan.requestEntry(signal))) {
      return { ok: true, text: "The user declined plan mode. Continue with the task as asked." };
    }
    // Before the text is built, not after: the model's next iteration may already be a write, and
    // a flip that lands late is a write refused for no reason the model can see.
    plan.setPlanMode(true);
    return {
      ok: true,
      text:
        "PLAN MODE IS ON for the rest of this pass: reading, listing, searching and inspecting run " +
        "without asking, and every write is refused. Investigate whatever the plan needs, then call " +
        "exit_plan_mode with the plan. Do not attempt a write.",
    };
  }

  if (!plan.isPlanMode()) {
    return {
      ok: false,
      text:
        "exit_plan_mode is only for a pass that is in plan mode, and nothing was approved or " +
        "changed. Continue the task; if a plan is what this needs, call enter_plan_mode first.",
    };
  }
  const planText = typeof args.plan === "string" ? args.plan.trim() : "";
  if (!planText) {
    return {
      ok: false,
      text: 'exit_plan_mode needs a "plan": the complete plan, in markdown, is what the user reviews.',
    };
  }
  const decision = await plan.requestApproval(planText, signal);
  if (!decision.approved) {
    const asked = decision.feedback?.trim();
    return {
      ok: true,
      text:
        "The user did not approve the plan yet. " +
        (asked
          ? `Their requested changes: ${asked}`
          : "They closed the review without saying what to change.") +
        " Revise the plan accordingly and call exit_plan_mode again when it is ready. Do not " +
        "modify the workspace.",
    };
  }
  // The gate opens before the file is written. Both orders are inside this awaited call, so the
  // loop cannot observe the difference — the reason to open it first is that a `persist` that hangs
  // or throws must not hold the mode closed after the user has already said yes.
  plan.setPlanMode(false);
  const path = await plan.persist(planText).catch(() => null);
  return {
    ok: true,
    planApproved: true,
    text:
      "The user approved the plan." +
      (path ? ` It is saved at ${path}.` : "") +
      " Plan mode is off for the rest of this pass: implement the plan now, step by step, starting " +
      "with its first step. Do not re-plan.",
  };
}

/**
 * What the model is told, per request, when the live plan mode no longer matches the framing the
 * pass started with.
 *
 * The system turn is composed once by the caller and cannot be rebuilt mid-run, so a mode change
 * inside a pass has to be stated in the request instead. Appended rather than substituted — the
 * loop cannot know which paragraph of a caller-composed system turn was the plan framing — so each
 * note names what it supersedes. The alternative is a model holding two contradictory instructions
 * and picking the wrong one, which is the failure measured on 2026-10-10: after an approved
 * `exit_plan_mode`, every remaining iteration still carried "PLAN MODE — do not attempt a write",
 * so a compliant model answered that it could not implement the plan the user had just approved.
 * The browser suite could never have caught it: the test oracle never reads the system turn.
 *
 * Three notes, because the exits mean different things and one sentence cannot be true for all of
 * them: a plan the user approved is a mandate to implement, a mode the user switched off is
 * permission to continue, and a mode switched ON mid-pass is a constraint to respect.
 */
const PLAN_MODE_APPROVED_NOTE =
  "PLAN MODE IS NOW OFF — the user reviewed and approved the plan this pass presented, so any " +
  "instruction above telling you not to write, or that every writing tool is refused, is " +
  "superseded: the writing tools are available now. Implement the plan in this same pass, starting " +
  "with its first step, and do not re-plan.";

const PLAN_MODE_OFF_NOTE =
  "PLAN MODE IS NOW OFF — the user switched it off during this pass, so any instruction above " +
  "telling you not to write, or that every writing tool is refused, is superseded: the writing " +
  "tools are available now. Continue the task.";

const PLAN_MODE_ON_NOTE =
  "PLAN MODE IS NOW ON — the user switched it on during this pass, after it had started. It means " +
  "what it always means: reading, listing, searching and inspecting run without asking, and every " +
  "write is refused until a plan is approved. Investigate whatever the plan needs, then call " +
  "exit_plan_mode with the plan; do not attempt a write.";

/**
 * The workspace-relative path of the plan a settled `exit_plan_mode` saved, or null.
 *
 * The sentence and its parser live in one module on purpose: the path exists only inside the tool
 * result the loop writes, so a UI that re-derived it with its own regex would break silently the
 * day the sentence is reworded.
 *
 * Anchored, not a substring search, and that is the whole point of the two-step pattern. The
 * refusal sentence quotes the user's own feedback ("Their requested changes: …"), so an
 * unanchored scan would let a user type "It is saved at /etc/passwd." into a request-changes box
 * and mint a Reveal button pointing outside the workspace — `RevealButton` sends an absolute path
 * straight to the OS, bypassing the root join. Anchoring to the approval sentence and to the
 * plan-file shape also rejects the 80-character graph *label*, whose truncation ends mid-path.
 */
export function planPathFromResult(result: string): string | null {
  const m = /The user approved the plan\. It is saved at (\.zcode\/plans\/[^\s.]+\.md)\./.exec(result);
  return m ? m[1]! : null;
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
    plan,
    runId,
    subagentRecorder,
    subagentMaxIterations,
    subagentDefs,
    subagentCanWrite = false,
    subagentSummaryCap,
    subagentInactivityTimeoutMs = SUBAGENT_INACTIVITY_TIMEOUT_MS,
  } = opts;

  // Resolved once per run: the cap is a property of this loop, and re-reading the option at each
  // truncation would let a caller change it mid-run into a transcript half of one size.
  const summaryCap = resolveSubagentResultCap(subagentSummaryCap);

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
  // The same counter for the *other* truncation class: a length cut that arrived carrying tool
  // calls (see `TRUNCATED_TOOL_CALL_RETRIES`). Kept apart from `truncationRetries` so neither
  // class can spend the other's retry.
  let truncatedToolCallRetries = 0;
  let noOutputRetries = 0;
  // The pacing counter (see `TOOL_CALL_NUDGE_AFTER`): calls made this turn, and reminders sent.
  let toolCallsThisTurn = 0;
  let nudgesSent = 0;
  // Set once the NO_OUTPUT fallback has fired: every attempt afterwards asks for thinking off,
  // so the knob's level never re-arms mid-turn.
  let forceNoReasoning = false;
  // Set once a length-cut turn has been re-asked: that retry carries the chunking note, because a
  // blind re-ask is what produced four identical failures in the measured case.
  let forceChunkedCalls = false;
  // Whether the user approved the plan this pass presented. Decides WHICH correction the system
  // turn carries once the mode is off — "the user approved it, implement it" is a different
  // instruction from "the user switched the mode off, carry on".
  let planApprovedThisPass = false;

  for (let iter = 1; maxIterations === null || iter <= maxIterations; iter++) {
    if (signal?.aborted) throw new DOMException("Agent loop aborted", "AbortError");

    // Pace a long turn: once it has made enough calls, every request carries a reminder to wrap up
    // or ask — at most `TOOL_CALL_NUDGE_MAX` times, so a model that ignores it is not nagged
    // forever and a model that heeds it is not told twice. The final round under budget does not
    // get the nudge — it gets something stronger (see `FINAL_ROUND_NOTE`), and the two would only
    // repeat each other.
    const isFinalRound = maxIterations !== null && iter === maxIterations;
    const dueForNudge =
      !isFinalRound &&
      toolCallsThisTurn >= TOOL_CALL_NUDGE_AFTER * (nudgesSent + 1) &&
      nudgesSent < TOOL_CALL_NUDGE_MAX;
    // The pass's system turn is frozen, so its plan framing has to be corrected in the request
    // rather than rebuilt — see `PLAN_MODE_OFF_NOTE`. Read live: the mode can go off mid-iteration.
    // The pass's system turn is frozen, so a mode change inside the pass has to be corrected in the
    // request rather than rebuilt — see the PLAN_MODE_*_NOTE constants. Read live, per iteration:
    // the mode can change between any two round-trips, and it does so in both directions.
    const startedInPlan = Boolean(plan?.startedInPlanMode());
    const inPlanNow = Boolean(plan?.isPlanMode());
    const planFramingNote =
      inPlanNow === startedInPlan
        ? ""
        : inPlanNow
          ? PLAN_MODE_ON_NOTE
          : planApprovedThisPass
            ? PLAN_MODE_APPROVED_NOTE
            : PLAN_MODE_OFF_NOTE;
    const systemForThisRequest =
      !opts.system && !dueForNudge && !planFramingNote && !isFinalRound && !forceChunkedCalls
        ? ""
        : [
            opts.system,
            planFramingNote,
            dueForNudge ? nudgeText(toolCallsThisTurn) : "",
            isFinalRound ? FINAL_ROUND_NOTE : "",
            // The chunking note rides the system turn of the retry only — steering, never
            // transcript, exactly like the nudge and the plan framing above.
            forceChunkedCalls ? TRUNCATED_TOOL_CALL_NOTE : "",
          ]
            .filter(Boolean)
            .join("\n\n");
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

    // A turn the provider cut at the output cap is **not** a turn whose tool calls can be trusted:
    // the call in flight is the thing that ran out of budget, so its arguments stop mid-JSON. Re-ask
    // once with the remedy attached (see `TRUNCATED_TOOL_CALL_NOTE`) rather than executing a call
    // whose payload never finished arriving. This is the guard the terminal-branch check above
    // cannot reach: that one is gated on `collected.length === 0`, so a length cut carrying tool
    // calls fell straight through to execution — the measured 2026-10-13 defect. Whatever a re-ask
    // still cannot deliver is caught by `argumentProblem` below, which refuses it and says why.
    if (
      finishReported &&
      finishReason === "length" &&
      collected.length > 0 &&
      truncatedToolCallRetries < TRUNCATED_TOOL_CALL_RETRIES
    ) {
      truncatedToolCallRetries += 1;
      iter -= 1; // the for's increment restores it: the retry re-runs this iteration number
      forceChunkedCalls = true;
      // The same event the other truncation class reports: the stream did end early — at the cap
      // rather than without a finish — and the loop is re-asking the same iteration either way.
      onEvent?.({ type: "truncation_retry", attempt: truncatedToolCallRetries });
      continue;
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
    // `args` is what the executor gets (always an object, `{}` when there is nothing to parse) and
    // `problem` is what the *transcript* needs: the reason this call cannot run at all. Keeping both
    // is what lets a payload that never finished arriving be refused with its cause, instead of
    // being executed as an empty object and reported as a missing key.
    const parsed = collected.map((call) => ({
      call,
      args: parseArgs(call.arguments),
      problem: argumentProblem(call.arguments),
    }));

    const verdicts: { allow: boolean; denyReason: string }[] = [];
    // Sparse, positional like `verdicts`: index i holds the settled sentence for a plan-mode
    // control call, undefined for every other call.
    const planNotes: (PlanNote | undefined)[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const { call, args, problem } = parsed[i]!;
      if (signal?.aborted) throw new DOMException("Agent loop aborted", "AbortError");
      // The segment is opened for **every** call, malformed ones included: the timeline's
      // `tool_result` fills the last segment still `calling`, so a call whose result is an error
      // must still have opened one or its explanation would render nowhere.
      onEvent?.({ type: "tool_call", call });
      const name = call.name ?? "(unknown)";

      // What is skipped is the *approval*, not the result. A call whose arguments never finished
      // arriving cannot run, so there is nothing for the user to approve and no dialog is owed; the
      // reason lands as this call's result in the execution phase below. The verdict is still pushed
      // — one per call, in order — because the execution map indexes `verdicts` and `parsed` by the
      // same `i`.
      if (problem) {
        verdicts.push({ allow: true, denyReason: "" });
        continue;
      }

      // The plan-mode pair first, and instead of the gate: their approval is their own interaction
      // with the user (a plan review, a mode consent), which the effect policy cannot express —
      // see `settlePlanTool`. Settled here, in the one-at-a-time phase, so a review never parks
      // inside the concurrent execution below and never slips past the ordering every other
      // approval keeps.
      const note = await settlePlanTool(name, args, plan, signal);
      if (note) {
        planNotes[i] = note;
        // Remembered for the rest of the pass: the system-turn correction distinguishes an approved
        // plan ("implement it") from a mode the user simply switched off ("carry on").
        if (note.planApproved) planApprovedThisPass = true;
        verdicts.push({ allow: true, denyReason: "" });
        continue;
      }

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
    /**
     * Run one delegated child to completion, and return what the parent model reads.
     *
     * **One implementation, two callers.** `dispatch_agent` runs one child; `fan_out` runs many.
     * The rules that must not drift between them live here rather than in each caller: the granted
     * tool set (the user's setting) with the definition narrowing it, the child's system prompt, its
     * step budget and hard backstop, the parent's approval gate riding along, one ledger row per
     * child, and the inactivity watchdog. A second copy is how a fan-out child ends up at a
     * different privilege level from a dispatched one.
     */
    async function runChild(
      task: string,
      def: import("../agents/defs").SubagentDef | undefined,
    ): Promise<{
      resultText: string;
      ok: boolean;
      iterations: number;
      tokensIn: number;
      tokensOut: number;
    }> {
      let resultText = "";
      let ok = false;
      let iterations = 0;
      let childIn = 0;
      let childOut = 0;
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
        // The granted set is the **user's** setting; a definition only ever narrows it.
        // An empty `tools` list narrows to nothing rather than falling back to everything:
        // `.length` read an empty allowlist as "unset", which quietly handed a
        // write-capable child every tool the moment writes were switched on.
        const granted = subagentTools(subagentCanWrite);
        const childRegistry = Array.isArray(def?.tools)
          ? granted.filter((t) => def.tools!.includes(t.name))
          : granted;
        const childSystem = def
          ? `${def.systemPrompt}\n\n${SUBAGENT_PROTOCOL}${subagentCanWrite ? SUBAGENT_WRITE_NOTE : ""}`
          : subagentCanWrite
            ? SUBAGENT_SYSTEM_WRITE
            : SUBAGENT_SYSTEM;
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
        iterations = sub.iterations;
          const summary = sub.text.trim();
          const capped =
            summary.length > summaryCap
              ? summary.slice(0, summaryCap) +
                `\n\n(summary truncated at ${summaryCap} characters)`
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
      return { resultText, ok, iterations, tokensIn: childIn, tokensOut: childOut };
    }

    const executed: { name: string; resultText: string; ok: boolean }[] = await Promise.all(
      parsed.map(async ({ call, args, problem }, i) => {
        const name = call.name ?? "(unknown)";
        const { allow, denyReason } = verdicts[i]!;
        let resultText: string;
        let ok = true;

        if (problem) {
          // Refused here rather than sent as `{}`. An empty object is what turned a truncated
          // `write_file` into `missing argument "path"` — a message naming a missing key while the
          // real cause was a payload that never finished arriving. This sentence is the result the
          // model reads on the next round-trip, which is where the remedy can still be acted on.
          resultText = argumentProblemMessage(name, problem);
          ok = false;
        } else if (!allow) {
          resultText = denyReason;
          ok = false;
        } else if (planNotes[i]) {
          // A plan-mode control call: its interaction already happened in the approval phase, so
          // there is nothing left to execute — the sentence settled there is the result.
          resultText = planNotes[i]!.text;
          ok = planNotes[i]!.ok;
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
                const child = await runChild(task, def);
                resultText = child.resultText;
                ok = child.ok;
              }
            } else if (name === "fan_out") {
              // **N independent children in one round, one structured result each.** The point is
              // the shape of the answer: a `dispatch_agent` batch returns N prose summaries in call
              // order, which the model has to keep straight itself, while this returns JSON keyed by
              // the caller's own label — so "which of the twelve failed, and what did it say" is a
              // question the model can answer without re-reading the batch.
              //
              // Everything expensive is `runChild`'s: the granted tool set and the definition
              // narrowing it, the system prompt, the step budget and hard backstop, the parent's
              // confirm gate, one ledger row per child, and the inactivity watchdog. They cannot
              // drift from `dispatch_agent`'s because they are the same code — and the concurrency
              // cap applies here for free, since each child takes its permit inside `runChild`. A
              // batch larger than the cap runs in waves rather than being refused, the same bargain
              // `dispatch_agent` makes.
              const raw = Array.isArray(args.tasks) ? args.tasks : [];
              if (raw.length === 0) {
                resultText =
                  'fan_out needs "tasks": an array of { task, label?, agent? } — at least one. Use ' +
                  "`dispatch_agent` for a single task.";
                ok = false;
              } else if (raw.length > FAN_OUT_MAX) {
                resultText =
                  `fan_out accepts at most ${FAN_OUT_MAX} tasks, got ${raw.length}. Split the set ` +
                  "across rounds — the cap exists because each task is a full sub-agent run.";
                ok = false;
              } else {
                const knownIds = (subagentDefs ?? []).map((d) => d.id);
                const results = await Promise.all(
                  raw.map(async (entry, i) => {
                    const e = (entry ?? {}) as Record<string, unknown>;
                    const label =
                      typeof e.label === "string" && e.label.trim()
                        ? e.label.trim()
                        : `task-${i + 1}`;
                    const task = typeof e.task === "string" ? e.task.trim() : "";
                    const agentId = typeof e.agent === "string" ? e.agent.trim() : "";
                    // A bad ITEM fails that item, not the batch: the others ran to completion, and
                    // their results are not the caller's mistake. An unknown id names the valid ones
                    // for the same reason `dispatch_agent` does — a silent fallback would read as a
                    // routing success while running the wrong prompt.
                    if (!task) {
                      return { label, ok: false, error: 'this task has no "task" text' };
                    }
                    const def = agentId
                      ? (subagentDefs ?? []).find((d) => d.id === agentId)
                      : undefined;
                    if (agentId && !def) {
                      return {
                        label,
                        ok: false,
                        error:
                          `no sub-agent named "${agentId}". Available: ` +
                          `${knownIds.join(", ") || "(none)"}. Omit "agent" for the general researcher.`,
                      };
                    }
                    const child = await runChild(task, def);
                    return {
                      label,
                      ok: child.ok,
                      summary: child.resultText,
                      iterations: child.iterations,
                      tokensIn: child.tokensIn,
                      tokensOut: child.tokensOut,
                    };
                  }),
                );
                const failed = results.filter((r) => !r.ok).length;
                // A one-line header, then the structure: the model reads both, and the counts are
                // what it needs before deciding whether anything is worth retrying.
                resultText =
                  `fan_out ran ${results.length} task(s)${failed ? `, ${failed} failed` : ""}.\n\n` +
                  JSON.stringify({ tasks: results }, null, 2);
                ok = failed < results.length;
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

    // **Every tool result of this turn goes out before any image does, and that ordering is the
    // whole fix.** The image rides on its own `user` message (see below), so building it inline put
    // a `user` message *between* two `tool_result`s whenever the turn called `read_image` alongside
    // any other tool. Anthropic requires each `tool_use` to be answered by a `tool_result` in the
    // message **immediately** after it, and rejects the entire request otherwise — measured
    // 2026-10-15 against `agentrouter.org`, on the exact shape this loop produced:
    //
    //   messages.1:`tool_use` ids were found without `tool_result` blocks immediately after:
    //   call_2. Each `tool_use` block must have a corresponding `tool_result` block in the next
    //   message.
    //
    // The run that exposed it called `read_image` and `run_command` in one turn (agent_steps 9/10):
    // the image message split the two results and every attempt for that request failed — 6 tool
    // calls in, 224k prompt tokens, `iterations = 0`, the whole turn lost. Deferring the image
    // messages until the run is complete keeps the results consecutive, and the image still arrives
    // with its note, one message later: proven by the same experiment, which answers `200` when the
    // two `tool_result`s are together and the image follows. See docs/dev-book/07-drift-register.md
    // D109.
    const imageMessages: ChatMessage[] = [];
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
        imageMessages.push({
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
    messages.push(...imageMessages);
    toolCallsThisTurn += collected.length;

    // **The wrap-up round: the budget ran out mid tool_use, so end with an answer, not a dump.**
    // The final round was told in advance (`FINAL_ROUND_NOTE`); a model that called tools anyway
    // has had those calls executed and their results appended — a complete, replayable state — so
    // one extra round with the tools *absent* asks for the model's own summary of them. It is an
    // extra round-trip outside the budget on purpose: the alternative is the ceiling exit below,
    // whose fallback text tells the user where the steps went but not what they mean. A model that
    // answers nothing here (or errors, or the user pressed Stop) falls through to that fallback —
    // it is the backstop, not the plan. The reasoning knob rides along so a model already asked to
    // think silent keeps doing so.
    if (isFinalRound && !signal?.aborted) {
      const wrapSystem = [opts.system, WRAP_UP_NOTE].filter(Boolean).join("\n\n");
      try {
        const wrap = await generate(
          {
            model,
            messages: wrapSystem
              ? [{ role: "system" as const, content: wrapSystem }, ...messages]
              : messages,
            ...(forceNoReasoning ? { reasoning: "off" as const } : {}),
            onUsage: (u) => opts.onUsage?.(u),
            onReasoning: (t) => onEvent?.({ type: "reasoning", text: t }),
          },
          { signal },
        );
        let wrapText = "";
        for await (const chunk of wrap.chunks) {
          if (signal?.aborted) break;
          wrapText += chunk;
          onEvent?.({ type: "assistant", text: chunk });
        }
        if (wrapText.trim()) {
          onEvent?.({ type: "done", text: wrapText, iterations: iter, hitCeiling: true });
          return { text: wrapText, messages, truncated: false, hitCeiling: true, iterations: iter };
        }
      } catch {
        /* the ceiling exit below answers with the last tool activity instead */
      }
    }
  }

  // Hit the iteration ceiling: hand back the last answer rather than spinning forever. This is the
  // wrap-up's backstop, not the plan — the wrap-up round above normally ends the turn with the
  // model's own summary, and this runs only when that answered nothing, errored, or was aborted.
  // The ceiling exit is not a truncation — every stream here declared its own finish — so that
  // flag stays off. It is its own outcome, named: the model was still calling tools when the
  // budget ran out, and the last iteration's text is typically empty (that turn was pure
  // tool_use). The caller reads `hitCeiling` and says so, rather than appending an empty assistant
  // turn that reads as a hang. Only reachable with an explicit budget: with no ceiling the loop
  // exits through the terminal branch above, on an answer.
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
