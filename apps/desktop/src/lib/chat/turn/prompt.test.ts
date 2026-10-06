import { describe, it, expect } from "vitest";
import {
  buildAgentSystem, buildPlainRequestMessages, NO_TOOLS_SYSTEM, PLAN_MODE_SYSTEM,
} from "./prompt";
import type { ChatMessage } from "@aiprovider/router-core";

describe("buildAgentSystem", () => {
  it("concatenates base → skills → memory → plan mode → per-turn, omitting absent pieces", () => {
    const out = buildAgentSystem({
      root: "/tmp/ws",
      skillsBlock: "\n\n## skill one\nbody",
      recalledMemory: "User prefers terse answers.",
      planMode: true,
      perTurn: "Only look, do not fix.",
    });
    // Order assertions, each anchored: the base names the root, then skills, then memory, then
    // the plan-mode suffix, then the per-turn instruction last.
    const iRoot = out.indexOf("Your workspace root is: /tmp/ws");
    const iSkills = out.indexOf("## skill one");
    const iMemory = out.indexOf("User prefers terse answers.");
    const iPlan = out.indexOf("PLAN MODE");
    const iPerTurn = out.indexOf("Only look, do not fix.");
    expect([iRoot, iSkills, iMemory, iPlan, iPerTurn]).toEqual(
      [iRoot, iSkills, iMemory, iPlan, iPerTurn].sort((a, b) => a - b),
    );
  });

  it("omits the memory, plan-mode and per-turn pieces when they are absent", () => {
    const out = buildAgentSystem({ root: "", skillsBlock: "" });
    expect(out).not.toContain("PLAN MODE");
    expect(out).not.toContain("Your workspace root is:");
    expect(out.endsWith("final answer.")).toBe(true);
  });

  it("wraps the recalled memory in its own paragraph, never splices it into the prompt", () => {
    const out = buildAgentSystem({ root: "", skillsBlock: "", recalledMemory: "remembered fact" });
    expect(out).toContain("\n\nremembered fact");
  });

  it("carries PLAN_MODE_SYSTEM verbatim when plan mode is on", () => {
    expect(buildAgentSystem({ root: "", skillsBlock: "", planMode: true })).toContain(PLAN_MODE_SYSTEM);
  });
});

describe("buildPlainRequestMessages", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
  ];

  it("orders system → recall → per-turn → history → user", () => {
    const out = buildPlainRequestMessages("be terse", "remembered", "stay short", history, { content: "now this" });
    expect(out.map((m) => m.role)).toEqual(["system", "system", "system", "user", "assistant", "user"]);
    expect(out[0]).toEqual({ role: "system", content: "be terse" });
    expect(out[1]).toEqual({ role: "system", content: "remembered" });
    expect(out[2]).toEqual({ role: "system", content: "stay short" });
    expect(out[5]).toEqual({ role: "user", content: "now this" });
  });

  it("omits the system turn entirely when the prompt resolves to nothing (blank editor's third state)", () => {
    const out = buildPlainRequestMessages(undefined, undefined, "", [], { content: "hi" });
    expect(out).toEqual([{ role: "user", content: "hi" }]);
  });

  it("falls back to the built-in no-tools guard only when the caller resolved it that way", () => {
    const out = buildPlainRequestMessages(NO_TOOLS_SYSTEM, undefined, "", [], { content: "hi" });
    expect(out[0]).toEqual({ role: "system", content: NO_TOOLS_SYSTEM });
  });

  it("sends an image-bearing user turn as content parts", () => {
    const out = buildPlainRequestMessages(undefined, undefined, "", [], {
      content: "what is this?",
      attachments: [{ mediaType: "image/png", dataBase64: "aGk=" } as never],
    });
    expect(Array.isArray(out[0]!.content)).toBe(true);
  });
});
