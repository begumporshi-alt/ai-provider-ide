/**
 * Gateway normalizer tests (Phase 1 of gateway-flexibility plan).
 * Pure-function unit tests — no network, no I/O.
 */
import { describe, expect, it } from "vitest";
import { normalizeGatewayRequest, ensureToolCallIds, fixMissingToolResponses, stripOrphanedToolResults, sanitizeOpenAITools } from "../src/gateway-normalizer.js";
import { detectClient } from "../src/gateway-client-detector.js";

describe("detectClient", () => {
  it("detects WorkBuddy", () => {
    expect(detectClient({ "user-agent": "WorkBuddy/1.0" })).toBe("workbuddy");
    expect(detectClient({ "x-client-name": "workbuddy" })).toBe("workbuddy");
  });

  it("detects Claude Code", () => {
    expect(detectClient({ "user-agent": "claude-code/0.1.0" })).toBe("claude-code");
    expect(detectClient({ "user-agent": "Anthropic CLI" })).toBe("claude-code");
  });

  it("detects Codex", () => {
    expect(detectClient({ "user-agent": "codex/1.0" })).toBe("codex");
    expect(detectClient({ "x-codex-client": "true" })).toBe("codex");
  });

  it("detects zcode / z.ai", () => {
    expect(detectClient({ "user-agent": "zcode/1.0" })).toBe("zcode");
    expect(detectClient({ "x-client-name": "z.ai" })).toBe("zcode");
  });

  it("detects Cursor", () => {
    expect(detectClient({ "user-agent": "Cursor/1.0" })).toBe("cursor");
  });

  it("falls back to generic", () => {
    expect(detectClient({ "user-agent": "Mozilla/5.0" })).toBe("generic");
    expect(detectClient({})).toBe("generic");
  });
});

describe("normalizeGatewayRequest — role normalization", () => {
  it("maps developer -> system for non-OpenAI providers", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "developer", content: "Be helpful" }],
    }, { targetProvider: "openrouter" });
    expect((out.messages as unknown[])[0]).toMatchObject({ role: "system", content: [{ type: "text", text: "Be helpful" }] });
  });

  it("preserves developer role for OpenAI provider when preserveDeveloperRole is true", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "developer", content: "Be helpful" }],
    }, { targetProvider: "openai", preserveDeveloperRole: true });
    expect((out.messages as unknown[])[0]).toMatchObject({ role: "developer", content: [{ type: "text", text: "Be helpful" }] });
  });

  it("maps developer -> system for OpenAI provider when preserveDeveloperRole is false", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "developer", content: "Be helpful" }],
    }, { targetProvider: "openai", preserveDeveloperRole: false });
    expect((out.messages as unknown[])[0]).toMatchObject({ role: "system", content: [{ type: "text", text: "Be helpful" }] });
  });

  it("maps model -> assistant", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "model", content: "Hello" }],
    });
    expect((out.messages as unknown[])[0]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Hello" }] });
  });

  it("folds system into first user message for providers without system role", () => {
    const out = normalizeGatewayRequest({
      messages: [
        { role: "system", content: "Sys1" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
    }, { targetProvider: "duckduckgo-web" });
    const msgs = out.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content[0]!.text).toContain("Sys1");
    expect(msgs[0]!.content[0]!.text).toContain("Hello");
    expect(msgs).toHaveLength(2);
  });

  it("inserts user message with system content when no user exists and provider lacks system role", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "system", content: "Sys1" }],
    }, { targetProvider: "duckduckgo-web" });
    const msgs = out.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content[0]!.text).toContain("Sys1");
  });

  it("hoists system message to index 0", () => {
    const out = normalizeGatewayRequest({
      messages: [
        { role: "user", content: "Hello" },
        { role: "system", content: "Sys" },
        { role: "assistant", content: "Hi" },
      ],
    });
    const msgs = out.messages as Array<{ role: string }>;
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
  });
});

describe("normalizeGatewayRequest — tool-call id safety", () => {
  it("generates missing tool_call ids", () => {
    const out = normalizeGatewayRequest({
      messages: [
        {
          role: "assistant",
          tool_calls: [{ function: { name: "read", arguments: "{}" } }],
        },
      ],
    });
    const tc = (out.messages as unknown[])[0] as { tool_calls: Array<{ id: string }> };
    expect(tc.tool_calls[0]!.id).toBeTruthy();
    expect(typeof tc.tool_calls[0]!.id).toBe("string");
  });

  it("preserves existing tool_call ids", () => {
    const out = normalizeGatewayRequest({
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "call_abc123", function: { name: "read", arguments: "{}" } }],
        },
      ],
    });
    const tc = (out.messages as unknown[])[0] as { tool_calls: Array<{ id: string }> };
    expect(tc.tool_calls[0]!.id).toBe("call_abc123");
  });
});

