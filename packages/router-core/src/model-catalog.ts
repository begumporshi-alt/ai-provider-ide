/**
 * model-catalog (L3): discovery via adapters, local cache, modality tagging, alias map
 * (spec req. 7, §3.4 merged-ID scheme). TTL 24h with manual refresh and stale-fallback (§7).
 */
import type { Modality } from "@aiprovider/adapter-spec";
import type { AliasEntry, CatalogModel } from "./domain.js";
import type { AdapterRuntime } from "./adapter-runtime.js";
import type { ProviderRegistry } from "./provider-registry.js";

const TTL_MS = 24 * 60 * 60 * 1000;

export class ModelCatalog {
  private models: CatalogModel[] = [];
  private fetchedAt = new Map<string, number>(); // providerId -> ts
  aliases: AliasEntry[] = [];

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly adapters: AdapterRuntime,
  ) {}

  /** Restore a previously fetched catalog at startup (§4 models_cache). */
  hydrate(rows: CatalogModel[], fetchedByProvider: Record<string, number>): void {
    this.models = rows;
    for (const [pid, ts] of Object.entries(fetchedByProvider)) this.fetchedAt.set(pid, ts);
  }

  /** Refresh one provider's catalog; errors leave the stale rows in place (stale-fallback). */
  async refreshProvider(providerId: string, signal?: AbortSignal): Promise<number> {
    const { interpreter } = await this.adapters.forProvider(providerId);
    const keys = this.registry.keysOf(providerId).filter((k) => k.status === "active");
    if (!keys.length) throw new Error(`provider ${providerId} has no active key`);
    let entries: { nativeId: string }[] = [];
    let lastErr: unknown;
    for (const k of keys) {
      try {
        entries = await interpreter.listModels(k.secretRef, signal);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    const now = Date.now();
    this.models = this.models.filter((m) => m.providerId !== providerId);
    for (const e of entries) {
      this.models.push({
        providerId,
        nativeId: e.nativeId,
        modality: interpreter.tagModality(e.nativeId) as Modality,
        fetchedAt: now,
      });
    }
    this.fetchedAt.set(providerId, now);
    return entries.length;
  }

  isStale(providerId: string, now = Date.now()): boolean {
    const t = this.fetchedAt.get(providerId);
    return t === undefined || now - t > TTL_MS;
  }

  setAliases(a: AliasEntry[]): void {
    this.aliases = a;
  }

  /**
   * Alias auto-derivation (§Phase 1 acceptance): identical native IDs across providers get a
   * bare alias whose rows follow alias priority; qualified IDs always resolve directly.
   */
  deriveAutoAliases(): void {
    const byNative = new Map<string, Set<string>>();
    for (const m of this.models) {
      if (!byNative.has(m.nativeId)) byNative.set(m.nativeId, new Set());
      byNative.get(m.nativeId)!.add(m.providerId);
    }
    const manual = new Set(this.aliases.filter((a) => !a.auto).map((a) => a.alias));
    const auto: AliasEntry[] = [];
    let pr = 100;
    for (const [native, provIds] of [...byNative.entries()].sort()) {
      if (provIds.size < 2 || manual.has(native)) continue;
      for (const pid of [...provIds].sort()) {
        auto.push({ alias: native, providerId: pid, nativeModelId: native, priority: pr++, auto: true });
      }
    }
    this.aliases = [...this.aliases.filter((a) => a.auto === false), ...auto];
  }

  all(): CatalogModel[] {
    return this.models;
  }

  forModality(modality: Modality): CatalogModel[] {
    return this.models.filter((m) => m.modality === modality);
  }
}
