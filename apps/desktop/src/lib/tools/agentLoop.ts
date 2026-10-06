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
import { registryToOpenAI } from "./registry";
import { toWireToolCalls } from "./wire";
import type { AgentLoopOptions } from "./types";

/**
 * Ceiling on model round-trips in one agent turn. A model that will not stop calling tools
 * must not be able to spend without limit; 8 is enough for real work and bounded when
 * something goes wrong.
 *
 * Exported because the gateway path bounds its own loop with the same number. Those used to be
 * two separate `= 8` constants kept in step by a comment — the kind of duplication that survives
 * exactly until someone edits one of them.
 */
export const DEFAULT_MAX_ITERATIONS = 8;

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
  } = opts;

  // Conversation only — the system turn is prepended at each model call, never stored here.
  const messages: ChatMessage[] = [...opts.messages];

  const tools = registryToOpenAI(registry);

  let lastText = "";
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
      return { text, messages, truncated, hitCeiling: false };
    }

    // Replay the assistant turn with its tool_calls so the provider accepts the results.
    // The wire entries and the ids come from ONE decision (`toWireToolCalls`), so the results
    // appended below are guaranteed to name a call this turn actually declared — the pairing
    // providers check before accepting a continuation.
    const { wire, ids } = toWireToolCalls(collected);
    messages.push({ role: "assistant", content: text, tool_calls: wire });

    for (let i = 0; i < collected.length; i++) {
      const call = collected[i]!;
      if (signal?.aborted) throw new DOMException("Agent loop aborted", "AbortError");
      onEvent?.({ type: "tool_call", call });
      const name = call.name ?? "(unknown)";
      const args = parseArgs(call.arguments);

      let resultText: string;
      let ok = true;

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
      if (!allow) {
        resultText = denyReason;
        ok = false;
      } else {
        try {
          // `web_ask` never reaches the sandbox: it is answered HERE, by the same model, in a
          // side conversation — fetch the page (cache included) through the host, then ask the
          // question against the text. The 32 KB of page content stays out of the main
          // transcript, which is the whole point of the tool. The backend has no handler on
          // purpose: the gateway path has no aux-model mechanism, so the tool is
          // Assistant-only, and the sandbox would refuse the name if it ever saw it.
          if (name === "web_ask") {
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

      // `read_image` returns its payload under a marker: the tool message itself stays a short
      // text receipt, and the image rides as a real content part on a following user message —
      // the same wire shape chat attachments use. Without this, the base64 would flood the
      // transcript as text no model can see.
      const imageData = name === "read_image" && ok ? extractReadImage(resultText) : null;
      if (imageData) {
        const receipt = `image loaded: ${imageData.path} (${Math.round(imageData.bytes / 1024)} KB) — attached as an image part below`;
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

      messages.push({ role: "tool", content: resultText, tool_call_id: ids[i]! });
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
  const ceiling = maxIterations ?? 0;
  onEvent?.({ type: "done", text: lastText, iterations: ceiling, hitCeiling: true });
  return { text: lastText, messages, truncated: false, hitCeiling: true };
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
