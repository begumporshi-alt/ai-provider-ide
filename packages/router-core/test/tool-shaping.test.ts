/**
 * tool-shaping.test.ts — the shaper's own contract, and the guard that the dialects which declare
 * nothing are untouched.
 *
 * The wire-level behaviour of the Gemini path is pinned by `gemini-tools.test.ts`; this file is the
 * other half. Two things live here that cannot be seen from the wire:
 *
 *  - the shaper's edge cases, where the interesting behaviour is a REFUSAL (a block with no name is
 *    not a tool call, an undeclared dialect is not reshaped at all) — an assertion on a body cannot
 *    tell "the shaper left this alone" from "the shaper produced the same thing";
 *  - the three declarations a dialect may make independently, so that declaring one cannot start
 *    changing requests for a dialect that declared another.
 */
import { describe, expect, it } from "vitest";
import {
  attachToolParts, blockField, isToolCallBlock, readToolCall, readToolCalls, shapeToolDeclarations,
} from "../src/tool-shaping.js";
import type { ToolCallShape } from "../src/tool-shaping.js";

/** `renderTemplate`'s contract, faked: substitute whole-field placeholders at any depth. */
function render(template: Record<string, unknown>, values: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) {
    if (typeof v === "string" && v.startsWith("{{") && v.endsWith("}}")) {
      const key = v.slice(2, -2);
      if (values[key] !== undefined) out[k] = values[key];
      continue;
    }
    out[k] = v && typeof v === "object" ? render(v as Record<string, unknown>, values) : v;
  }
  return out;
}

const GEMINI: ToolCallShape = {
  discriminator: { path: "functionCall", present: true },
  name: "functionCall.name",
  arguments: "functionCall.args",
  argumentsFormat: "object",
  streamedAs: "whole",
};

const TOOLS = [{ type: "function", function: { name: "read_file", description: "d", parameters: { type: "object" } } }];

describe("blockField", () => {
  it("walks a dotted path", () => {
    expect(blockField({ function: { name: "read_file" } }, "function.name")).toBe("read_file");
  });

  it("returns undefined for a missing segment rather than throwing", () => {
    // A shape read off a provider's response must survive a provider that omitted a piece.
    expect(blockField({ function: {} }, "function.arguments")).toBeUndefined();
    expect(blockField({}, "function.name")).toBeUndefined();
    expect(blockField(null, "name")).toBeUndefined();
    expect(blockField("a-string", "name")).toBeUndefined();
    expect(blockField({ a: { b: null } }, "a.b.c")).toBeUndefined();
  });
});

describe("isToolCallBlock", () => {
  it("accepts everything when no discriminator is declared", () => {
    expect(isToolCallBlock({}, { name: "name", arguments: "input" })).toBe(true);
  });

  it("matches on equality (OpenAI's type, Anthropic's type)", () => {
    const shape: ToolCallShape = { discriminator: { path: "type", equals: "function" }, name: "function.name", arguments: "function.arguments" };
    expect(isToolCallBlock({ type: "function" }, shape)).toBe(true);
    expect(isToolCallBlock({ type: "text" }, shape)).toBe(false);
    expect(isToolCallBlock({}, shape)).toBe(false);
  });

  it("matches on presence, which is all Gemini can support", () => {
    // A Gemini part has no `type` to compare against — the shape itself is the discriminator.
    expect(isToolCallBlock({ functionCall: { name: "x" } }, GEMINI)).toBe(true);
    expect(isToolCallBlock({ text: "hi" }, GEMINI)).toBe(false);
    expect(isToolCallBlock({ functionCall: null }, GEMINI)).toBe(false);
  });

  it("matches on absence when present:false", () => {
    const shape: ToolCallShape = { discriminator: { path: "functionCall", present: false }, name: "name", arguments: "input" };
    expect(isToolCallBlock({ text: "hi" }, shape)).toBe(true);
    expect(isToolCallBlock({ functionCall: {} }, shape)).toBe(false);
  });
});

