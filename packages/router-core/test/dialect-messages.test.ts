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

/** A wire message as the assertions read it: the role, and optionally the content. */
type WireMessage = { role: string; content?: unknown };

/** An interpreter that captures the request body it sends. */
function capture(dialect: "openai-compat" | "anthropic-compat" | "gemini-compat", response: unknown): { interp: ManifestInterpreter; http: FakeHttp; lastBody: () => Record<string, unknown> | undefined } {
  let last: CaptureResponder = { lastBody: undefined, status: 200, body: response };
  const http = new FakeHttp((_url, init) => {
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
    const msgs = body.messages as WireMessage[];
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
    const msgs = body.messages as WireMessage[];
    // system is gone from the array; the three remaining roles are user / assistant / "user" (tool→user).
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // System content was hoisted into the top-level `system` field.
    expect(body.system).toBe("You are a helpful assistant.");
  });

  it("translates 'auto' tool_choice to Anthropic's {type:'auto'}", async () => {
    // The previous declaration emitted {type:"const", value:"any"} — a `const` type in no Anthropic
    // API surface — and mapped auto to ANY, which would have FORCED a tool call on every agent
    // request rather than letting the model decide. These pin the real schema.
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, toolChoice: "auto" });
    expect(lastBody()!.tool_choice).toEqual({ type: "auto" });
  });

  it("translates 'none' tool_choice to Anthropic's {type:'none'}", async () => {
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, toolChoice: "none" });
    expect(lastBody()!.tool_choice).toEqual({ type: "none" });
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

  it("replays a tool turn as tool_use and tool_result blocks, not OpenAI sibling fields", async () => {
    // The 2026-10-01 shaping: the call is a `tool_use` CONTENT BLOCK on the assistant turn, the
    // result a `tool_result` block on a user turn, addressed by the call's id. Before this the
    // OpenAI sibling fields (`tool_calls`, `role:"tool"` + tool_call_id) were forwarded and the
    // result reached the model as an anonymous plain-text user turn.
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: MESSAGES, stream: false });
    const wire = JSON.stringify(lastBody());
    expect(wire).not.toContain('"tool_calls"');
    expect(wire).not.toContain('tool_call_id');
    const msgs = lastBody()!.messages as Array<{ role: string; content: unknown }>;
    // This fixture's assistant turn declares no tool_calls, so its content is untouched — and
    // Anthropic declares no `contentField`, so plain-string content stays a plain string.
    const assistant = msgs.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("Hi there");
    // **Flipped 2026-10-02.** This used to pin a `tool_result` block for `MESSAGES`' result, whose
    // `call_123` no turn in the payload declares. Reproduced against agentrouter.org's Anthropic
    // route: a `tool_result` addressing a call the request does not contain is refused outright —
    // `unexpected \`messages.2.content.0: tool_use_id\` found in \`tool_result\` blocks: <id>` — so
    // that shape 400'd the whole turn, which is the live failure this came from. A block can only
    // be legal when the call it answers is present, so the result rides as an ordinary user turn
    // instead and the model still reads the output.
    expect(wire).not.toContain("tool_result");
    const result = msgs.find(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("result of tool call"),
    )!;
    expect(result).toBeDefined();
  });

  it("surfaces finish_reason from stop_reason via onFinish, in the OpenAI vocabulary", async () => {
    let finish: string | undefined;
    const http = new FakeHttp(() => ({ status: 200, body: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } }));
    const interp = new ManifestInterpreter(BUILTIN_TEMPLATES["anthropic-compat"]("https://api.test/v1"), { http, vars: {} });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, onFinish: (r) => { finish = r; } });
    // `end_turn` maps to `stop` (v1.1 2026-10-01). Both consumers of this router speak OpenAI —
    // the app warns when `reason === "length"`, the gateway writes it onto an OpenAI-shaped
    // `finish_reason` — so the raw dialect word has to be translated at the source.
    expect(finish).toBe("stop");
  });

  it("translates a max_tokens truncation to OpenAI's 'length'", async () => {
    // The defect this pins: Anthropic reports `max_tokens` and OpenAI says `length`, so the app's
    // truncation warning (`finishReason === "length"`) never fired on an Anthropic provider and a
    // cut-off answer looked complete.
    let finish: string | undefined;
    const http = new FakeHttp(() => ({ status: 200, body: { content: [{ type: "text", text: "ok" }], stop_reason: "max_tokens" } }));
    const interp = new ManifestInterpreter(BUILTIN_TEMPLATES["anthropic-compat"]("https://api.test/v1"), { http, vars: {} });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, onFinish: (r) => { finish = r; } });
    expect(finish).toBe("length");
  });

  it("a caller's output budget overrides the manifest's, which is the lever for a reasoning model", async () => {
    // `max_tokens` on this dialect covers the model's **reasoning and its answer together**, and
    // the manifest's own `limits.maxOutputTokens` (8192) is a request-side default, not a property
    // of the model. Measured 2026-10-02 against `agentrouter.org` (`deepseek-v4-flash`): at 8192 a
    // hard prompt spent every token thinking and opened no text block at all (`stop_reason:
    // max_tokens`, `output_tokens: 8192`, zero text); the same prompt at 64000 answered, having
    // used 13211. So the caller's value MUST win — the composer's "max tokens" field is what makes
    // such a model usable, and letting the manifest's default override it would silently put the
    // working lever out of reach.
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, maxTokens: 32000 });
    expect(lastBody()!.max_tokens).toBe(32000);

    // And with no caller value the manifest's limit is what goes on the wire — the budget the
    // truncation above happened at.
    const bare = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(bare.interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false });
    expect(bare.lastBody()!.max_tokens).toBe(8192);
  });

  it("passes an unnamed reason through raw rather than dropping it", async () => {
    // A dialect that knows some of its reasons should still surface the rest — Anthropic has added
    // stop reasons before and will again, and an unrecognised word beats `undefined`.
    let finish: string | undefined;
    const http = new FakeHttp(() => ({ status: 200, body: { content: [{ type: "text", text: "ok" }], stop_reason: "model_context_window_exceeded" } }));
    const interp = new ManifestInterpreter(BUILTIN_TEMPLATES["anthropic-compat"]("https://api.test/v1"), { http, vars: {} });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, onFinish: (r) => { finish = r; } });
    expect(finish).toBe("model_context_window_exceeded");
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

  it("surfaces finish_reason from candidates[0].finishReason via onFinish, in the OpenAI vocabulary", async () => {
    let finish: string | undefined;
    const http = new FakeHttp(() => ({
      status: 200,
      body: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] },
    }));
    const interp = new ManifestInterpreter(BUILTIN_TEMPLATES["gemini-compat"]("https://generativelanguage.googleapis.com"), { http, vars: {} });
    await drain(interp, { model: "models/gemini-2.0-flash", messages: [], stream: false, onFinish: (r) => { finish = r; } });
    // Gemini's `STOP` maps to OpenAI's `stop` (v1.1 2026-10-01) — see the anthropic case above.
    expect(finish).toBe("stop");
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
    expect(finish).toBe("stop");
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
    // `tool_use` maps to OpenAI's `tool_calls`.
    expect(finish).toBe("tool_calls");
  });

  it("a declared-finish stream that ends without a finish reason fires onFinish(undefined) — the truncation signal", async () => {
    // The agent loop's truncation retry is built on this distinction: the callback FIRING with
    // undefined means the provider closed a stream whose manifest declares a finish selector —
    // measured 2026-10-03 on vyceai/deepseek: prose arrived, the finish reason never did, and the
    // turn read as a clean success. A callback that never fires (next test) means no selector was
    // declared and the caller cannot judge.
    let fired = false;
    let finish: string | undefined;
    // One text delta and then [DONE] — the shape a cut-off provider produces.
    const http = new FakeHttp(() => ({
      status: 200,
      lines: [
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "First, let me check" } })}`,
        "data: [DONE]",
      ],
    }));
    const interp = new ManifestInterpreter(BUILTIN_TEMPLATES["anthropic-compat"]("https://api.test/v1"), { http, vars: {} });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: true, onFinish: (r) => { fired = true; finish = r; } });
    expect(fired).toBe(true);
    expect(finish).toBeUndefined();
  });

  it("a manifest that declares no finish selector never fires onFinish", async () => {
    let fired = false;
    const tmpl = JSON.parse(JSON.stringify(BUILTIN_TEMPLATES["anthropic-compat"]("https://api.test/v1")));
    delete tmpl.endpoints.generateText.stream.finish;
    delete tmpl.endpoints.generateText.responseFinish;
    const http = new FakeHttp(() => ({
      status: 200,
      lines: [
        `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
        `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}`,
        `data: ${JSON.stringify({ type: "message_stop" })}`,
      ],
    }));
    const interp = new ManifestInterpreter(tmpl, { http, vars: {} });
    await drain(interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: true, onFinish: () => { fired = true; } });
    expect(fired).toBe(false);
  });
});

