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
});
