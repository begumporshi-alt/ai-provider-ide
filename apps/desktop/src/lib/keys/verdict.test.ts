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
