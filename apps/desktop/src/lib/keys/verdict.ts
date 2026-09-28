/**
 * What a key test actually proved.
 *
 * The distinction that matters is between *the provider told us this credential is no good* and
 * *we never got an answer*. `pingKey` reports the second as `status: 0`, and a key whose status is
 * `invalid` is removed from rotation outright — `HealthTracker.isKeyUsable` returns false for it,
 * and the catalog refresh only considers `active` keys. So mapping every failure onto `invalid`
 * means a DNS blip, an offline laptop, or a provider 5xx silently takes a working key out of
 * service, and the operator sees the word "invalid" attached to a key that was never rejected.
 *
 * Hence four verdicts, not three. `unverified` is not a stored key status — the column's vocabulary
 * is `active | cooldown | invalid | disabled` and this module does not widen it. It means "leave the
 * status alone", which is the only honest thing to do when the test proved nothing.
 *
 * Lives in a `.ts` file on purpose: the desktop vitest config does not include `.tsx`, so logic that
 * needs unit tests has to live outside a component.
 */

import { detectClientGate, clientGateNotice } from "@aiprovider/router-core";

/** `active | cooldown | invalid` are storable; `unverified` deliberately is not. */
export type KeyVerdict = "active" | "cooldown" | "invalid" | "unverified";

/** The shape `AdapterInstance.pingKey` resolves to. */
export interface PingResult {
  ok: boolean;
  status: number;
  rateLimited: boolean;
  message?: string;
}

/**
 * Classify a ping. Deliberately conservative: `invalid` is reserved for the two statuses that
 * unambiguously mean "this credential is not accepted".
 */
export function verdictFor(r: PingResult): KeyVerdict {
  if (r.ok) return "active";
  // A rate limit is checked before the missing-status case below, because `rateLimited` is a
  // *positive* claim by the adapter ("I saw a 429") while `status: 0` is the *absence* of a status.
  // When the two disagree the claim is the better evidence.
  if (r.rateLimited || r.status === 429) return "cooldown";
  // No HTTP response at all — DNS, TLS, timeout, offline, or a manifest with no listModels
  // endpoint. `pingKey` uses 0 for every one of those.
  if (r.status === 0) return "unverified";
  // **A 401/403 is not evidence about the key when the provider never read the key.** Some
  // gateways refuse the *client* first; measured 2026-09-29, `agentrouter.org` answers
  // `401 unauthorized_client_error` to any unrecognised `User-Agent` and only judges the
  // credential once the client is accepted. Classifying that as `invalid` did two wrong things at
  // once: it took a working key out of rotation (`HealthTracker.isKeyUsable`, and the catalog
  // refresh considers `active` keys only) and it told the operator their key had been rejected.
  // `unverified` is the honest verdict — it means "leave the status alone" — and the notice below
  // carries the real cause. See `client-gate.ts` for the measurement.
  if (detectClientGate(r.status, r.message)) return "unverified";
  // The only two answers that are evidence about the credential itself.
  if (r.status === 401 || r.status === 403) return "invalid";
  // 5xx is the provider failing; 400/404/422 usually mean our request or base URL is wrong. Neither
  // is evidence about the key, so we decline to claim one.
  return "unverified";
}

/**
 * Whether a verdict is strong enough to overwrite the key's stored status. Exported so the rule has
 * one name and one test, rather than being re-derived as a `!== "unverified"` in each caller.
 */
export function isConclusive(v: KeyVerdict): v is Exclude<KeyVerdict, "unverified"> {
  return v !== "unverified";
}

/**
 * The one line the operator sees. Says what was proved, and — when nothing was — says so instead of
 * borrowing a verdict. The raw `message` is appended rather than reformatted: it already carries
 * the cause (`NETWORK`, `HTTP 401: <body>`), and paraphrasing it would only add a second place for
 * the truth to drift.
 */
export function verdictNotice(label: string, r: PingResult): string {
  // Checked before the switch, because the gate's whole point is that the ordinary `invalid`
  // wording would be a lie here: `verdictFor` has already declined to call this key bad, and this
  // line has to agree with it. The gate is quoted by its own marker rather than paraphrased.
  const gate = detectClientGate(r.status, r.message);
  if (gate) return `${label}: ${clientGateNotice(gate)}`;
  const verdict = verdictFor(r);
  const detail = r.message ? ` — ${r.message}` : "";
  switch (verdict) {
    case "active":
      return `${label}: valid`;
    case "cooldown":
      return `${label}: rate-limited${detail}. The key is kept and will cool down.`;
    case "invalid":
      return `${label}: the provider rejected this key${detail}. It is out of rotation until you enable it.`;
    case "unverified":
      return `${label}: could not verify${detail}. The key was left as it was.`;
  }
}
