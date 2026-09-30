import { describe, expect, it } from "vitest";
import { unifiedDiff } from "./diff";

const kinds = (r: ReturnType<typeof unifiedDiff>) => r.lines.map((l) => `${l.kind}:${l.text}`);

describe("unifiedDiff", () => {
  it("marks an unchanged body as all context", () => {
    const r = unifiedDiff("a\nb", "a\nb");
    expect(kinds(r)).toEqual(["ctx:a", "ctx:b"]);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("inserts a line without disturbing the rest", () => {
    const r = unifiedDiff("a\nc", "a\nb\nc");
    expect(kinds(r)).toEqual(["ctx:a", "add:b", "ctx:c"]);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
  });

  it("deletes a line", () => {
    const r = unifiedDiff("a\nb\nc", "a\nc");
    expect(kinds(r)).toEqual(["ctx:a", "del:b", "ctx:c"]);
    expect(r.removed).toBe(1);
  });

  it("shows a modified line as a delete plus an add", () => {
    const r = unifiedDiff("a\nold\nc", "a\nnew\nc");
    expect(kinds(r)).toEqual(["ctx:a", "del:old", "add:new", "ctx:c"]);
    expect(r.added).toBe(1);
    expect(r.removed).toBe(1);
  });

  it("treats an empty old side as an all-additions diff (a new file)", () => {
    const r = unifiedDiff("", "x\ny");
    expect(kinds(r)).toEqual(["add:x", "add:y"]);
    expect(r.added).toBe(2);
    expect(r.removed).toBe(0);
  });

  it("does not manufacture a trailing empty line for a trailing newline", () => {
    expect(unifiedDiff("a\n", "a\n").lines).toHaveLength(1);
  });

  it("caps output and reports truncation without lying about the counts", () => {
    const big = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
    const r = unifiedDiff("", big, { maxLines: 100 });
    expect(r.lines).toHaveLength(100);
    expect(r.truncated).toBe(true);
    // The counts describe the whole change, not just the lines that were kept.
    expect(r.added).toBe(600);
  });

  it("falls back to a truthful (non-minimal) diff when the table would be too large", () => {
    const a = Array.from({ length: 600 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 600 }, (_, i) => `b${i}`).join("\n");
    const r = unifiedDiff(a, b);
    expect(r.truncated).toBe(true);
    expect(r.removed).toBe(600);
    expect(r.added).toBe(600);
  });
});
