/**
 * Desktop bootstrap: the single place where router-core gets wired to the host.
 * Owns the core instances (registry, catalog, adapters, ledger, router), hydration from
 * SQLite, and write-through persistence — every state-changing action mutates the core AND
 * calls one fixed host command (the invariant-12-safe replacement for a raw StorePort).
 */
import { invoke } from "@tauri-apps/api/core";
import {
  AdapterRuntime,
  ModelCatalog,
  ModelRouter,
  ProviderRegistry,
  UsageLedger,
  PROVIDER_PROFILES,
  type AdapterManifest,
  type ApiKeyRecord,
  type CatalogModel,
  type LedgerEntry,
  type ProviderRecord,
} from "@aiprovider/router";
import { createHttpPort, createKeyVaultPort } from "./ipc-client";

// ---------- host row shapes (camelCase, mirror persist.rs) ----------

export interface HostProviderRow {
  id: string; slug: string; name: string; type: string | null; baseUrl: string;
  status: string; rotationStrategy: string; createdAt: number; updatedAt: number;
}
export interface HostKeyRow {
  id: string; providerId: string; label: string; secretRef: string; secretHint: string | null;
  status: string; priority: number; cooldownUntil: number | null; addedAt: number;
  lastUsedAt: number | null; lastTestedAt: number | null;
}
export interface HostModelRow {
  providerId: string; nativeId: string; modality: string; contextWindow: number | null; fetchedAt: number;
}
export interface HostManifestRow {
  id: string; providerId: string; version: number; origin: string; bodyJson: string;
  contractResultJson: string | null; createdAt: number; isActive: boolean;
}
export interface HostAliasRow {
  alias: string; providerId: string; nativeModelId: string; priority: number;
}
export interface HostLedgerRow {
  ts: number; modality: string; source: string; providerId: string | null; keyId: string | null;
  requestedModel: string | null; model: string; status: string; httpStatus: number | null;
  errorClass: string | null; latencyMs: number | null; tokensIn: number; tokensOut: number;
  costEstimateMicros: number; fallbackChainJson: string | null;
}

// ---------- singletons ----------

const vault = createKeyVaultPort();
const http = createHttpPort();

export const registry = new ProviderRegistry(vault);
export const adapters = new AdapterRuntime(http, { appUrl: "https://aiprovider.ide" });
export const ledger = new UsageLedger({
  async append(e: LedgerEntry) {
    await invoke("ledger_append", {
      e: {
        ts: e.ts,
        modality: e.modality,
        source: e.source,
        providerId: e.providerId ?? null,
        keyId: e.keyId ?? null,
        requestedModel: e.requestedModel,
        model: e.model,
        status: e.status,
        httpStatus: e.httpStatus ?? null,
        errorClass: e.errorClass ?? null,
        latencyMs: e.latencyMs ?? null,
        tokensIn: e.tokensIn,
        tokensOut: e.tokensOut,
        costEstimateMicros: e.costEstimateMicros,
        fallbackChainJson: e.fallbackChain
          ? JSON.stringify(e.fallbackChain.map((a) => ({
              provider: a.candidate.provider.slug,
              key: a.candidate.key.label,
              cls: a.cls,
            })))
          : null,
      },
    });
  },
});
export const catalog = new ModelCatalog(registry, adapters);
export const router = new ModelRouter(registry, adapters, catalog, ledger);

let bootstrapped = false;

