import { describe, expect, it } from "vitest";
import {
  fileChangeFor,
  groupSearchMatches,
  groupToolRuns,
  indexToolCalls,
  parseStoredToolCalls,
  toolCallArgs,
  toolCallId,
} from "./render";

describe("toolCallArgs / toolCallId", () => {
  it("reads the flat internal shape", () => {
    expect(toolCallArgs({ id: "c1", name: "edit_file", arguments: '{"path":"a.ts"}' })).toEqual({
      path: "a.ts",
    });
    expect(toolCallId({ id: "c1" })).toBe("c1");
  });

  it("reads the OpenAI nested wire shape", () => {
    const wire = { id: "c2", type: "function", function: { name: "write_file", arguments: '{"path":"b"}' } };
    expect(toolCallArgs(wire)).toEqual({ path: "b" });
    expect(toolCallId(wire)).toBe("c2");
  });

  it("returns {} for malformed, non-object or missing arguments rather than throwing", () => {
    expect(toolCallArgs({ arguments: "not json" })).toEqual({});
    expect(toolCallArgs({ arguments: "[1,2]" })).toEqual({});
    expect(toolCallArgs({})).toEqual({});
    expect(toolCallArgs(undefined)).toEqual({});
  });
});

describe("indexToolCalls", () => {
  it("maps each declared call id to its name and args across turns", () => {
    const msgs = [
      { role: "user" as const, tool_calls: undefined },
      {
        role: "assistant" as const,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "edit_file", arguments: '{"path":"x","old":"a","new":"b"}' } },
          { id: "c2", type: "function", function: { name: "list_dir", arguments: "{}" } },
        ],
      },
      { role: "tool" as const, tool_calls: undefined },
    ];
    const idx = indexToolCalls(msgs);
    expect(idx.get("c1")).toEqual({ name: "edit_file", args: { path: "x", old: "a", new: "b" } });
    expect(idx.get("c2")!.name).toBe("list_dir");
  });

  it("ignores assistant turns with no calls and ids that are absent", () => {
    const idx = indexToolCalls([
      { role: "assistant" as const, tool_calls: [{ name: "x", arguments: "{}" }] },
      { role: "assistant" as const, tool_calls: undefined },
    ]);
    expect(idx.size).toBe(0);
  });
});

describe("fileChangeFor", () => {
  it("extracts an edit_file change", () => {
    expect(fileChangeFor("edit_file", { path: "src/a.ts", old: "one", new: "two" })).toEqual({
      path: "src/a.ts",
      kind: "edit",
      oldText: "one",
      newText: "two",
    });
  });

  it("flags replace_all as a note", () => {
    const c = fileChangeFor("edit_file", { path: "a", old: "x", new: "y", replace_all: true })!;
    expect(c.note).toMatch(/replace_all/);
  });

  it("presents write_file as an all-additions change with a caveat", () => {
    const c = fileChangeFor("write_file", { path: "new.md", content: "hello" })!;
    expect(c).toMatchObject({ kind: "write", oldText: "", newText: "hello" });
    expect(c.note).toMatch(/whole-file write/);
  });

  it("returns null for non-mutating tools and for a missing path", () => {
    expect(fileChangeFor("read_file", { path: "a" })).toBeNull();
    expect(fileChangeFor("edit_file", { old: "x" })).toBeNull();
  });
});

describe("parseStoredToolCalls", () => {
  it("reads a persisted tool_calls JSON array into id→ref pairs", () => {
    const json = JSON.stringify([
      { id: "c1", type: "function", function: { name: "edit_file", arguments: '{"path":"a","old":"x","new":"y"}' } },
    ]);
    expect(parseStoredToolCalls(json)).toEqual([
      { id: "c1", ref: { name: "edit_file", args: { path: "a", old: "x", new: "y" } } },
    ]);
  });

  it("returns [] for null, malformed JSON, a non-array, or entries with no id", () => {
    expect(parseStoredToolCalls(null)).toEqual([]);
    expect(parseStoredToolCalls("")).toEqual([]);
    expect(parseStoredToolCalls("{not json")).toEqual([]);
    expect(parseStoredToolCalls('{"a":1}')).toEqual([]);
    expect(parseStoredToolCalls(JSON.stringify([{ name: "x", arguments: "{}" }]))).toEqual([]);
  });
});

describe("groupSearchMatches", () => {  it("groups path:line hits by file, preserving first-seen order", () => {
    const out = groupSearchMatches(
      ["src/b.ts:3: beta", "src/a.ts:1: alpha", "src/b.ts:9: gamma", "noise without a path"].join("\n"),
    );
    expect(out.map((g) => g.file)).toEqual(["src/b.ts", "src/a.ts"]);
    expect(out[0]!.hits).toHaveLength(2);
    expect(out[1]!.hits).toHaveLength(1);
  });

  it("returns nothing for output with no path:line lines", () => {
    expect(groupSearchMatches("plain text\nmore text")).toEqual([]);
  });
});

describe("groupToolRuns", () => {
  const call = (id: string, name: string, args: object) => ({
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });

  it("pairs a turn's calls with the results that answered them, in call order", () => {
    const msgs = [
      { role: "user", content: "do both" },
      { role: "assistant", content: "", tool_calls: [call("c1", "read_file", { path: "a.ts" }), call("c2", "read_file", { path: "b.ts" })] },
      { role: "tool", content: "contents of a", tool_call_id: "c1" },
      { role: "tool", content: "contents of b", tool_call_id: "c2" },
      { role: "assistant", content: "done" },
    ];
    const { byAssistant, consumed } = groupToolRuns(msgs);
    // One group on the turn that asked, not one per message.
    expect([...byAssistant.keys()]).toEqual([1]);
    expect(byAssistant.get(1)!.map((s) => [s.name, s.result])).toEqual([
      ["read_file", "contents of a"],
      ["read_file", "contents of b"],
    ]);
    // Both tool turns are drawn by the group, so the transcript must skip them.
    expect([...consumed].sort()).toEqual([2, 3]);
  });

  it("groups results by POSITION, so a result with a mismatched id is not misfiled", () => {
    const msgs = [
      { role: "assistant", content: "", tool_calls: [call("c1", "list_dir", { path: "." })] },
      { role: "tool", content: "the answer", tool_call_id: "some-other-id" },
    ];
    const { byAssistant } = groupToolRuns(msgs);
    const steps = byAssistant.get(0)!;
    // The call keeps its own row (no result), and the orphan is kept visible rather than dropped:
    // losing a tool's output is worse than an unlabelled row.
    expect(steps.map((s) => [s.name, s.result])).toEqual([
      ["list_dir", undefined],
      ["tool", "the answer"],
    ]);
  });

  it("leaves a tool turn that follows no calls alone", () => {
    const { byAssistant, consumed } = groupToolRuns([
      { role: "user", content: "hi" },
      { role: "tool", content: "orphan", tool_call_id: "c9" },
    ]);
    expect(byAssistant.size).toBe(0);
    // Not consumed: with no group to carry it, the transcript's own bubble must still render it.
    expect(consumed.size).toBe(0);
  });

  it("reads a turn's arguments in both stored shapes", () => {
    const { byAssistant } = groupToolRuns([
      { role: "assistant", content: "", tool_calls: [{ id: "c1", name: "flat", arguments: '{"path":"f.ts"}' }] },
    ]);
    expect(byAssistant.get(0)![0]!.args).toEqual({ path: "f.ts" });
  });
});
