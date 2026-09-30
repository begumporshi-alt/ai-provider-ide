/**
 * Dialect message normalization (v1.1 amendment 2026-09-30).
 *
 * The assistant loop speaks OpenAI roles internally (`user | assistant | system | tool`), but the
 * three dialects shape messages differently:
 *  - Anthropic has no `system` in `messages`; it is a top-level param. Tool results are `user`.
 *  - Gemini calls the assistant `model`; tool results are `user`. It has no system param.
 *  - OpenAI is pass-through.
 *
 * The bug: every template received `{{messages}}` with raw OpenAI-shaped messages, and Anthropic
 * and Gemini rejected or mis-parsed them. The fix is declarative: `messagesRoleMap` maps internal
 * roles to dialect roles (with `null` meaning "hoist to the system field"), and the interpreter's
 * `normalizeDialectMessages` applies the map at render time.
 *
 * These tests assert on the REQUEST BODY the three dialects actually put on the wire — the
 * end-to-end contract from the assistant's message array to the provider's expected shape.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES } from "../src/builtin-templates.js";
import { ManifestInterpreter } from "../src/manifest-interpreter.js";
import { FakeHttp } from "./fakes.js";

type CaptureResponder = {
  lastBody: Record<string, unknown> | undefined;
  status: number;
  body: unknown;
};

/** An interpreter that captures the request body it sends. */
function capture(dialect: "openai-compat" | "anthropic-compat" | "gemini-compat", response: unknown): { interp: ManifestInterpreter; http: FakeHttp; lastBody: () => Record<string, unknown> | undefined } {
  let last: CaptureResponder = { lastBody: undefined, status: 200, body: response };
  const http = new FakeHttp((url, init) => {
    if (init.body) last.lastBody = JSON.parse(init.body);
    last.status = 200;
    return { status: 200, body: response };
  });
  const interp = new ManifestInterpreter(BUILTIN_TEMPLATES[dialect]("https://api.test/v1"), { http, vars: {} });
  return {
    interp,
    http,
    lastBody: () => last.lastBody,
  };
}

const MESSAGES = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Hello" },
  { role: "assistant", content: "Hi there" },
  { role: "tool", content: "result of tool call", tool_call_id: "call_123" },
];

async function drain(interp: ManifestInterpreter, args: Parameters<ManifestInterpreter["generateText"]>[1]): Promise<void> {
  for await (const _ of interp.generateText("key:t", args)) void _;
}

describe("openai-compat: pass-through role map", () => {
  it("sends system messages in the messages array, role 'system'", async () => {
    const { interp, lastBody } = capture("openai-compat", { choices: [{ message: { content: "ok" } }] });
    await drain(interp, { model: "gpt-4o", messages: MESSAGES, stream: false });
    const body = lastBody()!;
    const msgs = body.messages as Array<{ role: string }>;
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(msgs[0]!.content).toBe("You are a helpful assistant.");
    // No top-level system param (OpenAI takes it in the array).
    expect(body).not.toHaveProperty("system");
  });

  it("passes tool_choice through untouched", async () => {
    const { interp, lastBody } = capture("openai-compat", { choices: [{ message: { content: "ok" } }] });
    await drain(interp, { model: "gpt-4o", messages: MESSAGES, stream: false, toolChoice: "auto" });
    expect(lastBody()!.tool_choice).toBe("auto");
  });
});

