/**
 * The agent turn's timeline — thinking, prose and tool calls as one ordered list.
 *
 * # Why this exists
 *
 * An agent turn is several model round-trips, and each one can deliberate before it acts. The
 * transcript used to throw that order away: reasoning was accumulated into one blob shown above
 * everything, tool calls into one list below it, so a run that thought → read a file → thought →
 * edited it rendered as "all the thinking, then all the tools" — an order the model never
 * produced. Measured 2026-10-06 against the ZCode client, where the same turn reads as
 * `Thinking → tool → Thinking → tool`, and the user asked for that shape.
 *
 * # The two halves
 *
 * **Live** (`applyAgentEvent`): the loop's events, folded into segments as they arrive. This is
 * what the running turn renders.
 *
 * **After the turn** (`attachReasoning`): the persisted transcript is the loop's own messages —
 * one assistant message per round-trip, each followed by its tool results (`agentLoop` pushes
 * them that way) — and the transcript already renders each assistant message in the order
 * `reasoning → content → its tool calls`. So the interleave falls out of the existing renderer
 * *if the reasoning lands on the right messages*, and that attribution is the whole job of this
 * function: round k's deliberation belongs to round k's message.
 *
 * # What is deliberately not here
 *
 * The tool results. A result belongs to its call, the transcript pairs them by call id
 * (`indexToolCalls`), and duplicating that pairing would give two answers to one question.
 */
import { VERIFICATION_DEMAND } from "../../tools/agentLoop";
import type { AgentEvent, SubagentChildProgress } from "../../tools/types";
import { tryParseArgs } from "./graph-record";
import type { Msg } from "./messages";

/** The states one tool call moves through, in the order it moves through them. */
export type ToolStatus = "calling" | "ok" | "error" | "denied";

/**
 * One segment of a turn, in the order the model produced it.
 *
 * `text` and `thinking` are separate kinds even though both are prose, because they are read
 * differently: thinking is the model's notes and folds away, text is something it said and does
 * not. Merging them would make the transcript quote a model's private deliberation as its answer.
 */
export type TimelineSegment =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      name: string;
      args: Record<string, unknown>;
      status: ToolStatus;
      result?: string;
      /** The call's id, when the wire carried one — how a `subagent_progress` event finds its row. */
      callId?: string;
      /** Live delegation progress for a `dispatch_agent` / `fan_out` row, last snapshot wins. */
      children?: SubagentChildProgress[];
    };

/**
 * The tool calls of a timeline, in order — what the status line and the row list both read.
 *
 * Named `ToolCallSegment` rather than `ToolSegment` because that name is taken: `assistant-stream`
 * exports a `ToolSegment` for the *in-band* call a model writes into its prose, which is a
 * different thing (model output, never executed) from a call this loop actually ran.
 */
export type ToolCallSegment = Extract<TimelineSegment, { kind: "tool" }>;

export function toolSegments(segments: readonly TimelineSegment[]): ToolCallSegment[] {
  return segments.filter((s): s is ToolCallSegment => s.kind === "tool");
}

/** Append to the trailing segment of the same kind, or start a new one. Prose arrives as deltas,
 *  so this is what keeps a streamed sentence one segment rather than one segment per token. */
function appendProse(
  segments: TimelineSegment[],
  kind: "thinking" | "text",
  text: string,
): TimelineSegment[] {
  const last = segments[segments.length - 1];
  if (last && last.kind === kind) {
    return [...segments.slice(0, -1), { kind, text: last.text + text }];
  }
  return [...segments, { kind, text }];
}

/**
 * Fold one loop event into the timeline. Pure, so the ordering rules are unit-testable without a
 * loop, a model, or a DOM.
 */
export function applyAgentEvent(segments: TimelineSegment[], ev: AgentEvent): TimelineSegment[] {
  switch (ev.type) {
    case "assistant":
      return appendProse(segments, "text", ev.text);
    case "reasoning":
      return appendProse(segments, "thinking", ev.text);
    case "tool_call":
      return [
        ...segments,
        {
          kind: "tool",
          name: ev.call.name ?? "?",
          args: tryParseArgs(ev.call.arguments),
          status: "calling",
          ...(ev.call.id ? { callId: ev.call.id } : {}),
        },
      ];
    case "tool_result": {
      const next = [...segments];
      // Match the call the result names. Calls in one batch run concurrently, so the last
      // segment still `calling` is often a different call than the one that just finished.
      let index = -1;
      if (ev.call.id) {
        for (let i = next.length - 1; i >= 0; i--) {
          const seg = next[i]!;
          if (seg.kind === "tool" && seg.status === "calling" && seg.callId === ev.call.id) {
            index = i;
            break;
          }
        }
      }
      if (index < 0) {
        for (let i = next.length - 1; i >= 0; i--) {
          const seg = next[i]!;
          if (seg.kind === "tool" && seg.status === "calling") {
            index = i;
            break;
          }
        }
      }
      if (index >= 0) {
        const seg = next[index]!;
        if (seg.kind === "tool") {
          next[index] = {
            ...seg,
            status: /denied|refused/i.test(ev.result) ? "denied" : ev.ok ? "ok" : "error",
            result: ev.result,
          };
        }
      }
      return next;
    }
    case "subagent_progress":
      return foldSubagentProgress(segments, ev.callId, ev.children);
    case "truncation_retry":
      // The abandoned attempt's prose is dropped, not concatenated: the retry's text is the answer
      // being built, and two attempts joined would read as one sentence the model never said. The
      // notice stays as the prefix until the retry's own text appends after it.
      return appendProse(dropTrailingText(segments), "text", "⏳ the model's stream ended early — re-asking…\n\n");
    case "no_output_retry":
      // No prose to drop: the attempt being retried is the one that answered with nothing.
      return appendProse(segments, "text", "⏳ the model answered with thinking only — re-asking with thinking off…\n\n");
    case "verification_nudge":
      // The claim's own prose is dropped from the live view the way an abandoned attempt's is:
      // the claim is not abandoned (it is on the transcript as its own message, followed by the
      // demand), but keeping it here would let the next round's text stream INTO the same
      // segment and read as one sentence the model never said. The end-of-turn transcript
      // replace redraws it in its rightful place.
      return appendProse(
        dropTrailingText(segments),
        "text",
        "⚠ the answer claimed the work is done, but nothing this turn verified it — the loop is demanding a check before the claim stands…\n\n",
      );
    case "done":
      return segments;
  }
}

