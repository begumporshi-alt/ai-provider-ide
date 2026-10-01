/**
 * gemini-tools.test.ts — function calling over the gemini-compat dialect (2026-10-01).
 *
 * The defect these pin: gemini-compat declared **no tool field at all**. On the request side that
 * meant `{{tools}}` was never referenced, so the model was never told it had tools; on the response
 * side there was no `responseMap.toolCalls`, so a `functionCall` part was never reported. Agent mode
 * against a Gemini model therefore could not work, and nothing in the call said why — the request
 * simply went out without tools and the answer came back with no calls to run.
 *
 * Written as the three seams the fix touches, each asserted on the wire:
 *   1. the declarations sent (functionDeclarations, not OpenAI's `function` wrapping);
 *   2. a replayed call and its result (functionCall / functionResponse *parts*);
 *   3. reading a call back out, unary and streamed.
 *
 * The OpenAI and Anthropic paths are covered by `tool-calling.test.ts`, which must keep passing
 * untouched — a dialect that declares none of the new fields gets exactly its old behaviour.
 */
import { describe, expect, it } from "vitest";
import { ManifestInterpreter } from "../src/manifest-interpreter.js";
import { BUILTIN_TEMPLATES } from "../src/builtin-templates.js";
import type { ToolCall } from "../src/ports.js";
import { FakeHttp, type Responder } from "./fakes.js";

const BASE = "https://generativelanguage.googleapis.com";
const MODEL = "models/gemini-2.0-flash";

/** Build the interpreter and its fake transport together, so the test can read the request. */
function make(responder: Responder) {
  const http = new FakeHttp(responder);
  const interp = new ManifestInterpreter(BUILTIN_TEMPLATES["gemini-compat"]!(BASE), { http, vars: {} });
  return { http, interp };
}

function lastBody(http: FakeHttp): Record<string, unknown> {
  const call = [...http.calls].reverse().find((c) => c.method === "POST" && c.url.includes(":generateContent"));
  if (!call?.body) throw new Error("no generateContent request was made");
  return JSON.parse(call.body);
}

const OK_BODY = { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] };

const READ_FILE_TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a UTF-8 text file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

async function drain(gen: AsyncGenerator<string, void, void>): Promise<string> {
  let out = "";
  for await (const c of gen) out += c;
  return out;
}

describe("request: tool declarations", () => {
  it("nests declarations under functionDeclarations, without OpenAI's wrapping", async () => {
    const { http, interp: m } = make(() => ({ status: 200, body: OK_BODY }));
    await drain(m.generateText("key:t", { model: MODEL, messages: [{ role: "user", content: "hi" }], tools: [READ_FILE_TOOL], stream: false }));

    const body = lastBody(http);
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "read_file",
            description: "Read a UTF-8 text file.",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        ],
      },
    ]);
    // The OpenAI wrapping Gemini does not read, and which the old pass-through sent in full.
    expect(JSON.stringify(body.tools)).not.toContain('"function"');
  });

  it("fills in a parameter schema when the declaration has none", async () => {
    const { http, interp: m } = make(() => ({ status: 200, body: OK_BODY }));
    await drain(m.generateText("key:t", { model: MODEL, messages: [], tools: [{ type: "function", function: { name: "noop" } }], stream: false }));

    // Gemini rejects a declaration with no parameter schema, and the repo already carries this same
    // default in the other direction (declaration_to_openai in core/gateway_gemini.rs).
    expect(lastBody(http).tools).toEqual([
      { functionDeclarations: [{ name: "noop", description: "", parameters: { type: "object", properties: {} } }] },
    ]);
  });

  it("omits the tools field entirely when the caller supplies none", async () => {
    const { http, interp: m } = make(() => ({ status: 200, body: OK_BODY }));
    await drain(m.generateText("key:t", { model: MODEL, messages: [], stream: false }));
    expect(lastBody(http)).not.toHaveProperty("tools");
    expect(lastBody(http)).not.toHaveProperty("toolConfig");
  });

  it("translates tool_choice into functionCallingConfig rather than passing the string through", async () => {
    const { http, interp: m } = make(() => ({ status: 200, body: OK_BODY }));
    await drain(
      m.generateText("key:t", {
        model: MODEL,
        messages: [],
        tools: [READ_FILE_TOOL],
        // What the agent loop actually sends on every tool-enabled request.
        toolChoice: "auto",
        stream: false,
      }),
    );
    expect(lastBody(http).toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
  });

  it("keeps the forced-function name in a list, not an object", async () => {
    // `renderToolChoiceTemplate` treated an array as an object and emitted `{0: "read_file"}`;
    // latent until this dialect needed a list.
    const { http, interp: m } = make(() => ({ status: 200, body: OK_BODY }));
    await drain(
      m.generateText("key:t", {
        model: MODEL,
        messages: [],
        tools: [READ_FILE_TOOL],
        toolChoice: { type: "function", function: { name: "read_file" } },
        stream: false,
      }),
    );
    expect(lastBody(http).toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read_file"] },
    });
  });
});

