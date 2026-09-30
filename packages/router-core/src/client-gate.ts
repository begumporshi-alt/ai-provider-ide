/**
 * client-gate: a provider that refused **this client** without ever judging the credential.
 *
 * # Why this is a separate finding from "the key is bad"
 *
 * A `401` normally means the provider looked at the credential and rejected it. Some gateways
 * answer `401` for a different reason entirely: they only serve a set of recognised clients, and
 * they check *that* first. The operator's key is never read. Measured 2026-09-29 against
 * `agentrouter.org`, holding the credential constant and varying only `User-Agent`:
 *
 *   | `User-Agent`                     | Body                                                        |
 *   |----------------------------------|-------------------------------------------------------------|
 *   | *(none)*, `curl/8.7.1`, `Mozilla`| `401 unauthorized_client_error` — "unauthorized client detected" |
 *   | `totally-made-up-client/9.9`     | `401 unauthorized_client_error` — "unauthorized client detected" |
 *   | `claude-cli/2.0.0 (external, cli)`| `401 new_api_error` — "无效的令牌" (invalid token)          |
 *
 * The third row is the one that matters: with the client accepted, the *same* dummy key is judged
 * on its merits. So the first two rows are evidence about the client, and none at all about the key.
 *
 * Treating those two rows as a rejected credential is wrong twice over: it takes a working key out
 * of rotation, and it tells the operator something the provider never said.
 *
 * # The marker list is short on purpose, and here is what that costs
 *
 * Both markers below are quoted from the one response above. They are **not** a taxonomy of every
 * client gate in existence, and this module does not pretend to be one. A gateway that words its
 * refusal differently is simply not recognised, and the caller falls back to the previous
 * behaviour — blaming the key. That is the correct direction to fail: a missed gate is the status
 * quo, while a false positive would tell an operator their rejected key is fine.
 *
 * # Where this is consumed
 *
 * One implementation, because two would drift — the defect this repository keeps rediscovering.
 * `lib/keys/verdict.ts` (the desktop's key test) and `probe-runner.ts` (auto setup) both call it.
 */

/**
 * Substrings that name a **client** problem rather than a credential problem.
 *
 * Case-insensitive. Deliberately narrow: each entry is a phrase a provider uses about the caller,
 * not about the key. `unauthorized_client_error` is the OAuth-style `type` token this gateway
 * family emits; `unauthorized client` is the prose of the same response.
 */
const CLIENT_GATE_MARKERS = ["unauthorized_client_error", "unauthorized client"] as const;

/** Statuses a client gate is reported with. A `200` carrying this prose is not a refusal. */
const GATE_STATUSES: ReadonlySet<number> = new Set([401, 403]);

/**
 * Markers in a 400 body that name a **model or endpoint** that does not exist, rather than a
 * request that is malformed. The distinction is drift vs. drift — both are failures of the manifest
 * or alias, not of the key — but classifying a "model not found" as `BAD_REQUEST_SCHEMA` misleads
 * the operator into thinking their request shape is wrong when the real problem is that the
 * provider does not serve that model over that path.
 *
 * Case-insensitive. Narrow and provider-measured, not speculative: each entry is a phrase a real
 * 400 response uses to say "that model is not available here". A body that merely mentions the
 * word "model" is not evidence.
 */
const MODEL_NOT_FOUND_MARKERS = [
  "model not found",
  "model does not exist",
  "does not exist",
  "model not exist",
  "the model does not exist",
  "invalid model",
  "unknown model",
  "does not support model",
] as const;

/**
 * Whether a response is a client gate, and which marker identified it.
 *
 * Returns the matched marker so the caller can quote the provider's own words rather than
 * paraphrase them — the repository's rule for operator-facing text is that the raw signal is
 * appended, not reformatted, so there is only one place for the truth to drift.
 *
 * A non-`401`/`403` status returns `undefined` regardless of body: a client gate is a *refusal*,
 * and a body that merely mentions the phrase is not evidence of one.
 */
export function detectClientGate(status: number, body: string | undefined | null): string | undefined {
  if (!GATE_STATUSES.has(status)) return undefined;
  if (!body) return undefined;
  const hay = body.toLowerCase();
  return CLIENT_GATE_MARKERS.find((m) => hay.includes(m));
}

/**
 * Whether a 400 response body names a **model that does not exist** on this provider, rather than
 * a malformed request. Returns the matched marker (or undefined) so the caller can quote the
 * provider's own words in the chain entry.
 *
 * A non-400 status returns `undefined`: "model not found" is a 400-class signal, not a 404-class
 * one on every provider (some gatekeepers return 400 for anything they refuse before routing).
 */
export function detectNotFound(status: number, body: string | undefined | null): string | undefined {
  if (status !== 400) return undefined;
  if (!body) return undefined;
  const hay = body.toLowerCase();
  return MODEL_NOT_FOUND_MARKERS.find((m) => hay.includes(m));
}

/**
 * What the operator should be told, given a detected gate.
 *
 * Phrased around what was *proved*: the provider refused the client, and by implication did not
 * evaluate the key. It deliberately does not name a `User-Agent` to send — which client a gateway
 * will accept is a per-gateway fact, and impersonating a recognised one is the operator's decision
 * to make, not a default this product should apply on their behalf.
 */
export function clientGateNotice(marker: string): string {
  return (
    `the provider refused this client, not this key — it answered "${marker}" before reading the ` +
    `credential, so the key was never judged. The key has been left as it was. This gateway serves ` +
    `only specific clients; set the User-Agent it expects under the provider's custom headers.`
  );
}
