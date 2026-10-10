/**
 * artifact-versions.test.ts — replaying the transcript into a version list.
 *
 * The cases that matter are the ones where replay CANNOT be exact: an edit whose old text is gone,
 * an edit with no write before it, and a base64 file edited as text. Each must still produce a
 * version, marked inexact — the failure mode this file exists to prevent is a confidently wrong
 * page (a version that looks like history but is not what the file held).
 */
import { describe, expect, it } from "vitest";
import { artifactHistories, artifactHistory } from "./artifact-versions";
import type { WriteStep } from "./artifacts";

/** A successful write_file step. */
function write(path: string, content: string, extra: Record<string, unknown> = {}): WriteStep {
  return {
    name: "write_file",
    args: { path, content, ...extra },
    result: `wrote ${content.length} bytes to ${path}`,
  };
}

/** A successful edit_file step. */
function edit(path: string, oldText: string, newText: string, extra: Record<string, unknown> = {}): WriteStep {
  return {
    name: "edit_file",
    args: { path, old: oldText, new: newText, ...extra },
    result: `edited ${path}`,
  };
}

/** Runs from a flat list of steps, one message per step — the transcript's shape. */
function runs(steps: WriteStep[]): Map<number, WriteStep[]> {
  return new Map(steps.map((s, i) => [i + 1, [s]]));
}

