/**
 * Approval policy (Phase 5, 2026-10-01).
 *
 * Before this, every agent tool call — `read_file` included — blocked on the same modal. That is
 * safe and unusable at the same time: a ten-step task meant ten clicks, so in practice the modal
 * gets clicked through without being read, which is worse than not having it.
 *
 * The policy is a pure function of (mode, what the user has already trusted, whether this pass is
 * a plan) and the tool's **declared** effect. It is deliberately not a function of the model, the
 * arguments, or how many calls came before: any of those would make the gate unpredictable, and a
 * gate the user cannot predict is one they cannot rely on.
 *
 * Nothing here touches Tauri or React — the whole thing is unit-tested, which is the only way to
 * be sure that "auto-approve reads" lets a read through and still stops a write.
 */
import { toolEffect } from "./registry";

export type ApprovalMode = "ask" | "auto-reads" | "yolo";

/** The three modes, in escalation order, with the wording the Settings-style picker shows. */
export const APPROVAL_MODES: ReadonlyArray<{ id: ApprovalMode; label: string; hint: string }> = [
  {
    id: "ask",
    label: "ask every time",
    hint: "Every tool call waits for you — reads and writes alike.",
  },
  {
    id: "auto-reads",
    label: "auto-approve reads",
    hint: "Reading, listing and searching run straight away. Anything that writes still asks.",
  },
  {
    id: "yolo",
    label: "yolo",
    hint: "Everything runs without asking. The sandbox and its root still apply — nothing else does.",
  },
];

export interface ApprovalState {
  mode: ApprovalMode;
  /** Tools the user answered "always allow this tool" for. */
  trustedTools: ReadonlySet<string>;
  /** "Allow for this session": every remaining call runs unprompted, whatever its tool. */
  allowAll: boolean;
  /**
   * Plan mode. A pass whose job is to produce a plan, not to carry it out.
   *
   * It outranks the mode on purpose: `yolo` + plan mode must still refuse writes, or "propose
   * before you touch anything" is a promise the yolo setting can silently break.
   *
   * It only ever **subtracts**. Plan mode does not quietly auto-approve reads in an "ask every
   * time" session — a switch that can grant permissions the mode above it withheld is a switch
   * whose effect the user cannot predict from the two labels they chose. Pair it with
   * "auto-approve reads" if the pass should be quiet; the UI says so.
   */
  planMode: boolean;
}

export const INITIAL_APPROVAL: ApprovalState = {
  mode: "ask",
  trustedTools: new Set<string>(),
  allowAll: false,
  planMode: false,
};

export type Verdict =
  | { action: "allow" }
  | { action: "ask" }
  /** Refused without asking. Carries the wording the model is given, so the reason is not
   *  flattened into "the user denied this" when the user was never asked. */
  | { action: "deny"; reason: string };

/** What the model is told when plan mode refuses a write. It has to say *what to do instead* —
 *  "denied" alone teaches the model to rephrase the same call and try again. */
export function planRefusal(name: string): string {
  return (
    `Tool call "${name}" was refused: this run is in PLAN MODE, which may not modify the workspace. ` +
    "Inspect whatever else you need with the read-only tools, then reply with the plan you intend " +
    "to carry out — the numbered steps and the files each one touches. The user will approve it."
  );
}

/**
 * The decision for one call.
 *
 * Order is the whole specification:
 *  1. plan mode refuses writes — before every mode, including `yolo`;
 *  2. a session-wide allow, or this tool's own allow, is already the user's answer;
 *  3. the mode decides by effect.
 */
export function decide(state: ApprovalState, name: string | undefined | null): Verdict {
  const effect = toolEffect(name);
  if (state.planMode && effect === "mutate") {
    return { action: "deny", reason: planRefusal(name ?? "?") };
  }
  if (state.allowAll) return { action: "allow" };
  if (name && state.trustedTools.has(name)) return { action: "allow" };
  if (state.mode === "yolo") return { action: "allow" };
  if (state.mode === "auto-reads" && effect === "read") return { action: "allow" };
  return { action: "ask" };
}

/** New state with one tool trusted. Immutable, so React sees a new object and the modal closes. */
export function withTrustedTool(state: ApprovalState, name: string): ApprovalState {
  const trustedTools = new Set(state.trustedTools);
  trustedTools.add(name);
  return { ...state, trustedTools };
}

/** New state where nothing else asks this session. */
export function withAllowAll(state: ApprovalState): ApprovalState {
  return { ...state, allowAll: true };
}

/** Whether a mode can ever auto-approve a write — used to word the yolo warning honestly. */
export function modeApprovesWrites(mode: ApprovalMode): boolean {
  return mode === "yolo";
}
