/**
 * TurnController — the module-level holder of the in-flight turn's abort handle and approval gate.
 *
 * Module-level, not React state, because the turn outlives the screen that started it: the user
 * reaches the Agents dashboard (whose stop button is the remote control) precisely *by* unmounting
 * the Assistant, and a run parked on its approval gate must survive that (pinned by
 * web-test/agent-approval "stopping a run parked on the approval gate unblocks it"). This mirrors
 * `lib/agent/orchestrator`'s registry and `lib/context/recorder`'s `current` singleton.
 *
 * The gate owns the abort race: Stop fired while the modal is up resolves the parked promise as a
 * deny — the call is not run, the modal closes, and the next loop boundary throws the AbortError
 * the engine's catch already turns into "stopped by you".
 */
import type { ToolCall } from "@aiprovider/router-core";
import { decide, withAllowAll, withTrustedTool, type ApprovalState } from "../../tools/approval";
import type { ApprovalChoice } from "../../../components/ApproveModal";

export interface ConfirmOutcome {
  allow: boolean;
  reason?: string;
}

/** The approval state seam. `approvalState()` is a getter on purpose — plan approval mutates the
 *  state *between* runs, and a snapshot taken at turn start would re-refuse the executing pass's
 *  first write. */
export interface GateApprovalPorts {
  approvalState(): ApprovalState;
  /** Trust escalation ("always allow this tool" / "allow all this session"): applied to the
   *  caller's ref — the very next call of this same run reads it before React re-renders — and to
   *  state, both. */
  escalate(next: ApprovalState): void;
}

export interface GateSink {
  onConfirmRequest(req: { call: ToolCall; args: Record<string, unknown>; resolve: (choice: ApprovalChoice) => void }): void;
  onConfirmCleared(): void;
}

export class ActiveTurn {
  readonly controller = new AbortController();

  constructor(private approval: GateApprovalPorts, private sink: GateSink) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Stop the turn. While the approval gate is parked, this resolves it as a deny (see below). */
  stop(): void {
    this.controller.abort();
  }

  /** Release the module-level slot. Called by the engine's settle path, never by unmount. */
  finish(): void {
    if (currentTurn() === this) clearCurrentTurn();
  }

  /**
   * The per-call approval gate. Policy first (allow/deny never surface a modal — plan mode refuses
   * writes itself, without a prompt: a prompt here would let the user approve exactly the write
   * plan mode exists to prevent, one click away from a mode they chose for a reason); "ask" parks
   * on the modal, raced against this turn's own abort signal.
   */
  async confirm(call: ToolCall, args: Record<string, unknown>): Promise<ConfirmOutcome> {
    const name = call.name ?? "?";
    const verdict = decide(this.approval.approvalState(), name);
    if (verdict.action === "allow") return { allow: true };
    if (verdict.action === "deny") return { allow: false, reason: verdict.reason };
    const choice = await new Promise<ApprovalChoice & { reason?: string }>((resolve) => {
      const sig = this.controller.signal;
      let onAbort: (() => void) | null = null;
      const denyForStop = () => {
        if (onAbort) sig.removeEventListener("abort", onAbort);
        this.sink.onConfirmCleared();
        resolve({ allow: false, scope: "once", reason: "stopped by you — this call was not run" });
      };
      if (sig.aborted) {
        denyForStop();
        return;
      }
      onAbort = denyForStop;
      sig.addEventListener("abort", onAbort, { once: true });
      this.sink.onConfirmRequest({
        call,
        args,
        resolve: (c) => {
          if (onAbort) sig.removeEventListener("abort", onAbort);
          resolve(c);
        },
      });
    });
    if (choice.allow && choice.scope !== "once") {
      // Applied to the caller's ref **and** to state. State is what the render reads; the ref is
      // what the very next call of this same run reads, and a setState is not applied until React
      // re-renders — which the loop does not wait for. Without the ref, "always allow this tool"
      // would ask about the same tool again on the immediately following call.
      const state = this.approval.approvalState();
      const next = choice.scope === "session"
        ? withAllowAll(state)
        : withTrustedTool(state, name);
      this.approval.escalate(next);
    }
    // A deny that Stop caused carries its own wording: the model must not read "the user denied
    // this" out of a run the user cancelled, and the transcript step should say which happened.
    return choice.reason ? { allow: choice.allow, reason: choice.reason } : { allow: choice.allow };
  }
}

let current: ActiveTurn | null = null;

/** The turn now running, if any. The dashboard's stop path reaches it through `stop()`. */
export function currentTurn(): ActiveTurn | null {
  return current;
}

export function beginTurn(approval: GateApprovalPorts, sink: GateSink): ActiveTurn {
  current = new ActiveTurn(approval, sink);
  return current;
}

export function clearCurrentTurn(): void {
  current = null;
}
