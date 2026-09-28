/**
 * Key-test verdicts. Pins the one property that matters: a test which proved nothing must not be
 * reported as a verdict about the key.
 *
 * The regression this guards is not cosmetic. `invalid` removes a key from rotation
 * (`HealthTracker.isKeyUsable`), so classifying a transport failure as `invalid` meant that testing
 * a key while the network hiccuped — or while the provider was returning 5xx — silently disabled a
 * key that was fine, and told the operator it had been rejected.
 */
import { describe, expect, it } from "vitest";
import { isConclusive, verdictFor, verdictNotice, type PingResult } from "./verdict";

const ping = (p: Partial<PingResult> = {}): PingResult => ({
  ok: false,
  status: 0,
  rateLimited: false,
  ...p,
});

describe("key verdicts", () => {
  describe("verdictFor", () => {
    it("calls a served ping active", () => {
      expect(verdictFor(ping({ ok: true, status: 200 }))).toBe("active");
    });

    it("refuses to blame the key when no response arrived", () => {
      // `pingKey` uses status 0 for DNS, TLS, timeout, offline and a missing listModels endpoint.
      // This is the case that used to be reported as an invalid key.
      expect(verdictFor(ping({ status: 0, message: "NETWORK" }))).toBe("unverified");
    });

    it("does not blame the key for a provider-side failure", () => {
      for (const status of [500, 502, 503]) {
        expect(verdictFor(ping({ status })), `HTTP ${status}`).toBe("unverified");
      }
    });

    it("does not blame the key for a request the provider rejected", () => {
      // 400/404 normally mean our request or base URL is wrong, not that the credential is bad.
      for (const status of [400, 404, 422]) {
        expect(verdictFor(ping({ status })), `HTTP ${status}`).toBe("unverified");
      }
    });

    it("blames the key only when the provider rejected the credential", () => {
      expect(verdictFor(ping({ status: 401 }))).toBe("invalid");
      expect(verdictFor(ping({ status: 403 }))).toBe("invalid");
    });

    it("cools down on a rate limit, whether flagged or inferred from 429", () => {
      expect(verdictFor(ping({ status: 429, rateLimited: true }))).toBe("cooldown");
      // The flag is authoritative when the adapter reports it without a status.
      expect(verdictFor(ping({ status: 0, rateLimited: true }))).toBe("cooldown");
    });

    it("never returns invalid for a transport failure", () => {
      // The property, stated once: across every non-credential failure mode, `invalid` is absent.
      const transport: PingResult[] = [
        ping({ status: 0, message: "NETWORK" }),
        ping({ status: 0, message: "fetch failed" }),
        ping({ status: 0, message: "provider has no listModels endpoint" }),
        ping({ status: 500 }),
      ];
      for (const r of transport) expect(verdictFor(r)).not.toBe("invalid");
    });
  });

  /**
   * A gateway that refuses the client before reading the credential. The body below is quoted
   * verbatim from `agentrouter.org`, measured 2026-09-29: the *same* dummy key returns this body
   * with no recognised `User-Agent`, and a real "invalid token" once the client is accepted.
   * So this response is evidence about the client and none at all about the key.
   */
  describe("a client gate is not a rejected key", () => {
    const GATE_BODY =
      '{"error":{"message":"unauthorized client detected, contact support for assistance at ' +
      'https://discord.gg/HgekCyHJqB"},"message":"UNAUTHENTICATED","success":false,' +
      '"type":"unauthorized_client_error"}';
    const gatePing = (status = 401): PingResult =>
      ping({ status, message: `HTTP ${status}: ${GATE_BODY}` });

    it("leaves the key alone rather than pulling it out of rotation", () => {
      expect(verdictFor(gatePing(401))).toBe("unverified");
      expect(verdictFor(gatePing(403))).toBe("unverified");
      // The consequence that matters: an `unverified` verdict is never written, so the key stays
      // usable. Asserted through `isConclusive` because that is the gate the writer actually uses.
      expect(isConclusive(verdictFor(gatePing(401)))).toBe(false);
    });

    it("says the client was refused, and does not claim the key was rejected", () => {
      const s = verdictNotice("key-01", gatePing());
      expect(s).toContain("refused this client");
      expect(s).toContain("before reading the credential");
      expect(s).toContain("left as it was");
      expect(s).toContain("unauthorized_client_error");
      // The specific misreport: the operator was told the provider rejected their key.
      expect(s).not.toContain("rejected this key");
      expect(s).not.toContain("out of rotation");
    });

    it("still blames the key when the 401 is really about the credential", () => {
      // The guard against over-reach: no gate marker, so this stays a credential verdict.
      expect(verdictFor(ping({ status: 401, message: "HTTP 401: no auth credentials" }))).toBe("invalid");
      expect(verdictFor(ping({ status: 401, message: '{"error":"invalid api key"}' }))).toBe("invalid");
    });

    it("only treats a refusal as a gate, never a body that merely mentions the phrase", () => {
      // A 200 or a 500 carrying this prose is not a refusal, so it is not a client gate. Without
      // the status guard the phrase alone would suppress a genuine credential verdict.
      expect(verdictFor(ping({ ok: true, status: 200, message: GATE_BODY }))).toBe("active");
      expect(verdictFor(ping({ status: 500, message: GATE_BODY }))).toBe("unverified");
      expect(verdictNotice("k", ping({ ok: true, status: 200 }))).toBe("k: valid");
    });
  });

  describe("isConclusive", () => {
    it("lets only the three storable verdicts overwrite a status", () => {
      expect(isConclusive("active")).toBe(true);
      expect(isConclusive("cooldown")).toBe(true);
      expect(isConclusive("invalid")).toBe(true);
      // `unverified` is not in the column's vocabulary, so it must not be written.
      expect(isConclusive("unverified")).toBe(false);
    });
  });

  describe("verdictNotice", () => {
    it("says the test proved nothing, and says the key was left alone", () => {
      const s = verdictNotice("key-01", ping({ status: 0, message: "NETWORK" }));
      expect(s).toContain("could not verify");
      expect(s).toContain("NETWORK");
      expect(s).toContain("left as it was");
      // The specific misreport this replaced.
      expect(s).not.toContain("invalid");
    });

    it("names the rejection and the consequence when the key really is bad", () => {
      const s = verdictNotice("key-02", ping({ status: 401, message: "HTTP 401: no auth credentials" }));
      expect(s).toContain("rejected this key");
      expect(s).toContain("HTTP 401: no auth credentials");
      expect(s).toContain("out of rotation");
    });

    it("keeps the raw cause rather than paraphrasing it", () => {
      expect(verdictNotice("k", ping({ status: 503, message: "HTTP 503: upstream down" }))).toContain(
        "HTTP 503: upstream down",
      );
      // No message at all must still read as a sentence.
      expect(verdictNotice("k", ping({ status: 0 }))).toContain("could not verify.");
    });

    it("reports success plainly, with no caveat attached", () => {
      expect(verdictNotice("key-03", ping({ ok: true, status: 200 }))).toBe("key-03: valid");
    });
  });
});
