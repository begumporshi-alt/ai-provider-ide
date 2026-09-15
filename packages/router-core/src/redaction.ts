/**
 * redaction (L1): structure-only scrubber. Everything a probe (or later, docs fetch) sees is
 * UNTRUSTED input; the redacted form is what may be persisted, displayed, or (Phase 4) sent
 * to the Generator AI — §2.3 redaction contract:
 *   - response values stripped to key/type shapes (no bodies)
 *   - no header VALUES (names only)
 *   - regex scrub for key-shaped strings (sk-…, Bearer …, high-entropy tokens)
 *   - hard size cap
 */

const KEY_SHAPED = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
  /api[_-]?key["'\s:=]+[A-Za-z0-9._-]{8,}/gi,
];

export function scrubStrings(text: string): string {
  let out = text;
  for (const re of KEY_SHAPED) out = out.replace(re, "[REDACTED]");
  return out;
}

/** Collapse a JSON value into a {key: type} shape, depth- and width-capped. */
export function shapeOf(value: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") {
    // strings keep only their length class — never their content
    const s = value as string;
    return s.length > 64 ? `string(${s.length})` : "string";
  }
  if (t === "number" || t === "boolean" || t === "undefined") return t;
  if (Array.isArray(value)) {
    return value.length ? [shapeOf(value[0], depth + 1)] : [];
  }
  if (t === "object" && value) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 24)) {
      out[scrubStrings(k)] = shapeOf(v, depth + 1);
    }
    return out;
  }
  return "unknown";
}

/** Total serialized-size cap for anything redacted (§2.3). */
export function sizeCap<T>(value: T, maxChars = 20_000): T | { truncated: true } {
  const s = JSON.stringify(value) ?? "";
  if (s.length <= maxChars) return value;
  return { truncated: true };
}
