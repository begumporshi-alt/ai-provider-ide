import { describe, it, expect, vi } from "vitest";
import { ActiveTurn, beginTurn, currentTurn, clearCurrentTurn, type GateSink } from "./controller";
import type { ApprovalState } from "../../tools/approval";
import type { ToolCall } from "@aiprovider/router-core";

const STATE: ApprovalState = {
  mode: "ask", planMode: false, trustedTools: new Set<string>(), allowAll: false,
};

function makeTurn(over: Partial<ApprovalState> = {}, sink: Partial<GateSink> = {}) {
  let state: ApprovalState = { ...STATE, ...over };
  const seen: { escalated?: ApprovalState } = {};
  const turn = new ActiveTurn(
    {
      approvalState: () => state,
      escalate: (next) => {
        state = next;
        seen.escalated = next;
      },
    },
    {
      onConfirmRequest: vi.fn(),
      onConfirmCleared: vi.fn(),
      ...sink,
    } as GateSink,
  );
  return { turn, seen, sink: turn["sink"] as GateSink };
}

const call: ToolCall = { id: "c1", name: "edit_file", arguments: "{}" };

describe("ActiveTurn.confirm", () => {
  it("allows under allow-all policy without surfacing the modal", async () => {
    const { turn, sink } = makeTurn({ allowAll: true });
    const out = await turn.confirm(call, {});
    expect(out).toEqual({ allow: true });
    expect(sink.onConfirmRequest).not.toHaveBeenCalled();
  });

  it("denies writes in plan mode with the policy's own reason, no modal", async () => {
    const { turn, sink } = makeTurn({ planMode: true });
    const out = await turn.confirm(call, {});
    expect(out.allow).toBe(false);
    expect(out.reason).toBeTruthy();
    expect(sink.onConfirmRequest).not.toHaveBeenCalled();
  });

  it("parks on the modal for an ask, escalates trust on a session-scope allow, and applies it to the getter", async () => {
    const requestSpy = vi.fn();
    const { turn, seen } = makeTurn({}, {
      onConfirmRequest: (req) => {
        requestSpy(req);
        req.resolve({ allow: true, scope: "session" });
      },
    });
    const out = await turn.confirm(call, {});
    expect(out.allow).toBe(true);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(seen.escalated?.allowAll).toBe(true);
    // The escalated state is what the NEXT call reads — no second modal.
    const out2 = await turn.confirm(call, {});
    expect(out2.allow).toBe(true);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it("escalates a once-per-tool allow into the trusted list", async () => {
    const { turn, seen } = makeTurn({}, {
      onConfirmRequest: (req) => req.resolve({ allow: true, scope: "tool" }),
    });
    await turn.confirm(call, {});
    expect(seen.escalated?.trustedTools.has("edit_file")).toBe(true);
  });

  it("resolves a parked gate as a deny when Stop fires — the pinned gate/abort race", async () => {
    const cleared = vi.fn();
    const { turn } = makeTurn({}, { onConfirmCleared: cleared });
    const parked = turn.confirm(call, {});
    turn.stop(); // the user pressed Stop while the modal was up
    const out = await parked;
    // scope is an ApprovalChoice field and is dropped in the gate's outcome shape
    expect(out).toEqual({ allow: false, reason: "stopped by you — this call was not run" });
    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it("denies immediately when the turn was already stopped", async () => {
    const { turn, sink } = makeTurn({});
    turn.stop();
    const out = await turn.confirm(call, {});
    expect(out.allow).toBe(false);
    expect(sink.onConfirmRequest).not.toHaveBeenCalled();
  });
});

describe("the module-level turn slot", () => {
  it("holds the current turn until finish, and stop reaches it from anywhere", () => {
    const begun = beginTurn(
      { approvalState: () => STATE, escalate: vi.fn() },
      { onConfirmRequest: vi.fn(), onConfirmCleared: vi.fn() },
    );
    expect(currentTurn()).toBe(begun);
    expect(currentTurn()!.signal.aborted).toBe(false);
    currentTurn()!.stop();
    expect(begun.signal.aborted).toBe(true);
    begun.finish();
    expect(currentTurn()).toBeNull();
    // Finishing a turn that is no longer current does not clobber the new one.
    begun.finish();
    const next = beginTurn(
      { approvalState: () => STATE, escalate: vi.fn() },
      { onConfirmRequest: vi.fn(), onConfirmCleared: vi.fn() },
    );
    begun.finish();
    expect(currentTurn()).toBe(next);
    clearCurrentTurn();
  });
});