/** Load persisted state into the core; safe to call repeatedly (no-op after the first). */
export async function bootstrap(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;

  const [providers, keys, models, manifests, aliases] = await Promise.all([
    invoke<HostProviderRow[]>("providers_list"),
    invoke<HostKeyRow[]>("api_keys_list", { providerId: null }),
    invoke<HostModelRow[]>("models_cache_list"),
    invoke<HostManifestRow[]>("manifests_active"),
    invoke<HostAliasRow[]>("aliases_list"),
  ]);

  registry.hydrate(providers.map(hostToProvider), keys.map(hostToKey));

  const fetchedByProvider: Record<string, number> = {};
  for (const m of models) fetchedByProvider[m.providerId] = Math.max(fetchedByProvider[m.providerId] ?? 0, m.fetchedAt);
  catalog.hydrate(
    models.map((m) => ({
      providerId: m.providerId, nativeId: m.nativeId,
      modality: m.modality as CatalogModel["modality"],
      contextWindow: m.contextWindow ?? undefined, fetchedAt: m.fetchedAt,
    })),
    fetchedByProvider,
  );

  // Adapter registration: builtin profiles win by slug (pinned facts, current template);
  // custom providers use their active manifest row.
  for (const p of providers) {
    const profile = PROVIDER_PROFILES[p.slug];
    if (profile) {
      adapters.register(p.id, withBaseUrl(profile(), p.baseUrl));
      continue;
    }
    const row = manifests.find((x) => x.providerId === p.id);
    if (row) {
      try {
        adapters.register(p.id, JSON.parse(row.bodyJson) as AdapterManifest);
      } catch {
        // corrupt manifest: leave unregistered; Phase 5 drift/repair surfaces it
      }
    }
  }

  if (aliases.length) {
    catalog.setAliases(aliases.map((a) => ({ ...a, auto: false })));
  } else {
    catalog.deriveAutoAliases();
    await persistAliases();
  }

  const settingsRaw = await invoke<string | null>("settings_get", { key: "router" });
  if (settingsRaw) {
    try {
      Object.assign(router.settings, JSON.parse(settingsRaw));
    } catch {
      /* keep defaults */
    }
  }
}

async function refreshFromHost(): Promise<void> {
  const [providers, keys] = await Promise.all([
    invoke<HostProviderRow[]>("providers_list"),
    invoke<HostKeyRow[]>("api_keys_list", { providerId: null }),
  ]);
  registry.hydrate(providers.map(hostToProvider), keys.map(hostToKey));
}

async function persistAliases(): Promise<void> {
  await invoke("aliases_replace", {
    rows: catalog.aliases.map((a) => ({
      alias: a.alias, providerId: a.providerId, nativeModelId: a.nativeModelId, priority: a.priority,
    })),
  });
}

function withBaseUrl(m: AdapterManifest, baseUrl: string): AdapterManifest {
  return { ...m, provider: { ...m.provider, baseUrl } };
}

