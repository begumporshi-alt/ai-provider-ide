/**
 * `{{placeholder}}` request-template rendering (grammar v1.1).
 *
 * Rules:
 *   "{{x}}"   -> substitute value; if missing, throw (required)
 *   "{{x?}}"  -> OMIT the field entirely when x is undefined/null (sending null breaks some
 *                servers — frozen rule in §2.6)
 *   literals  (non-string JSON values, or strings without {{ }}) pass through unchanged.
 * Mixed text like "Bearer {{token}}" is NOT supported in v1 by design — the manifest lint
 * keeps templating simple and auditable.
 */

export type TemplateValue = unknown;

const PLACEHOLDER = /^\{\{\s*([A-Za-z0-9_]+)(\?)?\s*\}\}$/;

export function renderTemplate<V extends Record<string, TemplateValue>>(
  template: Record<string, unknown>,
  values: V,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, tpl] of Object.entries(template)) {
    if (typeof tpl === "string") {
      const m = PLACEHOLDER.exec(tpl);
      if (!m) {
        out[field] = tpl; // literal string
        continue;
      }
      const [, key, optional] = m;
      const value = values[key as keyof V];
      if (value === undefined || value === null) {
        if (optional) continue; // omit
        throw new Error(`template placeholder {{${key}}} is required but missing for field ${field}`);
      }
      out[field] = value;
    } else {
      out[field] = tpl; // JSON literal (number, bool, object, array)
    }
  }
  return out;
}
