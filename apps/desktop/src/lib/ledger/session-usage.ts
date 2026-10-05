/**
 * session-usage — the Assistant's per-session cost/token accumulator.
 *
 * Pre-A1 the session strip re-read the webview's in-memory ledger after every turn. Post-A1 the
 * Assistant's rows are written host-side as `source: "gateway"` — the same source every external
 * client's rows carry, with no app key on those rows to tell them apart — so no ledger query can
 * say what *this* session spent. The screen instead charges each turn's own usage report here
 * (2026-10-05: the readout had been reading the dead ledger since the A1 migration and showed
 * $0.00 for real spend).
 *
 * The honesty rules are the same ones the ledger row and Activity screen use, which is why they
 * live in a pure module rather than in the screen: a turn's cost is only meaningful when pricing
 * exists for the model that actually served it, and "unknown" is kept distinct from "free".
 */
import { estimateCostMicros, type PricingMicros } from "@aiprovider/router-core";

export interface SessionUsage {
  /** Summed micro-USD over the priced turns only — a lower bound when `unpriced > 0`. */
  micros: number;
  /** Turns charged, priced or not. */
  rows: number;
  /** Of `rows`, how many had no published price. */
  unpriced: number;
  tokensIn: number;
  tokensOut: number;
}

export function emptySessionUsage(): SessionUsage {
  return { micros: 0, rows: 0, unpriced: 0, tokensIn: 0, tokensOut: 0 };
}

/** One turn's usage report. `pricing` is the served model's catalog entry, absent when unknown. */
export interface SessionUsageCharge {
  tokensIn: number;
  tokensOut: number;
  pricing?: PricingMicros;
}

/**
 * Charge one turn and return the new totals. An unpriced turn still counts as a row (tokens
 * happened) but contributes no micros — so an all-unpriced session reads as "unknown", not $0.00,
 * and a mixed one reads as "≥ total".
 */
export function chargeSessionUsage(u: SessionUsage, charge: SessionUsageCharge): SessionUsage {
  const cost = estimateCostMicros(charge.pricing, charge.tokensIn, charge.tokensOut);
  return {
    micros: u.micros + (cost ?? 0),
    rows: u.rows + 1,
    unpriced: u.unpriced + (cost === undefined ? 1 : 0),
    tokensIn: u.tokensIn + charge.tokensIn,
    tokensOut: u.tokensOut + charge.tokensOut,
  };
}