/**
 * Multimodal forwarding (v1.1 amendment 2026-10-01).
 *
 * The same request — one user turn carrying text and a PNG — through all three dialects, asserted on
 * the body that actually goes on the wire. This is the test that makes the `contentPartTemplates`
 * declaration real: each dialect's block is checked for its own nesting, because the differences are
 * exactly where a hand-written mapping goes wrong (`{type,url}` vs `{type,image_url:{url}}` differ by
 * one level; Gemini has no `type` field at all).
 */
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const MULTIMODAL = [
  {
    role: "user",
    content: [
      { type: "text", text: "what is this?" },
      { type: "image", mediaType: "image/png", dataBase64: PNG_1PX },
    ],
  },
];

describe("multimodal content parts reach each dialect in its own shape", () => {
  it("openai-compat: image_url carrying a data URI", async () => {
    const { interp, lastBody } = capture("openai-compat", { choices: [{ message: { content: "ok" } }] });
    await drain(interp, { model: "gpt-4o", messages: MULTIMODAL, stream: false });
    const msgs = lastBody()!.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]!.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1PX}` } },
    ]);
  });

  it("anthropic-compat: a base64 source block, media type beside the bytes", async () => {
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: MULTIMODAL, stream: false });
    const msgs = lastBody()!.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[0]!.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1PX } },
    ]);
  });

  it("gemini-compat: inlineData with no type field", async () => {
    const { interp, lastBody } = capture("gemini-compat", { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    await drain(interp, { model: "models/gemini-2.0-flash", messages: MULTIMODAL, stream: false });
    const contents = lastBody()!.contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[0]!.parts).toEqual([
      { text: "what is this?" },
      { inlineData: { mimeType: "image/png", data: PNG_1PX } },
    ]);
  });

  it("a hoisted system message carrying parts becomes text, not '[object Object]'", async () => {
    // Anthropic takes the system prompt as a top-level string. A parts-shaped system message used to
    // render as `[object Object]` — the provider would receive that as its instructions.
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, {
      model: "claude-x",
      messages: [{ role: "system", content: [{ type: "text", text: "be terse" }] }, ...MULTIMODAL],
      stream: false,
    });
    expect(lastBody()!.system).toBe("be terse");
  });

  it("a text-only string turn keeps its plain-string shape", async () => {
    // Nothing about supporting attachments may upgrade an ordinary message into an array: a dialect
    // without part templates handles a string and only a string.
    const { interp, lastBody } = capture("openai-compat", { choices: [{ message: { content: "ok" } }] });
    await drain(interp, { model: "gpt-4o", messages: [{ role: "user", content: "plain" }], stream: false });
    expect((lastBody()!.messages as Array<{ content: unknown }>)[0]!.content).toBe("plain");
  });
});


describe("tool turns on replay: only a dialect that asks is reshaped", () => {
  /**
   * An assistant turn that declared a call, plus the result answering it. This is what the agent
   * loop replays on its second iteration, and each dialect needs it in its own place: OpenAI as a
   * sibling `tool_calls` array answered by `role:"tool"`, Gemini as `functionCall`/`functionResponse`
   * parts (see gemini-tools.test.ts).
   */
  const TOOL_TURN = [
    { role: "user", content: "read it" },
    {
      role: "assistant",
      content: "Reading.",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }],
    },
    { role: "tool", content: "file text", tool_call_id: "c1" },
  ];

  it("openai-compat keeps the sibling tool_calls array and the role:'tool' result", async () => {
    // OpenAI is the one dialect whose shape the shaper must NOT touch: it reads `tool_calls` on the
    // assistant turn and a `tool` role for the answer. Declaring a `toolCall` part template here
    // would move the call into the content array and break every OpenAI tool call.
    const { interp, lastBody } = capture("openai-compat", { choices: [{ message: { content: "ok" } }] });
    await drain(interp, { model: "gpt-4o", messages: [...TOOL_TURN], stream: false });

    const msgs = lastBody()!.messages as Array<Record<string, unknown>>;
    expect(msgs[1]!.tool_calls).toEqual(TOOL_TURN[1]!.tool_calls);
    expect(msgs[1]!.content).toBe("Reading.");
    expect(msgs[2]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "file text" });
  });

  it("anthropic-compat reshapes the replay too, as tool_use / tool_result blocks", async () => {
    // Updated 2026-10-01: this test used to pin that Anthropic's replay was left on the OpenAI
    // sibling fields ("a separate, unmodelled gap"). The gap is now modelled — the call is a
    // tool_use block on the assistant turn, the result a tool_result block on a user turn — so
    // the pin flipped from "unchanged" to "the dialect's own shape".
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: [...TOOL_TURN], stream: false });

    const wire = JSON.stringify(lastBody());
    expect(wire).not.toContain('"tool_calls"');
    const msgs = lastBody()!.messages as Array<{ role: string; content: unknown }>;
    expect(msgs[1]!.content).toEqual([
      { type: "text", text: "Reading." },
      { type: "tool_use", id: "c1", name: "read_file", input: { path: "a" } },
    ]);
    expect(msgs[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "file text" },
    ]);
  });

  it("anthropic-compat collapses a turn's several results into the ONE user message Anthropic requires", async () => {
    // Measured live (agentrouter, 2026-10-01): a turn that made two calls replayed as two
    // consecutive tool messages went out as two consecutive user messages, and the provider
    // rejected the second — `unexpected messages.3.content.0: tool_use_id found in tool_result
    // blocks` — because only the single message following the assistant turn may answer it.
    // Every result of a turn belongs in that one message.
    const parallel = [
      { role: "user", content: "read both" },
      {
        role: "assistant",
        content: "Reading.",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
          { id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"b"}' } },
        ],
      },
      { role: "tool", content: "file a", tool_call_id: "c1" },
      { role: "tool", content: "file b", tool_call_id: "c2" },
    ];
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: parallel, stream: false });

    const msgs = lastBody()!.messages as Array<{ role: string; content: unknown }>;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[2]!.content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "file a" },
      { type: "tool_result", tool_use_id: "c2", content: "file b" },
    ]);
  });

  it("anthropic-compat never sends a tool_result whose call the request does not declare", async () => {
    // The exact 400 the live app hit on 2026-10-02, reproduced against agentrouter.org with a
    // hand-built body. A result naming a call that is not in the request is refused as
    //   unexpected `messages.2.content.0: tool_use_id` found in `tool_result` blocks: .
    // — note the EMPTY id list, which is the signature of a missing `tool_call_id`: the shaper used
    // to fall back to `""` and render the block anyway, so `tool_use_id: ""` went out and the whole
    // turn was refused. An id that names nothing can never be paired, by any dialect.
    const orphaned = [
      { role: "user", content: "read it" },
      { role: "assistant", content: "Reading." }, // declares no call at all
      { role: "tool", content: "file a", tool_call_id: "c1" }, // answers a call that is gone
      { role: "tool", content: "no id was recorded" }, // `tool_call_id` missing entirely
    ];
    const { interp, lastBody } = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(interp, { model: "claude-x", messages: orphaned, stream: false });

    const wire = JSON.stringify(lastBody());
    expect(wire).not.toContain("tool_result");
    expect(wire).not.toContain('"tool_use_id"');
    // The output is not discarded along with the block: the role map turns each into an ordinary
    // user turn, so the model still sees what the tool produced.
    expect(wire).toContain("file a");
    expect(wire).toContain("no id was recorded");
  });
});

