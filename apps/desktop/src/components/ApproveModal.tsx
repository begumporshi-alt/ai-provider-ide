/**
 * ApproveModal — the per-call gate (Phase 5, 2026-10-01).
 *
 * Replaces the old two-button ConfirmModal. It answered "allow or deny" and nothing else, which
 * meant a ten-step agent task was ten identical decisions with no way to say "and stop asking me
 * about reads" — so in practice the modal gets dismissed reflexively, which is worse than no gate.
 *
 * Four answers, deliberately: the two narrow ones (this call, this tool) and one wide one (this
 * session). "Always allow this tool" is scoped to the tool rather than to its effect class, because
 * that is the decision the user is actually making when they see a call: not "do I trust reading"
 * but "do I trust `run_command`". The effect class is still shown, as information.
 *
 * The arguments are rendered in full and unelided. They are the thing being approved; a modal that
 * summarizes the command it is about to run is a modal that approves something else.
 */
import { Button, Modal } from "./atoms";
import { toolEffect } from "../lib/tools/registry";

export type ApprovalScope = "once" | "tool" | "session";

export interface ApprovalChoice {
  allow: boolean;
  scope: ApprovalScope;
}

export function ApproveModal({
  name,
  args,
  onResolve,
}: {
  name: string;
  args: Record<string, unknown>;
  onResolve: (choice: ApprovalChoice) => void;
}) {
  const effect = toolEffect(name);
  const writes = effect === "mutate";

  return (
    <Modal
      title={writes ? "Allow this change?" : "Allow this tool call?"}
      width={560}
      onClose={() => onResolve({ allow: false, scope: "once" })}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="mono text-[12px]" style={{ color: writes ? "var(--warn)" : "var(--info)" }} data-testid="approve-tool">
          {name}
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[10px]"
          style={{ background: "var(--surface-2)", color: writes ? "var(--warn)" : "var(--text-dim)" }}
          data-testid="approve-effect"
        >
          {writes ? "modifies the workspace" : "read-only"}
        </span>
      </div>

      <pre
        className="mono mb-3 max-h-56 overflow-auto rounded border p-2 text-[11px]"
        style={{ borderColor: "var(--border)", color: "var(--text-dim)", background: "var(--surface-2)" }}
        data-testid="approve-args"
      >
        {JSON.stringify(args, null, 2)}
      </pre>

      {name === "run_command" && (
        // Say what the checkpoint cannot undo, where the decision is made. The sandbox is what
        // stops the command; nothing stops its side effects on files.
        <p className="mb-3 text-[11px]" style={{ color: "var(--warn)" }}>
          A command runs in the workspace. Its effects on files are not tracked, so “revert this run”
          cannot undo them.
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {/* No `ariaLabel` overrides here: each visible label is already the complete, unique
            accessible name, and an override that reworded it would break WCAG 2.5.3 (the name must
            contain the visible text) for no gain. */}
        <Button variant="ghost" onClick={() => onResolve({ allow: false, scope: "once" })}>
          Deny
        </Button>
        <Button variant="ghost" onClick={() => onResolve({ allow: true, scope: "tool" })}>
          Always allow {name}
        </Button>
        <Button variant="ghost" onClick={() => onResolve({ allow: true, scope: "session" })}>
          Allow all this session
        </Button>
        <Button variant="primary" onClick={() => onResolve({ allow: true, scope: "once" })}>
          Allow once
        </Button>
      </div>
    </Modal>
  );
}
