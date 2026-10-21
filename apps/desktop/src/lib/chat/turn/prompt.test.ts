import { describe, it, expect } from "vitest";
import {
  buildAgentSystem, buildPlainRequestMessages, AGENT_SYSTEM, NO_TOOLS_SYSTEM, PLAN_MODE_SYSTEM,
} from "./prompt";
import { PROMPT_CAP, countPatches } from "@aiprovider/axiom-core";
import type { ChatMessage } from "@aiprovider/router-core";

describe("buildAgentSystem", () => {
  it("names the checks to run when a project has no test script, and how to verify print and devices", () => {
    // The failure this pins: a project with only dev/build/start/typecheck was reported as
    // "nothing to run", and print verification stopped at Chrome's default Letter paper. The
    // prompt has to name the fallback checks and the tools that reach real paper sizes/devices.
    expect(AGENT_SYSTEM).toContain("no test script");
    expect(AGENT_SYSTEM).toContain("typecheck");
    expect(AGENT_SYSTEM).toContain("nothing to run");
    expect(AGENT_SYSTEM).toContain("paper");
    expect(AGENT_SYSTEM).toContain("device_screenshot");
  });

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

  it("tells the pass how it ends — the exit tool, by name", () => {
    // The prompt plus the registry description are the model's whole contract for ending a
    // planning pass. If the tool is ever renamed, this is the sentence that goes stale first, and
    // the model is the one that would have found out.
    expect(PLAN_MODE_SYSTEM).toContain("exit_plan_mode");
    expect(PLAN_MODE_SYSTEM).toContain("same pass");
  });

  it("appends the session-references block after skills and before memory", () => {
    const out = buildAgentSystem({
      root: "",
      skillsBlock: "\n\n## skill one",
      referencesBlock: "\n\nReferences gathered in this session",
      recalledMemory: "remembered fact",
    });
    expect(out).toContain("References gathered in this session");
    expect(out.indexOf("## skill one")).toBeLessThan(out.indexOf("References gathered"));
    expect(out.indexOf("References gathered")).toBeLessThan(out.indexOf("remembered fact"));
  });

  it("adds nothing for the references block when it is absent or empty", () => {
    const without = buildAgentSystem({ root: "", skillsBlock: "" });
    expect(without).not.toContain("References gathered");
    const empty = buildAgentSystem({ root: "", skillsBlock: "", referencesBlock: "" });
    expect(empty).toBe(without);
  });

  it("puts the manifest above the recalled block so stable knowledge reads first", () => {
    const out = buildAgentSystem({
      root: "",
      skillsBlock: "",
      manifest: "Session manifest",
      recalledMemory: "remembered fact",
    });
    expect(out.indexOf("Session manifest")).toBeGreaterThan(-1);
    expect(out.indexOf("Session manifest")).toBeLessThan(out.indexOf("remembered fact"));
  });

  it("puts a promoted version's blocks after the base prompt and before the per-turn context", () => {
    // The position is the point: the blocks amend the agent's standing instructions, so they sit
    // with them, above the pieces that change on every send.
    const out = buildAgentSystem({
      root: "/tmp/ws",
      skillsBlock: "\n\n## skill one",
      recalledMemory: "remembered fact",
      perTurn: "Only look, do not fix.",
      axiomPatches: [{ marker: "axiom:premature-success", text: "Run the check before claiming it passes." }],
    });
    const iBase = out.indexOf("Your workspace root is: /tmp/ws");
    const iPatch = out.indexOf("[axiom:premature-success]");
    const iSkills = out.indexOf("## skill one");
    const iMemory = out.indexOf("remembered fact");
    const iPerTurn = out.indexOf("Only look, do not fix.");
    expect([iBase, iPatch, iSkills, iMemory, iPerTurn]).toEqual(
      [iBase, iPatch, iSkills, iMemory, iPerTurn].sort((a, b) => a - b),
    );
  });

  it("lands on the prompt the user actually runs, including one they wrote themselves", () => {
    // The reason a version travels as patches rather than as a whole prompt: a stored override
    // applied verbatim would silently discard this custom prompt, and the agent AXIOM benchmarked
    // would stop being the agent the user runs.
    const out = buildAgentSystem({
      root: "",
      skillsBlock: "",
      custom: "You are terse. Never pad an answer.",
      // The screen derives these from the stored prompt; parsing it is axiom-core's round trip.
      axiomPatches: [{ marker: "axiom:tool-loop", text: "Stop repeating a call that already failed." }],
    });
    expect(out.startsWith("You are terse. Never pad an answer.")).toBe(true);
    expect(out).toContain("[axiom:tool-loop]\nStop repeating a call that already failed.");
    expect(out).not.toContain(AGENT_SYSTEM);
  });

  it("adds nothing when no version is promoted", () => {
    const without = buildAgentSystem({ root: "", skillsBlock: "" });
    expect(buildAgentSystem({ root: "", skillsBlock: "", axiomPatches: [] })).toBe(without);
  });

  it("refuses a hand-edited version's excess instead of appending all of it", () => {
    // `axiom_versions` is a database a person can open. The cap is applied here, at the point the
    // prompt is actually composed, so the number of blocks in a turn's prompt does not depend on
    // how the row got there.
    const out = buildAgentSystem({
      root: "",
      skillsBlock: "",
      axiomPatches: Array.from({ length: PROMPT_CAP.maxPatches + 3 }, (_, i) => ({
        marker: `axiom:detector-${i}`,
        text: "x".repeat(20),
      })),
    });
    expect(countPatches(out)).toBe(PROMPT_CAP.maxPatches);
  });
});

describe("buildPlainRequestMessages", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
  ];

  it("orders system → recall → per-turn → history → user", () => {
    const out = buildPlainRequestMessages("be terse", undefined, "remembered", "stay short", history, { content: "now this" });
    expect(out.map((m) => m.role)).toEqual(["system", "system", "system", "user", "assistant", "user"]);
    expect(out[0]).toEqual({ role: "system", content: "be terse" });
    expect(out[1]).toEqual({ role: "system", content: "remembered" });
    expect(out[2]).toEqual({ role: "system", content: "stay short" });
    expect(out[5]).toEqual({ role: "user", content: "now this" });
  });

  it("puts the manifest above the recalled block so stable knowledge reads first", () => {
    const out = buildPlainRequestMessages(
      "system", "Session manifest", "Context recalled from memory", "", [],
      { content: "hi", attachments: [] },
    );
    const system = out.filter((m) => m.role === "system").map((m) => m.content);
    expect(system).toEqual(["system", "Session manifest", "Context recalled from memory"]);
  });

  it("omits the system turn entirely when the prompt resolves to nothing (blank editor's third state)", () => {
    const out = buildPlainRequestMessages(undefined, undefined, undefined, "", [], { content: "hi" });
    expect(out).toEqual([{ role: "user", content: "hi" }]);
  });

  it("falls back to the built-in no-tools guard only when the caller resolved it that way", () => {
    const out = buildPlainRequestMessages(NO_TOOLS_SYSTEM, undefined, undefined, "", [], { content: "hi" });
    expect(out[0]).toEqual({ role: "system", content: NO_TOOLS_SYSTEM });
  });

  it("sends an image-bearing user turn as content parts", () => {
    const out = buildPlainRequestMessages(undefined, undefined, undefined, "", [], {
      content: "what is this?",
      attachments: [{ mediaType: "image/png", dataBase64: "aGk=" } as never],
    });
    expect(Array.isArray(out[0]!.content)).toBe(true);
  });
});
