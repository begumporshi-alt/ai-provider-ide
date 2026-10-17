import { describe, expect, it } from "vitest";
import { suiteSchema, describeExpectation, parseSuite } from "../src/suite";

const minimal = {
  id: "s1",
  name: "Minimal",
  tasks: [
    {
      id: "t1",
      capability: "file-edit",
      prompt: "Fix the bug",
      expect: [{ kind: "verified-done" }, { kind: "status-equals", status: "ok" }],
    },
  ],
};

describe("parseSuite", () => {
  it("accepts a well-formed suite", () => {
    const r = parseSuite(minimal);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.suite.tasks).toHaveLength(1);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    // Silently dropping a typo'd key is how a suite ends up asserting nothing while looking complete.
    const r = parseSuite({ ...minimal, tasks: [{ ...minimal.tasks[0], expectatons: [] }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path.includes("tasks[0]"))).toBe(true);
  });

  it("rejects an empty suite instead of reporting a 100% pass rate", () => {
    const r = parseSuite({ id: "s", name: "n", tasks: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects a task with no expectations", () => {
    const r = parseSuite({ ...minimal, tasks: [{ id: "t", capability: "c", prompt: "p", expect: [] }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path.endsWith("expect"))).toBe(true);
  });

  it("reports duplicate task ids", () => {
    const t = { id: "dup", capability: "c", prompt: "p", expect: [{ kind: "no-tool-loop" }] };
    const r = parseSuite({ id: "s", name: "n", tasks: [t, t] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const dup = r.errors.find((e) => e.message.includes("duplicate task id"));
      expect(dup).toBeDefined();
      // Points at the second task — the first occurrence is not the mistake.
      expect(dup?.path).toBe("tasks[1].id");
    }
  });

  it("numbers array positions with brackets so an index cannot read as a key", () => {
    // `tasks.0.expectatons` would leave the reader counting elements to find the typo; the shape
    // below says which task and which expectation outright.
    const r = parseSuite({
      ...minimal,
      tasks: [{ ...minimal.tasks[0], expect: [{ kind: "final-text-matches", pattern: "(" }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.path).toBe("tasks[0].expect[0].pattern");
  });

  it("reports a pattern that does not compile, at parse time rather than mid-evaluation", () => {
    const r = parseSuite({
      ...minimal,
      tasks: [{ id: "t1", capability: "c", prompt: "p", expect: [{ kind: "final-text-matches", pattern: "([unclosed" }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]?.message).toMatch(/does not compile/);
    }
  });

  it("reports every problem at once, not only the first", () => {
    const r = parseSuite({
      id: "s",
      name: "n",
      tasks: [
        { id: "a", capability: "c", prompt: "p", expect: [{ kind: "final-text-matches", pattern: "(" }] },
        { id: "a", capability: "c", prompt: "p", expect: [{ kind: "final-text-matches", pattern: ")" }] },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects a non-positive budget", () => {
    const r = parseSuite({
      ...minimal,
      tasks: [{ ...minimal.tasks[0], budget: { maxIterations: 0 } }],
    });
    expect(r.ok).toBe(false);
  });
});

describe("suiteSchema", () => {
  it("is exported for hosts that want to validate without AXIOM's extra checks", () => {
    expect(suiteSchema.safeParse(minimal).success).toBe(true);
  });
});

describe("describeExpectation", () => {
  it("covers every expectation kind", () => {
    const kinds = [
      { kind: "status-equals", status: "ok" },
      { kind: "final-text-matches", pattern: "x" },
      { kind: "tool-was-called", name: "read_file" },
      { kind: "tool-not-called", name: "write_file" },
      { kind: "no-tool-loop" },
      { kind: "verified-done" },
    ] as const;
    for (const k of kinds) {
      const text = describeExpectation(k);
      expect(text.length, `described ${k.kind}`).toBeGreaterThan(5);
    }
  });

  it("describes verified-done as the property it actually checks", () => {
    expect(describeExpectation({ kind: "verified-done" })).toMatch(/claim/i);
  });
});