function hostToProvider(p: HostProviderRow): ProviderRecord {
  return {
    id: p.id, slug: p.slug, name: p.name, type: (p.type ?? "manifest") as ProviderRecord["type"],
    baseUrl: p.baseUrl, status: p.status as ProviderRecord["status"],
    rotationStrategy: p.rotationStrategy as ProviderRecord["rotationStrategy"],
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

function hostToKey(k: HostKeyRow): ApiKeyRecord {
  return {
    id: k.id, providerId: k.providerId, label: k.label, secretRef: k.secretRef,
    secretHint: k.secretHint ?? undefined, status: k.status as ApiKeyRecord["status"],
    priority: k.priority, cooldownUntil: k.cooldownUntil, addedAt: k.addedAt,
    lastUsedAt: k.lastUsedAt, lastTestedAt: k.lastTestedAt,
  };
}

function providerToHost(r: ProviderRecord): HostProviderRow {
  return { ...r, type: r.type, baseUrl: r.baseUrl };
}

function keyToHost(r: ApiKeyRecord): HostKeyRow {
  return {
    id: r.id, providerId: r.providerId, label: r.label, secretRef: r.secretRef,
    secretHint: r.secretHint ?? null, status: r.status, priority: r.priority,
    cooldownUntil: r.cooldownUntil, addedAt: r.addedAt, lastUsedAt: r.lastUsedAt,
    lastTestedAt: r.lastTestedAt,
  };
}

// ---------- write-through actions ----------

export async function addProvider(input: {
  slug: string;
  name: string;
  type: ProviderRecord["type"];
  baseUrl: string;
  manifest: AdapterManifest;
}): Promise<ProviderRecord> {
  const p = registry.addProvider({
    id: crypto.randomUUID(), slug: input.slug, name: input.name, type: input.type,
    baseUrl: input.baseUrl, status: "draft", rotationStrategy: "round_robin",
  });
  await invoke("provider_upsert", { p: providerToHost(p) });
  adapters.register(p.id, input.manifest);
  await invoke("manifest_upsert_active", {
    m: {
      id: crypto.randomUUID(), providerId: p.id, version: 1, origin: "builtin-template",
      bodyJson: JSON.stringify(input.manifest), contractResultJson: null, createdAt: Date.now(), isActive: true,
    },
  });
  return p;
}

export async function setProviderStatus(id: string, status: ProviderRecord["status"]): Promise<void> {
  registry.setProviderStatus(id, status);
  const p = registry.getProvider(id);
  if (p) await invoke("provider_upsert", { p: providerToHost(p) }); // syncs allowlist host-side
}

export async function setProviderRotation(id: string, rotationStrategy: ProviderRecord["rotationStrategy"]): Promise<void> {
  registry.setProviderRotation(id, rotationStrategy);
  const p = registry.getProvider(id);
  if (p) await invoke("provider_upsert", { p: providerToHost(p) });
}

export async function deleteProvider(id: string): Promise<void> {
  await invoke("provider_delete", { id }); // cascades; host recomputes the allowlist
  adapters.unregister(id);
  await refreshFromHost();
}

/** Add a key: vault write happens inside registry.addKey via the KeyVaultPort (one call). */
export async function addKey(providerId: string, label: string, secret: string): Promise<ApiKeyRecord> {
  const k = await registry.addKey({ providerId, label, secret });
  await invoke("api_key_upsert", { k: keyToHost(k) });
  return k;
}

export async function deleteKey(id: string): Promise<void> {
  await invoke("api_key_delete", { id }); // host removes the keychain entry too (§7)
  await refreshFromHost();
}

export async function setKeyStatus(id: string, status: ApiKeyRecord["status"]): Promise<void> {
  registry.updateKey(id, { status });
  const k = registry.getKey(id);
  if (k) await invoke("api_key_upsert", { k: keyToHost(k) });
}

/** Spec req. 8: cheap validity ping per key. */
export async function testKey(keyId: string): Promise<{ ok: boolean; status: number; rateLimited: boolean }> {
  const k = registry.getKey(keyId);
  if (!k) throw new Error(`unknown key ${keyId}`);
  const { interpreter } = await adapters.forProvider(k.providerId);
  const res = await interpreter.pingKey(k.secretRef);
  registry.updateKey(keyId, {
    status: res.ok ? "active" : res.rateLimited ? "cooldown" : "invalid",
    lastTestedAt: Date.now(),
  });
  const fresh = registry.getKey(keyId);
  if (fresh) await invoke("api_key_upsert", { k: keyToHost(fresh) });
  return res;
}

export async function refreshCatalog(providerId: string, signal?: AbortSignal): Promise<number> {
  const n = await catalog.refreshProvider(providerId, signal);
  await invoke("models_cache_replace", {
    providerId,
    rows: catalog.all().filter((m) => m.providerId === providerId).map((m) => ({
      providerId: m.providerId, nativeId: m.nativeId, modality: m.modality,
      contextWindow: m.contextWindow ?? null, fetchedAt: m.fetchedAt,
    })),
  });
  catalog.deriveAutoAliases();
  await persistAliases();
  return n;
}

export function persistRouterSettings(): void {
  void invoke("settings_set", { key: "router", valueJson: JSON.stringify(router.settings) });
}

export function listLedger(): LedgerEntry[] {
  return ledger.query();
}

export async function loadRecentLedger(): Promise<HostLedgerRow[]> {
  return invoke<HostLedgerRow[]>("ledger_recent", { limit: 200 });
}
