import { describe, expect, it } from "vitest";
import { parseAssistantStream, toolSegments, visibleText } from "./assistant-stream";

/** The verbatim failure from the 2026-09-17 mercury-2.5 report. */
const MERCURY = `<|tool_call_start|> <function=Bash> <parameter=command> mkdir -p /Users/tushershikder/.zcode/skills/ai-provider-ide-guide <parameter=description> Create skill directory <|tool_call_end|>`;

describe("parseAssistantStream", () => {
  it("leaves ordinary prose untouched", () => {
    const src = "Here is a plain answer. 2 < 3, so it holds.";
    expect(parseAssistantStream(src)).toEqual([{ kind: "text", text: src }]);
  });

  it("extracts a complete tool call and keeps the prose around it", () => {
    const segs = parseAssistantStream(`I'll set that up. ${MERCURY} Done.`);
    expect(segs.map((s) => s.kind)).toEqual(["text", "tool", "text"]);
    const tool = segs[1];
    expect(tool.kind === "tool" && tool.name).toBe("Bash");
    expect(tool.kind === "tool" && tool.complete).toBe(true);
    expect(tool.kind === "tool" && tool.params.command).toBe(
      "mkdir -p /Users/tushershikder/.zcode/skills/ai-provider-ide-guide",
    );
  });

  it("marks an unterminated block incomplete mid-stream", () => {
    const partial = "<|tool_call_start|> <function=Bash> <parameter=command> mkdir -p /tmp/x";
    const segs = parseAssistantStream(partial);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("tool");
    expect(segs[0].kind === "tool" && segs[0].complete).toBe(false);
    expect(visibleText(partial)).toBe("");
  });

  it("holds back a half-typed marker so it is never painted", () => {
    expect(visibleText("Sure — <|tool_call_st")).toBe("Sure —");
    expect(visibleText("Sure — <|tool_call")).toBe("Sure —");
  });

  it("does not eat a lone angle bracket in prose", () => {
    expect(visibleText("a < b")).toBe("a < b");
  });

  it("handles several blocks in one response", () => {
    const src = `${MERCURY} <|tool_call_start|> <function=Write> <parameter=path> /tmp/a.md </parameter> <|tool_call_end|> tail`;
    expect(toolSegments(src).map((s) => s.name)).toEqual(["Bash", "Write"]);
    expect(visibleText(src)).toBe("tail");
  });

  it("never leaks a marker into visible text", () => {
    expect(visibleText(MERCURY)).toBe("");
    expect(visibleText(MERCURY)).not.toContain("tool_call");
    expect(visibleText(MERCURY)).not.toContain("function=");
  });
});
