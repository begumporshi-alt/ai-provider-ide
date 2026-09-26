/**
 * health-tracker (L2): per-key and per-provider circuit state + cooldowns. Decides whether a
 * candidate is currently usable and records the outcome of each attempt. Kept pure of I/O so
 * the execution engine can unit-test failover ordering against it.
 */
import type { ApiKeyRecord, ProviderRecord } from "./domain.js";
import type { ErrorClass } from "./errors.js";
import { isRetryableWithNextKey } from "./errors.js";

export interface KeyHealth {
  cooldownUntil: number; // 0 = ready
  consecutiveAuthFailures: number;
  /**
   * When the auth breaker opened, epoch ms — `null` while it is closed.
   *
   * **The moment rather than a flag, and that is what bounds the exclusion.** A `boolean` plus a
   * separate `openedAt` would be two fields that have to agree, and the pair has a state the flag
   * cannot describe on its own: open, with no idea when it started. Storing the moment makes that
   * state unrepresentable, and it is the moment — not a flag — that `isKeyUsable` reads, so the
   * half-open window cannot be defeated by a missing stamp.
   */
  breakerOpenAt: number | null;
}

const AUTH_BREAKER_THRESHOLD = 3;

/**
 * The shortest cooldown a rate-limited key is ever given, in milliseconds. A provider that names a
 * sub-second `Retry-After` (or none at all) still gets this, so a client is never told to retry
 * "now" into a window that has not closed.
 *
 * Exported because the value the client is *told* must equal the value the tracker *enforces*:
 * `AllAttemptsFailedError.minRetryAfterMs()` floors with this too, and two hardcoded 1000s would
 * be free to drift apart.
 */
export const COOLDOWN_FLOOR_MS = 1000;

/**
 * How long an open auth breaker excludes its key before one re-probe is allowed.
 *
 * **A breaker with no half-open state is a permanent exclusion, and that was this class's
 * behaviour until now.** `breakerOpen` was cleared *only* by an `OK`, and an open breaker meant the
 * key was never tried again — so no `OK` could ever arrive to clear it. A credential rotated back
 * into service, or an upstream that had a bad five minutes, stayed dead to the router for the life
 * of the session. This window bounds that: past it the key is admissible again, and the next
 * attempt decides — an `OK` clears the breaker, an `AUTH_FAILED` re-stamps it and excludes the key
 * for another window. A genuinely revoked key therefore costs **one** `401` per window rather than
 * one per request.
 *
 * **The re-probe is safe because an auth failure is retryable with the next key** — see
 * `isRetryableWithNextKey`, which lists `AUTH_FAILED`. The cost of admitting a dead key is one
 * wasted attempt, not a failed request.
 *
 * One minute: long enough that a revoked credential is not sampled per request, short enough that a
 * credential restored by an operator comes back without a reload. **The breaker is a heuristic
 * layered on the persisted `status` column** — the way to exclude a key permanently is
 * `status: "disabled"`, which is genuinely not on a clock.
 *
 * The Rust gateway implements the same rule at the same value in `core/engine.rs`. The two are
 * separate implementations of one policy, so a change to either needs the same change to the other.
 */
export const BREAKER_HALF_OPEN_MS = 60_000;

export class HealthTracker {
  private keys = new Map<string, KeyHealth>();

  private health(keyId: string): KeyHealth {
    let h = this.keys.get(keyId);
    if (!h) {
      h = { cooldownUntil: 0, consecutiveAuthFailures: 0, breakerOpenAt: null };
      this.keys.set(keyId, h);
    }
    return h;
  }

  /**
   * Whether the auth breaker is still excluding this key at `now`.
   *
   * **One spelling of the half-open rule**, so a second reader cannot answer it differently. The
   * exclusion is a comparison against the moment the breaker opened rather than a read of a flag,
   * and `breakerOpenAt` stays set while the key is half-open: admissible, but not yet trusted.
   */
  private breakerBlocks(h: KeyHealth, now: number): boolean {
    if (h.breakerOpenAt === null) return false;
    return now < h.breakerOpenAt + BREAKER_HALF_OPEN_MS;
  }

  isKeyUsable(key: ApiKeyRecord, now = Date.now()): boolean {
    if (key.status === "disabled" || key.status === "invalid") return false;
    const h = this.health(key.id);
    if (this.breakerBlocks(h, now)) return false;
    if (h.cooldownUntil > now) return false;
    if (key.cooldownUntil && key.cooldownUntil > now) return false;
    return true;
  }

  isProviderUsable(p: ProviderRecord): boolean {
    return p.status === "enabled";
  }

  /** Record an attempt outcome against the key it was made with. */
  recordResult(key: ApiKeyRecord, cls: ErrorClass, retryAfterMs?: number, now = Date.now()): void {
    const h = this.health(key.id);
    if (cls === "OK") {
      h.consecutiveAuthFailures = 0;
      h.cooldownUntil = 0;
      h.breakerOpenAt = null;
      return;
    }
    if (cls === "RATE_LIMITED") {
      h.cooldownUntil = now + Math.max(retryAfterMs ?? 0, COOLDOWN_FLOOR_MS);
      // A 429 says nothing about the credential, so a half-open breaker stays half-open: the key is
      // cooled but not re-armed, and the next attempt — not this rate limit — decides the breaker.
    } else if (cls === "AUTH_FAILED") {
      h.consecutiveAuthFailures++;
      // Stamped on every failure past the threshold, not only on the transition: a half-open
      // re-probe that fails again must re-arm the window, or the key would be admitted on every
      // request from here on — the latch traded for the opposite defect.
      if (h.consecutiveAuthFailures >= AUTH_BREAKER_THRESHOLD) h.breakerOpenAt = now;
    } else if (!isRetryableWithNextKey(cls)) {
      // NOT_FOUND / PARSE_ERROR / BAD_REQUEST_SCHEMA are provider/manifest issues, not key issues;
      // leave key health alone so a good key isn't burned by a model-side drift.
      return;
    }
  }

  resetKey(keyId: string): void {
    this.keys.delete(keyId);
  }
}
