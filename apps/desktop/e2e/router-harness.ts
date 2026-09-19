/**
 * router-harness.ts — the live-test composition of router-core.
 *
 * This is apps/desktop/src/store.ts with the Tauri host swapped for in-memory equivalents:
 * the real fetch-based HostHttp stands in for the Rust egress commands, and an in-memory
 * keychain stands in for the OS keyring. Everything above the ports — registry, adapter
 * runtime, catalog, ledger, router — is the production wiring, unchanged.
 *
 * The write-through actions mirror store.ts one-for-one minus the `invoke(...)` persistence
 * (SQLite persistence is covered by the Rust host's own tests); what matters here is that
 * every request crosses REAL HTTP to a REAL server.
 */
import {
  AdapterRuntime,
  BUILTIN_TEMPLATES,
  ModelCatalog,
  ModelRouter,
  ProviderRegistry,
  UsageLedger,
  type AdapterManifest,
  type ApiKeyRecord,
  type HttpPort,
  type KeyVaultPort,
  type ProviderRecord,
} from "@aiprovider/router-core";
import { HostHttp, type EgressAuditEntry } from "./host-http.js";
import { isConclusive, verdictFor } from "../src/lib/keys/verdict.js";

/** In-memory keychain + the ref->provider join the Rust host does in SQLite. */
class HarnessVault implements KeyVaultPort {
  private readonly secrets = new Map<string, string>();

  async put(label: string, secret: string): Promise<string> {
    // Mirrors the §4 keychain account format `key:<keyId>` (registry.addKey passes that label).
    this.secrets.set(label, secret);
    return label;
  }
  async get(ref: string): Promise<string | undefined> {
    return this.secrets.get(ref);
  }
  /** Sync lookup — the egress resolver runs in the hot path and needs no await. */
  peek(ref: string): string | undefined {
    return this.secrets.get(ref);
  }
  async delete(ref: string): Promise<void> {
    this.secrets.delete(ref);
  }

  /** All raw secrets known to the host (the key-leak audit asserts none ever leak). */
  knownSecrets(): string[] {
    return [...this.secrets.values()];
  }
}

export type ManifestOrigin = "builtin-template" | "ai-generated" | "ai-patched";

export interface ManifestRow {
  id: string;
  providerId: string;
  version: number;
  origin: ManifestOrigin;
  bodyJson: string;
  contractResultJson: string | null;
  createdAt: number;
  isActive: boolean;
}

export interface HarnessActions {
  addProvider(input: {
    slug: string;
    name: string;
    baseUrl: string;
    manifest?: AdapterManifest;
  }): ProviderRecord;
  addKey(providerId: string, label: string, secret: string): Promise<ApiKeyRecord>;
  setKeyStatus(keyId: string, status: ApiKeyRecord["status"]): void;
  refreshCatalog(providerId: string): Promise<number>;
  testKey(keyId: string): Promise<{ ok: boolean; status: number }>;

  // --- onboarding / repair seams (mirror store.ts createPendingProvider + the wizard) ---

  /** Create a provider in `pending` status: probes and contract checks reach it, but the
   *  route planner excludes it (§3.1) until enableProvider(). Mirrors createPendingProvider. */
  addPendingProvider(input: { slug: string; name: string; baseUrl: string }): ProviderRecord;
  setProviderStatus(providerId: string, status: ProviderRecord["status"]): void;
  /** The Settings-screen System AI pick — the router serves its own AI route (§2.9). */
  setSystemAi(providerId: string, model: string): void;
  /** Hot-swap a manifest on a provider without touching versions (adapters.register). */
  registerManifest(providerId: string, manifest: AdapterManifest): void;
  /** Mirror of the Rust `manifest_stage`: append an inactive version, return its number. */
  stageManifest(
    providerId: string,
    manifest: AdapterManifest,
    meta: { origin: ManifestOrigin; contract?: unknown },
  ): number;
  /** Mirror of `manifest_activate`: flip the active flag, hot-swap the adapter, return the
   *  previously active version (or null). This is approveRepair AND rollbackManifest. */
  activateManifest(providerId: string, version: number): number | null;
  activeManifest(providerId: string): AdapterManifest | undefined;
  manifestHistory(providerId: string): ManifestRow[];
}

/**
 * In-memory mirror of the Rust manifest tables (manifest_stage / manifest_activate /
 * manifests_active / manifests_history). Versioning and activation are the host's job in
 * production; here the same per-provider version numbers and single-active-flag discipline
 * are reproduced so the wizard's pickCandidate, approveRepair and rollbackManifest flows can
 * be exercised end-to-end above real HTTP.
 */
class ManifestStore {
  private readonly rows: ManifestRow[] = [];

  stage(
    providerId: string,
    manifest: AdapterManifest,
    meta: { origin: ManifestOrigin; contract?: unknown },
  ): number {
    const version = this.rows.filter((r) => r.providerId === providerId).length + 1;
    this.rows.push({
      id: crypto.randomUUID(),
      providerId,
      version,
      origin: meta.origin,
      bodyJson: JSON.stringify(manifest),
      contractResultJson: meta.contract ? JSON.stringify(meta.contract) : null,
      createdAt: Date.now(),
      isActive: false,
    });
    return version;
  }

