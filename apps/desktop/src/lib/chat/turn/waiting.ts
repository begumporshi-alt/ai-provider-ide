/**
 * A local "still waiting" line for a request that has not produced its first chunk yet.
 *
 * The engine's retry notices only fire when a retry is *scheduled*; a single attempt that spends
 * 25 seconds waiting for headers shows nothing at all. With a per-provider budget that can now be
 * a minute, that silence is the difference between "slow" and "frozen". This timer paints into the
 * same `retryStatus` field the retry notices use, so the bubble's existing status line is the only
 * surface that changes.
 *
 * Deliberately local and cosmetic: it never affects the request, the retry policy, or the
 * transcript. The caller stops it when the first chunk arrives, when a retry notice takes over, or
 * in its `finally`.
 */

export interface WaitingNoticeOptions {
  /** How long to wait before the first paint. Default 10s. */
  afterMs?: number;
  /** How often to update the elapsed count after that. Default 5s. */
  everyMs?: number;
}

/**
 * Paint `Still waiting on <model> (Ns)…` until the returned function is called.
 *
 * Returns `stop`; calling it more than once is harmless. The interval is cleared but the status
 * line is **not** cleared — the caller owns that, because a retry notice may be the next thing
 * painted and clearing here would erase it.
 */
export function startWaitingNotice(
  paint: (text: string) => void,
  model: string,
  options: WaitingNoticeOptions = {},
): () => void {
  const afterMs = options.afterMs ?? 10_000;
  const everyMs = options.everyMs ?? 5_000;
  const started = Date.now();

  const tick = () => {
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    paint(`Still waiting on ${model} (${seconds}s)…`);
  };

  let interval: ReturnType<typeof setInterval> | undefined;
  const timer = setTimeout(() => {
    tick();
    interval = setInterval(tick, everyMs);
  }, afterMs);
  // A cosmetic timer must not hold a Node process (or a test) open.
  const unref = (timer as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);

  return () => {
    clearTimeout(timer);
    if (interval !== undefined) clearInterval(interval);
    interval = undefined;
  };
}
