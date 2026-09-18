/**
 * pricing (audit finding R2): normalize provider catalog pricing into ONE unit and make it
 * computable.
 *
 * Before this module the ledger always wrote `costEstimateMicros: 0`: `models_cache.pricing_json`
 * was populated but never read, and `cost_spread` rotation fell back to priority because no
 * price was ever available. So a headline feature — "what did this cost?" — had a schema home
 * and no implementation.
 *
 * Canonical unit: **micro-USD per 1M tokens** (integer). Micros because the ledger column is
 * `cost_estimate_micros INTEGER`; per-1M because per-token prices are ~1e-7 and would round to
 * zero in any integer representation.
 *
 * Currency: providers publish USD. Anything we cannot confidently read as USD is treated as
 * UNKNOWN (undefined) rather than zero — "unknown" and "free" are different facts, and the UI
 * renders them differently.
 */
export interface PricingMicros {
  /** micro-USD per 1M prompt (input) tokens */
  prompt: number;
  /** micro-USD per 1M completion (output) tokens */
  completion: number;
}

const MICROS_PER_USD = 1_000_000;
const TOKENS_PER_MILLION = 1_000_000;

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** USD per token -> micro-USD per 1M tokens (same magnitude, integer-safe). */
function usdPerTokenToMicrosPerMTok(usdPerToken: number): number {
  return Math.round(usdPerToken * TOKENS_PER_MILLION * MICROS_PER_USD);
}

/**
 * Read pricing out of a provider's RAW catalog entry.
 *
 * Recognised shapes (all USD-per-token, string or number):
 *  - OpenRouter:  `{ pricing: { prompt, completion } }`
 *  - generic:     `{ pricing: { input, output } }`
 *  - LiteLLM-ish: `{ pricing: { input_cost_per_token, output_cost_per_token } }`
 *
 * Anything else -> `undefined` (unknown), NEVER zero. Providers that publish no pricing
 * (most Anthropic-compatible catalogs, b.ai) legitimately return undefined.
 */
export function parsePricing(raw: unknown): PricingMicros | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const pricing = (raw as Record<string, unknown>).pricing;
  if (!pricing || typeof pricing !== "object") return undefined;
  const p = pricing as Record<string, unknown>;
  const prompt =
    toNumber(p.prompt) ??
    toNumber(p.input) ??
    toNumber(p.input_cost_per_token) ??
    toNumber(p.prompt_cost_per_token);
  const completion =
    toNumber(p.completion) ??
    toNumber(p.output) ??
    toNumber(p.output_cost_per_token) ??
    toNumber(p.completion_cost_per_token);
  if (prompt === undefined || completion === undefined) return undefined;
  if (prompt < 0 || completion < 0) return undefined; // nonsense price -> unknown, not zero
  return {
    prompt: usdPerTokenToMicrosPerMTok(prompt),
    completion: usdPerTokenToMicrosPerMTok(completion),
  };
}

/**
 * Cost of one request in micro-USD, or `undefined` when pricing is unknown.
 * Callers persist `?? 0`; the UI distinguishes unknown from free via the catalog, not the ledger.
 */
export function estimateCostMicros(
  pricing: PricingMicros | undefined,
  tokensIn: number,
  tokensOut: number,
): number | undefined {
  if (!pricing) return undefined;
  const inCost = (tokensIn * pricing.prompt) / TOKENS_PER_MILLION;
  const outCost = (tokensOut * pricing.completion) / TOKENS_PER_MILLION;
  return Math.round(inCost + outCost);
}

/** Cheapest-first comparison for `cost_spread`; unknown pricing sorts last. */
export function priceRank(p: PricingMicros | undefined): number {
  if (!p) return Number.POSITIVE_INFINITY;
  return p.prompt + p.completion;
}
