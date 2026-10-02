/**
 * The evidence a drained `PARSE_ERROR` row is made of.
 *
 * The payloads below are not invented — they were captured from `agentrouter.org` on 2026-10-02
 * while diagnosing an "agent is not replying" report, and they are the reason this module exists.
 * The ledger said:
 *
 *   stream carried 8198 SSE event(s), none matched the manifest's delta selector;
 *   first: {"type":"message_start","content_block":null,"delta":null,"error":null,"index":0…
 *
 * The manifest was correct, `chunkMap.delta` was `$.delta.text`, and the stream was a well-formed
 * Anthropic sequence whose only deltas were `thinking_delta`. So the row blamed the wrong file and
 * quoted a lifecycle event that appears in every Anthropic stream — a sample that cannot distinguish
 * one stream from another. The first test pins the fix for both halves.
 */
import { expect, test } from "vitest";
import {
  classifyDelta,
  describeSilentStream,
  emptyTally,
  noteStreamEvent,
  reasoningDeltaOf,
  type StreamTally,
} from "../src/stream-shape.js";

/** Every `data:` payload of one stream, through the tally. */
function tallyOf(payloads: unknown[]): StreamTally {
  const t = emptyTally();
  for (const p of payloads) noteStreamEvent(t, typeof p === "string" ? p : JSON.stringify(p));
  return t;
}

// ---- the agentrouter.org shapes, verbatim ----

const messageStart = {
  type: "message_start",
  content_block: null,
  delta: null,
  error: null,
  index: 0,
  message: { id: "m1", model: "deepseek-v4-flash", role: "assistant", type: "message", usage: { input_tokens: 31, output_tokens: 0 } },
};
const thinkingBlockStart = {
  content_block: { signature: "", thinking: "", type: "thinking" },
  delta: null,
  error: null,
  index: 0,
  message: null,
  type: "content_block_start",
};
const ping = { content_block: null, delta: null, error: null, index: 0, message: null, type: "ping" };
const thinkingDelta = (text: string) => ({
  content_block: null,
  delta: { thinking: text, type: "thinking_delta" },
  error: null,
  index: 0,
  message: null,
  type: "content_block_delta",
});
const signatureDelta = {
  content_block: null,
  delta: { signature: "abc", type: "signature_delta" },
  error: null,
  index: 0,
  message: null,
  type: "content_block_delta",
};
const textDelta = (text: string) => ({
  content_block: null,
  delta: { text, type: "text_delta" },
  error: null,
  index: 0,
  message: null,
  type: "content_block_delta",
});
const blockStop = { content_block: null, delta: null, error: null, index: 0, message: null, type: "content_block_stop" };
const messageDelta = {
  type: "message_delta",
  content_block: null,
  delta: { stop_reason: "end_turn", stop_sequence: null },
  error: null,
  index: 0,
  message: null,
  usage: { input_tokens: 31, output_tokens: 12 },
};
const messageStop = { content_block: null, delta: null, error: null, index: 0, message: null, type: "message_stop" };

/** A stream that reasoned and hit its budget before ever emitting a text block. */
const reasoningOnly = [
  messageStart,
  thinkingBlockStart,
  ping,
  thinkingDelta("Hi"),
  thinkingDelta(" there"),
  signatureDelta,
  blockStop,
  messageDelta,
  messageStop,
];

test("a reasoning-only Anthropic stream is not reported as a manifest defect", () => {
  const detail = describeSilentStream(tallyOf(reasoningOnly));

  // The finding that was missing: the model never sent text, so nothing is wrong with the manifest.
  expect(detail).toContain("every delta was model reasoning");
  expect(detail).toContain("delta.thinking");
  expect(detail).toContain("no text was sent");
  expect(detail).toContain("the selector is not at fault");
});

