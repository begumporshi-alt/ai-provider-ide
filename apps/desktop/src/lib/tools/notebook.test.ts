/**
 * Notebook composite tests (2026-10-06).
 *
 * The composites are read_file + parse + (edit) + write_file, so a fake host that serves the
 * .ipynb and records the write is all the harness needed. The load-bearing invariant: an edit
 * rewrites ONE field on ONE raw cell and everything else — outputs, metadata, kernelspec,
 * unknown extensions — survives byte-for-byte. An editor that destroys execution outputs is
 * worse than no editor.
 */
import { describe, expect, it } from "vitest";
import { applyNotebookEdit, parseNotebook, renderNotebookListing, runNotebookEdit, runNotebookRead } from "./notebook";
import type { ToolHost } from "./types";

const NOTEBOOK = JSON.stringify({
  cells: [
    { cell_type: "markdown", source: ["# Title\n"], metadata: {} },
    {
      cell_type: "code",
      source: ["import os\n", "os.getcwd()"],
      execution_count: 3,
      outputs: [{ output_type: "stream", text: "/home\n" }],
      metadata: {},
      id: "abc123",
    },
    { cell_type: "code", source: "print('array-form source is valid too')", execution_count: null, outputs: [], metadata: {} },
  ],
  metadata: { kernelspec: { name: "python3", display_name: "Python 3" } },
  nbformat: 4,
  nbformat_minor: 5,
});

describe("parseNotebook", () => {
  it("normalizes string and array source forms to one string", () => {
    const nb = parseNotebook(NOTEBOOK);
    expect(nb.cells[0]!.source).toBe("# Title\n");
    expect(nb.cells[1]!.source).toBe("import os\nos.getcwd()");
    expect(nb.cells[2]!.source).toBe("print('array-form source is valid too')");
  });

  it("surfaces execution count, output types and cell id", () => {
    const nb = parseNotebook(NOTEBOOK);
    expect(nb.cells[1]!.execution_count).toBe(3);
    expect(nb.cells[1]!.outputTypes).toEqual(["stream"]);
    expect(nb.cells[1]!.id).toBe("abc123");
    expect(nb.cells[2]!.execution_count).toBeNull();
  });

  it("says what is wrong with a file that is not a notebook", () => {
    expect(() => parseNotebook("not json at all")).toThrow(/not valid JSON/);
    expect(() => parseNotebook('{"foo": 1}')).toThrow(/no "cells" array/);
  });
});

describe("renderNotebookListing", () => {
  it("lists one line per cell with enough to target an edit", () => {
    const listing = renderNotebookListing("x.ipynb", parseNotebook(NOTEBOOK));
    expect(listing).toContain("x.ipynb — nbformat 4.5, 3 cells (1 markdown, 2 code)");
    expect(listing).toContain("[0] markdown · 1 lines");
    expect(listing).toContain("[1] code · exec 3 · outputs: stream · id abc123");
    expect(listing).toContain("[2] code · never executed");
    expect(listing).toContain("import os");
  });
});

