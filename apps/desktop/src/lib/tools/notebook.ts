/**
 * Notebook tools — frontend composites (2026-10-06).
 *
 * A .ipynb file is JSON, so reading its cells and editing one is `read_file` + `write_file` in
 * a pattern. The loop composes the two so the model never has to hand-edit JSON it has not seen,
 * and the composite is declared `mutate` so the approval gate prompts once for the logical edit
 * rather than once per file the composite touches. Like `web_ask` and `dispatch_agent`, these
 * names have no Rust sandbox handler — the sandbox would refuse them if it ever saw one.
 *
 * Edits are applied to the RAW parsed cells and only the touched field is rewritten, so outputs,
 * metadata and kernelspec survive an edit byte-for-byte. Nothing here touches Tauri; `ToolHost`
 * is injected, so the composites are unit-testable.
 */

/** Cells one listing may show before the rest are summarized by count. A notebook bigger than
 *  this is a survey job for `dispatch_agent`, not something to page through in the transcript. */
const LISTING_CELL_CAP = 300;

/** Characters of a cell's first line shown in the listing — enough to recognize the cell. */
const PREVIEW_CHARS = 120;

/** A parsed view of one raw cell. `raw` is the original object; edits rewrite one field on it. */
export interface NotebookCellView {
  cell_type: string;
  /** Normalized to one string; nbformat allows a string or an array of lines. */
  source: string;
  execution_count: number | null;
  outputTypes: string[];
  /** nbformat ≥ 4.5 cell id, when present. */
  id?: string;
  raw: Record<string, unknown>;
}

export interface Notebook {
  cells: NotebookCellView[];
  nbformat: number;
  nbformatMinor: number;
  raw: Record<string, unknown>;
}

/** Parse notebook JSON. Throws with a model-readable message on anything that is not a
 *  notebook — the caller turns a throw into a failed tool result, never a crash. */
export function parseNotebook(text: string): Notebook {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("the file is not valid JSON, so it is not a notebook");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("the file is JSON but not a notebook object");
  }
  const nb = raw as Record<string, unknown> & { cells?: unknown };
  if (!Array.isArray(nb.cells)) {
    throw new Error('the file is JSON but has no "cells" array, so it is not a notebook');
  }
  const cells: NotebookCellView[] = nb.cells.map((c) => {
    const cell = (c && typeof c === "object" && !Array.isArray(c) ? c : {}) as Record<string, unknown>;
    const src = cell.source;
    const source = Array.isArray(src) ? src.map(String).join("") : typeof src === "string" ? src : "";
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    return {
      cell_type: typeof cell.cell_type === "string" ? cell.cell_type : "unknown",
      source,
      execution_count: typeof cell.execution_count === "number" ? cell.execution_count : null,
      outputTypes: outputs
        .filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object")
        .map((o) => String(o.output_type ?? "unknown")),
      id: typeof cell.id === "string" ? cell.id : undefined,
      raw: cell,
    };
  });
  return {
    cells,
    nbformat: typeof nb.nbformat === "number" ? nb.nbformat : 4,
    nbformatMinor: typeof nb.nbformat_minor === "number" ? nb.nbformat_minor : 5,
    raw: nb,
  };
}

function preview(cell: NotebookCellView): string {
  const first = cell.source.split("\n", 1)[0] ?? "";
  return first.length > PREVIEW_CHARS ? first.slice(0, PREVIEW_CHARS) + "…" : first;
}

/** Line count as an editor counts it: a trailing newline ends a line, it does not start one. */
function lineCount(source: string): number {
  const n = source.replace(/\n$/, "").split("\n").length;
  return source === "" ? 0 : n;
}

/** The listing `read_notebook` returns: one line per cell, enough to target `edit_notebook`. */
export function renderNotebookListing(name: string, nb: Notebook): string {
  const byType = nb.cells.reduce<Record<string, number>>((acc, c) => {
    acc[c.cell_type] = (acc[c.cell_type] ?? 0) + 1;
    return acc;
  }, {});
  const head =
    `${name} — nbformat ${nb.nbformat}.${nb.nbformatMinor}, ${nb.cells.length} cells` +
    (Object.keys(byType).length ? ` (${Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(", ")})` : "");
  if (nb.cells.length === 0) return head + "\n(the notebook has no cells)";

  const shown = nb.cells.slice(0, LISTING_CELL_CAP);
  const lines = shown.map((c, i) => {
    const exec =
      c.cell_type === "code"
        ? c.execution_count != null
          ? ` · exec ${c.execution_count}`
          : " · never executed"
        : "";
    const outs = c.outputTypes.length > 0 ? ` · outputs: ${c.outputTypes.join(", ")}` : "";
    const id = c.id ? ` · id ${c.id}` : "";
    const body = preview(c);
    return (
      `[${i}] ${c.cell_type}${exec}${outs}${id} · ${lineCount(c.source)} lines` +
      (body ? `\n    ${body}` : "")
    );
  });
  const tail =
    nb.cells.length > LISTING_CELL_CAP ? `\n(… ${nb.cells.length - LISTING_CELL_CAP} more cells not shown)` : "";
  return [head, ...lines, tail].filter(Boolean).join("\n");
}