test("the quoted sample is a delta, never the lifecycle event every stream opens with", () => {
  const detail = describeSilentStream(tallyOf(reasoningOnly));

  // `message_start` is present in this stream and would have been quoted by the old positional
  // sample. It distinguishes nothing, which is exactly why the old row could not be diagnosed.
  expect(detail).toContain("thinking_delta");
  expect(detail).not.toContain("message_start");
});

test("a stream that reasoned and then answered is not silent at all", () => {
  const t = tallyOf([...reasoningOnly.slice(0, -2), thinkingDelta(" done"), blockStop, textDelta("hello"), messageDelta, messageStop]);

  expect(t.text).toBeGreaterThan(0);
  expect(t.reasoning).toBeGreaterThan(0);
  // And `firstDelta` is still a reasoning delta, which is right: that is the first delta the
  // provider sent. It is only ever quoted when the stream produced nothing.
  expect(t.firstDelta).toContain("thinking_delta");
});

test("zero events is its own finding, not an absence of evidence", () => {
  expect(describeSilentStream(emptyTally())).toBe("stream carried no SSE events at all");
});

test("lifecycle events are counted separately and never mistaken for content", () => {
  // The four payloads that carry no delta at all. `thinkingBlockStart` is deliberately not here:
  // it announces reasoning, so it is counted as reasoning — see its own test.
  const t = tallyOf([messageStart, ping, blockStop, messageStop]);
  expect(t.lifecycle).toBe(4);
  expect(t.text).toBe(0);
  expect(t.reasoning).toBe(0);
  expect(t.firstDelta).toBeUndefined();
  expect(t.firstEvent).toBeDefined();
});

// ---- the OpenAI-compatible reasoning shape the live ledger also holds ----

test("an OpenAI reasoning_content stream names that field, not the Anthropic one", () => {
  // The shape `ledger-honesty.test.ts` pins the old wording against; the phrase must survive.
  const t = tallyOf([
    { choices: [{ delta: { reasoning_content: "thinking..." } }] },
    { choices: [{ delta: { reasoning_content: "more" } }] },
  ]);
  const detail = describeSilentStream(t);

  expect(t.reasoning).toBe(2);
  expect(detail).toContain("2 SSE event");
  expect(detail).toContain("none matched the manifest's delta selector");
  expect(detail).toContain("delta.reasoning_content");
  expect(detail).toContain("every delta was model reasoning");
});

// ---- classification, payload by payload ----

test("text is recognised from either dialect's field name", () => {
  expect(classifyDelta(JSON.stringify(textDelta("hi")))).toMatchObject({ kind: "text", field: "delta.text" });
  expect(classifyDelta(JSON.stringify({ choices: [{ delta: { content: "hi" } }] }))).toMatchObject({
    kind: "text",
    field: "choices[0].delta.content",
  });
});

test("tool-call framing is recognised, so a tool turn is never filed as empty", () => {
  expect(
    classifyDelta(JSON.stringify({ delta: { type: "input_json_delta", partial_json: '{"pa' }, index: 1 })),
  ).toMatchObject({ kind: "tool", field: "delta.partial_json" });
  expect(classifyDelta(JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "c1" }] } }] }))).toMatchObject({
    kind: "tool",
    field: "choices[0].delta.tool_calls",
  });
});

test("a thinking block announcement counts as reasoning but does not name the stream field", () => {
  // No delta yet, but the reasoning is a fact about the stream and reporting it as a lifecycle
  // event would understate the finding. `carried` is what keeps it from naming `delta.thinking`,
  // a key that is null at this point in the stream.
  const verdict = classifyDelta(JSON.stringify(thinkingBlockStart));
  expect(verdict).toMatchObject({ kind: "reasoning", field: "content_block.thinking" });
  expect(verdict.carried).toBeUndefined();
  expect(classifyDelta(JSON.stringify(thinkingDelta("x"))).carried).toBe(true);
});

