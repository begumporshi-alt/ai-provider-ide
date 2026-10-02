/**
 * error-taxonomy (§2.10): the ONLY classification the execution engine uses to decide
 * rotate / failover / drift. Maps an HTTP status (+ optional body signal) to a class.
 */
import { detectClientGate, detectNotFound } from "./client-gate.js";

export type ErrorClass =
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "BAD_REQUEST_SCHEMA"
  | "PARSE_ERROR"
  | "SERVER_ERROR"
  | "TIMEOUT"
  | "NETWORK"
  | "CLIENT_GATE"
  | "BILLING"
  | "OK";

/** Errors that count toward provider drift (§2.10). */
export const DRIFT_CLASSES: ReadonlySet<ErrorClass> = new Set([
  "NOT_FOUND",
  "BAD_REQUEST_SCHEMA",
  "PARSE_ERROR",
  "AUTH_FAILED",
]);

/** Errors where the next KEY might work (same provider). */
export function isRetryableWithNextKey(c: ErrorClass): boolean {
  return c === "AUTH_FAILED" || c === "RATE_LIMITED" || c === "SERVER_ERROR" || c === "NETWORK";
}

/**
 * Classify a response the engine actually saw, body in hand.
 *
 * `classify` stays body-blind so tests and planners can reason about statuses alone; this is the
 * wrapper every call site with a real response body uses, because two failures are invisible to a
 * status and only the body can name them:
 *
 * - **A client gate** (`CLIENT_GATE`): the provider refused the *caller* on a 401/403 without ever
 *   reading the credential. Classifying it `AUTH_FAILED` is wrong twice over — it rotates through
 *   every other key of the provider (none of which will be read either) and opens auth breakers on
 *   healthy keys. Detected by the one authority, `detectClientGate` (`client-gate.ts`), which fails
 *   toward "blame the key": an unrecognised body stays `AUTH_FAILED`.
 * - **A billing refusal** (`BILLING`): a 402 is a budget-pool condition, not a transport one.
 *   Classifying it `NETWORK` counted a billing condition against the provider's network health and
 *   sent the loop hunting for a "better connected" provider.
 * - **A model-not-found** (`NOT_FOUND`): a 400 whose body says the model does not exist is drift
 *   in the manifest or alias, not a malformed request. Classifying it `BAD_REQUEST_SCHEMA` (the
 *   status-only default) misleads the operator into checking their request shape when the real
 *   problem is that the provider does not serve that model. Detected by `detectNotFound`
 *   (`client-gate.ts`), which fails toward "schema": an unrecognised 400 body stays
 *   `BAD_REQUEST_SCHEMA`.
 */
export function classifyHttp(status: number, body: string | undefined | null): ErrorClass {
  const gate = detectClientGate(status, body);
  if (gate) return classify(status, "client_gate");
  if (detectNotFound(status, body)) return classify(status, "not_found");
  return classify(status);
}

export function classify(status: number, bodyHint?: "schema" | "not_found" | "client_gate" | null): ErrorClass {
  if (status >= 200 && status < 300) return "OK";
  // A gate is a 401/403 that is not about the credential — checked before the auth arm, and only
  // when the body named it (see client-gate.ts for why the marker list is deliberately narrow).
  if (bodyHint === "client_gate" && (status === 401 || status === 403)) return "CLIENT_GATE";
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 404) return "NOT_FOUND";
  if (status === 400) return bodyHint === "not_found" ? "NOT_FOUND" : "BAD_REQUEST_SCHEMA";
  if (status === 408) return "TIMEOUT";
  // Billing: the provider answered, so nothing about the transport or the credential is wrong.
  // Not drift (the manifest is fine), not key-retryable (the pool does not refill per key).
  if (status === 402) return "BILLING";
  if (status >= 500) return "SERVER_ERROR";
  return "NETWORK";
}

/**
 * The provider's own words for why it refused, short enough for a chain entry.
 *
 * Before this existed the classifier kept only the class token, so an upstream
 * `400 {"error":{"code":"content-blocked",…}}` reached the operator as "schema" — a word about
 * *our* request shape, for a refusal that was about the provider's content policy. The raw signal
 * is appended, not reformatted: `error.code` when the body names one, else `error.message`, else
 * the body itself, truncated to `MAX_REASON_CHARS`.
 */

/**
 * Longest provider reason kept, counted in **code points**.
 *
 * 120 was too tight for the message this exists to carry. Measured against `agentrouter.org`'s
 * Anthropic route on 2026-10-02, a rejected `tool_result` answers with 186 characters before the
 * aggregator appends its own request/trace ids:
 *
 *   unexpected `messages.2.content.0: tool_use_id` found in `tool_result` blocks: toolu_x.
 *   Each `tool_result` block must have a corresponding `tool_use` block in the previous message.
 *
 * The old cut landed at "Each `…", dropping BOTH the offending id and the rule that explains it —
 * so a live 400 could not be diagnosed from the ledger at all, which is the same
 * evidence-truncated-where-it-matters defect as the stream sample. The cap exists only to bound a
 * text column; a validation error that cannot state its rule is not evidence.
 */
export const MAX_REASON_CHARS = 400;

export function reasonFromBody(body: string | undefined | null): string | undefined {
  if (!body) return undefined;
  let reason: string | undefined;
  try {
    const json: unknown = JSON.parse(body);
    if (json && typeof json === "object") {
      const err = (json as Record<string, unknown>)["error"];
      if (err && typeof err === "object") {
        const e = err as Record<string, unknown>;
        const code = typeof e["code"] === "string" ? e["code"] : undefined;
        const message = typeof e["message"] === "string" ? e["message"] : undefined;
        reason = code && message ? `${code}: ${message}` : (code ?? message);
      }
    }
  } catch {
    // not JSON — the raw text is still the provider's own words
  }
  reason ??= body;
  // Code points, not `slice`: a UTF-16 cut can land between a surrogate pair and leave a lone half
  // in the ledger — the same rule the Rust mirror's `chars()` and the stream sample follow.
  const points = Array.from(reason);
  return points.length <= MAX_REASON_CHARS ? reason : `${points.slice(0, MAX_REASON_CHARS).join("")}…`;
}
