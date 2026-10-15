import { expect, it } from "vitest";

import { describeRequest, isShapeRefusal, refusalShape } from "../src/request-shape.js";

const describe_ = (v: Record<string, unknown>) => describeRequest(v, 1234);

/**
 * **The D109 shape, and the line that would have named it.** Two calls in one assistant turn, an
 * image message wedged between their results — the second `tool_result` is one message too late,
 * which is exactly what `agentrouter.org` refused:
 *
 * ```text
 * messages.1:`tool_use` ids were found without `tool_result` blocks immediately after: call_2.
 * ```
 *
 * The expectation is the *specific id*, not "something is wrong": a report that flags the wrong turn
 * is worse than none, because it sends the next reader to the wrong place.
 */
it("the_d109_split_shape_names_the_unanswered_id", () => {
  const out = describe_({
    model: "m",
    messages: [
      { role: "user", content: "load it" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "read_image", input: {} },
          { type: "tool_use", id: "call_2", name: "run_command", input: {} },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "loaded" }],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "[image]" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_2", content: "done" }],
      },
    ],
  });
  expect(out).toContain('UNANSWERED_TOOL_USE=["call_2@m1"]');
  // `call_1` was answered in the next message, so it must not be named.
  expect(out).not.toContain("call_1@");
  expect(out).not.toContain("shape=clean");
});

/**
 * The same turn with both results together — the arrangement the fix produces, and the one the
 * upstream answers `200`. It must come back clean, or the report is unusable as a signal.
 */
it("the_corrected_ordering_is_reported_clean", () => {
  const out = describe_({
    model: "m",
    messages: [
      { role: "user", content: "load it" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "read_image", input: {} },
          { type: "tool_use", id: "call_2", name: "run_command", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "loaded" },
          { type: "tool_result", tool_use_id: "call_2", content: "done" },
        ],
      },
    ],
  });
  expect(out).toContain("shape=clean");
});

/**
 * **An OpenAI-shaped body must not be accused by the array rule.** Its tool results ride on
 * `role:"tool"` messages, so the array check would find every turn unanswered. A diagnostic that
 * fires on valid traffic is one that gets filtered out of the log and stops being read.
 */
it("an_openai_shaped_body_is_judged_by_its_own_rule", () => {
  const out = describe_({
    model: "m",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }],
      },
      { role: "tool", content: "a.txt", tool_call_id: "call_1" },
    ],
  });
  expect(out).not.toContain("UNANSWERED");

  // …and the same shape with the result missing *is* caught.
  const missing = describe_({
    model: "m",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }],
      },
      { role: "user", content: "and now?" },
    ],
  });
  expect(missing).toContain('UNANSWERED_TOOL_USE=["call_1@m1"]');
});

it("an_orphan_result_a_duplicate_id_and_an_undeclared_tool_are_each_named", () => {
  const orphan = describe_({
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_ghost", content: "x" }] },
    ],
  });
  expect(orphan).toContain('ORPHAN_TOOL_RESULT=["call_ghost@m0"]');

  const dupe = describe_({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "ls", input: {} },
          { type: "tool_use", id: "call_1", name: "ls", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] },
    ],
  });
  expect(dupe).toContain('DUPLICATE_TOOL_USE_ID=["call_1"]');

  const undeclared = describe_({
    tools: [{ name: "ls", input_schema: { type: "object" } }],
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "rm_rf", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "x" }] },
    ],
  });
  expect(undeclared).toContain('UNDECLARED_TOOL=["rm_rf@m0"]');
});

it("empty_content_empty_text_and_unknown_parts_are_counted_not_ignored", () => {
  const out = describe_({
    messages: [
      { role: "assistant", content: "" },
      { role: "assistant", content: [] },
      { role: "assistant", content: [{ type: "text", text: "" }, { type: "video", source: {} }] },
    ],
  });
  expect(out).toContain('empty_content=["m0", "m1"]');
  expect(out).toContain("empty_text_parts=1");
  expect(out).toContain('unknown_parts=["video@m2"]');
  // None of these makes the body invalid on its own, so the line must not claim it is.
  expect(out).not.toContain("UNANSWERED");
});

/** A body with no `messages` at all still has to describe itself rather than panic or lie. */
it("a_body_without_messages_says_so", () => {
  expect(describe_({ model: "m" })).toBe("request 1234B messages=absent");
});

/**
 * The line stays one line however many ids there are: a log entry that runs for a page is not read,
 * and the count is what matters once the first few are named.
 */
it("a_long_id_list_is_capped_and_counted", () => {
  const calls = Array.from({ length: 9 }, (_, i) => ({
    type: "tool_use",
    id: `call_${i}`,
    name: "ls",
    input: {},
  }));
  const out = describe_({ messages: [{ role: "assistant", content: calls }] });
  expect(out).toContain("+4more");
  expect(out).not.toContain("call_8");
});

/**
 * The gate, stated: a schema refusal is reported, and a status about the key, the balance, the route
 * or the pace is not. `500` is in the first set because that is the status this was built for — an
 * aggregator reporting a body refusal past its own edge.
 */
it("only_a_shape_refusal_is_described", () => {
  for (const s of [400, 422, 500, 502, 503, 529]) expect(isShapeRefusal(s)).toBe(true);
  for (const s of [200, 401, 402, 403, 404, 409, 413, 429]) expect(isShapeRefusal(s)).toBe(false);

  const body = { messages: [{ role: "user", content: "hi" }] };
  expect(refusalShape(500, body, 10)).toContain("messages=1");
  expect(refusalShape(429, body, 10)).toBeUndefined();
});
