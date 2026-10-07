/**
 * Run checkpointing and change review (Phase 5, 2026-10-01).
 *
 * The plan's question for this piece was: what does "apply or revert a run's edits" mean when the
 * tools write as they go? The answer taken here is a checkpoint — the pre-run contents of every
 * file the run touches are read *before* it is written, and the run's effect is the difference.
 * That buys three things at once:
 *
 *  - the review shows a real before/after diff. `DiffView` could previously only show a
 *    `write_file` as all-additions with the caveat "any previous contents are not shown", because
 *    nobody had read them;
 *  - "revert this run" is restoring bytes that were actually observed, not re-deriving them from
 *    the model's arguments;
 *  - a file written twice in one run still reverts to the state before the run, not to the state
 *    after the first write. Capturing on *first touch* is what makes that true.
 *
 * What this deliberately does NOT claim: `run_command` and `mkdir` are mutations with no tracked
 * file. A command's effects (a formatter rewriting files, a build dropping an artefact, a `git`
 * subcommand moving things) are outside the checkpoint, and the review says so rather than
 * implying an undo it cannot deliver. The sandbox already refuses the network-facing git
 * subcommands; everything else a command does is simply not undone here.
 */
import { toolEffect } from "./registry";
import type { ToolHost } from "./types";

export interface RunFileChange {
  /** Workspace-relative path, exactly as the model passed it. */
  path: string;
  /** Contents before this run touched the path. `null` when the file did not exist. */
  before: string | null;
  /** Contents after this run's last write, or `null` when they could not be read back. */
  after: string | null;
  /** True when the pre-run contents could not be read — the revert for this file is unknown,
   *  not "empty", and the review must not pretend otherwise. */
  beforeUnknown?: boolean;
}

export interface RunChangeSet {
  files: RunFileChange[];
  /** Mutations with no tracked file, described for the user rather than silently omitted. */
  untracked: string[];
}

const FILE_WRITERS = new Set(["write_file", "edit_file"]);

