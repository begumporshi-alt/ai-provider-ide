/**
 * What one agent turn wrote into the context graph, extracted from the Assistant screen
 * (turn-engine phase 1). Pure shaping against the Recorder interface — no I/O of its own.
 */
import type { ChatMessage, ToolCall } from "@aiprovider/router-core";
import type { Recorder } from "../../context/recorder";
import { toolCallName } from "../../tools/wire";

/** Graph labels are identifiers, not content — a 400-character node is unreadable on canvas. */
export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function tryParseArgs(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Record what one agent turn produced: each message after the user's, and for every tool call a
 * skill node plus the artifact its result produced.
 *
 * A tool result is recorded as an artifact because that is what it is to the model — context it
 * was handed, not something it said. That distinction is the whole reason the graph has two node
 * kinds instead of one.
 *
 * `userNode` and `produced` are both supplied by the caller, and both matter:
 *
 *   - `userNode` is the id of the node the caller already created for this turn's prompt. The
 *     caller needs that node before the run starts (recall edges anchor to it), so creating a
 *     second one here would put the same prompt in the graph twice.
 *   - `produced` is only what THIS turn added. `runAgentLoop` seeds its working copy from the
 *     replayed history and hands the whole transcript back, so passing that verbatim would
 *     re-record every earlier turn as brand-new nodes on every turn.
 */
export function recordAgentTurn(rec: Recorder, userNode: string, produced: ChatMessage[], model: string): string {
  let prev: string = userNode;
  const skillByCall = new Map<string, string>();

  for (const m of produced) {
    const content = typeof m.content === "string" ? m.content : "";
    if (m.role === "tool") {
      // `text` carries the full result beside the clipped label: the timeline (and therefore
      // resume) rebuilds content from it, and an 80-character label would truncate every tool
      // result a resumed session replays.
      const artifact = rec.node("artifact", clip(content, 80), { tool_call_id: m.tool_call_id, text: content });
      const skill = m.tool_call_id ? skillByCall.get(m.tool_call_id) : undefined;
      rec.edge(skill ?? prev, artifact, "produced");
      continue;
    }
    // `tool_calls` is `unknown` in the core's message type: the wire shape varies by dialect
    // and the core does not commit to one. A stored transcript may hold either the flat internal
    // shape or OpenAI's nested one (the agent loop writes the latter), so the name is read
    // tolerantly rather than assuming whichever shape the current writer produces.
    const calls = (m.tool_calls as ToolCall[] | undefined) ?? [];
    const node = rec.node("message", clip(content, 120), {
      role: m.role,
      model,
      // Full text beside the clipped label — the label is for the graph canvas, `text` is what
      // a resume rebuilds the conversation from.
      text: content,
      tool_calls: calls.length ? calls : undefined,
    });
    rec.edge(prev, node, "follows");
    for (const c of calls) {
      const skill = rec.node("skill", toolCallName(c));
      rec.edge(node, skill, "used");
      if (c.id) skillByCall.set(c.id, skill);
    }
    prev = node;
  }
  return prev;
}