describe("readToolCall", () => {
  it("serialises an object's arguments to JSON text", () => {
    // The internal `ToolCall.arguments` is JSON text — that is what every consumer parses.
    const call = readToolCall({ functionCall: { name: "read_file", args: { path: "a" } } }, GEMINI);
    expect(call?.name).toBe("read_file");
    expect(call?.arguments).toBe('{"path":"a"}');
  });

  it("passes a JSON string's arguments through untouched", () => {
    const shape: ToolCallShape = { name: "function.name", arguments: "function.arguments" };
    expect(readToolCall({ function: { name: "f", arguments: '{"a":1}' } }, shape)?.arguments).toBe('{"a":1}');
  });

  it("reads an empty argument object as no arguments, not as a missing value", () => {
    expect(readToolCall({ functionCall: { name: "f", args: {} } }, GEMINI)?.arguments).toBe("{}");
    expect(readToolCall({ functionCall: { name: "f" } }, GEMINI)?.arguments).toBe("");
  });

  it("refuses a block with no name", () => {
    // The defect this replaces produced exactly this: a nameless, argument-less call, which the
    // loop then handed to a host that could only refuse it. A nameless call is not a degraded call.
    expect(readToolCall({ functionCall: { args: { path: "a" } } }, GEMINI)).toBeNull();
    expect(readToolCall({ functionCall: { name: "" } }, GEMINI)).toBeNull();
  });

  it("refuses a non-matching block and a non-object", () => {
    expect(readToolCall({ text: "hi" }, GEMINI)).toBeNull();
    expect(readToolCall("a string", GEMINI)).toBeNull();
    expect(readToolCall(null, GEMINI)).toBeNull();
  });

  it("keeps the provider's own block on `raw`", () => {
    const block = { functionCall: { name: "f", args: { a: 1 } } };
    expect(readToolCall(block, GEMINI)?.raw).toBe(block);
  });

  it("reads an id when the shape names one", () => {
    const shape: ToolCallShape = { name: "name", arguments: "input", id: "id" };
    expect(readToolCall({ id: "call_1", name: "f", input: {} }, shape)?.id).toBe("call_1");
    expect(readToolCall({ name: "f", input: {} }, shape)?.id).toBeUndefined();
  });
});