describe("normalizeGatewayRequest — tool response hygiene", () => {
  it("inserts empty tool results for missing responses", () => {
    const out = normalizeGatewayRequest({
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }],
        },
      ],
    });
    const msgs = out.messages as Array<{ role: string; tool_call_id?: string }>;
    // assistant + inserted tool result + trailing user turn = 3
    expect(msgs).toHaveLength(3);
    expect(msgs[1]!.role).toBe("tool");
    expect(msgs[1]!.tool_call_id).toBe("call_1");
    expect(msgs[2]!.role).toBe("user");
  });

  it("strips orphaned tool results", () => {
    const out = normalizeGatewayRequest({
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
        { role: "tool", tool_call_id: "call_2", content: "orphan" },
      ],
    });
    const msgs = out.messages as Array<{ role: string; tool_call_id?: string }>;
    const toolMsgs = msgs.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0]!.tool_call_id).toBe("call_1");
  });
});

describe("normalizeGatewayRequest — tool schema sanitization", () => {
  it("strips null from enum arrays", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "test",
            parameters: {
              type: "object",
              properties: {
                color: { type: "string", enum: ["red", "blue", null] },
              },
            },
          },
        },
      ],
    });
    const tools = out.tools as Array<{ function: { parameters: { properties: { color: { enum: unknown[] } } } } }>;
    expect(tools[0]!.function.parameters.properties.color.enum).toEqual(["red", "blue"]);
  });

  it("ensures root type: object when missing", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "test",
            parameters: {
              properties: { foo: { type: "string" } },
            },
          },
        },
      ],
    });
    const tools = out.tools as Array<{ function: { parameters: { type: string } } }>;
    expect(tools[0]!.function.parameters.type).toBe("object");
  });

  it("filters required to existing property keys", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "test",
            parameters: {
              type: "object",
              properties: { foo: { type: "string" } },
              required: ["foo", "bar", 123],
            },
          },
        },
      ],
    });
    const tools = out.tools as Array<{ function: { parameters: { required: string[] } } }>;
    expect(tools[0]!.function.parameters.required).toEqual(["foo"]);
  });

  it("flattens tuple-form items to single schema", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "test",
            parameters: {
              type: "object",
              properties: {
                list: { type: "array", items: [{ type: "string" }, { type: "number" }] },
              },
            },
          },
        },
      ],
    });
    const tools = out.tools as Array<{ function: { parameters: { properties: { list: { items: unknown } } } } }>;
    expect(tools[0]!.function.parameters.properties.list.items).toEqual({ type: "string" });
  });
});

describe("normalizeGatewayRequest — message shape fixes", () => {
  it("promotes input -> messages for Codex shape", () => {
    const out = normalizeGatewayRequest({
      input: "Hello",
    }, { clientHint: "codex" });
    expect(Array.isArray(out.messages)).toBe(true);
    // Codex normalization uses Responses input_text format before promotion
    expect((out.messages as unknown[])[0]).toMatchObject({ role: "user", content: [{ type: "input_text", text: "Hello" }] });
  });

  it("promotes array input -> messages", () => {
    const out = normalizeGatewayRequest({
      input: [{ role: "user", content: "Hello" }],
    });
    expect(Array.isArray(out.messages)).toBe(true);
    expect((out.messages as unknown[])[0]).toMatchObject({ role: "user", content: [{ type: "text", text: "Hello" }] });
  });

  it("converts string content to array", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "user", content: "Hello" }],
    });
    const msg = (out.messages as unknown[])[0] as { content: unknown };
    expect(Array.isArray(msg.content)).toBe(true);
    expect(msg.content).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("adds trailing user turn after tool results", () => {
    const out = normalizeGatewayRequest({
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    });
    const msgs = out.messages as Array<{ role: string }>;
    expect(msgs[msgs.length - 1]!.role).toBe("user");
  });
});

describe("normalizeGatewayRequest — Claude Code adaptations", () => {
  it("remaps tool names lowercase -> TitleCase", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
    }, { clientHint: "claude-code" });
    const tools = out.tools as Array<{ function: { name: string } }>;
    expect(tools[0]!.function.name).toBe("Bash");
  });

  it("remaps tool_use block names in message history", () => {
    const out = normalizeGatewayRequest({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "bash", input: {} }],
        },
      ],
      tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
    }, { clientHint: "claude-code" });
    const content = (out.messages as unknown[])[0] as { content: Array<{ name: string }> };
    expect(content.content[0]!.name).toBe("Bash");
  });

  it("tracks renames in _toolNameMap", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
    }, { clientHint: "claude-code" });
    const map = out._toolNameMap as Map<string, string>;
    expect(map.get("Bash")).toBe("bash");
  });
});

