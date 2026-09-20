/**
 * web-test/seeds.ts — pre-seeded store states for `?seed=<name>` (DEV-ONLY, see shim.ts).
 *
 * The deterministic wizard path needs no seed (the spec types everything from an empty
 * store). These seeds exist for the scenarios that would otherwise need minutes of typing:
 * a configured System AI so the AI-assisted / Tier-2 paths unlock.
 *
 * Ports must match web-test/mock.mjs. Secrets appear here ONLY because this is a dev harness
 * against a local mock — they are never shipped and never touch a real provider.
 */
import { BUILTIN_TEMPLATES } from "@aiprovider/router-core";

export const MOCK_PORT = 18901;
export const MOCK_ORIGIN = `http://127.0.0.1:${MOCK_PORT}`;
/** OpenAI-compatible "System AI" that also scripts Tier-2 envelopes on demand. */
export const ORACLE_BASE = `${MOCK_ORIGIN}/v1`;
/** A provider the declarative grammar genuinely cannot express (see mock.mjs). */
export const EXOTIC_BASE = `${MOCK_ORIGIN}/v2`;
/** OpenRouter-shaped catalog: namespaced ids, capability only in metadata (see mock.mjs). */
export const OR_ROUTER_BASE = `${MOCK_ORIGIN}/v3`;
export const ORACLE_KEY = "sk-oracle-works";
/** The exotic's key. Must match RAW_EXOTIC_KEY in web-test/mock.mjs. */
export const EXOTIC_KEY = "sk-nd-works";
/** The OpenRouter-shaped provider's key. Must match RAW_OR_KEY in web-test/mock.mjs. */
export const OR_ROUTER_KEY = "sk-or-router-works";

export interface SeedInput {
  providers?: { id: string; slug: string; name: string; type: string; baseUrl: string; status: string; rotationStrategy: string; createdAt: number; updatedAt: number }[];
  keys?: { id: string; providerId: string; label: string; secretRef: string; secret?: string; secretHint: string | null; status: string; priority: number; cooldownUntil: number | null; addedAt: number; lastUsedAt: number | null; lastTestedAt: number | null }[];
  models?: { providerId: string; nativeId: string; modality: string; contextWindow: number | null; fetchedAt: number }[];
  aliases?: { alias: string; providerId: string; nativeModelId: string; priority: number }[];
  manifests?: { id: string; providerId: string; version: number; origin: string; bodyJson: string; contractResultJson: string | null; createdAt: number; isActive: boolean }[];
  settings?: Record<string, string>;
}

const now = Date.now();

/** One enabled OpenAI-compatible provider + active key + text models = System AI unlocked. */
function systemAi(): SeedInput {
  const providerId = "seed-oracle";
  // BUILTIN_TEMPLATES["openai-compat"] is the raw openaiCompat(baseUrl) builder; PROVIDER_PROFILES
  // only carries the three sketch providers (openrouter/opencode/b.ai), which pin other baseUrls.
  // imageEndpoint:true gives the oracle the image endpoint + modality rules the Assistant's
  // Image tab needs (the mock serves a URL, exercising the host egress carve-out).
  const manifest = BUILTIN_TEMPLATES["openai-compat"](ORACLE_BASE, { imageEndpoint: true });
  return {
    providers: [
      {
        id: providerId,
        slug: "sysai",
        name: "System AI (mock)",
        type: "builtin",
        baseUrl: ORACLE_BASE,
        status: "enabled",
        rotationStrategy: "round_robin",
        createdAt: now,
        updatedAt: now,
      },
    ],
    manifests: [
      {
        id: "seed-oracle-manifest",
        providerId,
        version: 1,
        origin: "builtin-template",
        bodyJson: JSON.stringify(manifest),
        contractResultJson: null,
        createdAt: now,
        isActive: true,
      },
    ],
    keys: [
      {
        id: "seed-oracle-key",
        providerId,
        label: "key-01",
        secretRef: "key-01",
        secret: ORACLE_KEY,
        secretHint: null,
        status: "active",
        priority: 1,
        cooldownUntil: null,
        addedAt: now,
        lastUsedAt: null,
        lastTestedAt: null,
      },
    ],
    models: [
      { providerId, nativeId: "oracle-mini", modality: "text", contextWindow: 8192, fetchedAt: now },
      { providerId, nativeId: "oracle-flash", modality: "text", contextWindow: 8192, fetchedAt: now },
      // Image model: "sd-" matches the openai-compat modality rule, so the Assistant's
      // Image tab lists it and the interpreter routes /images/generations.
      { providerId, nativeId: "sd-oracle-1", modality: "image", contextWindow: null, fetchedAt: now },
    ],
    aliases: [
      { alias: "sysai/oracle-mini", providerId, nativeModelId: "oracle-mini", priority: 1 },
      { alias: "sysai/sd-oracle-1", providerId, nativeModelId: "sd-oracle-1", priority: 1 },
    ],
    settings: {
      router: JSON.stringify({ failoverEnabled: true, systemAi: { providerId, model: "oracle-mini" } }),
    },
  };
}

/**
 * The production bug shape, reproduced (regression fixture for the 2026-09-16 modality
 * amendment): an ENABLED OpenRouter provider whose cache holds a catalog with ZERO image
 * models — exactly what the anchored id-pattern rule produced before the fix, and what is
 * still sitting in a real user's SQLite after upgrading. The Image tab is empty here, and the
 * spec asserts that Models > Refresh fills it by classifying the provider's own metadata.
 *
 * slug is deliberately "openrouter" so store.ts registers the REAL shipped profile (not a
 * template): the seed's cached rows cannot hide a regression in that profile, because the rows
 * are replaced by whatever a live refresh derives them from.
 */
function orRouter(): SeedInput {
  const providerId = "seed-or";
  return {
    providers: [
      {
        id: providerId,
        slug: "openrouter",
        name: "OpenRouter (mock)",
        type: "builtin",
        baseUrl: OR_ROUTER_BASE,
        status: "enabled",
        rotationStrategy: "round_robin",
        createdAt: now,
        updatedAt: now,
      },
    ],
    keys: [
      {
        id: "seed-or-key",
        providerId,
        label: "key-01",
        secretRef: "key-01",
        secret: OR_ROUTER_KEY,
        secretHint: null,
        status: "active",
        priority: 1,
        cooldownUntil: null,
        addedAt: now,
        lastUsedAt: null,
        lastTestedAt: null,
      },
    ],
    // The pre-fix cache: every namespaced id tagged text, so the Image tab has nothing.
    models: [
      { providerId, nativeId: "openai/gpt-5-image", modality: "text", contextWindow: null, fetchedAt: now },
      { providerId, nativeId: "google/gemini-2.5-flash-image", modality: "text", contextWindow: null, fetchedAt: now },
      { providerId, nativeId: "openrouter/auto", modality: "text", contextWindow: null, fetchedAt: now },
      { providerId, nativeId: "openai/gpt-4o", modality: "text", contextWindow: null, fetchedAt: now },
    ],
    settings: {
      router: JSON.stringify({ failoverEnabled: true, systemAi: null }),
    },
  };
}

const SEEDS: Record<string, () => SeedInput> = { systemai: systemAi, "or-router": orRouter };

export function seedByName(name: string): SeedInput | null {
  const fn = SEEDS[name.toLowerCase()];
  return fn ? fn() : null;
}
