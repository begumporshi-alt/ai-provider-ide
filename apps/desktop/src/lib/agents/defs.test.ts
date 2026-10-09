/**
 * Unit tests for the subagent-definition guards (lib/agents/defs.ts).
 *
 * The guards are the only thing standing between a hand-edited JSON file and the agent loop, so
 * each rejection reason is its own test — and the tolerant half (a bad file is a skip, never a
 * crash) is tested as behavior, not as a comment.
 */
import { describe, expect, it } from "vitest";
import { isValidDefId, parseSubagentDef, parseSubagentDefs } from "./defs";

const VALID = {
  id: "doc-sweeper",
  name: "Doc Sweeper",
  description: "Surfaces docs that drifted from the code.",
  systemPrompt: "You sweep documentation for drift.",
};

describe("parseSubagentDef", () => {
  it("accepts a minimal definition and defaults enabled to true", () => {
    const got = parseSubagentDef(VALID);
    expect("def" in got && got.def.enabled).toBe(true);
    expect("def" in got && got.def.model).toBe(null);
  });

  it("rejects a missing id, name, description, and systemPrompt", () => {
    for (const key of ["id", "name", "description", "systemPrompt"]) {
      const bad = { ...VALID };
      delete (bad as Record<string, unknown>)[key];
      const got = parseSubagentDef(bad);
      expect("error" in got && got.error.includes(`"${key}"`)).toBe(true);
    }
  });

  it("rejects ids the model could not safely type or the fs could not safely store", () => {
    for (const id of ["", "Big", "has space", "../escape", "a".repeat(65), "sl/ash"]) {
      expect(isValidDefId(id)).toBe(false);
    }
    expect(isValidDefId("doc-sweeper_2")).toBe(true);
  });

  it("rejects an allowlist naming a tool that is not a read-effect builtin", () => {
    // `write_file` exists in the registry but mutates; `not_a_tool` does not exist at all.
    for (const tool of ["write_file", "not_a_tool"]) {
      const got = parseSubagentDef({ ...VALID, tools: ["read_file", tool] });
      expect("error" in got && got.error.includes(tool)).toBe(true);
    }
  });

  it("accepts a read-effect allowlist and de-duplicates it", () => {
    const got = parseSubagentDef({ ...VALID, tools: ["read_file", "list_dir", "read_file"] });
    expect("def" in got && got.def.tools).toEqual(["read_file", "list_dir"]);
  });

  it("clamps maxIterations into the loop's bounds and rejects non-numbers", () => {
    const clamped = parseSubagentDef({ ...VALID, maxIterations: 999 });
    expect("def" in clamped && clamped.def.maxIterations).toBe(50);
    const low = parseSubagentDef({ ...VALID, maxIterations: 0.4 });
    expect("def" in low && low.def.maxIterations).toBe(1);
    const bad = parseSubagentDef({ ...VALID, maxIterations: "twelve" });
    expect("error" in bad).toBe(true);
  });

  it("treats a null tools field as absent rather than an empty deny-all", () => {
    const got = parseSubagentDef({ ...VALID, tools: null });
    expect("def" in got && got.def.tools).toBeUndefined();
  });
});

describe("parseSubagentDefs", () => {
  it("skips malformed files with a reason and keeps the rest", () => {
    const got = parseSubagentDefs([
      { fileName: "a.json", contentJson: "{not json" },
      { fileName: "b.json", contentJson: JSON.stringify({ ...VALID, id: "b-one" }) },
      { fileName: "c.json", contentJson: JSON.stringify({ ...VALID, id: "c-one", systemPrompt: "" }) },
    ]);
    expect(got.defs.map((d) => d.id)).toEqual(["b-one"]);
    expect(got.skipped).toEqual([
      { fileName: "a.json", error: "not valid JSON" },
      { fileName: "c.json", error: '"systemPrompt" is missing' },
    ]);
  });

  it("lets the first file win a duplicate id and reports the loser", () => {
    const got = parseSubagentDefs([
      { fileName: "a.json", contentJson: JSON.stringify(VALID) },
      { fileName: "z.json", contentJson: JSON.stringify(VALID) },
    ]);
    expect(got.defs).toHaveLength(1);
    expect(got.skipped[0]?.fileName).toBe("z.json");
    expect(got.skipped[0]?.error).toContain("duplicate id");
  });
});
