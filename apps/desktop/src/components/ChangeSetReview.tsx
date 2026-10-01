/**
 * ChangeSetReview — what one agent run changed, and the way back (Phase 5, 2026-10-01).
 *
 * The sibling of `CodeCandidateReview`, but for workspace edits rather than adapter source. It is
 * shown after a run that touched files, and the two answers are the two the plan asks for: keep
 * the changes, or revert the run.
 *
 * Why "revert" rather than a pre-apply "apply/reject": by the time a diff can be shown, the tools
 * have already written — the sandbox executes calls, and holding a speculative patch in the UI would
 * mean a second write path with its own failure modes. So the guarantee offered is the one that can
 * actually be kept: the pre-run bytes were read *before* each write (see `lib/tools/changeset.ts`),
 * and this panel can put them back. The wording says "revert", not "reject", so it does not claim an
 * undo happened that did not.
 *
 * Two things it refuses to overstate, both printed rather than hidden:
 *  - a command's side effects are outside the checkpoint;
 *  - a file whose previous contents could not be read is not restorable, and is not emptied to look
 *    like one.
 */
import { Button } from "./atoms";
import { DiffView } from "./DiffView";
import type { RunChangeSet } from "../lib/tools/changeset";
import type { FileChange } from "../lib/tools/render";

/** The change set as diffs, or `null` for a file whose new contents could not be read back. */
function asFileChange(f: RunChangeSet["files"][number]): FileChange | null {
  if (f.after === null) return null;
  return {
    path: f.path,
    // A file the run created has no "before": an all-additions diff is the truthful rendering,
    // and the note says why rather than leaving it to be inferred from the empty side.
    oldText: f.before ?? "",
    newText: f.after,
    kind: f.before === null ? "write" : "edit",
    ...(f.before === null ? { note: "did not exist before this run" } : {}),
  };
}

export function ChangeSetReview({
  set,
  busy,
  onKeep,
  onRevert,
}: {
  set: RunChangeSet;
  /** A turn is running: reverting mid-run would race the writes it is still making. */
  busy: boolean;
  onKeep: () => void;
  onRevert: () => void;
}) {
  const n = set.files.length;
  return (
    <div
      className="mt-3 rounded-md border p-3"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      data-testid="change-set"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold" style={{ color: "var(--text)" }}>
          {n === 0 ? "No files changed" : `${n} file${n === 1 ? "" : "s"} changed in this run`}
        </span>
        <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
          the previous contents were captured before each write, so this run can be undone
        </span>
      </div>

      {set.files.map((f) => {
        const change = asFileChange(f);
        return (
          <div key={f.path} data-testid="change-set-file">
            {f.beforeUnknown ? (
              <div className="mono mb-2 rounded border px-2.5 py-1.5 text-[11px]" style={{ borderColor: "var(--warn)", color: "var(--warn)" }}>
                {f.path} — its contents before this run could not be read, so it cannot be restored
              </div>
            ) : change ? (
              // Collapsed, deliberately. Every file here was written by a tool call the transcript
              // above already renders — with the same diff, from the same arguments — so opening
              // them all here showed one run's change twice on one screen (reported 2026-10-01).
              // The panel's job is the decision, and the collapsed row still carries what a decision
              // needs: the path, the verb, and the +/− counts. One click gets the lines.
              <DiffView change={change} defaultOpen={false} />
            ) : (
              <div className="mono mb-2 rounded border px-2.5 py-1.5 text-[11px]" style={{ borderColor: "var(--warn)", color: "var(--text-dim)" }}>
                {f.path} — written, but the new contents could not be read back to show a diff
              </div>
            )}
          </div>
        );
      })}

      {set.untracked.length > 0 && (
        <ul className="mb-2 text-[11px]" style={{ color: "var(--warn)" }}>
          {set.untracked.map((u) => (
            <li key={u}>· {u}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="default" disabled={busy} onClick={onKeep}>
          Keep changes
        </Button>
        <Button variant="danger" disabled={busy || n === 0} onClick={onRevert}>
          Revert this run
        </Button>
        {n > 0 && (
          <span className="text-[11px]" style={{ color: "var(--text-faint)" }}>
            restoring the {n} file{n === 1 ? "" : "s"} above
          </span>
        )}
      </div>
    </div>
  );
}