describe("the caller's thinking knob (`reasoningValues`)", () => {
  it("renders into each dialect's own request field", async () => {
    // Anthropic: an object with a budget. OpenAI: the level word. Gemini: a nested config. One
    // value per dialect, from one caller setting — so the three levels mean the same thing
    // everywhere and the request template is where a dialect's own shape is declared.
    const a = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(a.interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, reasoning: "medium" });
    expect(a.lastBody()!.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });

    const o = capture("openai-compat", { choices: [{ message: { content: "ok" } }] });
    await drain(o.interp, { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false, reasoning: "medium" });
    expect(o.lastBody()!.reasoning_effort).toBe("medium");

    const g = capture("gemini-compat", { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    await drain(g.interp, { model: "models/gemini-2.0-flash", messages: [{ role: "user", content: "hi" }], stream: false, reasoning: "low" });
    expect((g.lastBody()!.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({
      thinkingBudget: 1024,
    });
  });

  it("off is a real request on Anthropic and budget 0 on Gemini, an omission on OpenAI", async () => {
    // Probed 2026-10-02 on `agentrouter.org` (`deepseek-v4-flash`): `thinking:{type:"disabled"}`
    // is answered in a fraction of the all-thinking time — the real fix for a model that would
    // otherwise spend its entire output budget thinking. The OpenAI-compatible vocabulary has no
    // portable off, so omitting (the provider's default) is the honest rendering there.
    const a = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(a.interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, reasoning: "off" });
    expect(a.lastBody()!.thinking).toEqual({ type: "disabled" });

    const g = capture("gemini-compat", { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    await drain(g.interp, { model: "models/gemini-2.0-flash", messages: [{ role: "user", content: "hi" }], stream: false, reasoning: "off" });
    // D87 reconciliation: `thinkingBudget: 0` is a deterministic 400 on 2.5 Pro, so `off` omits
    // the field entirely — the Rust port has pinned exactly this since 2026-10-03
    // (`reasoning_off_omits_the_gemini_thinking_config`); this pin demanded the opposite until now.
    expect((g.lastBody()!.generationConfig as Record<string, unknown>).thinkingConfig).toBeUndefined();

    const o = capture("openai-compat", { choices: [{ message: { content: "ok" } }] });
    await drain(o.interp, { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false, reasoning: "off" });
    expect(o.lastBody()).not.toHaveProperty("reasoning_effort");
  });

  it("clamps the thinking budget under the request's output ceiling, per Anthropic's rule", async () => {
    // Anthropic requires `1024 <= budget_tokens < max_tokens`, and the answer needs room inside the
    // same cap — thinking runs first, so a budget that leaves the answer nothing is how a turn ends
    // with zero text. At the manifest's 8192 default a "high" 8192 budget lands at 6144, which
    // reserves 2048 for the answer; a tiny ceiling floors the budget at the API minimum instead of
    // sending something illegal.
    const high = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(high.interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, reasoning: "high" });
    expect(high.lastBody()!.thinking).toEqual({ type: "enabled", budget_tokens: 6144 });

    const tiny = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(tiny.interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, reasoning: "high", maxTokens: 1500 });
    expect(tiny.lastBody()!.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });

    // A cap that cannot hold thinking and an answer both asks for none at all, rather than a budget
    // the provider refuses — the regression for the turn that spent its whole cap thinking, "high"
    // requested or not, and rendered nothing.
    const starved = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(starved.interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, reasoning: "high", maxTokens: 1024 });
    expect(starved.lastBody()!.thinking).toEqual({ type: "disabled" });
  });

  it("a generous ceiling leaves the requested level alone", async () => {
    // The allowance is a reserve, not a tax: at a cap with room to spare the level's own budget is
    // what reaches the wire. This is the configuration the reasoning fix was measured against —
    // 64000 answered using 13211 tokens — so it must not shift.
    const high = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(high.interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false, reasoning: "high", maxTokens: 64000 });
    expect(high.lastBody()!.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  it("an unset knob puts none of the fields on the wire", async () => {
    // The contract for "unset" is the provider's own default: no field, no guess.
    const a = capture("anthropic-compat", { content: [{ type: "text", text: "ok" }] });
    await drain(a.interp, { model: "claude-x", messages: [{ role: "user", content: "hi" }], stream: false });
    expect(a.lastBody()).not.toHaveProperty("thinking");

    const o = capture("openai-compat", { choices: [{ message: { content: "ok" } }] });
    await drain(o.interp, { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false });
    expect(o.lastBody()).not.toHaveProperty("reasoning_effort");

    const g = capture("gemini-compat", { candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    await drain(g.interp, { model: "models/gemini-2.0-flash", messages: [{ role: "user", content: "hi" }], stream: false });
    expect(g.lastBody()!.generationConfig as Record<string, unknown>).not.toHaveProperty("thinkingConfig");
  });
});
