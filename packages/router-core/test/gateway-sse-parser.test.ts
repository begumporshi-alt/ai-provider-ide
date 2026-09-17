/**
 * Gateway SSE Parser tests (Phase 2).
 * Pure-function unit tests covering OpenAI Chat, Anthropic, and Responses parsers.
 */
import { describe, expect, it } from "vitest";
import {
  parseOpenAIChatDelta,
  parseClaudeDelta,
  parseResponsesDelta,
  initAccumulatorState,
  type ParsedChunk,
} from "../src/gateway-sse-parser";

function makeState(): ReturnType<typeof initAccumulatorState> {
  return initAccumulatorState();
}

const COM_ARG = '{"com';
const MAND_LS_ARG = 'mand":"ls"}';
const CMD_LS_ARG = '{"cmd":"ls"}';
const A_1_ARG = '{"a":1}';

describe("parseOpenAIChatDelta", () => {
  it("extracts text delta", () => {
    const state = makeState();
    const chunk = parseOpenAIChatDelta(
      { choices: [{ index: 0, delta: { content: "Hello" } }] },
      state
    );
    expect(chunk?.text).toBe("Hello");
  });

  it("accumulates text across chunks", () => {
    const state = makeState();
    parseOpenAIChatDelta(
      { choices: [{ index: 0, delta: { content: "Hel" } }] },
      state
    );
    parseOpenAIChatDelta(
      { choices: [{ index: 0, delta: { content: "lo" } }] },
      state
    );
    expect(state.textBuf).toBe("Hello");
  });

  it("extracts reasoning_content", () => {
    const state = makeState();
    const chunk = parseOpenAIChatDelta(
      {
        choices: [
          { index: 0, delta: { reasoning_content: "Let me think..." } },
        ],
      },
      state
    );
    expect(chunk?.reasoning).toBe("Let me think...");
    expect(state.reasoningBuf).toBe("Let me think...");
  });

  it("reassembles tool_calls from fragments", () => {
    const state = makeState();
    // First fragment: id + name
    parseOpenAIChatDelta(
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: { name: "Bash", arguments: "" },
                },
              ],
            },
          },
        ],
      },
      state
    );
    // Second fragment: first half of arguments JSON
    parseOpenAIChatDelta(
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: COM_ARG }},
              ],
            },
          },
        ],
      },
      state
    );
    // Final fragment: closing args + finish_reason
    const final = parseOpenAIChatDelta(
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: MAND_LS_ARG }}] },
            finish_reason: "tool_calls",
          },
        ],
      },
      state
    );
    expect(final?.toolCalls).toHaveLength(1);
    expect(final?.toolCalls![0]!.id).toBe("call_abc");
    expect(final?.toolCalls![0]!.function.name).toBe("Bash");
    expect(final?.toolCalls![0]!.function.arguments).toBe('{"command":"ls"}');
    expect(final?.finishReason).toBe("tool_calls");
    expect(final?.done).toBe(true);
  });

  it("marks done with finish_reason stop", () => {
    const state = makeState();
    const chunk = parseOpenAIChatDelta(
      { choices: [{ index: 0, delta: { content: "bye" }, finish_reason: "stop" }] },
      state
    );
    expect(chunk?.done).toBe(true);
    expect(chunk?.finishReason).toBe("stop");
    expect(chunk?.text).toBe("bye");
  });

  it("captures usage on terminal chunk", () => {
    const state = makeState();
    const chunk = parseOpenAIChatDelta(
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      state
    );
    expect(chunk?.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it("returns null for non-object input", () => {
    expect(parseOpenAIChatDelta("not json", makeState())).toBeNull();
    expect(parseOpenAIChatDelta(null, makeState())).toBeNull();
    expect(parseOpenAIChatDelta([], makeState())).toBeNull();
  });

  it("returns null for empty choices", () => {
    expect(parseOpenAIChatDelta({ choices: [] }, makeState())).toBeNull();
  });

  it("returns chunk with empty text when no delta", () => {
    const result = parseOpenAIChatDelta(
      { choices: [{ index: 0 }] },
      makeState()
    );
    expect(result).not.toBeNull();
    expect(result?.text).toBe("");
  });
});

describe("parseClaudeDelta", () => {
  it("handles message_start", () => {
    const state = makeState();
    const result = parseClaudeDelta(
      {
        type: "message_start",
        message: { id: "msg_123", model: "claude-3-opus" },
      },
      state
    );
    expect(result).toBeNull();
    expect(state.messageId).toBe("msg_123");
    expect(state.model).toBe("claude-3-opus");
  });

  it("extracts text from content_block_delta", () => {
    const state = makeState();
    parseClaudeDelta(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", id: "blk_1", name: null },
      },
      state
    );
    const chunk = parseClaudeDelta(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      state
    );
    expect(chunk?.text).toBe("Hello");
    expect(state.textBuf).toBe("Hello");
  });

  it("reassembles tool_use from content_block events", () => {
    const state = makeState();
    parseClaudeDelta(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_01", name: "Bash" },
      },
      state
    );
    parseClaudeDelta(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"cmd"' },
      },
      state
    );
    parseClaudeDelta(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: 'input_json_delta', partial_json: ':"ls"}' },
      },
      state
    );
    const chunk = parseClaudeDelta(
      { type: "content_block_stop", index: 0 },
      state
    );
    expect(chunk).toBeNull();
    expect(state.toolCalls.get(0)?.id).toBe("toolu_01");
    expect(state.toolCalls.get(0)?.function.name).toBe("Bash");
    expect(state.toolCalls.get(0)?.function.arguments).toBe(CMD_LS_ARG);
  });

  it("emits tool_calls on message_delta after tool_use", () => {
    const state = makeState();
    parseClaudeDelta(
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "t1", name: "Read" },
      },
      state
    );
    parseClaudeDelta(
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
      state
    );
    parseClaudeDelta({ type: "content_block_stop", index: 0 }, state);
    const chunk = parseClaudeDelta(
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 42 },
      },
      state
    );
    expect(chunk?.finishReason).toBe("tool_calls");
    expect(chunk?.toolCalls).toHaveLength(1);
    expect(chunk?.done).toBe(true);
  });

  it("returns null on error event", () => {
    expect(
      parseClaudeDelta(
        { type: "error", error: { type: "overloaded_error", message: "too many" } },
        makeState()
      )
    ).toBeNull();
  });
});