export type NotebookEditAction = "replace" | "insert" | "delete";

/** `source` as Jupyter writes it: an array of lines, each newline-terminated but the last. */
function toSourceLines(source: string): string[] {
  return source.split(/(?<=\n)/);
}

/** Apply one cell edit to the RAW cells and return the serialized notebook. Throws on a bad
 *  action or index — the caller reports the message as the tool result. Nothing is mutated:
 *  the return carries the full new JSON text. */
export function applyNotebookEdit(
  nb: Notebook,
  args: Record<string, unknown>,
): { json: string; receipt: string } {
  const action = args.action;
  if (action !== "replace" && action !== "insert" && action !== "delete") {
    throw new Error('action must be "replace", "insert" or "delete"');
  }
  const index = typeof args.index === "number" && Number.isInteger(args.index) ? args.index : NaN;
  if (!Number.isFinite(index)) {
    throw new Error("index must be an integer cell position (0-based, as the listing shows)");
  }
  const rawCells = (nb.raw.cells as unknown[]).slice();

  if (action === "delete") {
    if (index < 0 || index >= rawCells.length) {
      throw new Error(`index ${index} is outside the notebook (0–${rawCells.length - 1})`);
    }
    const gone = nb.cells[index]!;
    rawCells.splice(index, 1);
    return {
      json: serialize(nb.raw, rawCells),
      receipt: `deleted cell ${index} (${gone.cell_type}); ${rawCells.length} cells remain`,
    };
  }

  const source = typeof args.source === "string" ? args.source : undefined;
  if (source === undefined) throw new Error(`"${action}" needs "source": the new cell text`);

  if (action === "replace") {
    if (index < 0 || index >= rawCells.length) {
      throw new Error(`index ${index} is outside the notebook (0–${rawCells.length - 1})`);
    }
    const target = rawCells[index] as Record<string, unknown>;
    if (!target || typeof target !== "object") {
      throw new Error(`cell ${index} is not a notebook cell object`);
    }
    rawCells[index] = { ...target, source: toSourceLines(source) };
    const kind = nb.cells[index]!.cell_type;
    return {
      json: serialize(nb.raw, rawCells),
      receipt: `replaced cell ${index} (${kind}, ${lineCount(source)} lines); ${rawCells.length} cells total`,
    };
  }

  // insert
  const cellType = args.cell_type;
  if (cellType !== "code" && cellType !== "markdown") {
    throw new Error('insert needs "cell_type" of "code" or "markdown"');
  }
  if (index < 0 || index > rawCells.length) {
    throw new Error(`insert index ${index} is outside the notebook (0–${rawCells.length})`);
  }
  const fresh: Record<string, unknown> =
    cellType === "code"
      ? { cell_type: "code", source: toSourceLines(source), metadata: {}, execution_count: null, outputs: [] }
      : { cell_type: "markdown", source: toSourceLines(source), metadata: {} };
  rawCells.splice(index, 0, fresh);
  return {
    json: serialize(nb.raw, rawCells),
    receipt: `inserted ${cellType} cell at ${index} (${lineCount(source)} lines); ${rawCells.length} cells total`,
  };
}

function serialize(raw: Record<string, unknown>, cells: unknown[]): string {
  return JSON.stringify({ ...raw, cells }, null, 1) + "\n";
}

type RunResult = { ok: boolean; output: string };
type RunOpts = { callId?: string; signal?: AbortSignal };
type Host = { run(name: string, args: Record<string, unknown>, opts?: RunOpts): Promise<RunResult> };

/** The `read_notebook` composite: read_file → parse → listing. */
export async function runNotebookRead(host: Host, args: Record<string, unknown>, opts?: RunOpts): Promise<RunResult> {
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) return { ok: false, output: 'read_notebook needs a "path".' };
  const file = await host.run("read_file", { path }, opts);
  if (!file.ok) return { ok: false, output: `could not read the notebook: ${file.output}` };
  try {
    return { ok: true, output: renderNotebookListing(path, parseNotebook(file.output)) };
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

/** The `edit_notebook` composite: read_file → parse → apply → write_file. The composite is
 *  approved once as `mutate`; the write_file inside is part of that one logical edit. */
export async function runNotebookEdit(host: Host, args: Record<string, unknown>, opts?: RunOpts): Promise<RunResult> {
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) return { ok: false, output: 'edit_notebook needs a "path".' };
  const file = await host.run("read_file", { path }, opts);
  if (!file.ok) return { ok: false, output: `could not read the notebook: ${file.output}` };
  let nb: Notebook;
  try {
    nb = parseNotebook(file.output);
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
  let edit: { json: string; receipt: string };
  try {
    edit = applyNotebookEdit(nb, args);
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
  const write = await host.run("write_file", { path, content: edit.json }, opts);
  if (!write.ok) {
    return { ok: false, output: `the edit was computed but could not be written: ${write.output}` };
  }
  return { ok: true, output: edit.receipt };
}
