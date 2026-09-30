/**
 * Line diff for tool results (Phase 2).
 *
 * The Assistant rendered `edit_file` / `write_file` as raw JSON args and plain text, which is
 * unreadable for the one thing a coding agent produces most: a change to a file. This is the pure
 * algorithm behind the diff view — no React, no DOM, so it is unit-testable.
 *
 * Deliberately small and bounded. It is a line-level LCS, not a patch-format generator: the inputs
 * are one edit snippet (`edit_file` old/new) or one file body (`write_file`), not two revisions of
 * a large tree, so a quadratic table is fine up to a cap and a non-minimal fallback beyond it.
 * `truncated` is reported rather than silently swallowing lines, so the view can say so.
 */

export type DiffKind = "add" | "del" | "ctx";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when the LCS table was too large to build, or the output exceeded `maxLines`. */
  truncated: boolean;
}

/**
 * Cell budget for the LCS table. 250k cells ≈ a 500×500-line change, far beyond a hand-written
 * edit snippet; past it we fall back to "delete everything, add everything", which is still a
 * truthful diff, just not a minimal one.
 */
const MAX_LCS_CELLS = 250_000;

/** Cap on emitted lines, so a `write_file` of a huge file cannot paint the whole transcript. */
const DEFAULT_MAX_LINES = 400;

function splitLines(text: string): string[] {
  // A trailing newline should not manufacture a final empty line — `"a\n"` is one line, not two.
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Non-minimal but truthful: every old line removed, every new line added. */
function fallbackDiff(a: string[], b: string[]): DiffLine[] {
  return [
    ...a.map((text): DiffLine => ({ kind: "del", text })),
    ...b.map((text): DiffLine => ({ kind: "add", text })),
  ];
}

function lcsOps(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_LCS_CELLS) return fallbackDiff(a, b);

  // dp[i][j] = length of the LCS of a[i..] and b[j..]. Built backwards so the walk below can be
  // greedy from the front without a second pass.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

/**
 * A line-level unified diff of `oldText` → `newText`.
 *
 * `maxLines` caps the emitted lines; when the diff is longer the extra lines are dropped and
 * `truncated` is set (the counts still describe the full change, because a caller that hides lines
 * must not also lie about how many there were).
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  opts?: { maxLines?: number },
): DiffResult {
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const a = splitLines(oldText);
  const b = splitLines(newText);

  const all = lcsOps(a, b);
  const added = all.filter((l) => l.kind === "add").length;
  const removed = all.filter((l) => l.kind === "del").length;

  const capped = all.length > maxLines;
  return {
    lines: capped ? all.slice(0, maxLines) : all,
    added,
    removed,
    truncated: capped || a.length * b.length > MAX_LCS_CELLS,
  };
}
