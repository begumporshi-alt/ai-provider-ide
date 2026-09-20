/**
 * Tool-call wire normalisation (2026-09-20).
 *
 * The router reports tool calls in a dialect-neutral shape (`ToolCall`: flat
 * `{id?, name?, arguments?}` — see router-core/ports.ts). What goes on the wire is different
 * and stricter:
 *
 *   1. Each entry needs `type: "function"` and a nested `function: {name, arguments}`. A flat
 *      `{id, name, arguments}` is not the shape OpenAI-compatible servers accept.
 *   2. The *result* turn must carry a `tool_call_id` that matches a declared `tool_calls[].id`
 *      exactly. A result naming a call the assistant turn never declared is rejected — every
 *      OpenAI-compatible provider answers HTTP 400 — and the whole continuation dies with it.
 *
 * Two defects made rule 2 impossible to satisfy, and they are why "the router stops after a
 * tool call" was reported:
 *
 *   - The assistant turn and the tool result each applied their OWN fallback for a missing id:
 *     `""` in one place, the tool *name* in the other. When a provider omitted the id (or the
 *     manifest mapped none — `manifest-interpreter` emits `id: undefined` for exactly this
 *     case) the two values could never match.
 *   - Both turns were built flat, with no `type` and no nested `function`.
 *
 * Nothing required the two halves to agree because nothing built them together. The fix is to
 * build them together: `toWireToolCalls` returns the wire entries *and* the ids it chose, so
 * the assistant turn and the results are always derived from one decision.
 */
import type { ToolCall } from "@aiprovider/router-core";

/** One entry of an assistant turn's `tool_calls`, in OpenAI's wire shape. */
export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * Counter behind `synthesizedId`. Module-level, so ids stay unique across every turn in the
 * process — a value only has to be *consistent within one pair*, but a repeat across turns
 * would be a real ambiguity if a transcript were ever replayed wholesale.
 */
let seq = 0;

/** An id for a call the provider did not identify. The value is arbitrary; its stability is not. */
function synthesizedId(): string {
  seq += 1;
  return `call_${seq.toString(36)}`;
}

/**
 * Normalise a batch of calls into the wire shape, returning the ids alongside so the caller can
 * pair each result with the call it answers. Index-aligned with the input.
 */
export function toWireToolCalls(calls: ToolCall[]): { wire: WireToolCall[]; ids: string[] } {
  const wire: WireToolCall[] = [];
  const ids: string[] = [];
  for (const c of calls) {
    const id = typeof c.id === "string" && c.id ? c.id : synthesizedId();
    ids.push(id);
    wire.push({
      id,
      type: "function",
      // `arguments` is JSON text. An empty string is not valid JSON, so an absent value
      // becomes `{}` rather than "" — some servers parse it before dispatch.
      function: { name: c.name ?? "", arguments: c.arguments ?? "{}" },
    });
  }
  return { wire, ids };
}

/**
 * Read a call's name from either shape — the flat internal one or the OpenAI wire one.
 *
 * The context graph walks stored transcripts, which may hold either (an assistant turn written
 * before this module existed is flat; one written after is nested), so the reader is tolerant
 * rather than assuming the current writer.
 */
export function toolCallName(call: unknown): string {
  const o = call as { name?: unknown; function?: { name?: unknown } } | null | undefined;
  if (typeof o?.name === "string" && o.name) return o.name;
  if (typeof o?.function?.name === "string" && o.function.name) return o.function.name;
  return "tool";
}
