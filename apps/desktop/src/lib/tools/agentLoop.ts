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
import type { ChatMessage, ToolCall } from "@aiprovider/router";
import { registryToOpenAI } from "./registry";
import type { AgentLoopOptions } from "./types";

const DEFAULT_MAX_ITERATIONS = 8;

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
    messages.push({ role: "assistant", content: text, tool_calls: collected });

    for (const call of collected) {
      if (signal?.aborted) throw new DOMException("Agent loop aborted", "AbortError");
      onEvent?.({ type: "tool_call", call });
      const name = call.name ?? "(unknown)";
      const args = parseArgs(call.arguments);

      let resultText: string;
      let ok = true;

      let allow = true;
      if (confirm) allow = await confirm(call, args);
      if (!allow) {
        resultText = `Tool call "${name}" was denied by the user.`;
        ok = false;
      } else {
        try {
          const r = await host.run(name, args);
          resultText = r.output;
          ok = r.ok;
        } catch (e) {
          resultText = `Tool execution error: ${e instanceof Error ? e.message : String(e)}`;
          ok = false;
        }
      }

      onEvent?.({ type: "tool_result", call, result: resultText, ok });
      messages.push({ role: "tool", content: resultText, tool_call_id: call.id ?? name });
    }
  }

  // Hit the iteration ceiling: hand back the last answer rather than spinning forever.
  onEvent?.({ type: "done", text: lastText, iterations: maxIterations });
  return { text: lastText, messages };
}
