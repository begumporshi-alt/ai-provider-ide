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

/** Upper bound when the ceiling is user-set. Not a security control — the loop is bounded
 *  either way — but a value of 5000 would just be a slow way to burn tokens. */
export const MAX_ITERATIONS_CAP = 50;

/** Clamp a user-supplied ceiling into `[1, MAX_ITERATIONS_CAP]`. Non-finite and non-numeric
 *  input falls back to the default rather than to 1: a corrupted setting should degrade to the
 *  value that works, not to a loop that gives up immediately. */
export function clampIterations(value: unknown): number {
  // Numbers and numeric strings only. A blanket `Number(value)` would coerce `null`, `[]` and
  // `true` into 0, 0 and 1 — a JSON blob that lost its field would then read as "run one step",
  // which is indistinguishable from a broken agent rather than a missing setting.
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return DEFAULT_MAX_ITERATIONS;
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
    maxIterations = DEFAULT_MAX_ITERATIONS,
    confirm,
    onEvent,
    signal,
  } = opts;

  // Conversation only — the system turn is prepended at each model call, never stored here.
  const messages: ChatMessage[] = [...opts.messages];

  const tools = registryToOpenAI(registry);

  let lastText = "";

  for (let iter = 1; iter <= maxIterations; iter++) {
    if (signal?.aborted) throw new DOMException("Agent loop aborted", "AbortError");

    const collected: ToolCall[] = [];
    let text = "";
    const stream = await generate(
      {
        model,
        messages: opts.system ? [{ role: "system" as const, content: opts.system }, ...messages] : messages,
        tools,
        toolChoice: tools ? "auto" : undefined,
        onToolCall: (call) => {
          collected.push(call);
        },
        onFinish: opts.onFinish,
      },
      { signal },
    );

    for await (const chunk of stream.chunks) {
      if (signal?.aborted) break;
      text += chunk;
      onEvent?.({ type: "assistant", text: chunk });
    }
    lastText = text;

    // Terminal turn: the model produced a final answer with no tool calls.
    if (collected.length === 0) {
      onEvent?.({ type: "done", text, iterations: iter });
      return { text, messages };
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
            // `call.id` and the run's signal travel together: the id lets the sandbox register a
            // long `run_command` for cancellation, and the signal is what fires the cancel when
            // the user hits Stop mid-tool. Without both, Stop could only take effect at the next
            // tool boundary — which for a 60-second command is exactly the "stop doesn't work"
            // complaint this path exists to answer.
            const r = await host.run(name, args, { callId: call.id, signal });
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
  }

  // Hit the iteration ceiling: hand back the last answer rather than spinning forever.
  onEvent?.({ type: "done", text: lastText, iterations: maxIterations });
  return { text: lastText, messages };
}

/** The marker `read_image` writes: `READ_IMAGE:<media>;base64,<payload>` then `path:`/`bytes:` lines. */
function extractReadImage(resultText: string): { mediaType: string; base64: string; path: string; bytes: number } | null {
  const marker = resultText.match(/^READ_IMAGE:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)/);
  if (!marker) return null;
  const path = resultText.match(/^path: (.+)$/m)?.[1] ?? "(unknown)";
  const bytes = Number(resultText.match(/^bytes: (\d+)$/m)?.[1] ?? 0);
  return { mediaType: marker[1], base64: marker[2], path, bytes };
}
