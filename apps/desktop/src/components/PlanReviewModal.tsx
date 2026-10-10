/**
 * The two plan-mode decisions (2026-10-10).
 *
 * `PlanReviewModal` is what `exit_plan_mode` raises: the plan the model wrote, in full, and the two
 * answers that matter — approve it (plan mode ends and the same pass implements it) or ask for
 * changes (the feedback travels back as the tool result, and the model revises and presents
 * again). The plan is rendered as markdown rather than as the tool's JSON arguments the way
 * `ApproveModal` renders every other call: the argument here *is* a document the user is being
 * asked to read, and a clipped JSON dump would present it as a payload to rubber-stamp.
 *
 * `PlanModeEntryModal` is the other direction (`enter_plan_mode`): the model asking to plan before
 * changing anything. That one is a consent, not a review — the body says what the mode does, and
 * the answer is yes or no.
 *
 * Both live here because they are one conversation: the same mode changes hands, and a reader
 * looking for "what happens when the agent plans" should find both halves in one file.
 */
import { useState } from "react";
import { Button, Modal } from "./atoms";
import { Markdown } from "./Markdown";

export function PlanReviewModal({
  plan,
  onResolve,
}: {
  plan: string;
  onResolve: (decision: { approved: boolean; feedback?: string }) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [feedback, setFeedback] = useState("");

  return (
    <Modal
      title="Review this implementation plan."
      width={760}
      onClose={() => onResolve({ approved: false })}
    >
      <div
        className="mb-3 max-h-[55vh] overflow-auto rounded border p-3"
        style={{ borderColor: "var(--border)", background: "var(--surface-2)" }}
        data-testid="plan-review-body"
      >
        <Markdown source={plan} />
      </div>

      {asking ? (
        <>
          <textarea
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should change? The model keeps planning with this."
            rows={3}
            className="mb-3 w-full resize-y rounded border p-2 text-[12px]"
            style={{ borderColor: "var(--border)", background: "var(--surface)", color: "var(--text)" }}
            data-testid="plan-review-feedback"
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Back
            </Button>
            <Button
              variant="primary"
              onClick={() => onResolve({ approved: false, feedback: feedback.trim() || undefined })}
            >
              Send and keep planning
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap justify-end gap-2">
          {/* No `ariaLabel` overrides: each visible label is already the complete, unique
              accessible name (the same rule `ApproveModal` states). */}
          <Button variant="ghost" onClick={() => setAsking(true)}>
            Request changes
          </Button>
          <Button variant="primary" onClick={() => onResolve({ approved: true })}>
            Approve — implement it now
          </Button>
        </div>
      )}
    </Modal>
  );
}

export function PlanModeEntryModal({ onResolve }: { onResolve: (ok: boolean) => void }) {
  return (
    <Modal title="Switch to plan mode?" width={520} onClose={() => onResolve(false)}>
      <p className="mb-3 text-[12px]" style={{ color: "var(--text-dim)" }}>
        The agent wants to plan before it changes anything. In plan mode it can read, list, search
        and inspect, but every write is refused until you approve a plan — so you will see the plan
        before anything is carried out.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => onResolve(false)}>
          Not now
        </Button>
        <Button variant="primary" onClick={() => onResolve(true)}>
          Enter plan mode
        </Button>
      </div>
    </Modal>
  );
}
