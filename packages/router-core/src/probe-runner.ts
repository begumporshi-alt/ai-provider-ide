/**
 * probe-runner (L1, §2.2): deterministic, FREE-ONLY probes of a candidate provider.
 * GET/OPTIONS over an endpoint matrix; unauthenticated (captures the 401 challenge);
 * response bodies are immediately reduced to shapes by `redaction` — a raw body never
 * survives this module. Runs through the same HttpPort/egress path as everything else
 * (invariant 3: the provider row must exist and be allowlisted before probing).
 */

import type { HttpPortLike } from "./manifest-interpreter.js";
import { shapeOf, sizeCap } from "./redaction.js";

export interface ProbeAttempt {
  method: "GET" | "POST";
  path: string;
  status: number | null;
  contentType?: string;
  authChallenge?: string; // WWW-Authenticate header (name only — values scrubbed by shape)
  bodyShape?: unknown; // redacted {key: type} shape of a JSON body, if parseable
  ms: number;
  error?: string;
}

export interface ProbeReport {
  baseUrl: string;
  ts: number;
  attempts: ProbeAttempt[];
  /** First JSON body that parsed with an OpenAPI `openapi`/`swagger` field, shaped. */
  openapiShape?: unknown;
}

// Existence probes use POST with an empty body: a 400/401/405 proves the route exists and
// captures the auth challenge; 404 proves absence. A validation 400 never reaches a model,
// so these stay FREE (§2.2).
const MATRIX: Array<{ method: "GET" | "POST"; path: string; body?: string }> = [
  { method: "GET", path: "/models" },
  { method: "GET", path: "/v1/models" },
  { method: "POST", path: "/chat/completions", body: "{}" },
  { method: "POST", path: "/v1/chat/completions", body: "{}" },
  { method: "POST", path: "/messages", body: "{}" },
  { method: "POST", path: "/v1/messages", body: "{}" },
  { method: "GET", path: "/openapi.json" },
  { method: "GET", path: "/v1/openapi.json" },
  { method: "GET", path: "/docs" },
];

const BODY_CAP = 8 * 1024; // read at most this much of any probe body

export async function runProbes(
  http: HttpPortLike,
  baseUrl: string,
  onAttempt?: (a: ProbeAttempt) => void,
  signal?: AbortSignal,
): Promise<ProbeReport> {
  const attempts: ProbeAttempt[] = [];
  let openapiShape: unknown;
  for (const { method, path, body } of MATRIX) {
    if (signal?.aborted) break;
    const t0 = Date.now();
    const attempt: ProbeAttempt = { method, path, status: null, ms: 0 };
    try {
      const res = await http.request({
        url: baseUrl.replace(/\/+$/, "") + path,
        method,
        headers: { accept: "application/json, text/plain, */*" },
        body,
        signal,
      });
      attempt.status = res.status;
      attempt.contentType = res.headers["content-type"];
      const challenge = res.headers["www-authenticate"];
      if (challenge) attempt.authChallenge = challenge.split(/\s+/)[0]; // scheme name only
      if (method === "GET" && res.status && res.status < 300) {
        const raw = (await res.text()).slice(0, BODY_CAP);
        try {
          const json: unknown = JSON.parse(raw);
          attempt.bodyShape = shapeOf(json);
          if (
            openapiShape === undefined &&
            json &&
            typeof json === "object" &&
            ("openapi" in (json as object) || "swagger" in (json as object))
          ) {
            openapiShape = sizeCap(shapeOf(json));
          }
        } catch {
          // non-JSON body: nothing recorded (values never persist)
        }
      }
    } catch (e) {
      attempt.error = String((e as Error)?.message ?? e).slice(0, 200);
    }
    attempt.ms = Date.now() - t0;
    attempts.push(attempt);
    onAttempt?.(attempt);
  }
  return { baseUrl, ts: Date.now(), attempts, openapiShape };
}
