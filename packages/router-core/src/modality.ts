/**
 * modality — the single place a manifest rule decides a model's modality (v1.1; the
 * `rawMatch` matcher was added by the 2026-09-16 amendment, DECISIONS.md). Shared by the
 * declarative interpreter and the sandboxed code adapter so both tiers tag models identically.
 *
 * A rule matches when EITHER matcher hits. `rawMatch` reads the provider's own model
 * metadata (the raw object from `listModels.map.raw`) — namespaced catalogs like
 * OpenRouter's state image capability there (`architecture.output_modalities`), where an
 * id regex can never see it.
 */
import type { Modality, ModalityRule } from "@aiprovider/adapter-spec";
import { selectOne } from "./jsonpath.js";

export interface ModalityInput {
  nativeId: string;
  raw?: unknown;
}

/** True when the rule's id pattern or metadata matcher picks this model. */
export function matchesModalityRule(rule: ModalityRule, entry: ModalityInput): boolean {
  if (rule.modelIdPattern !== undefined && new RegExp(rule.modelIdPattern).test(entry.nativeId)) {
    return true;
  }
  if (rule.rawMatch !== undefined) {
    const v = selectOne(entry.raw, rule.rawMatch.path);
    // Scalar => equality; array => membership. Anything else (missing, number, nested) => no.
    if (Array.isArray(v) ? v.includes(rule.rawMatch.contains) : v === rule.rawMatch.contains) {
      return true;
    }
  }
  return false;
}

/**
 * Modality of a discovered model. Modality is single-valued (text | image) by design — a
 * model that can BOTH write text and emit images is classified by whichever rule claims it,
 * and only the image rule ever claims anything here: unmatched models are text.
 */
export function tagModality(
  rules: { image?: ModalityRule } | undefined,
  entry: ModalityInput,
): Modality {
  return rules?.image && matchesModalityRule(rules.image, entry) ? "image" : "text";
}
