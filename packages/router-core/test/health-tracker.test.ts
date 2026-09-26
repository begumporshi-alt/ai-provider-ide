/**
 * health-tracker (2026-09-27): the auth breaker's exclusion must be finite.
 *
 * The breaker opened after three consecutive `AUTH_FAILED`s and was cleared *only* by an `OK` — and
 * an open breaker meant the key was never tried again, so no `OK` could ever arrive. A credential
 * rotated back into service, or an upstream that had a bad five minutes, stayed dead to the router
 * for the life of the session. These tests pin the half-open window that bounds it.
 *
 * The Rust gateway implements the same rule at the same value (`core/engine.rs`), and its
 * `an_open_breaker_admits_its_key_again_after_the_half_open_window` mirrors the second case below.
 * The two paths are separate implementations of one policy, so a change to either needs both.
 */
import { describe, expect, it } from "vitest";
import { BREAKER_HALF_OPEN_MS, HealthTracker } from "../src/health-tracker.js";
import type { ApiKeyRecord } from "../src/domain.js";

const NOW = 1_000_000;
const HALF_OPEN = NOW + BREAKER_HALF_OPEN_MS;

function key(id = "k1"): ApiKeyRecord {
  return {
    id, providerId: "p1", label: id, secretRef: `key:${id}`,
    status: "active", priority: 0, cooldownUntil: null,
    addedAt: 1, lastUsedAt: null, lastTestedAt: null,
  };
}

/** Three consecutive auth failures, which is what opens the breaker. */
function openTheBreaker(t: HealthTracker, k: ApiKeyRecord, at = NOW): void {
  for (let i = 0; i < 3; i++) t.recordResult(k, "AUTH_FAILED", undefined, at);
}

describe("the auth breaker's half-open window", () => {
  it("opens on the third consecutive auth failure and not before", () => {
    const t = new HealthTracker();
    const k = key();
    for (let i = 1; i < 3; i++) {
      t.recordResult(k, "AUTH_FAILED", undefined, NOW);
      expect(t.isKeyUsable(k, NOW), `still closed after ${i} failure(s)`).toBe(true);
    }
    t.recordResult(k, "AUTH_FAILED", undefined, NOW);
    expect(t.isKeyUsable(k, NOW)).toBe(false);
  });

  it("admits the key again once the window elapses, and not one millisecond before", () => {
    // The regression test for the latch: before this, the key was never admissible again, so the
    // only thing that could clear the breaker was an `OK` that could never be attempted.
    const t = new HealthTracker();
    const k = key();
    openTheBreaker(t, k);

    expect(t.isKeyUsable(k, HALF_OPEN - 1), "excluded one millisecond before the window").toBe(false);
    expect(t.isKeyUsable(k, HALF_OPEN), "the window bounds the exclusion").toBe(true);
  });

  it("re-arms on a failed re-probe rather than admitting the key forever", () => {
    // Without the re-stamp the window would be a one-way door in the other direction: the key would
    // be tried on every request from here on, which is the latch traded for the opposite defect.
    const t = new HealthTracker();
    const k = key();
    openTheBreaker(t, k);

    t.recordResult(k, "AUTH_FAILED", undefined, HALF_OPEN);
    expect(t.isKeyUsable(k, HALF_OPEN), "excluded again").toBe(false);
    expect(t.isKeyUsable(k, HALF_OPEN + BREAKER_HALF_OPEN_MS - 1)).toBe(false);
    expect(t.isKeyUsable(k, HALF_OPEN + BREAKER_HALF_OPEN_MS)).toBe(true);
  });

  it("closes for good when a re-probe succeeds, resetting the consecutive count", () => {
    const t = new HealthTracker();
    const k = key();
    openTheBreaker(t, k);

    t.recordResult(k, "OK", undefined, HALF_OPEN);
    expect(t.isKeyUsable(k, HALF_OPEN)).toBe(true);
    // The breaker counts *consecutive* failures, so one failure after an `OK` is not three.
    t.recordResult(k, "AUTH_FAILED", undefined, HALF_OPEN);
    expect(t.isKeyUsable(k, HALF_OPEN), "one failure after an OK must not re-open it").toBe(true);
  });

  it("stays half-open across a rate limit, because a 429 says nothing about the credential", () => {
    const t = new HealthTracker();
    const k = key();
    openTheBreaker(t, k);

    t.recordResult(k, "RATE_LIMITED", 2_000, HALF_OPEN);
    // Cooling is the only reason it is unusable now: the breaker was *not* re-armed, so the key is
    // free when the cooldown ends rather than a further window later.
    expect(t.isKeyUsable(k, HALF_OPEN + 1_999)).toBe(false);
    expect(t.isKeyUsable(k, HALF_OPEN + 2_000)).toBe(true);
  });
});
