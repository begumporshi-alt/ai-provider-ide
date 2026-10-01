/**
 * Which manifest serves a provider (2026-10-01).
 *
 * Two sources exist and they disagree in exactly one dimension that matters:
 *
 *  - the **builtin profiles** (`PROVIDER_PROFILES`) carry the measured facts — dialect, and all the
 *    dialect-shaping declarations (`messagesRoleMap`, `systemField`, `contentField`, …). They are
 *    kept current with the interpreter.
 *  - the **stored manifest row** is what setup wrote or the operator edited. It carries the
 *    operator's own headers, and — measured on the live database — often predates a shaping
 *    amendment entirely.
 *
 * Until this module existed the lookup was `PROVIDER_PROFILES[p.slug]`, keyed on an exact slug.
 * The live database had a provider named `agent-router`; the profile is keyed `agentrouter`. One
 * hyphen, and the measured profile was unreachable: the provider was served by its stored
 * user-edited manifest, which sent `role:"system"` inside `messages` to an Anthropic-API endpoint —
 * a 400 on every request this app makes, because every request carries a system turn. The ledger
 * agreed: the provider never served one successful request.
 *
 * So the rule here is: **the profile wins by slug or by measured host** (`profileForBaseUrl`
 * matches whole hostnames, the D80 rule — never a suffix, so a lookalike host gets nothing), and
 * the stored row's **endpoint headers survive**, merged over the profile's. Headers are operator
 * intent — the client-gate panel exists because which `User-Agent` to name is the operator's
 * decision, not a default — and a profile that silently dropped one would be a regression worse
 * than the bug this fixes.
 */
import { PROVIDER_PROFILES, profileForBaseUrl, type AdapterManifest } from "@aiprovider/router-core";

export interface ProviderRowLike {
  slug: string;
  baseUrl: string;
}

export interface ManifestRowLike {
  bodyJson: string;
}

/** The profile manifest with the provider's base URL applied and stored headers merged in. */
function adoptProfile(profile: AdapterManifest, baseUrl: string, stored: AdapterManifest | null): AdapterManifest {
  const withUrl: AdapterManifest = { ...profile, provider: { ...profile.provider, baseUrl } };
  const storedHeaders = stored?.endpoints?.generateText?.headers;
  if (!storedHeaders || Object.keys(storedHeaders).length === 0) return withUrl;
  const text = withUrl.endpoints.generateText;
  if (!text) return withUrl;
  return {
    ...withUrl,
    endpoints: {
      ...withUrl.endpoints,
      generateText: { ...text, headers: { ...text.headers, ...storedHeaders } },
    },
  };
}

/**
 * The manifest a provider is served by, or `null` when it has none (a custom provider with no
 * active row). `null` — not a throw — is the caller's existing contract: an unregistered provider
 * is surfaced by drift/repair, and a throw here would take the whole boot down.
 */
export function resolveProviderManifest(provider: ProviderRowLike, row: ManifestRowLike | undefined): AdapterManifest | null {
  const stored: AdapterManifest | null = (() => {
    if (!row) return null;
    try {
      const parsed: unknown = JSON.parse(row.bodyJson);
      return parsed && typeof parsed === "object" ? (parsed as AdapterManifest) : null;
    } catch {
      return null; // corrupt manifest: leave unregistered; Phase 5 drift/repair surfaces it
    }
  })();

  // The slug lookup answers a *factory*; the host lookup answers a built manifest.
  const profile = PROVIDER_PROFILES[provider.slug]?.() ?? profileForBaseUrl(provider.baseUrl)?.manifest;
  if (profile) return adoptProfile(profile, provider.baseUrl, stored);
  return stored;
}