describe("request: replaying a tool turn", () => {
  const HISTORY = [
    { role: "user" as const, content: "list files" },
    {
      role: "assistant" as const,
      content: "Reading it.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } },
      ],
    },
    { role: "tool" as const, content: "hello\nworld\n", tool_call_id: "call_1" },
  ];

  it("turns the assistant's tool_calls into functionCall parts", async () => {
    const { http, interp: m } = make(() => ({ status: 200, body: OK_BODY }));
    await drain(m.generateText("key:t", { model: MODEL, messages: [...HISTORY], stream: false }));

    const contents = lastBody(http).contents as unknown[];
    expect(contents[1]).toEqual({
      role: "model",
      parts: [
        { text: "Reading it." },
        { functionCall: { name: "read_file", args: { path: "README.md" } } },
      ],
    });
  });

  it("turns the tool result into a functionResponse part addressed by NAME", async () => {
    const { http, interp: m } = make(() => ({ status: 200, body: OK_BODY }));
    await drain(m.generateText("key:t", { model: MODEL, messages: [...HISTORY], stream: false }));

    const contents = lastBody(http).contents as unknown[];
    // `name` is the tool's name, resolved from the assistant turn that declared the call — the
    // internal shape carries only `tool_call_id`, and Gemini addresses a response to the tool.
    // `response` is an object because Gemini requires a Struct there, not a string.
    expect(contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "read_file", response: { result: "hello\nworld\n" } } }],
    });
  });

  it("removes the OpenAI sibling fields the provider does not read", async () => {
    const { http, interp: m } = make(() => ({ status: 200, body: OK_BODY }));
    await drain(m.generateText("key:t", { model: MODEL, messages: [...HISTORY], stream: false }));

    // Gemini rejects unknown fields outright, so an assistant turn that kept `tool_calls` and
    // gained `parts` would fail the whole request rather than lose a detail.
    const wire = JSON.stringify(lastBody(http).contents);
    expect(wire).not.toContain("tool_calls");
    expect(wire).not.toContain("tool_call_id");
    expect(wire).not.toContain('"content"');
  });

  it("leaves an ordinary conversation alone", async () => {
    const { http, interp: m } = make(() => ({ status: 200, body: OK_BODY }));
    await drain(
      m.generateText("key:t", {
        model: MODEL,
        messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
        stream: false,
      }),
    );
    expect(lastBody(http).contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
    ]);
  });
});

describe("response: reading a functionCall", () => {
  it("reports a unary functionCall part as a tool call with JSON-text arguments", async () => {
    const { interp: m } = make(() => ({
      status: 200,
      body: {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: "read_file", args: { path: "README.md" } } }] },
            finishReason: "STOP",
          },
        ],
      },
    }));
    const calls: ToolCall[] = [];
    const text = await drain(
      m.generateText("key:t", { model: MODEL, messages: [{ role: "user", content: "go" }], onToolCall: (c) => calls.push(c), stream: false }),
    );

    // No text parts in the response, so no transcript — the regression was that this was ALL there
    // was: an empty answer and no tool call.
    expect(text).toBe("");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("read_file");
    // `arguments` is JSON *text* — the internal contract every consumer parses — even though Gemini
    // sent an object.
    expect(calls[0]!.arguments).toBe('{"path":"README.md"}');
    expect(JSON.parse(calls[0]!.arguments!)).toEqual({ path: "README.md" });
  });

  it("ignores text parts sitting beside a functionCall, and vice versa", async () => {
    const { interp: m } = make(() => ({
      status: 200,
      body: {
        candidates: [
          {
            content: { parts: [{ text: "Let me check." }, { functionCall: { name: "list_dir", args: {} } }] },
            finishReason: "STOP",
          },
        ],
      },
    }));
    const calls: ToolCall[] = [];
    const text = await drain(
      m.generateText("key:t", { model: MODEL, messages: [], onToolCall: (c) => calls.push(c), stream: false }),
    );
    expect(text).toBe("Let me check.");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe("list_dir");
    // An empty argument object is "no arguments", not a missing value — the loop parses it to {}.
    expect(JSON.parse(calls[0]!.arguments ?? "null")).toEqual({});
  });

  it("stays silent when the caller registers no handler", async () => {
    const { interp: m } = make(() => ({
      status: 200,
      body: { candidates: [{ content: { parts: [{ functionCall: { name: "x", args: {} } }] }, finishReason: "STOP" }] },
    }));
    const text = await drain(m.generateText("key:t", { model: MODEL, messages: [], stream: false }));
    expect(text).toBe("");
  });
});

describe("response: reading a streamed functionCall", () => {
  it("reports each whole call once, keeping several distinct", async () => {
    const { interp: m } = make(() => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      lines: [
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Let me look." }] } }] })}`,
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "a.txt" } } }] } }] })}`,
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "list_dir", args: { path: "." } } }] } }] })}`,
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: " done" }] }, finishReason: "STOP" }] })}`,
      ],
    }));
    const calls: ToolCall[] = [];
    const text = await drain(
      m.generateText("key:t", { model: MODEL, messages: [], onToolCall: (c) => calls.push(c), stream: true }),
    );

    expect(text).toBe("Let me look. done");
    // Two calls, not one merged: `streamedAs: "whole"` must not fall into the fragment
    // accumulator, which reads `function.arguments` (absent here) and would drop both.
    expect(calls.map((c) => c.name)).toEqual(["read_file", "list_dir"]);
    expect(JSON.parse(calls[0]!.arguments!)).toEqual({ path: "a.txt" });
    expect(JSON.parse(calls[1]!.arguments!)).toEqual({ path: "." });
  });

  it("reports a tool-only stream with no text at all", async () => {
    const { interp: m } = make(() => ({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      lines: [
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: "read_file", args: { path: "a" } } }] } }] })}`,
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] })}`,
      ],
    }));
    const calls: ToolCall[] = [];
    const text = await drain(
      m.generateText("key:t", { model: MODEL, messages: [], onToolCall: (c) => calls.push(c), stream: true }),
    );
    expect(text).toBe("");
    expect(calls).toHaveLength(1);
  });
});
