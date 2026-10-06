/**
 * Unit tests for the agent turn's timeline — the ordering rules, with no DOM, no loop and no
 * model. The two things pinned here are the two things the code exists for:
 *
 *  1. `applyAgentEvent` keeps arrival order: thinking and prose accumulate into their own trailing
 *     segment, a call opens a tool segment, a result fills the last one still calling.
 *  2. `attachReasoning` lands round k's deliberation on round k's message — anchored on tool
 *     batches, so a round that called a tool *without* thinking does not shift every later round's
 *     thinking onto the wrong message.
 */
import { describe, expect, it } from "vitest";
import { applyAgentEvent, attachReasoning, toolSegments, type TimelineSegment } from "./timeline";
import type { AgentEvent } from "../../tools/types";
import type { Msg } from "./messages";

const reasoning = (text: string): AgentEvent => ({ type: "reasoning", text });
const assistant = (text: string): AgentEvent => ({ type: "assistant", text });
const call = (name: string, args = "{}"): AgentEvent => ({
  type: "tool_call",
  call: { id: `c-${name}`, name, arguments: args },
});
const result = (name: string, output = "ok", ok = true): AgentEvent => ({
  type: "tool_result",
  call: { id: `c-${name}`, name, arguments: "{}" },
  result: output,
  ok,
});

/** Fold a whole scripted run, the way the screen does event by event. */
function fold(events: AgentEvent[]): TimelineSegment[] {
  return events.reduce<TimelineSegment[]>((segs, ev) => applyAgentEvent(segs, ev), []);
}

describe("applyAgentEvent", () => {
  it("keeps thinking, prose and calls in the order they arrived", () => {
    const segments = fold([
      reasoning("Let me look. "),
      reasoning("First the config."),
      assistant("Reading the config now."),
      call("read_file", '{"path":"a.toml"}'),
      result("read_file", "port = 8080"),
      reasoning("Now I know the port."),
      call("edit_file", '{"path":"a.toml"}'),
      result("edit_file", "written"),
      assistant("Done."),
    ]);

    expect(segments.map((s) => s.kind)).toEqual([
      "thinking",
      "text",
      "tool",
      "thinking",
      "tool",
      "text",
    ]);
    // Deltas accumulate into one segment, not one per token.
    expect(segments[0]).toEqual({ kind: "thinking", text: "Let me look. First the config." });
  });

  it("fills the last call still running, and marks a refusal denied", () => {
    const segments = fold([
      call("run_command"),
      call("read_file"),
      result("read_file", "contents"),
      result("run_command", "refused: plan mode", false),
    ]);
    const tools = toolSegments(segments);
    expect(tools.map((t) => [t.name, t.status])).toEqual([
      ["run_command", "denied"],
      ["read_file", "ok"],
    ]);
    expect(tools[1]!.result).toBe("contents");
  });

  it("parses a call's arguments once, tolerantly", () => {
    const segments = fold([call("read_file", '{"path":"a.toml"}'), call("grep", "not json")]);
    const tools = toolSegments(segments);
    expect(tools[0]!.args).toEqual({ path: "a.toml" });
    expect(tools[1]!.args).toEqual({});
  });

  it("drops an abandoned attempt's prose on a truncation retry, and keeps the notice as its prefix", () => {
    const segments = fold([
      reasoning("thinking"),
      assistant("The answer so far is"),
      { type: "truncation_retry", attempt: 1 },
      assistant("The answer, complete."),
    ]);
    const text = segments.filter((s) => s.kind === "text").map((s) => s.text).join("");
    expect(text).toContain("re-asking");
    expect(text).toContain("The answer, complete.");
    expect(text, "the abandoned prose is gone").not.toContain("The answer so far is");
  });
});

describe("attachReasoning", () => {
  const msg = (role: Msg["role"], content: string, toolCalls?: unknown): Msg => ({
    id: `${role}-${content.slice(0, 8)}`,
    role,
    content,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
  });

  it("counts each round's calls, so a round that skipped thinking does not shift the next one", () => {
    const msgs: Msg[] = [
      msg("user", "do the thing"),
      msg("assistant", "Let me check.", [{ id: "c1" }]),
      msg("tool", "file contents"),
      // A round that acted without deliberating (two calls, one batch): nothing to attribute, and
      // a counting implementation would hand it the *next* round's thinking.
      msg("assistant", "", [{ id: "c2" }]),
      msg("tool", "edited"),
      msg("assistant", "All done."),
    ];
    const timeline = fold([
      reasoning("Round one thinking."),
      call("read_file"),
      call("edit_file"),
      reasoning("Round three thinking."),
      assistant("All done."),
    ]);

    const out = attachReasoning(msgs, timeline);
    expect(out[1]!.reasoning).toBe("Round one thinking.");
    expect(out[3]!.reasoning, "the round that skipped thinking stays clean").toBeUndefined();
    expect(out[5]!.reasoning, "the trailing thinking lands on the closing message").toBe(
      "Round three thinking.",
    );
    expect(out[0]!.reasoning, "the user turn is untouched").toBeUndefined();
  });

  it("leaves messages before the turn alone, so an earlier agent run is not re-attributed", () => {
    const msgs: Msg[] = [
      msg("user", "first question"),
      msg("assistant", "", [{ id: "old" }]),
      msg("tool", "old result"),
      msg("assistant", "first answer"),
      msg("user", "second question"),
      msg("assistant", "", [{ id: "new" }]),
      msg("tool", "new result"),
      msg("assistant", "second answer"),
    ];
    const timeline = fold([reasoning("Second turn thinking."), assistant("second answer")]);

    const out = attachReasoning(msgs, timeline);
    expect(out[1]!.reasoning, "history keeps whatever it had").toBeUndefined();
    expect(out[5]!.reasoning).toBe("Second turn thinking.");
    expect(out[7]!.reasoning, "the closing message takes the trailing thinking").toBeUndefined();
  });

  it("returns the same array when there is nothing to attach", () => {
    const msgs: Msg[] = [msg("user", "hi"), msg("assistant", "hello")];
    expect(attachReasoning(msgs, [])).toBe(msgs);
    expect(attachReasoning(msgs, fold([assistant("hello")]))).toBe(msgs);
  });
});
