/**
 * Auto context compression (2026-09-23).
 *
 * A conversation eventually exceeds the model's window, and until now nothing trimmed it. The
 * gateway forwarded `messages` verbatim and the assistant replayed every prior turn, so a long
 * session failed at the provider with a context-length error — a failure that arrived as a
 * provider error rather than as anything this app could have prevented.
 *
 * This is Tier 1: **hard truncation**. It drops the oldest *complete turns* until the prompt
 * fits. Summarising instead of dropping (Tier 2) preserves more of the conversation, but costs
 * an extra model call on the request path, and the safety net is what is missing today.
 *
 * Both callers converge here deliberately. The gateway (external clients, arbitrary message
 * arrays) and the assistant (internal, history assembled from the transcript) both reach
 * `router.generateText`, so one implementation covers both and cannot drift — the same rule
 * this repo applies to every other cross-cutting switch.
 *
 * Three properties the drop order has to preserve:
 *
 *  - **System survives.** Leading `system` turns carry the client's instructions and, on the
 *    gateway, the injected memory block. Dropping those changes what the model is being asked
 *    to do, not merely how much history it can see.
 *  - **The newest turn survives.** It holds the question being asked right now. Dropping it to
 *    save tokens would answer a question the user did not ask.
 *  - **A tool call and its results move together.** A turn boundary only ever falls on a `user`
 *    message, so an assistant `tool_calls` turn and the `tool` results answering it always land
 *    in the same turn — and providers reject a result whose originating call was dropped.
 */
import type { ChatMessage } from "./ports.js";

/**
 * Fallback window when the catalog published none. Matches the host's `DEFAULT_WINDOW_TOKENS`
 * so both sides of the bridge plan against the same conservative number. Under-estimating is
 * the correct direction to fail: it costs some history, while over-estimating overflows.
 */
export const DEFAULT_CONTEXT_WINDOW = 8192;

/**
 * Rough characters per token. Deliberately crude — the estimate only has to be good enough to
 * decide *whether* to drop, and a request that lands 10% under the window is a success.
 */
export const CHARS_PER_TOKEN = 4;

/** Share of the window held back for the answer when the caller declared no `maxTokens`. */
export const RESERVE_FRACTION = 0.25;

/** Per-message overhead — role, delimiters, the turn wrapper. */
const MESSAGE_OVERHEAD_TOKENS = 4;

export interface CompressResult {
  messages: ChatMessage[];
  /** Messages removed. Zero when nothing needed dropping. */
  dropped: number;
  beforeTokens: number;
  afterTokens: number;
  budget: number;
  compressed: boolean;
}

/**
 * Text of one message, as an estimate-able string.
 *
 * ` ChatMessage.content` is typed `string`, but the gateway forwards a client's JSON verbatim
 * and multimodal requests send an *array* of content parts. Treating that as `""` would
 * estimate zero tokens for what is often the largest message in the request, so anything that
 * is not a string is measured by its serialised size instead.
 */
function contentText(m: ChatMessage): string {
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (c == null) return "";
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === "string") return p;
        const t = (p as { text?: unknown } | null)?.text;
        if (typeof t === "string") return t;
        try {
          return JSON.stringify(p ?? "");
        } catch {
          return "";
        }
      })
      .join(" ");
  }
  try {
    return JSON.stringify(c);
  } catch {
    return "";
  }
}

export function estimateMessageTokens(m: ChatMessage): number {
  return Math.ceil(contentText(m).length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;
}

export function estimateTokens(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += estimateMessageTokens(m);
  return n;
}

/**
 * Prompt-token budget: what the request may send, leaving room for the answer.
 *
 * A declared `maxTokens` is honoured over the fraction, because that is the reservation the
 * caller actually asked for. Floored at zero rather than allowed to go negative — a window
 * smaller than its own reserve is pathological, and a negative budget would make every
 * comparison below read as "fits".
 */
export function promptBudget(window: number, maxTokens?: number): number {
  const declared = typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 0;
  const reserve = declared > 0 ? declared : Math.floor(window * RESERVE_FRACTION);
  return Math.max(0, window - reserve);
}

/** Leading `system` turns, and everything after them. */
function splitSystem(messages: readonly ChatMessage[]): [ChatMessage[], ChatMessage[]] {
  let i = 0;
  while (i < messages.length && messages[i]!.role === "system") i += 1;
  return [messages.slice(0, i), messages.slice(i)];
}

/**
 * Group the non-system messages into turns. A new turn begins at every `user` message;
 * anything else joins the turn already open.
 *
 * That single rule is what keeps tool calls paired with their results: a `tool` message never
 * starts a turn, so it always lands in the same turn as the assistant message whose
 * `tool_calls` it answers.
 */
function toTurns(rest: readonly ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  for (const m of rest) {
    if (m.role === "user" || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1]!.push(m);
  }
  return turns;
}

/**
 * Drop the oldest whole turns until the prompt fits `budgetTokens`.
 *
 * Returns the input unchanged when it already fits, when it is empty, or when it is nothing
 * but system turns — in that last case there is no turn to drop, and a system-only request is
 * worse than an over-budget one.
 */
export function compressMessages(
  messages: readonly ChatMessage[],
  budgetTokens: number,
): CompressResult {
  const beforeTokens = estimateTokens(messages);
  const unchanged = (): CompressResult => ({
    messages: [...messages],
    dropped: 0,
    beforeTokens,
    afterTokens: beforeTokens,
    budget: budgetTokens,
    compressed: false,
  });

  if (messages.length === 0 || beforeTokens <= budgetTokens) return unchanged();

  const [systemPrefix, rest] = splitSystem(messages);
  if (rest.length === 0) return unchanged();

  const turns = toTurns(rest);
  const turnTokens = turns.map((t) => estimateTokens(t));
  let total = estimateTokens(systemPrefix) + turnTokens.reduce((a, b) => a + b, 0);
  let start = 0;
  // The bound is `turns.length - 1`: the newest turn survives even when it alone exceeds the
  // budget, because it carries the question being asked. Everything older is expendable.
  while (start < turns.length - 1 && total > budgetTokens) {
    total -= turnTokens[start]!;
    start += 1;
  }

  const kept: ChatMessage[] = [...systemPrefix, ...turns.slice(start).flat()];
  return {
    messages: kept,
    dropped: messages.length - kept.length,
    beforeTokens,
    afterTokens: estimateTokens(kept),
    budget: budgetTokens,
    compressed: kept.length < messages.length,
  };
}
