/**
 * usage-ledger (L3): append per-request entries + query for the Usage screen (spec req. 11,
 * criterion 10 source attribution). Persisted via StorePort in production; the in-memory mode
 * backs unit tests and the Playground session view.
 */
import type { Modality } from "@aiprovider/adapter-spec";
import type { StorePort } from "./ports.js";
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

export class UsageLedger {
  private mem: LedgerEntry[] = [];
  constructor(private readonly store?: StorePort) {}

  async append(e: LedgerEntry): Promise<void> {
    this.mem.push(e);
    if (this.store) {
      await this.store.execute(
        `INSERT INTO ledger (ts, modality, source, provider_id, key_id, requested_model, model,
            status, http_status, error_class, latency_ms, tokens_in, tokens_out,
            cost_estimate_micros, fallback_chain_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          e.ts, e.modality, e.source, e.providerId ?? null, e.keyId ?? null, e.requestedModel,
          e.model, e.status, e.httpStatus ?? null, e.errorClass ?? null, e.latencyMs ?? null,
          e.tokensIn, e.tokensOut, e.costEstimateMicros,
          e.fallbackChain ? JSON.stringify(e.fallbackChain.map((a) => ({
            provider: a.candidate.provider.slug, key: a.candidate.key.label, cls: a.cls,
          }))) : null,
        ],
      );
    }
  }

  query(filter: { since?: number; source?: LedgerSource; providerId?: string } = {}): LedgerEntry[] {
    return this.mem
      .filter((e) => (filter.since ? e.ts >= filter.since : true))
      .filter((e) => (filter.source ? e.source === filter.source : true))
      .filter((e) => (filter.providerId ? e.providerId === filter.providerId : true))
      .sort((a, b) => b.ts - a.ts);
  }
}