describe("artifactHistory", () => {
  it("lists one version per write, oldest first, with the content of each", () => {
    const { versions, unresolved } = artifactHistory(
      runs([
        write("page.html", "<h1>one</h1>"),
        edit("page.html", "one", "two"),
        edit("page.html", "two", "three"),
      ]),
      "page.html",
    );

    expect(unresolved).toBe(0);
    expect(versions.map((v) => v.seq)).toEqual([1, 2, 3]);
    expect(versions.map((v) => v.content)).toEqual([
      "<h1>one</h1>",
      "<h1>two</h1>",
      "<h1>three</h1>",
    ]);
    expect(versions.every((v) => v.exact)).toBe(true);
    // The tool that produced each version is what the label reads.
    expect(versions.map((v) => v.tool)).toEqual(["write_file", "edit_file", "edit_file"]);
  });

  it("replays replace_all as every occurrence", () => {
    const { versions } = artifactHistory(
      runs([write("a.html", "x x x"), edit("a.html", "x", "y", { replace_all: true })]),
      "a.html",
    );
    expect(versions[1]!.content).toBe("y y y");
  });

  /** The reported shape of the feature: write, then a second write of the same path. */
  it("gives a second write its own version rather than replacing the first", () => {
    const { versions } = artifactHistory(
      runs([write("site/index.html", "<h1>FIRST</h1>"), write("site/index.html", "<h1>FINAL</h1>")]),
      "site/index.html",
    );
    expect(versions).toHaveLength(2);
    expect(versions[0]!.content).toBe("<h1>FIRST</h1>");
    expect(versions[1]!.content).toBe("<h1>FINAL</h1>");
  });

  it("counts bytes as they land on disk, for text and for base64", () => {
    const { versions } = artifactHistory(
      runs([
        write("a.html", "abc"),
        write("logo.png", "aGVsbG8=", { encoding: "base64" }), // "hello" — 5 bytes
      ]),
      "a.html",
    );
    expect(versions[0]!.bytes).toBe(3);

    const png = artifactHistory(
      runs([write("logo.png", "aGVsbG8=", { encoding: "base64" })]),
      "logo.png",
    );
    expect(png.versions[0]!.encoding).toBe("base64");
    expect(png.versions[0]!.bytes).toBe(5);
  });

  /**
   * An edit whose `old` text is not in the content means something changed the file outside the
   * transcript. The version is kept and MARKEED, and the count is reported, because a page that
   * silently shows the wrong revision is worse than one that says it cannot be sure.
   */
  it("marks a version inexact when an edit cannot be replayed", () => {
    const { versions, unresolved } = artifactHistory(
      runs([
        write("a.html", "<h1>one</h1>"),
        edit("a.html", "NOT PRESENT", "two"), // e.g. a run_command touched the file
      ]),
      "a.html",
    );
    expect(unresolved).toBe(1);
    expect(versions).toHaveLength(2);
    expect(versions[1]!.exact).toBe(false);
    // The content is the last one we can account for, not a guess.
    expect(versions[1]!.content).toBe("<h1>one</h1>");
    // The earlier version stays exact — the failure is local to the edit that failed.
    expect(versions[0]!.exact).toBe(true);
  });

  /**
   * An edit with no write before it produces NO version, and that is the deliberate choice: the
   * file existed before the conversation, so its content at that moment is unknowable. Emitting a
   * version would mean inventing one — an empty page labelled "v1", which reads as history and is
   * not. `unresolved` still counts the operation, so the gap is recorded even when it is not shown.
   */
  it("records, but does not fabricate, an edit that has no write before it", () => {
    const { versions, unresolved } = artifactHistory(
      runs([edit("pre-existing.html", "hello", "goodbye")]),
      "pre-existing.html",
    );
    expect(unresolved).toBe(1);
    expect(versions).toEqual([]);
  });

  /** Once a write grounds the content, later edits on a pre-existing file do become exact. */
  it("becomes exact from the first write onwards", () => {
    const { versions, unresolved } = artifactHistory(
      runs([
        edit("pre-existing.html", "hello", "goodbye"), // unknowable — no version
        write("pre-existing.html", "<h1>known</h1>"),
        edit("pre-existing.html", "known", "known2"),
      ]),
      "pre-existing.html",
    );
    expect(unresolved).toBe(1);
    expect(versions.map((v) => v.content)).toEqual(["<h1>known</h1>", "<h1>known2</h1>"]);
    expect(versions.every((v) => v.exact)).toBe(true);
  });

  it("cannot replay a text edit against a base64 file, and says so", () => {
    const { versions, unresolved } = artifactHistory(
      runs([
        write("r.pdf", "JVBERi0xLjQ=", { encoding: "base64" }),
        edit("r.pdf", "x", "y"),
      ]),
      "r.pdf",
    );
    expect(unresolved).toBe(1);
    expect(versions[1]!.exact).toBe(false);
    expect(versions[1]!.encoding).toBe("base64");
  });

  it("ignores other files, other tools, and writes that failed", () => {
    const okWrite = write("a.html", "<h1>one</h1>");
    const { versions } = artifactHistory(
      new Map<number, WriteStep[]>([
        [1, [okWrite]],
        [
          2,
          [
            write("b.html", "<h1>other file</h1>"),
            { name: "read_file", args: { path: "a.html" }, result: "…" },
            // A refused write made no version (plan mode, or a denied approval).
            {
              name: "write_file",
              args: { path: "a.html", content: "<h1>refused</h1>" },
              result: "refused — PLAN MODE forbids writes",
            },
            { name: "write_file", args: { path: "a.html", content: "x" }, result: "boom", status: "error" },
          ],
        ],
      ]),
      "a.html",
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]!.content).toBe("<h1>one</h1>");
  });

  it("orders by message, not by the order steps happen to sit in a map", () => {
    const { versions } = artifactHistory(
      new Map<number, WriteStep[]>([
        [9, [edit("a.html", "second", "THIRD")]],
        [2, [write("a.html", "first")]],
        [5, [edit("a.html", "first", "second")]],
      ]),
      "a.html",
    );
    expect(versions.map((v) => v.content)).toEqual(["first", "second", "THIRD"]);
  });

  it("returns nothing for a path the transcript never wrote", () => {
    const { versions, unresolved } = artifactHistory(runs([write("a.html", "x")]), "never.html");
    expect(versions).toEqual([]);
    expect(unresolved).toBe(0);
  });
});

describe("artifactHistories", () => {
  it("builds an independent history per path in one walk", () => {
    const map = artifactHistories(
      runs([
        write("a.html", "<h1>a1</h1>"),
        write("b.html", "<h1>b1</h1>"),
        edit("a.html", "a1", "a2"),
      ]),
    );
    expect([...map.keys()].sort()).toEqual(["a.html", "b.html"]);
    expect(map.get("a.html")!.versions.map((v) => v.content)).toEqual(["<h1>a1</h1>", "<h1>a2</h1>"]);
    expect(map.get("b.html")!.versions.map((v) => v.content)).toEqual(["<h1>b1</h1>"]);
  });

  it("includes paths that are not previewable only when they are", () => {
    const map = artifactHistories(runs([write("main.rs", "fn main() {}"), write("a.html", "x")]));
    expect([...map.keys()]).toEqual(["a.html"]);
  });
});
