import { describe, it, expect } from "vitest";
import { attachToolParts } from "../src/tool-shaping";
import { renderTemplate } from "../src/template";
import { normalizeGatewayRequest } from "../src/gateway-normalizer";

const body = {
  model: "deepseek-v4-flash",
  messages: [
    { role: "user", content: "list the files" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_abc", type: "function", function: { name: "ls", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call_abc", content: "file-a.txt\nfile-b.txt" },
  ],
};

describe("tool result content survives gateway normalization (2026-10-05 empty-tool-result bug)", () => {
  it("anthropic dialect: tool_result content survives normalization", () => {
    const normalized: any = normalizeGatewayRequest(body as any, { clientHint: "generic" });

    const templates = {
      toolResult: { type: "tool_result", tool_use_id: "{{id}}", content: "{{text}}" },
    };
    const out: any[] = attachToolParts(
      normalized.messages,
      templates as any,
      (tpl, vals) => renderTemplate(tpl, vals),
    );
    const user = out.find((m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "tool_result"));
    const block = user.content.find((p: any) => p.type === "tool_result");
    expect(block.content).toBe("file-a.txt\nfile-b.txt");
  });

  it("phase F arrays every message but a tool result (OpenAI dialect passes tool content through verbatim)", () => {
    const normalized: any = normalizeGatewayRequest(body as any, { clientHint: "generic" });
    const user = normalized.messages.find((m: any) => m.role === "user");
    expect(user.content).toEqual([{ type: "text", text: "list the files" }]);
    const tool = normalized.messages.find((m: any) => m.role === "tool");
    expect(tool.content).toBe("file-a.txt\nfile-b.txt");
  });

  it("an empty assistant turn contributes no text block, so no part the caller never sent is rendered", () => {
    // The fixture above is the shape every agent transcript has: the assistant turn that calls a
    // tool carries `content: ""`. Phase F used to spell that empty string as
    // `[{type:"text",text:""}]`, and the assistant branch of `attachToolParts` rendered the empty
    // block beside the `tool_use` — a content part the caller never sent. Measured 2026-10-14
    // (D107): `agent-router` answered those requests `500 … "invalid_request_error"` with
    // `tokens_in = 0`, on every dial.
    const normalized: any = normalizeGatewayRequest(body as any, { clientHint: "generic" });

    // Phase F leaves the empty string alone rather than fabricating a part from it.
    const assistant = normalized.messages.find((m: any) => m.role === "assistant");
    expect(assistant.content).toBe("");

    const templates = {
      toolCall: { type: "tool_use", id: "{{id}}", name: "{{name}}", input: "{{argumentsObject}}" },
      toolResult: { type: "tool_result", tool_use_id: "{{id}}", content: "{{text}}" },
    };
    const out: any[] = attachToolParts(
      normalized.messages,
      templates as any,
      (tpl, vals) => renderTemplate(tpl, vals),
    );
    const rendered = out.find(
      (m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "tool_use"),
    );
    expect(rendered.content).toEqual([
      { type: "tool_use", id: "call_abc", name: "ls", input: {} },
    ]);
  });

  it("drops an empty text part a client sent already spelled as an array", () => {
    // The other spelling, and the one the Phase F guard cannot reach: a client that sends content
    // as a parts array puts the empty part on the wire itself, so Phase F skips the message
    // (already an array) and only `asParts` can remove the block before it is rendered. Pinned
    // separately from the case above because the two guards are not interchangeable — removing
    // either one alone left the other's path silently uncovered.
    const arraySpelled = {
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "list the files" },
        {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          tool_calls: [{ id: "call_abc", type: "function", function: { name: "ls", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_abc", content: "file-a.txt\nfile-b.txt" },
      ],
    };
    const normalized: any = normalizeGatewayRequest(arraySpelled as any, { clientHint: "generic" });
    const templates = {
      toolCall: { type: "tool_use", id: "{{id}}", name: "{{name}}", input: "{{argumentsObject}}" },
    };
    const out: any[] = attachToolParts(
      normalized.messages,
      templates as any,
      (tpl, vals) => renderTemplate(tpl, vals),
    );
    const rendered = out.find(
      (m) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "tool_use"),
    );
    expect(rendered.content).toEqual([
      { type: "tool_use", id: "call_abc", name: "ls", input: {} },
    ]);
  });
});
