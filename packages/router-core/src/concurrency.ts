/**
 * provider-limiter (L1): per-provider in-flight cap (audit finding R3).
 *
 * Why this exists: the gateway admits requests through ONE global semaphore
 * (`MAX_TOTAL` = 8 concurrent + 32 queued), so a single slow or rate-limited provider could
 * occupy every slot and starve every other provider — which defeats the entire point of
 * failover. A global bound cannot see providers; this one can.
 *
 * Why it lives in the core and not at the gateway edge: the gateway does not know which
 * provider will serve a request until the router has planned it. Enforcing the cap here means
 * a saturated provider is *skipped in the plan*, so the request fails over to a provider that
 * can actually serve it, rather than being rejected outright or queued behind a degraded one.
 *
 * Placement follows the existing layering: the engine consults it per candidate, so consecutive
 * candidates belonging to the same saturated provider are all skipped and the loop naturally
 * advances to the next provider's keys.
 */
export const PER_PROVIDER_DEFAULT = 4;

/** Upper bound when the cap is user-set. Not a security control — `0` already means unlimited,
 *  and that is a legitimate choice — but 5000 in-flight requests to one provider is not a
 *  different setting from 64, it is 64 with the failure arriving later. */
export const MAX_PER_PROVIDER = 64;

/**
 * Clamp a user-supplied (or stored) per-provider cap into `[0, MAX_PER_PROVIDER]`.
 *
 * `0` is preserved: it is the documented "unlimited" and a deliberate choice. A NEGATIVE is not
 * the same thing — `hasCapacity` tests `maxPerProvider <= 0`, so `-1` would behave as unlimited
 * while displaying as a bound. It falls back to the default: removing the cap should take a
 * deliberate `0`, and a corrupted value must yield a real cap rather than no cap at all.
 *
 * Numbers and numeric strings only; anything else falls back to the default, because
 * `null`/`[]`/`true` all coerce to a number in JS and would turn a missing setting into a real
 * one.
 */
export function clampConcurrency(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return PER_PROVIDER_DEFAULT;
  const floored = Math.floor(n);
  if (floored < 0) return PER_PROVIDER_DEFAULT;
  return Math.min(MAX_PER_PROVIDER, floored);
}

export class ProviderLimiter {
  /** Mutable so Router Settings can change it at runtime. `<= 0` means unlimited. */
  maxPerProvider: number;

  private readonly inFlight = new Map<string, number>();

  constructor(maxPerProvider: number = PER_PROVIDER_DEFAULT) {
    this.maxPerProvider = maxPerProvider;
  }

  inFlightCount(providerId: string): number {
    return this.inFlight.get(providerId) ?? 0;
  }

  hasCapacity(providerId: string): boolean {
    if (this.maxPerProvider <= 0) return true; // explicitly unlimited
    return this.inFlightCount(providerId) < this.maxPerProvider;
  }

  /**
   * Reserve a slot for one attempt. Returns a release function, or `null` when the provider is
   * saturated. The release fn is idempotent — a double release must never under-count, or the
   * limiter would slowly leak capacity and stop admitting traffic.
   */
  acquire(providerId: string): (() => void) | null {
    if (!this.hasCapacity(providerId)) return null;
    this.inFlight.set(providerId, this.inFlightCount(providerId) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.inFlightCount(providerId) - 1;
      if (next <= 0) this.inFlight.delete(providerId);
      else this.inFlight.set(providerId, next);
    };
  }

  /** Diagnostics only (Router Settings / Activity): current per-provider occupancy. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.inFlight);
  }
}
