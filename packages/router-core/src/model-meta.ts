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

/** Does a modality list mention image input? `["image"]`, `["text","image"]`, … */
function mentionsImageInput(v: unknown): boolean {
  return Array.isArray(v) && v.some((m) => typeof m === "string" && /image/i.test(m));
}

/**
 * Whether the model accepts images as **input**, or `undefined` when the provider does not say.
 *
 * `undefined` is NOT false, for the same reason as reasoning support: a catalog that never mentions
 * modalities is silent about vision, and reporting that silence as "cannot see" would disable image
 * input for providers that support it perfectly well. The UI keeps the two apart — it gates image
 * attachment on a positive declaration and says which case it is, rather than presenting a greyed-out
 * button with no explanation.
 *
 * Read from the shapes providers actually publish:
 *  - OpenRouter: `architecture.input_modalities` — output modalities are deliberately NOT read, since
 *    a model that *generates* images need not accept them
 *  - generic OpenAI-compatible extensions: `input_modalities`, `modalities`
 *  - explicit flags: `supports_vision`, `vision`, `capabilities.vision`
 *
 * Text-only is a positive answer rather than a fallback: an entry publishing
 * `input_modalities: ["text"]` is declaring that images are not accepted, and that returns `false`.
 */
export function parseVisionSupport(raw: unknown): boolean | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const arch = r.architecture;
  if (arch && typeof arch === "object") {
    const inputs = (arch as Record<string, unknown>).input_modalities;
    if (Array.isArray(inputs)) return mentionsImageInput(inputs);
  }
  if (Array.isArray(r.input_modalities)) return mentionsImageInput(r.input_modalities);
  if (Array.isArray(r.modalities)) return mentionsImageInput(r.modalities);
  const caps = r.capabilities;
  if (caps && typeof caps === "object") {
    const flag = (caps as Record<string, unknown>).vision;
    if (typeof flag === "boolean") return flag;
  }
  const direct = r.supports_vision ?? r.vision ?? r.supportsVision;
  if (typeof direct === "boolean") return direct;
  return undefined;
}