describe("readToolCalls", () => {
  it("picks the calls out of a mixed array of parts", () => {
    const calls = readToolCalls([{ text: "thinking" }, { functionCall: { name: "a", args: { x: 1 } } }, { functionCall: { name: "b", args: {} } }], GEMINI);
    expect(calls.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("accepts a single block rather than an array", () => {
    expect(readToolCalls({ functionCall: { name: "a", args: {} } }, GEMINI)).toHaveLength(1);
  });

  it("returns nothing for a response with no calls in it", () => {
    expect(readToolCalls([{ text: "hi" }], GEMINI)).toEqual([]);
    expect(readToolCalls(undefined, GEMINI)).toEqual([]);
  });
});

describe("shapeToolDeclarations", () => {
  const templates = { function: { name: "{{name}}", description: "{{description}}", parameters: "{{parameters}}" } };

  it("leaves the caller's array alone when the dialect declares no templates", () => {
    // By reference: an undeclared dialect must not even be copied, so it cannot differ subtly.
    expect(shapeToolDeclarations(TOOLS, undefined, render)).toBe(TOOLS);
  });

  it("shapes each declaration without the OpenAI wrapping", () => {
    expect(shapeToolDeclarations(TOOLS, templates, render)).toEqual([
      { name: "read_file", description: "d", parameters: { type: "object" } },
    ]);
  });

  it("fills in a parameter schema when there is none", () => {
    const bare = [{ type: "function", function: { name: "noop" } }];
    expect(shapeToolDeclarations(bare, templates, render)).toEqual([
      { name: "noop", description: "", parameters: { type: "object", properties: {} } },
    ]);
  });

  it("passes a tool whose type it has no template for", () => {
    const odd = [{ type: "code_interpreter", id: "x" }];
    expect(shapeToolDeclarations(odd, templates, render)).toEqual(odd);
  });

  it("wraps the whole array in the declared container", () => {
    expect(shapeToolDeclarations(TOOLS, templates, render, { functionDeclarations: "{{declarations}}" })).toEqual([
      { functionDeclarations: [{ name: "read_file", description: "d", parameters: { type: "object" } }] },
    ]);
  });

  it("returns an empty array — never a wrapper around nothing — for no tools", () => {
    // A wrapper around an empty list would leave `{{tools?}}` truthy and put `tools: [{}]` on the
    // wire for a request that asked for no tools at all.
    expect(shapeToolDeclarations([], templates, render, { functionDeclarations: "{{declarations}}" })).toEqual([]);
  });
});

describe("attachToolParts", () => {
  const tpl = {
    toolCall: { functionCall: { name: "{{name}}", args: "{{argumentsObject}}" } },
    toolResult: { functionResponse: { name: "{{name}}", response: "{{response}}" } },
  };

  const HISTORY = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "Reading.",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
    },
    { role: "tool", content: "file text", tool_call_id: "c1" },
  ];

  it("does nothing at all — not even a copy — when neither template is declared", () => {
    const out = attachToolParts(HISTORY, {}, render);
    expect(out).toEqual(HISTORY);
    expect(out[1]).toBe(HISTORY[1]);
  });

  it("moves an assistant's tool_calls into parts and removes the sibling field", () => {
    const out = attachToolParts(HISTORY, tpl, render) as Array<Record<string, unknown>>;
    expect(out[1]!.content).toEqual([
      { type: "text", text: "Reading." },
      { functionCall: { name: "read_file", args: { path: "a" } } },
    ]);
    expect(out[1]).not.toHaveProperty("tool_calls");
  });

  it("names a tool result after the call it answers", () => {
    // The one step a manifest cannot express: `ChatMessage` carries only `tool_call_id`, and
    // Gemini addresses a response to the tool's name.
    const out = attachToolParts(HISTORY, tpl, render) as Array<Record<string, unknown>>;
    expect(out[2]!.content).toEqual([
      { functionResponse: { name: "read_file", response: { result: "file text" } } },
    ]);
  });

  it("replaces the result message's content rather than appending to it", () => {
    // Appending would send the same output to the model twice — once as text it cannot place on a
    // user turn, once inside the functionResponse.
    const out = attachToolParts(HISTORY, tpl, render) as Array<Record<string, unknown>>;
    expect(out[2]!.content).toHaveLength(1);
  });

  it("tolerates an assistant turn already in the nested wire shape", () => {
    const nested = [
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "list_dir", arguments: "{}" } }] },
      { role: "tool", content: "ok", tool_call_id: "c1" },
    ];
    const out = attachToolParts(nested, tpl, render) as Array<Record<string, unknown>>;
    expect(out[0]!.content).toEqual([{ functionCall: { name: "list_dir", args: {} } }]);
    expect(out[1]!.content).toEqual([{ functionResponse: { name: "list_dir", response: { result: "ok" } } }]);
  });

  it("leaves a result whose id it cannot resolve nameless rather than guessing", () => {
    const orphan = [{ role: "tool", content: "text", tool_call_id: "ghost" }];
    const out = attachToolParts(orphan, tpl, render) as Array<Record<string, unknown>>;
    expect(out[0]!.content).toEqual([{ functionResponse: { name: "", response: { result: "text" } } }]);
  });

  it("declares each half independently", () => {
    // A dialect may want a call part without a result part (or the reverse); wiring one must not
    // start reshaping the other.
    const onlyCall = attachToolParts(HISTORY, { toolCall: tpl.toolCall }, render) as Array<Record<string, unknown>>;
    expect(onlyCall[1]!.content).toHaveLength(2);
    expect(onlyCall[2]!.content).toBe("file text");
    expect(onlyCall[2]!.tool_call_id).toBe("c1");

    const onlyResult = attachToolParts(HISTORY, { toolResult: tpl.toolResult }, render) as Array<Record<string, unknown>>;
    expect(onlyResult[1]!.tool_calls).toBeDefined();
    expect(onlyResult[2]!.content).toEqual([{ functionResponse: { name: "read_file", response: { result: "file text" } } }]);
  });

  it("leaves messages with no tool traffic byte-for-byte alone", () => {
    const plain = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    expect(attachToolParts(plain, tpl, render)).toEqual(plain);
  });

  it("survives a malformed argument string without losing the call", () => {
    // The host reports the malformed arguments; dropping the call would lose the turn entirely.
    const bad = [{ role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{not json" } }] }];
    const out = attachToolParts(bad, tpl, render) as Array<Record<string, unknown>>;
    expect(out[0]!.content).toEqual([{ functionCall: { name: "f", args: {} } }]);
  });
});
