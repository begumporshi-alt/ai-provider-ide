/**
 * error-taxonomy (§2.10): the ONLY classification the execution engine uses to decide
 * rotate / failover / drift. Maps an HTTP status (+ optional body signal) to a class.
 */
export type ErrorClass =
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "BAD_REQUEST_SCHEMA"
  | "PARSE_ERROR"
  | "SERVER_ERROR"
  | "TIMEOUT"
  | "NETWORK"
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

export function classify(status: number, bodyHint?: "schema" | "not_found" | null): ErrorClass {
  if (status >= 200 && status < 300) return "OK";
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 429) return "RATE_LIMITED";
  if (status === 404) return "NOT_FOUND";
  if (status === 400) return bodyHint === "not_found" ? "NOT_FOUND" : "BAD_REQUEST_SCHEMA";
  if (status === 408) return "TIMEOUT";
  if (status >= 500) return "SERVER_ERROR";
  return "NETWORK";
}
