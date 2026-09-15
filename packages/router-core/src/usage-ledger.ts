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
  keyId?: string;
  requestedModel: string;
  model: string; // native model that actually served
  status: "ok" | "error";
  httpStatus?: number;
  errorClass?: string;
  latencyMs?: number;
  tokensIn: number;
  tokensOut: number;
  costEstimateMicros: number;
  fallbackChain?: AttemptOutcome[];
}

/** The host's structured persistence surface for ledger writes (invariant 12). */
export interface LedgerSink {
  append(entry: LedgerEntry): Promise<void>;
}

export class UsageLedger {
  private mem: LedgerEntry[] = [];
  constructor(private readonly sink?: LedgerSink) {}

  async append(e: LedgerEntry): Promise<void> {
    this.mem.push(e);
    if (this.sink) await this.sink.append(e);
  }

  query(filter: { since?: number; source?: LedgerSource; providerId?: string } = {}): LedgerEntry[] {
    return this.mem
      .filter((e) => (filter.since ? e.ts >= filter.since : true))
      .filter((e) => (filter.source ? e.source === filter.source : true))
      .filter((e) => (filter.providerId ? e.providerId === filter.providerId : true))
      .sort((a, b) => b.ts - a.ts);
  }
}
