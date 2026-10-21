/**
 * The one-time profile for slow aggregators.
 *
 * `agentrouter.org` routinely takes 20–40s to send response headers. The built-in 20s budget turns
 * that into a failed turn; the recommended profile gives the plan three full 60s attempts inside
 * 180s. This is applied only when the provider has no entry, so a value the operator chose is
 * never overwritten and the seed is a no-op on every later launch.
 */
import type { ProviderTimeoutProfile } from "@aiprovider/router-core";

export const AGENT_ROUTER_TIMEOUT_PROFILE: ProviderTimeoutProfile = {
  headerMs: 60_000,
  firstByteMs: 60_000,
  firstOutputMs: 60_000,
  planBudgetMs: 180_000,
  maxAttempts: 4,
};

export interface SeedableProvider {
  id: string;
  slug: string;
  status: string;
}

/**
 * The map to persist, or `null` when nothing should change.
 *
 * Pure so the idempotence is testable without hydration: a second call on the returned map
 * returns `null`, and a disabled or already-profiled provider is never touched.
 */
export function seedAgentRouterTimeouts(
  existing: Record<string, ProviderTimeoutProfile> | undefined,
  providers: SeedableProvider[],
): Record<string, ProviderTimeoutProfile> | null {
  const target = providers.find(
    (p) => p.slug === "agent-router" && p.status === "enabled",
  );
  if (!target || existing?.[target.id]) return null;
  return {
    ...(existing ?? {}),
    [target.id]: { ...AGENT_ROUTER_TIMEOUT_PROFILE },
  };
}