test("a recognised lifecycle type is lifecycle; an unrecognised one is not", () => {
  expect(classifyDelta(JSON.stringify(ping)).kind).toBe("lifecycle");
  expect(classifyDelta(JSON.stringify(messageStart)).kind).toBe("lifecycle");
  // A well-formed JSON object this module does not know is a shape finding, so it must not be
  // quietly filed as lifecycle — that would hide exactly the case the row exists to report.
  expect(classifyDelta(JSON.stringify({ something: "else" })).kind).toBe("other");
  expect(classifyDelta("<html>gateway error</html>")).toEqual({ kind: "other", field: "not JSON" });
});

test("an unrecognised payload is quoted as it arrived, not replaced by a second failure", () => {
  const detail = describeSilentStream(tallyOf(["<html>502</html>"]));
  expect(detail).toContain("<html>502</html>");
  expect(detail).not.toContain("model reasoning");
});

test("the sample is cut on a character boundary", () => {
  // The same trap the Rust `StreamObservation` guards: a byte-indexed cut mid-UTF-8 panics, and a
  // UTF-16 `slice` can leave a lone surrogate. The sample cap is applied here, at the capture point.
  const t = tallyOf([{ choices: [{ delta: { content: "🙂".repeat(400) } }] }]);
  expect(t.firstDelta!.endsWith("…")).toBe(true);
  // No lone surrogate survived: code-point iteration would surface one as a separate unit.
  const lone = [...t.firstDelta!].some((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp >= 0xd800 && cp <= 0xdfff;
  });
  expect(lone).toBe(false);
});

// ---- the reasoning itself, not merely its tally ----

test("reasoning is read from either dialect's field, and only when it carries text", () => {
  expect(reasoningDeltaOf(JSON.stringify(thinkingDelta("a thought")))).toBe("a thought");
  expect(
    reasoningDeltaOf(JSON.stringify({ choices: [{ delta: { reasoning_content: "openai thought" } }] })),
  ).toBe("openai thought");
  // A third spelling several compatible gateways use.
  expect(reasoningDeltaOf(JSON.stringify({ choices: [{ delta: { reasoning: "third spelling" } }] }))).toBe(
    "third spelling",
  );

  // The block announcement carries `thinking: ""` — turning that into text would put an empty
  // line in front of the answer for every reasoning model on the wire.
  expect(reasoningDeltaOf(JSON.stringify(thinkingBlockStart))).toBeUndefined();
  // A signature is not reasoning, and the answer is not reasoning.
  expect(reasoningDeltaOf(JSON.stringify(signatureDelta))).toBeUndefined();
  expect(reasoningDeltaOf(JSON.stringify(textDelta("hi")))).toBeUndefined();
  // Neither is a lifecycle event, a non-JSON line, or an object-valued `reasoning` (OpenRouter's
  // `reasoning_details` is structured, and rendering `[object Object]` is worse than showing none).
  expect(reasoningDeltaOf(JSON.stringify(messageStart))).toBeUndefined();
  expect(reasoningDeltaOf("<html>502</html>")).toBeUndefined();
  expect(
    reasoningDeltaOf(JSON.stringify({ choices: [{ delta: { reasoning: { type: "summary" } } }] })),
  ).toBeUndefined();
});

test("hitting the output limit turns the finding into advice", () => {
  const t = tallyOf(reasoningOnly);
  const withFinish = describeSilentStream(t, "length");

  // The finding is unchanged — a reader has to be able to trust it before acting on the advice.
  expect(withFinish).toContain("every delta was model reasoning");
  expect(withFinish).toContain("the selector is not at fault");
  // And the advice names the cause and the lever, because "the model reasoned" is not something
  // an operator can act on by itself.
  expect(withFinish).toContain("output budget");
  expect(withFinish).toContain("max output tokens");

  // Without a finish reason the finding still stands, with the weaker advice rather than none.
  const without = describeSilentStream(t);
  expect(without).toContain("every delta was model reasoning");
  expect(without).toContain("stopped before answering");
  expect(without).not.toContain("output budget");
});