describe("applyNotebookEdit", () => {
  it("replaces one cell's source and preserves everything else byte-for-byte", () => {
    const nb = parseNotebook(NOTEBOOK);
    const { json, receipt } = applyNotebookEdit(nb, { action: "replace", index: 1, source: "print('new')" });
    const out = JSON.parse(json);
    expect(receipt).toContain("replaced cell 1 (code");
    // The untouched cells are unchanged, including the array source form.
    expect(out.cells[0]).toEqual(JSON.parse(NOTEBOOK).cells[0]);
    // The edited cell keeps its id, execution count and OUTPUTS — only source moved.
    expect(out.cells[1].id).toBe("abc123");
    expect(out.cells[1].execution_count).toBe(3);
    expect(out.cells[1].outputs).toEqual([{ output_type: "stream", text: "/home\n" }]);
    expect(out.cells[1].source).toEqual(["print('new')"]);
    // Notebook-level metadata survives.
    expect(out.metadata).toEqual({ kernelspec: { name: "python3", display_name: "Python 3" } });
  });

  it("inserts a code cell with empty outputs at the requested position", () => {
    const nb = parseNotebook(NOTEBOOK);
    const { json, receipt } = applyNotebookEdit(nb, { action: "insert", index: 1, cell_type: "code", source: "x = 1\n" });
    const out = JSON.parse(json);
    expect(receipt).toContain("inserted code cell at 1");
    expect(out.cells).toHaveLength(4);
    expect(out.cells[1].cell_type).toBe("code");
    expect(out.cells[1].execution_count).toBeNull();
    expect(out.cells[1].outputs).toEqual([]);
  });

  it("deletes a cell and renumbers implicitly", () => {
    const nb = parseNotebook(NOTEBOOK);
    const { json, receipt } = applyNotebookEdit(nb, { action: "delete", index: 0 });
    const out = JSON.parse(json);
    expect(receipt).toContain("deleted cell 0 (markdown); 2 cells remain");
    expect(out.cells[0].cell_type).toBe("code");
  });

  it("refuses a bad action, a bad index, and a missing source", () => {
    const nb = parseNotebook(NOTEBOOK);
    expect(() => applyNotebookEdit(nb, { action: "move", index: 0 })).toThrow(/replace.*insert.*delete/);
    expect(() => applyNotebookEdit(nb, { action: "delete", index: 99 })).toThrow(/outside the notebook/);
    expect(() => applyNotebookEdit(nb, { action: "replace", index: 1 })).toThrow(/needs "source"/);
    expect(() => applyNotebookEdit(nb, { action: "insert", index: 0, source: "x" })).toThrow(/cell_type/);
    expect(() => applyNotebookEdit(nb, { action: "replace", index: 1.5, source: "x" })).toThrow(/integer/);
  });
});

describe("runNotebookRead / runNotebookEdit over a host", () => {
  /** A host that serves one file for read_file and records write_file calls. */
  function fakeHost(file: { ok: boolean; output: string } | null) {
    const writes: Array<{ path: string; content: string }> = [];
    const host: ToolHost = {
      async run(name, args) {
        if (name === "read_file") return file ?? { ok: false, output: "no such file" };
        if (name === "write_file") {
          writes.push({ path: String(args.path), content: String(args.content) });
          return { ok: true, output: "written" };
        }
        return { ok: false, output: `refused: ${name}` };
      },
    };
    return { host, writes };
  }

  it("read_notebook turns the file into a listing without writing", async () => {
    const { host, writes } = fakeHost({ ok: true, output: NOTEBOOK });
    const r = await runNotebookRead(host, { path: "x.ipynb" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("3 cells");
    expect(writes).toEqual([]);
  });

  it("edit_notebook computes the edit and writes the new JSON", async () => {
    const { host, writes } = fakeHost({ ok: true, output: NOTEBOOK });
    const r = await runNotebookEdit(host, { path: "x.ipynb", action: "replace", index: 1, source: "print('v2')" });
    expect(r.ok).toBe(true);
    expect(r.output).toContain("replaced cell 1");
    expect(writes).toEqual([{ path: "x.ipynb", content: expect.stringContaining("print('v2')") }]);
    const out = JSON.parse(writes[0]!.content);
    expect(out.cells[1].outputs).toEqual([{ output_type: "stream", text: "/home\n" }]);
  });

  it("a failed read or write is a failed tool result, never a crash", async () => {
    const missing = fakeHost(null);
    const r1 = await runNotebookRead(missing.host, { path: "gone.ipynb" });
    expect(r1.ok).toBe(false);
    expect(r1.output).toContain("could not read the notebook");

    const broken = fakeHost({ ok: true, output: "}" });
    const r2 = await runNotebookEdit(broken.host, { path: "x.ipynb", action: "delete", index: 0 });
    expect(r2.ok).toBe(false);
    expect(r2.output).toContain("not valid JSON");

    const writeFails = fakeHost({ ok: true, output: NOTEBOOK });
    (writeFails.host as { run: (n: string, a: unknown, o?: unknown) => Promise<{ ok: boolean; output: string }> }).run =
      async (name: string) =>
        name === "read_file"
          ? { ok: true, output: NOTEBOOK }
          : { ok: false, output: "disk full" };
    const r3 = await runNotebookEdit(writeFails.host, { path: "x.ipynb", action: "delete", index: 0 });
    expect(r3.ok).toBe(false);
    expect(r3.output).toContain("could not be written");
  });
});