describe("parseResponsesDelta", () => {
  it("handles response.created", () => {
    const state = makeState();
    const result = parseResponsesDelta(
      {
        type: "response.created",
        response: { id: "resp_1", model: "o1" },
      },
      state
    );
    expect(result).toBeNull();
    expect(state.messageId).toBe("resp_1");
    expect(state.model).toBe("o1");
  });

  it("accumulates output_text deltas", () => {
    const state = makeState();
    const c1 = parseResponsesDelta(
      { type: "response.output_text.delta", delta: "Hello" },
      state
    );
    expect(c1?.text).toBe("Hello");
    const c2 = parseResponsesDelta(
      { type: "response.output_text.delta", delta: " world" },
      state
    );
    expect(c2?.text).toBe(" world");
    expect(state.textBuf).toBe("Hello world");
  });

  it("emits accumulated text on output_text.done", () => {
    const state = makeState();
    state.textBuf = "accumulated";
    const chunk = parseResponsesDelta(
      { type: "response.output_text.done" },
      state
    );
    expect(chunk?.text).toBe("accumulated");
  });

  it("reassembles function_call from delta + done", () => {
    const state = makeState();
    parseResponsesDelta(
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "fc_1", type: "function_call", name: "Bash", call_id: "call_x" },
      },
      state
    );
    parseResponsesDelta(
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"a"' },
      state
    );
    parseResponsesDelta(
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: ':1}' },
      state
    );
    const chunk = parseResponsesDelta(
      { type: "response.function_call_arguments.done", item_id: "fc_1" },
      state
    );
    expect(chunk).toBeNull();
    expect(state.toolCalls.get(0)?.id).toBe("call_x");
    expect(state.toolCalls.get(0)?.function.name).toBe("Bash");
    expect(state.toolCalls.get(0)?.function.arguments).toBe(A_1_ARG);
  });

  it("emits final chunk on response.completed with tool calls", () => {
    const state = makeState();
    state.toolCalls.set(0, {
      id: "call_x",
      type: "function",
      function: { name: "Bash", arguments: "{}" },
    });
    state.textBuf = "done";
    const chunk = parseResponsesDelta(
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          model: "o1",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
      state
    );
    expect(chunk?.done).toBe(true);
    expect(chunk?.text).toBe("done");
    expect(chunk?.toolCalls).toHaveLength(1);
    expect(chunk?.finishReason).toBe("tool_calls");
    expect(chunk?.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("emits final chunk on response.completed without tool calls", () => {
    const state = makeState();
    state.textBuf = "just text";
    const chunk = parseResponsesDelta(
      {
        type: "response.completed",
        response: { id: "resp_1", model: "o1" },
      },
      state
    );
    expect(chunk?.done).toBe(true);
    expect(chunk?.finishReason).toBe("stop");
    expect(chunk?.toolCalls).toBeUndefined();
  });
});

describe("initAccumulatorState", () => {
  it("creates fresh state", () => {
    const s1 = initAccumulatorState();
    const s2 = initAccumulatorState();
    s1.toolCalls.set(0, { id: "a", type: "function", function: { name: "x", arguments: "{}" } });
    expect(s2.toolCalls.size).toBe(0);
  });
});
