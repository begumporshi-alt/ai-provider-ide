/**
 * Ledger row formatting — the pure text the Activity screen prints for a request row.
 *
 * Kept out of Activity.tsx deliberately: vitest here runs in a node environment with no jsdom,
 * and `.tsx` is not in the include glob, so anything living in the screen is untestable. These
 * functions exist because the screen shipped rows that contradicted themselves:
 *
 *   - the chain closed with a hardcoded `✓`, so a failed request rendered `final: — · — → ✓`;
 *   - the detail line said `served:` for a request that was never served, because `model` falls
 *     back to the requested id when nothing served;
 *   - the status column printed a catch-all class, so the row's own chain disagreed with it.
 *
 * All three are the same mistake — asserting something the ledger did not know — so they are
 * pinned together, in a module a test can reach.
 */

/** The row fields the summary lines depend on. `provider`/`key` are display strings, `—` if none. */
export interface RowOutcome {
  status: string;
  provider: string;
  key: string;
  errorClass: string | null;
  httpStatus: number | null;
}

/**
 * Did a provider actually produce a token for this request?
 *
 * This is the load-bearing distinction, and it is why the ledger stores the *serving* provider
 * only: a non-null provider on a failed row means it served and then broke, while `—` means
 * nothing served at all. Overloading the column with the last *attempted* provider would erase
 * the difference and name a provider that never answered.
 */
export function wasServed(r: Pick<RowOutcome, "status" | "provider">): boolean {
  return r.status === "ok" || r.provider !== "—";
}

/**
 * The closing line of a routing chain. It must agree with the status column, and on a failure it
 * names the class and the upstream status. "no provider served" is spelled out rather than shown
 * as a dash, because a dash is precisely what made the original row ambiguous.
 */
export function finalLine(r: RowOutcome): string {
  const who = wasServed(r) ? `${r.provider} · ${r.key}` : "no provider served";
  if (r.status === "ok") return `${who} → ✓`;
  const cls = r.errorClass ?? "failed";
  return `${who} → ✕ ${cls}${r.httpStatus != null ? ` (HTTP ${r.httpStatus})` : ""}`;
}

/** The `requested: … → …` line, which must not claim a provider served when none did. */
export function servedLine(
  r: Pick<RowOutcome, "status" | "provider">,
  requested: string,
  model: string,
  modality: string,
): string {
  return `requested: ${requested} → ${wasServed(r) ? `served: ${model}` : "not served"} (${modality})`;
}

/** Tooltip for the status cell: the class, the raw status, and who (if anyone) served. */
export function statusTitle(r: RowOutcome): string | undefined {
  if (r.status === "ok") return undefined;
  return [
    r.errorClass ?? "failed",
    r.httpStatus != null ? `HTTP ${r.httpStatus}` : "no HTTP response",
    r.provider === "—" ? "no provider served" : `served by ${r.provider} before failing`,
  ].join(" · ");
}