/** Everything after the last tool call or thought was this attempt's prose, and prose from an
 *  abandoned attempt is not part of the record. */
function dropTrailingText(segments: TimelineSegment[]): TimelineSegment[] {
  let end = segments.length;
  while (end > 0 && segments[end - 1]!.kind === "text") end -= 1;
  return end === segments.length ? segments : segments.slice(0, end);
}

/**
 * Attach a delegation snapshot to its `dispatch_agent` / `fan_out` row.
 *
 * Rows match by call id when the wire carried one. A call without an id — a hand-built `ToolCall`
 * in a test or a dialect that omits it — matches the most recent *calling* delegation row instead:
 * the event can only arrive while that row is in flight, and two delegations cannot share the
 * fallback because concurrent calls in one batch each carry their own id. No match, no change —
 * a stale snapshot for a row already resolved is dropped, not resurrected.
 */
function foldSubagentProgress(
  segments: TimelineSegment[],
  callId: string,
  children: SubagentChildProgress[],
): TimelineSegment[] {
  let target = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!;
    if (seg.kind !== "tool" || seg.status !== "calling") continue;
    if (!/^(dispatch_agent|fan_out)$/.test(seg.name)) continue;
    if (callId && seg.callId && seg.callId !== callId) continue;
    target = i;
    break;
  }
  if (target === -1) return segments;
  const seg = segments[target]!;
  if (seg.kind !== "tool") return segments;
  const next = [...segments];
  next[target] = { ...seg, children };
  return next;
}

/**
 * Attribute each round-trip's deliberation to its message, so the persisted transcript renders
 * `Thinking → tools → Thinking → tools → answer` the way the live turn did.
 *
 * **The walk counts calls, and that is the load-bearing decision.** Every executed call appears in
 * the timeline exactly once and in order, and the loop writes one assistant message per round-trip
 * carrying exactly that round's calls — so a message's calls *are* the next N tool segments, N
 * being how many its own `tool_calls` declare. Consuming by count rather than by adjacency is what
 * keeps two thinking-free rounds apart: with four calls in a row from two rounds that never
 * reasoned, an adjacency walk would have merged them into one batch and handed the next round's
 * deliberation to the wrong message (the unit test
 * `counts each round's calls, so a round that skipped thinking does not shift the next one`
 * pins exactly that).
 *
 * Only the current turn's messages are touched: everything from the last user turn onward. The
 * history prefix is left exactly as it was.
 */
export function attachReasoning(msgs: Msg[], timeline: readonly TimelineSegment[]): Msg[] {
  if (timeline.length === 0) return msgs;
  // The turn's own messages start after its user turn — the loop's transcript always carries that
  // turn, and history messages (including earlier agent turns' tool calls) must not consume
  // segments that belong to this one.
  let start = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "user") continue;
    // The loop's own verification demand rides the wire as a user turn, but it is not a turn
    // boundary — the gate pushes it *mid*-turn, between the claim it refused and the round that
    // answers it. Taking it as the start would place every earlier round in the history prefix this
    // walk deliberately leaves alone, and those are precisely the rounds whose deliberation it
    // exists to attribute: their thinking would pile up unconsumed and land in one panel on the
    // final answer, which is the blob this function was written to prevent.
    if (m.content.startsWith(VERIFICATION_DEMAND)) continue;
    start = i + 1;
    break;
  }

  let cursor = 0;
  let touched = false;
  const out = msgs.map((m, i) => {
    if (i < start || m.role !== "assistant") return m;
    const calls = callCount(m.tool_calls);
    // This message's work begins at the next unconsumed call. Thinking before that point is this
    // round's deliberation; thinking at or after it belongs to a later round, or to the answer.
    let first = timeline.length;
    if (calls > 0) {
      for (let k = cursor; k < timeline.length; k++) {
        if (timeline[k]!.kind === "tool") {
          first = k;
          break;
        }
      }
    }
    let reasoning = "";
    for (let k = cursor; k < first; k++) {
      const seg = timeline[k]!;
      if (seg.kind === "thinking") reasoning += seg.text;
    }
    if (calls === 0) {
      // The closing message (or a step with no calls): it takes everything that is left.
      cursor = first;
    } else {
      // Consume exactly this round's calls, whatever it declared — the timeline is the record of
      // what ran, and a retry that produced fewer calls than the message claims must not eat the
      // next round's segments.
      let consumed = 0;
      let k = first;
      while (k < timeline.length && consumed < calls) {
        if (timeline[k]!.kind === "tool") consumed += 1;
        k += 1;
      }
      cursor = k;
    }
    if (!reasoning) return m;
    touched = true;
    return { ...m, reasoning };
  });
  return touched ? out : msgs;
}

/** How many calls a stored assistant turn declares. `tool_calls` is `unknown` on `Msg` because a
 *  resumed transcript may hold either wire shape; only the count is read, and only from entries
 *  that look like calls at all. */
function callCount(toolCalls: unknown): number {
  return Array.isArray(toolCalls) ? toolCalls.length : 0;
}
