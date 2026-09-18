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