/**
 * The paths a unified diff touches, read the way the Rust patch parser reads them.
 *
 * **Why this exists.** `apply_patch` is the one mutate tool whose targets live inside a *text*
 * argument rather than a `path` field, and the first version of this wrapper matched neither the
 * writers set nor the untracked note — so a patch's changes were invisible to the run checkpoint
 * and "revert this run" reported "reverted N of N files" while those files kept the patch. A silent
 * lie about restored state is the one failure this module exists to prevent.
 *
 * The rules are the Rust parser's, deliberately: the `+++ ` line decides the target, a `b/` or `a/`
 * prefix is VCS noise, and a path on the `---` side of `/dev/null` is a creation (whose "before" is
 * simply absent). A `+++ /dev/null` is a deletion, which the host refuses — skipped here rather than
 * captured, so the two sides of the wire cannot disagree about what ran. The one ambiguity both
 * parsers share: an *added line whose own content starts with `++ `* renders as `+++ …` and would
 * be read as a header. Capturing a path the patch never touched is a no-op for revert (its bytes
 * are unchanged), so the ambiguity is stated rather than defended against with a second grammar.
 */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const raw = line.slice(4).trim();
    if (!raw || raw === "/dev/null") continue;
    const path = raw.replace(/^[ab]\//, "").replace(/^[: ]+/, "");
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/** Read a workspace file, or `null` when it is absent/unreadable. Never throws: a checkpoint
 *  that cannot be taken must not fail the tool call it was taken for. */
async function readOrNull(host: ToolHost, path: string): Promise<string | null> {
  try {
    const r = await host.run("read_file", { path });
    return r.ok ? r.output : null;
  } catch {
    return null;
  }
}

/**
 * Accumulates one run's mutations. Mutable by design — it is written to from inside the tool
 * host during the run — with `snapshot()` handing React a frozen plain object.
 */
export class RunCheckpoint {
  private readonly files = new Map<string, RunFileChange>();
  private readonly untracked: string[] = [];

  has(path: string): boolean {
    return this.files.has(path);
  }

  /**
   * Record the pre-run contents, once per path. The second call for the same path is a no-op:
   * the interesting "before" is the one from before the run, not the one from before this write.
   */
  captureBefore(path: string, before: string | null, unknown = false): void {
    if (this.files.has(path)) return;
    this.files.set(path, { path, before, after: null, ...(unknown ? { beforeUnknown: true } : {}) });
  }

  /** Record the contents once the write returned. */
  setAfter(path: string, after: string | null): void {
    const entry = this.files.get(path);
    if (entry) entry.after = after;
  }

  noteUntracked(text: string): void {
    if (!this.untracked.includes(text)) this.untracked.push(text);
  }

  get empty(): boolean {
    return this.files.size === 0 && this.untracked.length === 0;
  }

  snapshot(): RunChangeSet {
    // Clone each entry, not just the array. `setAfter` mutates the entry it found in the map, so
    // a snapshot that shared those objects would keep changing after it was taken — React would
    // hold a "finished run" whose `after` moved whenever another write landed.
    return { files: [...this.files.values()].map((f) => ({ ...f })), untracked: [...this.untracked] };
  }
}

/**
 * Wrap a host so every file-writing call is checkpointed.
 *
 * The wrapper chains two `run`s per mutation (read the old bytes, then the write, then read the
 * new ones). That is three sandbox calls where there was one, and it is the price of a truthful
 * review: the alternatives are to trust the model's own arguments or to have no review at all.
 * Read-only calls are not wrapped — a run that only inspects the workspace costs exactly what it
 * did before.
 */
export function createCheckpointingHost(inner: ToolHost, checkpoint: RunCheckpoint): ToolHost {
  return {
    async run(name, args, opts) {
      const effect = toolEffect(name);
      const path = typeof args.path === "string" ? args.path : "";

      if (effect !== "mutate") return inner.run(name, args, opts);

      // A patch names its targets inside the diff, so it is checkpointed path by path before the
      // call is made — see `patchPaths`, and the revert gap it closes.
      if (name === "apply_patch") {
        const paths = patchPaths(typeof args.patch === "string" ? args.patch : "");
        if (paths.length === 0) {
          // A patch whose targets cannot be read is a mutation this checkpoint cannot track. Saying
          // so beats the alternative, which is claiming a revert that would not happen.
          checkpoint.noteUntracked("applied a patch whose target files could not be read from it");
          return inner.run(name, args, opts);
        }
        for (const p of paths) {
          if (!checkpoint.has(p)) checkpoint.captureBefore(p, await readOrNull(inner, p));
        }
        const res = await inner.run(name, args, opts);
        // Same rule as the single-file writers: a cancelled write never happened. A *failed* patch
        // changed nothing (the host fails the whole patch on any hunk mismatch), so `after` reads
        // back as it was.
        if (!res.ok && /stopped by you/.test(res.output)) return res;
        for (const p of paths) checkpoint.setAfter(p, res.ok ? await readOrNull(inner, p) : null);
        return res;
      }

      if (!FILE_WRITERS.has(name) || !path) {
        // `mkdir` makes a directory; `run_command` can do anything; `browser_screenshot` saves a
        // PNG the Rust side composed (never a model-chosen rewrite of existing content). None
        // has a file body to snapshot, so the review names them instead of counting them as
        // reverted.
        if (name === "run_command") {
          const program = typeof args.program === "string" ? args.program : "a command";
          checkpoint.noteUntracked(
            `ran \`${program}\` — whatever it changed is outside this checkpoint and is not reverted`,
          );
        } else if (name === "mkdir" && path) {
          checkpoint.noteUntracked(`created directory ${path}`);
        } else if (name === "browser_screenshot") {
          checkpoint.noteUntracked(
            `saved a browser screenshot${path ? ` to ${path}` : " into images/"} — a new capture, never an overwrite of tracked content`,
          );
        }
        return inner.run(name, args, opts);
      }

      if (!checkpoint.has(path)) {
        checkpoint.captureBefore(path, await readOrNull(inner, path));
      }
      const res = await inner.run(name, args, opts);
      // A cancelled write never happened: a stopped `edit_file` must not be recorded as the
      // file's new state, or "revert this run" would offer to undo a change that was never made.
      if (!res.ok && /stopped by you/.test(res.output)) return res;
      // Read back rather than deriving the new contents from `args`: `edit_file` has a
      // `replace_all` mode and the file on disk is the only account of what actually happened.
      checkpoint.setAfter(path, res.ok ? await readOrNull(inner, path) : null);
      return res;
    },
  };
}

export interface RevertOp {
  path: string;
  content: string;
  note?: string;
}

export interface RevertPlan {
  ops: RevertOp[];
  /** Files that cannot be restored, with the reason. Reported, never silently skipped. */
  skipped: { path: string; reason: string }[];
}

/**
 * What "revert this run" writes.
 *
 * A file that existed before is restored byte-for-byte. A file the run *created* cannot be
 * removed — agent mode's sandbox has no delete tool, and adding one would hand the model a new
 * destructive primitive to solve a UI problem — so it is emptied and the note says so. Where the
 * pre-run contents were never readable, nothing is written: an unreadable file is not an empty
 * one, and emptying it would be a destructive act dressed up as an undo.
 */
export function revertPlan(set: RunChangeSet): RevertPlan {
  const ops: RevertOp[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const f of set.files) {
    if (f.beforeUnknown) {
      skipped.push({ path: f.path, reason: "its previous contents could not be read" });
    } else if (f.before === null) {
      if (f.after === null) {
        skipped.push({ path: f.path, reason: "it did not exist before the run and could not be read back" });
      } else {
        ops.push({
          path: f.path,
          content: "",
          note: "did not exist before this run — emptied (agent mode cannot delete a file)",
        });
      }
    } else {
      ops.push({ path: f.path, content: f.before });
    }
  }
  return { ops, skipped };
}
