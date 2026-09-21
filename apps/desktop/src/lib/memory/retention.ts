/**
 * Idle retention — Phase 5 (design §6.2).
 *
 * Two tables, two policies, one scheduler:
 *
 *  - `memories`  — L0 TTL + per-session ring, L1/L2 decayed below a recency floor. Pinned and L3
 *                  are exempt, because both survive on the operator's say-so rather than on
 *                  recency.
 *  - live context — turn ring per session, TTL on turns, TTL on idle sessions.
 *
 * Both policies already existed host-side; what was missing was anything calling them, so in
 * practice both tables grew without limit.
 *
 * **Runs off the request path.** That is the design's actual requirement ("pruning runs on app
 * idle, never on the request path"), and it is satisfied by construction: this is a timer in the
 * webview, several hops from dispatch. There is no idle *signal* available to a Tauri webview, so
 * "idle" is approximated by a long interval plus one pass at start — inventing an idle detector to
 * save a cheap bounded DELETE would be worse than the thing it replaces.
 *
 * **Gated on the master toggle.** With memory off, neither table is written either, so there is
 * nothing to prune — and the off-by-default guarantee is that the layer performs no writes at all,
 * which has to include deletes. A user's memories are not touched because a feature they never
 * switched on is running housekeeping.
 */
import {
  gatewayMemoryEnabled,
  pruneLiveContext,
  pruneMemories,
  type LiveContextPruneStats,
  type MemoryPruneStats,
} from "../../store";

/** Long enough that a pass is never the thing standing between the user and a response. */
export const IDLE_INTERVAL_MS = 30 * 60_000;

export interface RetentionResult {
  memories?: MemoryPruneStats;
  live?: LiveContextPruneStats;
  /**
   * True when nothing ran: a pass was already in flight, or memory is off host-side. Distinct from
   * "removed nothing" so the UI can say the right thing.
   */
  skipped: boolean;
}

/** A prune is a table scan; two overlapping passes would each re-scan what the other is deleting. */
let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

export async function pruneOnce(): Promise<RetentionResult> {
  if (running) return { skipped: true };
  running = true;
  try {
    if (!(await gatewayMemoryEnabled().catch(() => false))) {
      return { skipped: true };
    }
    const memories = await pruneMemories();
    const live = await pruneLiveContext();
    return { memories, live, skipped: false };
  } finally {
    running = false;
  }
}

export function startRetention(intervalMs: number = IDLE_INTERVAL_MS): void {
  if (timer !== null) return;
  void pruneOnce();
  timer = setInterval(() => void pruneOnce(), intervalMs);
}

export function stopRetention(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test seam: drop the scheduling state. */
export function resetRetention(): void {
  stopRetention();
  running = false;
}
