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
import { VERIFICATION_DEMAND } from "../../tools/agentLoop";
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

  it("the verification nudge drops the claim's prose and announces the demand", () => {
    const segments = fold([
      call("write_file"),
      result("write_file", "written"),
      assistant("Done — it is fixed."),
      { type: "verification_nudge" },
      call("run_command", '{"command":"npm test"}'),
      result("run_command", "3 passed"),
      assistant("The tests pass."),
    ]);
    const text = segments.filter((s) => s.kind === "text").map((s) => s.text).join("");
    expect(text).toContain("demanding a check");
    expect(text).toContain("The tests pass.");
    // The claim's prose does not stay in the live stream: kept, it would let the next round's
    // answer stream into the same segment and read as one sentence the model never said. The
    // persisted transcript carries the claim as its own message, ahead of the demand.
    expect(text, "the claim is not glued to the answer").not.toContain("Done — it is fixed.The tests pass.");
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

  it("does not read a turn boundary off the loop's own verification demand", () => {
    // The gate pushes its demand as a user turn *mid*-run, between the claim it refused and the
    // round that answers it. Taking the boundary from the last user turn would put the edit round
    // and the refused claim in the history prefix, so both rounds' thinking would go unconsumed and
    // land together on the final answer — one panel where the transcript shows two.
    const msgs: Msg[] = [
      msg("user", "edit the readme greeting"),
      msg("assistant", "", [{ id: "c1" }]),
      msg("tool", "edited"),
      msg("assistant", "Done."),
      msg("user", VERIFICATION_DEMAND),
      msg("assistant", "There is nothing to check here."),
    ];
    const timeline = fold([
      reasoning("Round one thinking."),
      call("edit_file"),
      reasoning("Round two thinking."),
      assistant("Done."),
    ]);

    const out = attachReasoning(msgs, timeline);
    expect(out[1]!.reasoning).toBe("Round one thinking.");
    expect(out[3]!.reasoning, "the refused claim keeps its own round's thinking").toBe(
      "Round two thinking.",
    );
    expect(out[5]!.reasoning, "the demand round is not given thinking it never produced").toBeUndefined();
  });

  it("returns the same array when there is nothing to attach", () => {
    const msgs: Msg[] = [msg("user", "hi"), msg("assistant", "hello")];
    expect(attachReasoning(msgs, [])).toBe(msgs);
    expect(attachReasoning(msgs, fold([assistant("hello")]))).toBe(msgs);
  });
});

describe("subagent progress", () => {
  const delegate = (id = "c1"): AgentEvent => ({
    type: "tool_call",
    call: { id, name: "dispatch_agent", arguments: '{"task":"t"}' },
  });
  const progress = (callId: string, state: "queued" | "running" | "done" | "failed", calls = 0): AgentEvent => ({
    type: "subagent_progress",
    callId,
    children: [{ label: "research", state, toolCalls: calls, ...(calls > 0 ? { lastTool: "read_file" } : {}) }],
  });

  it("folds a snapshot onto the delegating row by call id, leaving it calling", () => {
    const segs = fold([delegate(), progress("c1", "running", 2)]);
    const tool = toolSegments(segs)[0]!;
    expect(tool.status).toBe("calling");
    expect(tool.children).toEqual([
      { label: "research", state: "running", toolCalls: 2, lastTool: "read_file" },
    ]);
  });

  it("matches a delegation row with no call id by position, since only a calling delegation can be the target", () => {
    const noId: AgentEvent = { type: "tool_call", call: { name: "dispatch_agent", arguments: "{}" } };
    const segs = fold([noId, progress("", "queued")]);
    expect(toolSegments(segs)[0]!.children).toEqual([
      { label: "research", state: "queued", toolCalls: 0 },
    ]);
  });

  it("drops a snapshot whose row is resolved or absent, so a late event cannot resurrect a state", () => {
    const events = [delegate(), result("dispatch_agent", "SUB ANSWER")];
    const base = fold(events);
    expect(fold([...events, progress("c1", "done")])).toEqual(base);
    expect(fold([progress("zz", "running")])).toEqual([]);
  });
});
