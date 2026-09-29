/**
 * Anthropic `content` is a MIXED block array, and which block leads is the provider's choice.
 *
 * Measured 2026-09-29 against `agentrouter.org` (`deepseek-v4-flash`, extended thinking on), the
 * non-stream response was:
 *
 *   {"content":[{"type":"thinking","thinking":"…"},{"type":"text","text":"ok"}], "stop_reason":"end_turn"}
 *
 * The template's `text` selector was `$.content[0].text`, which on that body resolves to
 * `undefined` — so the interpreter yielded **nothing at all**. The request succeeded, the text was
 * in the response, and the caller received an empty message.
 *
 * The streaming path was already correct and is not what this file pins: there, text and thinking
 * are told apart by field name (`delta.text` vs `delta.thinking`), so `chunkMap.delta` never saw a
 * thinking delta. The two paths disagreed, and the non-stream one was wrong.
 *
 * The same host's *other* defect — it serves both dialects, so the fingerprinter cannot classify it
 * — is covered by `provider-profile.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES } from "../src/builtin-templates.js";
import { ManifestInterpreter } from "../src/manifest-interpreter.js";
import { FakeHttp } from "./fakes.js";

async function collect(gen: AsyncGenerator<string, void, void>): Promise<string> {
  let out = "";
  for await (const c of gen) out += c;
  return out;
}

/** An anthropic-compat interpreter that answers /messages with `body`, non-stream. */
function anthropic(body: unknown) {
  return new ManifestInterpreter(BUILTIN_TEMPLATES["anthropic-compat"]("https://api.test/v1"), {
    http: new FakeHttp((url) => (url.endsWith("/messages") ? { status: 200, body } : { status: 404 })),
    vars: {},
  });
}

function readText(interp: ManifestInterpreter) {
  return collect(
    interp.generateText("key:t", {
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }),
  );
}

describe("anthropic text is read from the block array, not block 0", () => {
  it("reads the text block when a thinking block leads — the agentrouter shape", async () => {
    const text = await readText(
      anthropic({
        content: [
          { type: "thinking", thinking: "The user wants exactly \"ok\".", signature: "sig" },
          { type: "text", text: "ok" },
        ],
        stop_reason: "end_turn",
      }),
    );
    // The regression: `$.content[0].text` is undefined here, so this was "".
    expect(text).toBe("ok");
  });

  it("reads a leading text block as before", async () => {
    const text = await readText(anthropic({ content: [{ type: "text", text: "hi" }] }));
    expect(text).toBe("hi");
  });

  it("concatenates several text blocks", async () => {
    const text = await readText(
      anthropic({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
    );
    expect(text).toBe("ab");
  });

  it("yields nothing when the response carries only a thinking block", async () => {
    const text = await readText(
      anthropic({ content: [{ type: "thinking", thinking: "private reasoning", signature: "s" }] }),
    );
    // Reasoning is not text. Reading `thinking` as the answer would put the model's scratchpad in
    // the transcript — a worse failure than the empty one this file is about.
    expect(text).toBe("");
  });

  it("reports a tool call and the text block from the same array", async () => {
    const calls: unknown[] = [];
    const interp = anthropic({
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
      ],
      stop_reason: "tool_use",
    });
    const text = await collect(
      interp.generateText("key:t", {
        model: "claude-x",
        messages: [{ role: "user", content: "read the readme" }],
        stream: false,
        onToolCall: (c) => calls.push(c),
      }),
    );
    // Both selectors read the same array; each takes what its own block type carries, so neither
    // can claim the other's block.
    expect(text).toBe("Let me check.");
    expect(calls).toHaveLength(1);
  });

  it("leaves a scalar text path alone — the openai dialect is unaffected", async () => {
    const interp = new ManifestInterpreter(BUILTIN_TEMPLATES["openai-compat"]("https://api.test/v1"), {
      http: new FakeHttp((url) =>
        url.endsWith("/chat/completions")
          ? { status: 200, body: { choices: [{ message: { content: "hi" } }] } }
          : { status: 404 },
      ),
      vars: {},
    });
    const text = await collect(
      interp.generateText("key:t", {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    );
    expect(text).toBe("hi");
  });
});
