/**
 * Pure helpers for the Assistant's per-message actions (retry / edit / delete).
 *
 * They live outside the screen because they are the fiddly part of those actions — which turn a
 * retry re-runs, and what prefix an edit keeps — and because index arithmetic over a transcript
 * is exactly the thing that is wrong once and then invisible. The screen calls these; the tests
 * pin the behaviour.
 */

/** The minimum a transcript entry needs for these helpers. `Msg` and the History types both fit. */
export interface Turn {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Optional, so the History types still fit. `retryPoint` carries the prompt's attachments back
   *  to the caller: a retried vision turn must go out with its images, or the model answers a
   *  question it can no longer see (measured 2026-10-05 — regenerate dropped the images). */
  attachments?: { mediaType: string; dataBase64: string }[];
}

/**
 * The user turn that produced the assistant reply at `assistantIndex`, plus the history that
 * precedes it. Returns null when there is no user turn before it — a transcript cannot be
 * retried from a point with no prompt.
 *
 * The prefix is `slice(0, userIndex)`, i.e. it EXCLUDES the user turn being retried: the caller
 * re-runs its text, and `runTurn` appends it fresh. Including it here would duplicate the prompt.
 * The retried turn's attachments ride alongside the text for the same reason.
 */
export function retryPoint<T extends Turn>(
  msgs: readonly T[],
  assistantIndex: number,
): { text: string; prefix: T[]; attachments: T["attachments"] } | null {
  const base = msgs.slice(0, assistantIndex);
  for (let k = base.length - 1; k >= 0; k--) {
    const m = base[k]!;
    if (m.role === "user") return { text: m.content, prefix: base.slice(0, k), attachments: m.attachments };
  }
  return null;
}

/**
 * The history kept when the user turn at `userIndex` is edited and resent: everything before it.
 * The edited turn and everything after it are dropped and rebuilt by `runTurn`.
 */
export function editPoint<T extends Turn>(msgs: readonly T[], userIndex: number): T[] {
  return msgs.slice(0, userIndex);
}