  activate(providerId: string, version: number): number | null {
    let previous: number | null = null;
    for (const r of this.rows) {
      if (r.providerId !== providerId) continue;
      if (r.isActive) previous = r.version;
      r.isActive = r.version === version;
    }
    return previous;
  }

  active(providerId: string): ManifestRow | undefined {
    return this.rows.find((r) => r.providerId === providerId && r.isActive);
  }

  history(providerId: string): ManifestRow[] {
    return this.rows.filter((r) => r.providerId === providerId);
  }
}

export interface RouterHarness {
  registry: ProviderRegistry;
  adapters: AdapterRuntime;
  catalog: ModelCatalog;
  ledger: UsageLedger;
  router: ModelRouter;
  http: HttpPort & { audit: EgressAuditEntry[] };
  vault: HarnessVault;
  actions: HarnessActions;
}

export function buildHarness(): RouterHarness {
  const vault = new HarnessVault();
  const registry = new ProviderRegistry(vault);
  const manifests = new ManifestStore();

  // The host-side egress: resolve a ref to (secret, own-provider host) exactly like the Rust
  // join of api_keys x providers, then substitute the sentinel at send time.
  const http = new HostHttp((secretRef) => {
    for (const p of registry.listProviders()) {
      const key = registry.keysOf(p.id).find((k) => k.secretRef === secretRef);
      if (key) {
        const host = (() => {
          try {
            return new URL(p.baseUrl).hostname;
          } catch {
            return undefined;
          }
        })();
        return { secret: vault.peek(secretRef), expectedHost: host };
      }
    }
    return { secret: undefined, expectedHost: undefined };
  });

  const adapters = new AdapterRuntime(http, { appUrl: "https://aiprovider.router" });
  const ledger = new UsageLedger();
  const catalog = new ModelCatalog(registry, adapters);
  const router = new ModelRouter(registry, adapters, catalog, ledger);

  const actions: HarnessActions = {
    addProvider({ slug, name, baseUrl, manifest }) {
      if (registry.providerBySlug(slug)) {
        throw new Error(`a provider with slug "${slug}" already exists — remove it first`);
      }
      const p = registry.addProvider({
        id: crypto.randomUUID(),
        slug,
        name,
        type: "manifest",
        baseUrl,
        status: "enabled",
        rotationStrategy: "round_robin",
      });
      adapters.register(
        p.id,
        manifest ?? BUILTIN_TEMPLATES["openai-compat"](baseUrl, { imageEndpoint: true }),
      );
      return p;
    },
    async addKey(providerId, label, secret) {
      return registry.addKey({ providerId, label, secret });
    },
    setKeyStatus(keyId, status) {
      registry.updateKey(keyId, { status });
    },
    async refreshCatalog(providerId) {
      const n = await catalog.refreshProvider(providerId);
      catalog.deriveAutoAliases();
      return n;
    },
    async testKey(keyId) {
      const k = registry.getKey(keyId);
      if (!k) throw new Error(`unknown key ${keyId}`);
      const { adapter } = await adapters.forProvider(k.providerId);
      const res = await adapter.pingKey(k.secretRef);
      // Same rule as store.ts, via the same classifier: an inconclusive test must not overwrite the
      // status, because `invalid` removes the key from rotation.
      const verdict = verdictFor(res);
      const patch: Parameters<typeof registry.updateKey>[1] = { lastTestedAt: Date.now() };
      if (isConclusive(verdict)) patch.status = verdict;
      registry.updateKey(keyId, patch);
      return { ok: res.ok, status: res.status };
    },

    addPendingProvider({ slug, name, baseUrl }) {
      if (registry.providerBySlug(slug)) {
        throw new Error(`a provider with slug "${slug}" already exists — remove it first`);
      }
      // No manifest registered yet — the wizard assigns one (template or AI candidate).
      return registry.addProvider({
        id: crypto.randomUUID(),
        slug,
        name,
        type: "manifest",
        baseUrl,
        status: "pending",
        rotationStrategy: "round_robin",
      });
    },
    setProviderStatus(providerId, status) {
      registry.setProviderStatus(providerId, status);
    },
    setSystemAi(providerId, model) {
      router.settings.systemAi = { providerId, model };
    },
    registerManifest(providerId, manifest) {
      adapters.register(providerId, manifest);
    },
    stageManifest(providerId, manifest, meta) {
      const provenance = {
        ...manifest.provenance,
        origin: meta.origin,
      } as AdapterManifest["provenance"];
      return manifests.stage(providerId, { ...manifest, provenance }, meta);
    },
    activateManifest(providerId, version) {
      const previous = manifests.activate(providerId, version);
      const row = manifests.active(providerId);
      if (row) adapters.register(providerId, JSON.parse(row.bodyJson) as AdapterManifest);
      return previous;
    },
    activeManifest(providerId) {
      const row = manifests.active(providerId);
      return row ? (JSON.parse(row.bodyJson) as AdapterManifest) : undefined;
    },
    manifestHistory(providerId) {
      return manifests.history(providerId);
    },
  };

  return { registry, adapters, catalog, ledger, router, http, vault, actions };
}
