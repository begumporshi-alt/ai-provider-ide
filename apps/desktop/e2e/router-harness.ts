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
} from "@aiprovider/router";
import { HostHttp, type EgressAuditEntry } from "./host-http.js";

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

  const adapters = new AdapterRuntime(http, { appUrl: "https://aiprovider.ide" });
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
      registry.updateKey(keyId, {
        status: res.ok ? "active" : res.rateLimited ? "cooldown" : "invalid",
        lastTestedAt: Date.now(),
      });
      return { ok: res.ok, status: res.status };
    },
  };

  return { registry, adapters, catalog, ledger, router, http, vault, actions };
}
