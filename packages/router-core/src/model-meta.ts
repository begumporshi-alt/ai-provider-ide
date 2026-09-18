/**
 * Catalog metadata: context window and reasoning support, read from a provider's RAW catalog
 * entry the same way `pricing.ts` reads price.
 *
 * These exist because a third-party client needs them and cannot guess them. WorkBuddy asks a
 * custom model entry for `maxInputTokens`/`maxOutputTokens` and `supportsReasoning`; answering
 * wrong is not cosmetic — `supportsReasoning: true` on a model that cannot reason makes the
 * client ask for reasoning that never arrives, and a missing input cap truncates long prompts.
 *
 * Both must be PERSISTED with the cached row: the gateway worker hydrates its catalog from
 * SQLite and never re-lists, so anything not written is invisible to it. That is the same
 * defect that made pricing — and therefore cost — read as unknown after every restart.
 */

function toPositiveInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/**
 * Prompt budget in tokens, or `undefined` when the provider published none.
 * OpenRouter uses `context_length`; the other names cover the common variants.
 */
export function parseContextWindow(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return (
    toPositiveInt(r.context_length) ??
    toPositiveInt(r.context_window) ??
    toPositiveInt(r.contextWindow) ??
    toPositiveInt(r.max_context_length) ??
    toPositiveInt(r.maxContextLength)
  );
}

/**
 * Whether the model can produce reasoning, or `undefined` when the provider does not say.
 * Undefined is NOT false: unknown stays unknown, and callers fall back to a conservative
 * default rather than claiming a capability the model may not have.
 */
export function parseReasoningSupport(raw: unknown): boolean | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const params = r.supported_parameters;
  if (Array.isArray(params) && params.length > 0) {
    return params.some((p) => typeof p === "string" && /reason|thinking/i.test(p));
  }
  const flag = r.supports_reasoning ?? r.reasoning ?? r.supportsReasoning;
  if (typeof flag === "boolean") return flag;
  return undefined;
}
