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
  breakerOpen: boolean; // too many auth failures -> treat key as invalid
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

export class HealthTracker {
  private keys = new Map<string, KeyHealth>();

  private health(keyId: string): KeyHealth {
    let h = this.keys.get(keyId);
    if (!h) {
      h = { cooldownUntil: 0, consecutiveAuthFailures: 0, breakerOpen: false };
      this.keys.set(keyId, h);
    }
    return h;
  }

  isKeyUsable(key: ApiKeyRecord, now = Date.now()): boolean {
    if (key.status === "disabled" || key.status === "invalid") return false;
    const h = this.health(key.id);
    if (h.breakerOpen) return false;
    if (h.cooldownUntil > now) return false;
    if (key.cooldownUntil && key.cooldownUntil > now) return false;
    return true;
  }

  isProviderUsable(p: ProviderRecord): boolean {
    return p.status === "enabled";
  }

  /** Record an attempt outcome. Returns the resulting error class for logging. */
  recordResult(key: ApiKeyRecord, cls: ErrorClass, retryAfterMs?: number, now = Date.now()): void {
    const h = this.health(key.id);
    if (cls === "OK") {
      h.consecutiveAuthFailures = 0;
      h.cooldownUntil = 0;
      h.breakerOpen = false;
      return;
    }
    if (cls === "RATE_LIMITED") {
      h.cooldownUntil = now + Math.max(retryAfterMs ?? 0, COOLDOWN_FLOOR_MS);
    } else if (cls === "AUTH_FAILED") {
      h.consecutiveAuthFailures++;
      if (h.consecutiveAuthFailures >= AUTH_BREAKER_THRESHOLD) h.breakerOpen = true;
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