describe("normalizeGatewayRequest — zcode / z.ai adaptations", () => {
  it("adds empty user turn when no user exists", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "assistant", content: "Hi" }],
    }, { clientHint: "zcode" });
    const msgs = out.messages as Array<{ role: string }>;
    expect(msgs.some((m) => m.role === "user")).toBe(true);
  });

  it("does not add user turn when one already exists", () => {
    const out = normalizeGatewayRequest({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
    }, { clientHint: "zcode" });
    const msgs = out.messages as Array<{ role: string }>;
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("preserves system prompts for zcode", () => {
    const out = normalizeGatewayRequest({
      messages: [
        { role: "system", content: "Always respond in JSON format" },
        { role: "user", content: "hi" },
      ],
    }, { clientHint: "zcode" });
    const msgs = out.messages as Array<{ role: string; content: unknown }>;
    const sys = msgs.find((m) => m.role === "system")!;
    const text = (sys.content as unknown as Array<{type:string; text:string}>)[0]!.text;
    expect(text).toBe("Always respond in JSON format");
  });
});

describe("normalizeGatewayRequest — Codex adaptations", () => {
  it("promotes reasoning_effort -> reasoning.effort", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
    }, { clientHint: "codex" });
    expect(out.reasoning).toEqual({ effort: "high" });
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("maps max_completion_tokens -> max_output_tokens", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "user", content: "hi" }],
      max_completion_tokens: 4096,
    }, { clientHint: "codex" });
    expect(out.max_output_tokens).toBe(4096);
    expect(out.max_completion_tokens).toBeUndefined();
    expect(out.max_tokens).toBeUndefined();
  });

  it("maps max_tokens -> max_output_tokens when max_completion_tokens absent", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 2048,
    }, { clientHint: "codex" });
    expect(out.max_output_tokens).toBe(2048);
    expect(out.max_tokens).toBeUndefined();
  });

  it("maps response_format -> text.format", () => {
    const out = normalizeGatewayRequest({
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_object" },
    }, { clientHint: "codex" });
    expect(out.text).toEqual({ format: { type: "json_object" } });
    expect(out.response_format).toBeUndefined();
  });

  it("normalizes string input to message array", () => {
    const out = normalizeGatewayRequest({
      input: "Hello",
    }, { clientHint: "codex" });
    // input is promoted to messages and deleted
    expect(out.input).toBeUndefined();
    expect(Array.isArray(out.messages)).toBe(true);
    const msgs = out.messages as Array<{ role: string; content: Array<{ type: string; text: string }> }>;
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content[0]!.text).toBe("Hello");
  });
});

describe("normalizeGatewayRequest — does not mutate input", () => {
  it("returns a deep clone", () => {
    const original = {
      messages: [{ role: "user", content: "Hello" }],
      tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
    };
    const out = normalizeGatewayRequest(original);
    expect(out).not.toBe(original);
    expect(out.messages).not.toBe(original.messages);
    expect((out.messages as unknown[])[0]).not.toBe(original.messages[0]);
    expect(out.tools).not.toBe(original.tools);
  });
});

describe("ensureToolCallIds", () => {
  it("adds ids to tool_calls missing them", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ function: { name: "read", arguments: "{}" } }],
        },
      ],
    };
    ensureToolCallIds(body);
    const tc = (body.messages as unknown[])[0] as { tool_calls: Array<{ id: string }> };
    expect(tc.tool_calls[0]!.id).toBeTruthy();
  });

  it("adds index to tool_calls missing them", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }],
        },
      ],
    };
    ensureToolCallIds(body);
    const tc = (body.messages as unknown[])[0] as { tool_calls: Array<{ index: number }> };
    expect(tc.tool_calls[0]!.index).toBe(0);
  });
});

describe("sanitizeOpenAITools", () => {
  it("returns non-array as-is", () => {
    expect(sanitizeOpenAITools("not tools")).toBe("not tools");
  });

  it("handles Responses API shape (no function wrapper)", () => {
    const out = sanitizeOpenAITools([{ type: "function", name: "test", parameters: { properties: { x: { type: "string" } } } }]);
    const tools = out as Array<{ type: string; parameters: { type: string } }>;
    expect(tools[0]!.parameters.type).toBe("object");
  });
});
