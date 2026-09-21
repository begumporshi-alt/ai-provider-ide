/**
 * Capture-queue drain — the consumer half of the memory write path (§3.3).
 *
 * The host enqueues at `BridgeMsg::Done` and never calls a model. This module is the other half:
 * off the request path, it claims a batch, distils it through the same prompt the chat path uses,
 * and reports each row back. The split is what makes the expensive, unreliable step safe — a slow,
 * misconfigured or offline model delays learning, never a response.
 *
 * Three properties the queue has to hold, and where each one is guaranteed:
 *
 * 1. **Nothing is lost.** A claimed row is `processing`, not gone; a webview that dies mid-batch is
 *    recovered by `captureRequeueStale` on the next start (10-minute claim TTL host-side).
 * 2. **Nothing is distilled twice.** `request_id` is UNIQUE host-side, and a row is only completed
 *    after its atoms are stored — a failure releases it instead.
 * 3. **Nothing is auto-scoped.** The row carries the request's scope, but distilled atoms are
 *    written capture-only. Binding them is a deliberate act in the Memory screen (§4b): an agent's
 *    traffic reaching the injected block on its own say-so is precisely what review rejected.
 */
import {
  captureClaim,
  captureComplete,
  capturePurgeFinished,
  captureRelease,
  captureRequeueStale,
  type PendingRow,
} from "../../store";
import { distilExchange, type Generator } from "./engine";

export interface DrainResult {
  /** Rows put back after a stale claim — i.e. recovered from an earlier crash. */
  requeued: number;
  claimed: number;
  /** Rows that distilled and were completed, including ones that yielded no atoms. */
  distilled: number;
  /** L1 atoms written across the batch. */
  atoms: number;
  /** Rows given back because the distillation call failed. */
  released: number;
  /**
   * True when nothing was attempted because a pass was already running or no model is configured.
   * Distinct from `claimed === 0` so the UI can say "already running" instead of the misleading
   * "nothing queued".
   */
  skipped: boolean;
}

const EMPTY: DrainResult = {
  requeued: 0, claimed: 0, distilled: 0, atoms: 0, released: 0, skipped: false,
};

/** Idle poll. Learning is not latency-sensitive, so this is deliberately slow. */
const IDLE_INTERVAL_MS = 60_000;

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * One drain pass. Re-entrancy-safe: a second concurrent pass returns immediately rather than
 * issuing a second burst of model calls against a different set of rows.
 */
export async function drainOnce(
  model: string | null,
  opts: { generate?: Generator } = {},
): Promise<DrainResult> {
  // No model means distillation cannot run at all. Returning without claiming is what keeps rows
  // queued rather than burning their three attempts on calls that cannot succeed.
  if (!model) return { ...EMPTY, skipped: true };
  if (running) return { ...EMPTY, skipped: true };
  running = true;
  try {
    const requeued = await captureRequeueStale().catch(() => 0);
    const rows = await captureClaim().catch(() => [] as PendingRow[]);
    const out: DrainResult = {
      requeued, claimed: rows.length, distilled: 0, atoms: 0, released: 0, skipped: false,
    };
    for (const row of rows) {
      // The row remembers the model that served the request; fall back to the configured one only
      // when the host could not tell us.
      const servingModel = row.model || model;
      try {
        const atoms = await distilExchange(
          row.session_id ?? "gateway",
          servingModel,
          { user: row.user_text, assistant: row.asst_text ?? "" },
          opts.generate,
        );
        await captureComplete(row.id).catch(() => false);
        out.distilled += 1;
        out.atoms += atoms.length;
      } catch {
        // Give it back. The host retires the row after three attempts, so a turn that will not
        // distil cannot wedge the queue.
        await captureRelease(row.id).catch(() => false);
        out.released += 1;
      }
    }
    return out;
  } finally {
    running = false;
  }
}

/**
 * Run the drain on a slow interval. `getModel` is a function rather than a value because the
 * operator can change the system model while the app is open, and a captured string would keep
 * calling a model that is no longer configured.
 */
export function startCaptureDrain(
  getModel: () => string | null,
  intervalMs: number = IDLE_INTERVAL_MS,
): void {
  if (timer !== null) return;
  // Once per start, not once per tick: finished rows are only an audit trail, and the sweep is a
  // single bounded DELETE.
  void capturePurgeFinished().catch(() => 0);
  void drainOnce(getModel());
  timer = setInterval(() => void drainOnce(getModel()), intervalMs);
}

export function stopCaptureDrain(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test seam: drop the scheduling state. */
export function resetDrain(): void {
  stopCaptureDrain();
  running = false;
}
