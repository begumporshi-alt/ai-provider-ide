/**
 * model-catalog (L3): discovery via adapters, local cache, modality tagging, alias map
 * (spec req. 7, §3.4 merged-ID scheme). TTL 24h with manual refresh and stale-fallback (§7).
 */
import type { Modality } from "@aiprovider/adapter-spec";
import type { AliasEntry, CatalogModel } from "./domain.js";
import type { AdapterRuntime } from "./adapter-runtime.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type { ModelEntry } from "./manifest-interpreter.js";
import { parsePricing, type PricingMicros } from "./pricing.js";
import { parseContextWindow, parseReasoningSupport, parseVisionSupport } from "./model-meta.js";

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
    // A copy, not the caller's array: `refreshProvider` and `upsertManual` reassign `this.models`,
    // and a hydrate that aliased an array it does not own would mutate it out from under the caller.
    this.models = rows.map((m) => ({ ...m }));
    for (const [pid, ts] of Object.entries(fetchedByProvider)) this.fetchedAt.set(pid, ts);
  }

  /**
   * Add or replace a model the operator typed in by hand.
   *
   * Manual rows are the reason `refreshProvider` cannot simply clear a provider's set: a provider
   * whose `/models` endpoint is missing, incomplete or gated still has to be usable, and the
   * operator's own entry is the only description of the model that exists.
   */
  upsertManual(input: {
    providerId: string;
    nativeId: string;
    modality: Modality;
    contextWindow?: number;
  }): CatalogModel {
    const nativeId = input.nativeId.trim();
    const existing = this.models.find(
      (m) => m.providerId === input.providerId && m.nativeId === nativeId,
    );
    const next: CatalogModel = {
      providerId: input.providerId,
      nativeId,
      modality: input.modality,
      fetchedAt: Date.now(),
      origin: "manual",
      // `undefined` rather than `0`: an absent window means "unknown", and the router's budget
      // planner reads `0` as a real number when it takes the minimum across a plan.
      ...(typeof input.contextWindow === "number" && input.contextWindow > 0
        ? { contextWindow: input.contextWindow }
        : {}),
    };
    this.models = existing
      ? this.models.map((m) => (m === existing ? next : m))
      : [...this.models, next];
    return next;
  }

  /** Remove a manual model. A discovered row is left alone — only a refresh may drop one. */
  removeManual(providerId: string, nativeId: string): boolean {
    const before = this.models.length;
    this.models = this.models.filter(
      (m) => !(m.providerId === providerId && m.nativeId === nativeId && m.origin === "manual"),
    );
    return this.models.length !== before;
  }

  /** A provider's hand-added models, newest addition last. */
  manualOf(providerId: string): CatalogModel[] {
    return this.models.filter((m) => m.providerId === providerId && m.origin === "manual");
  }

  /** Refresh one provider's catalog; errors leave the stale rows in place (stale-fallback). */
  async refreshProvider(providerId: string, signal?: AbortSignal): Promise<number> {
    const { adapter } = await this.adapters.forProvider(providerId);
    const keys = this.registry.keysOf(providerId).filter((k) => k.status === "active");
    if (!keys.length) throw new Error(`provider ${providerId} has no active key`);
    let entries: ModelEntry[] = [];
    let lastErr: unknown;
    for (const k of keys) {
      try {
        entries = await adapter.listModels(k.secretRef, signal);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) throw lastErr;
    const now = Date.now();
    // Manual rows are kept. They are not part of the provider's listing — clearing them here would
    // mean a Refresh, which the operator runs to pick up *new* models, also destroys the models
    // they added because the provider never listed them.
    const manual = this.models.filter((m) => m.providerId === providerId && m.origin === "manual");
    const manualIds = new Set(manual.map((m) => m.nativeId));
    this.models = this.models.filter((m) => m.providerId !== providerId);
    for (const m of manual) this.models.push(m);
    for (const e of entries) {
      // A manual row wins over the discovered one: the operator deliberately stated what this
      // model is, and their context window is the one that should plan the request.
      if (manualIds.has(e.nativeId)) continue;
      this.models.push({
        providerId,
        nativeId: e.nativeId,
        modality: adapter.tagModality(e) as Modality,
        fetchedAt: now,
        // Audit R2: keep the provider's published price, normalized. Unparseable/absent
        // pricing stays `undefined` (unknown), so "no price" can never read as "free".
        pricing: parsePricing(e.raw),
        // Same reasoning as pricing, for the other facts a client cannot guess: the prompt
        // budget and whether the model reasons. Persisted with the row (see model-meta.ts).
        contextWindow: parseContextWindow(e.raw),
        supportsReasoning: parseReasoningSupport(e.raw),
        supportsVision: parseVisionSupport(e.raw),
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
   * Adopt the alias table the host persisted, rebuild the derived rows from the catalog, and report
   * whether the table moved — so the caller can skip a write when the cache was already in step.
   *
   * # Why boot cannot simply trust the table
   *
   * `persistAliases` writes derived rows, but it is not the only writer: `config_import` merges the
   * aliases out of an imported snapshot (`persist.rs`, `INSERT OR IGNORE INTO model_aliases`). So the
   * table holds a mixture of *derived* and *authored* rows, and records no provenance — four columns,
   * none of them saying which. Loading all of it as operator intent made every derived row suppress
   * its own id from ever being re-derived, because `deriveAutoAliases` honours `auto: false` by
   * leaving that id alone. The table became write-once.
   *
   * Measured 2026-09-29: `deepseek-v4-flash` was carried by two enabled providers and had one alias
   * row, so the bare id resolved to a single provider and `failoverEnabled` had nothing to fail over
   * to — a second carrier could never join an alias that already existed.
   *
   * # How a row is classified
   *
   * A derived row is one the derivation *emits*, and `deriveAutoAliases` emits only bare rows:
   * `alias === nativeModelId`, on a provider whose catalog carries that native id. A row outside that
   * set cannot have come from a derivation, so it is kept — and kept as `auto: false`, which is what
   * leaves its id alone. That is a definition rather than a heuristic: the two populations are
   * exactly disjoint on it.
   *
   * The residual ambiguity is narrow and worth naming. A hand-authored row shaped exactly like a
   * derived one — bare, on a carrying provider — is re-derived, so a priority pin on it would be
   * lost. Nothing can author such a row today (there is no alias editor), and a row that predates
   * this method is indistinguishable from a derived one *even with* a provenance column, because a
   * migration would have to guess a default for both populations at once. That is why this is a
   * classification and not a migration. See `docs/dev-book/07-drift-register.md` D76.
   */
  hydrateAliases(rows: AliasEntry[]): boolean {
    const authored = rows.filter((r) => !this.derivationEmits(r));
    this.aliases = authored.map((r) => ({ ...r, auto: false }));
    this.deriveAutoAliases();
    return !this.holdsExactly(rows);
  }

  /** Would `deriveAutoAliases` emit this row? Only bare rows, on a provider that carries the id. */
  private derivationEmits(r: AliasEntry): boolean {
    return (
      r.alias === r.nativeModelId &&
      this.models.some((m) => m.providerId === r.providerId && m.nativeId === r.nativeModelId)
    );
  }

  /**
   * Does `aliases` hold exactly `rows`? Order-insensitive, and `auto` is deliberately not part of a
   * row's identity: the same rows derived or reloaded are the same table, and the flag is provenance
   * the host does not store.
   */
  private holdsExactly(rows: AliasEntry[]): boolean {
    const key = (a: AliasEntry) =>
      `${a.alias}\u0000${a.providerId}\u0000${a.nativeModelId}\u0000${a.priority}`;
    const mine = new Set(this.aliases.map(key));
    const theirs = new Set(rows.map(key));
    return mine.size === theirs.size && [...theirs].every((k) => mine.has(k));
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

  /** Normalized pricing for one model, or `undefined` when the provider published none. */
  pricingFor(providerId: string, nativeId: string): PricingMicros | undefined {
    return this.models.find((m) => m.providerId === providerId && m.nativeId === nativeId)?.pricing;
  }
}
