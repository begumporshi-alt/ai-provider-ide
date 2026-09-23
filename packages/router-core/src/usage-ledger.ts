/**
 * usage-ledger (L3): append per-request entries + query for the Usage screen (spec req. 11,
 * criterion 10 source attribution).
 *
 * Persistence goes through a structured `LedgerSink` — NOT raw SQL. The webview has no SQL
 * surface (invariant 12) and the host refuses raw `store.execute`, so a raw-SQL StorePort
 * would throw on every append (diff-review M8). The desktop provides a sink backed by the
 * fixed `ledger_append` command; unit tests use the in-memory mode only.
 */
import type { Modality } from "@aiprovider/adapter-spec";
import type { AttemptOutcome } from "./execution-engine.js";

export type LedgerSource = "ui" | "gateway" | "generator";

export interface LedgerEntry {
  ts: number;
  modality: Modality;
  source: LedgerSource;
  providerId?: string;
  /** The *provider* credential that served the request (`api_keys.id`). */
  keyId?: string;
  /**
   * The gateway app key that paid for this request (`gateway_keys.id`), when it arrived through the
   * local gateway.
   *
   * Deliberately a separate field from `keyId`: the two are different ids that both answer to
   * "key", and conflating them is why per-app spend was uncomputable for so long. Left `undefined`
   * for `ui` and `generator` rows, which are not attributable to any app — `ledger.app_key_id` is
   * nullable for the same reason (migration 0016).
   */
  appKeyId?: string;
  requestedModel: string;
  model: string; // native model that actually served
  status: "ok" | "error";
  httpStatus?: number;
  errorClass?: string;
  latencyMs?: number;
  tokensIn: number;
  tokensOut: number;
  costEstimateMicros: number;
  /**
   * Prompt tokens the upstream served from its own cache, when it reports them.
   *
   * Left `undefined` — deliberately **not** defaulted to 0 — when the provider reported no cache
   * block. `ledger.cached_tokens` is nullable for the same reason: this measurement exists to tell
   * "this provider does not report caching" apart from "it reported nothing cached", and only the
   * second is evidence that caching is unavailable to us. (Migration 0015.)
   */
  cachedTokens?: number;
  fallbackChain?: AttemptOutcome[];
}

/** The host's structured persistence surface for ledger writes (invariant 12). */
export interface LedgerSink {
  append(entry: LedgerEntry): Promise<void>;
}

/**
 * How many entries the in-memory mirror keeps.
 *
 * The database is the record — every entry still goes to the sink — so this bounds only the
 * window the Usage screen can answer without re-reading it. Left unbounded, the array grew for
 * the lifetime of the process: a gateway left running holds every request it ever served in RAM,
 * forever, and `run_rollup` prunes the database without ever touching this copy.
 */
export const DEFAULT_MAX_MEM_ENTRIES = 50_000;

export class UsageLedger {
  private mem: LedgerEntry[] = [];
  private evicted = 0;
  constructor(
    private readonly sink?: LedgerSink,
    private readonly maxEntries: number = DEFAULT_MAX_MEM_ENTRIES,
  ) {}

  async append(e: LedgerEntry): Promise<void> {
    this.mem.push(e);
    if (this.sink) await this.sink.append(e);
    // Trim after the append, not before: the newest entry survives even at maxEntries=1, and
    // the sink has already seen every entry, so dropping one from memory loses no data.
    const over = this.mem.length - Math.max(0, this.maxEntries);
    if (over > 0) {
      this.mem.splice(0, over);
      this.evicted += over;
    }
  }

  /**
   * How many entries have fallen out of the in-memory window.
   *
   * Non-zero means `query({ since })` cannot answer about the oldest traffic: those rows are in
   * the database, not here. Reporting the count is the point — a silently truncated result looks
   * like "there was no traffic then", which is exactly the kind of blank the ledger exists to
   * explain rather than produce.
   */
  get evictedCount(): number {
    return this.evicted;
  }

  /** Oldest timestamp still in memory — `query({ since })` before this is incomplete. */
  oldestTs(): number | undefined {
    let min: number | undefined;
    for (const e of this.mem) if (min === undefined || e.ts < min) min = e.ts;
    return min;
  }

  query(filter: { since?: number; source?: LedgerSource; providerId?: string } = {}): LedgerEntry[] {
    return this.mem
      .filter((e) => (filter.since ? e.ts >= filter.since : true))
      .filter((e) => (filter.source ? e.source === filter.source : true))
      .filter((e) => (filter.providerId ? e.providerId === filter.providerId : true))
      .sort((a, b) => b.ts - a.ts);
  }
}
