/**
 * provider-registry (L3): Provider/key CRUD + lifecycle. The registry holds refs only;
 * secrets go to the KeyVaultPort (invariant 1/2). Deletions cascade per §7 hygiene:
 * deleting a key deletes its keychain entry in the same operation; deleting a provider
 * cascades keys/manifests/catalog (ledger history preserved — soft refs).
 */
import type { KeyVaultPort } from "./ports.js";
import type { ApiKeyRecord, ProviderRecord } from "./domain.js";

export class ProviderRegistry {
  private providers = new Map<string, ProviderRecord>();
  private keys = new Map<string, ApiKeyRecord>();

  constructor(private readonly vault: KeyVaultPort) {}

  /** Test/load hook. */
  hydrate(providers: ProviderRecord[], keys: ApiKeyRecord[]): void {
    this.providers = new Map(providers.map((p) => [p.id, p]));
    this.keys = new Map(keys.map((k) => [k.id, k]));
  }

  addProvider(p: Omit<ProviderRecord, "createdAt" | "updatedAt">): ProviderRecord {
    const now = Date.now();
    const rec: ProviderRecord = { ...p, createdAt: now, updatedAt: now };
    this.providers.set(rec.id, rec);
    return rec;
  }

  setProviderStatus(id: string, status: ProviderRecord["status"]): void {
    const p = this.providers.get(id);
    if (!p) throw new Error(`unknown provider ${id}`);
    this.providers.set(id, { ...p, status, updatedAt: Date.now() });
  }

  setProviderRotation(id: string, rotationStrategy: ProviderRecord["rotationStrategy"]): void {
    const p = this.providers.get(id);
    if (!p) throw new Error(`unknown provider ${id}`);
    this.providers.set(id, { ...p, rotationStrategy, updatedAt: Date.now() });
  }

  getProvider(id: string): ProviderRecord | undefined {
    return this.providers.get(id);
  }

  providerBySlug(slug: string): ProviderRecord | undefined {
    return [...this.providers.values()].find((p) => p.slug === slug);
  }

  listProviders(): ProviderRecord[] {
    return [...this.providers.values()];
  }

  async deleteProvider(id: string): Promise<void> {
    for (const k of this.keysOf(id)) await this.deleteKey(k.id);
    this.providers.delete(id);
  }

  async addKey(input: {
    providerId: string;
    label: string;
    secret: string; // accepted exactly once, stored in keychain, never held here
    priority?: number;
  }): Promise<ApiKeyRecord> {
    if (!this.providers.has(input.providerId)) throw new Error(`unknown provider ${input.providerId}`);
    // §4 freezes the keychain account format as `key:<keyId>` — the id must be generated
    // BEFORE the vault write, or every key of a provider would share one account and
    // silently overwrite each other (diff-review M1).
    const id = crypto.randomUUID();
    const secretRef = await this.vault.put(`key:${id}`, input.secret);
    const rec: ApiKeyRecord = {
      id,
      providerId: input.providerId,
      label: input.label,
      secretRef,
      secretHint: input.secret.slice(-4),
      status: "active",
      priority: input.priority ?? 0,
      cooldownUntil: null,
      addedAt: Date.now(),
      lastUsedAt: null,
      lastTestedAt: null,
    };
    this.keys.set(rec.id, rec);
    return rec;
  }

  keysOf(providerId: string): ApiKeyRecord[] {
    return [...this.keys.values()].filter((k) => k.providerId === providerId);
  }

  getKey(id: string): ApiKeyRecord | undefined {
    return this.keys.get(id);
  }

  updateKey(id: string, patch: Partial<Pick<ApiKeyRecord, "status" | "priority" | "cooldownUntil" | "lastUsedAt" | "lastTestedAt">>): void {
    const k = this.keys.get(id);
    if (!k) throw new Error(`unknown key ${id}`);
    this.keys.set(id, { ...k, ...patch });
  }

  async deleteKey(id: string): Promise<void> {
    const k = this.keys.get(id);
    if (!k) return;
    await this.vault.delete(k.secretRef); // same-transaction hygiene (§7)
    this.keys.delete(id);
  }
}