describe("anthropic-compat: system hoist + role remap", () => {
  it("hoists system messages to the top-level 'system' param, removing them from messages", async () => {
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: MESSAGES, stream: false });
    const body = lastBody()!;
    const msgs = body.messages as Array<{ role: string }>;
    // system is gone from the array; the three remaining roles are user / assistant / "user" (tool→user).
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // System content was hoisted into the top-level `system` field.
    expect(body.system).toBe("You are a helpful assistant.");
  });

  it("translates 'auto' tool_choice to Anthropic's {type:'const', value:'any'}", async () => {
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, toolChoice: "auto" });
    expect(lastBody()!.tool_choice).toEqual({ type: "const", value: "any" });
  });

  it("translates 'none' tool_choice to Anthropic's {type:'const', value:'none'}", async () => {
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, toolChoice: "none" });
    expect(lastBody()!.tool_choice).toEqual({ type: "const", value: "none" });
  });

  it("translates {type:'function',function:{name:'fn'}} to {type:'tool',name:'fn'}", async () => {
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, toolChoice: { type: "function", function: { name: "read_file" } } });
    expect(lastBody()!.tool_choice).toEqual({ type: "tool", name: "read_file" });
  });

  it("omits tool_choice when the caller supplies none", async () => {
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false });
    expect(lastBody()).not.toHaveProperty("tool_choice");
  });

  it("drops tool_call_id — Anthropic's turn shape carries no such concept", async () => {
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: MESSAGES, stream: false });
    const toolMsg = (lastBody()!.messages as Array<Record<string, unknown>>).find((m) => m.role === "user" && m.content === "result of tool call");
    expect(toolMsg).toBeDefined();
    expect(toolMsg).not.toHaveProperty("tool_call_id");
  });

  it("surfaces finish_reason from stop_reason via onFinish", async () => {
    let finish: string | undefined;
    const http = new FakeHttp(() => ({ status: 200, body: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } }));
    const interp = new ManifestInterpreter(BUILTIN_TEMPLATES["anthropic-compat"]("https://api.test/v1"), { http, vars: {} });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, onFinish: (r) => { finish = r; } });
    expect(finish).toBe("end_turn");
  });
});

describe("gemini-compat: assistant→model, tool→user, no system field", () => {
  it("remaps assistant to 'model' and tool to 'user', drops system entirely", async () => {
    const { interp, lastBody } = capture("gemini-compat", { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    await drain(interp, { model: "models/gemini-2.0-flash", messages: MESSAGES, stream: false });
    const body = lastBody()!;
    const contents = body.contents as Array<{ role: string; parts: unknown[] }>;
    // System is hoisted-but-discarded (no systemField), so only 3 entries remain.
    expect(contents).toHaveLength(3);
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
  });

  it("surfaces finish_reason from candidates[0].finishReason via onFinish", async () => {
    let finish: string | undefined;
    const http = new FakeHttp(() => ({
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] },
    }));
    const interp = new ManifestInterpreter(BUILTIN_TEMPLATES["gemini-compat"]("https://generativelanguage.googleapis.com"), { http, vars: {} });
    await drain(interp, { model: "models/gemini-2.0-flash", messages: [], stream: false, onFinish: (r) => { finish = r; } });
    expect(finish).toBe("STOP");
  });

  it("captures finish_reason from the stream's final chunk", async () => {
    let finish: string | undefined;
    const http = new FakeHttp(() => ({
      status: 200,
      lines: [
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hi" }] } }] })}`,
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: " there" }] }, finishReason: "STOP" }] })}`,
      ],
    }));
    const interp = new ManifestInterpreter(BUILTIN_TEMPLATES["gemini-compat"]("https://generativelanguage.googleapis.com"), { http, vars: {} });
    await drain(interp, { model: "models/gemini-2.0-flash", messages: [], stream: true, onFinish: (r) => { finish = r; } });
    expect(finish).toBe("STOP");
  });

  it("captures finish_reason from the stream's final chunk — Anthropic stop_reason", async () => {
    let finish: string | undefined;
    const http = new FakeHttp(() => ({
      status: 200,
      lines: [
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } })}`,
        `data: ${JSON.stringify({ type: "message_stop" })}`,
      ],
    }));
    const interp = new ManifestInterpreter(BUILTIN_TEMPLATES["anthropic-compat"]("https://api.test/v1"), { http, vars: {} });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: true, onFinish: (r) => { finish = r; } });
    expect(finish).toBe("tool_use");
  });
});
