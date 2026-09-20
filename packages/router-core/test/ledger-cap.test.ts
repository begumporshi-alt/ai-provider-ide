/**
 * Ledger cap — the in-memory mirror is bounded, and says so.
 *
 * `UsageLedger.mem` grew for the lifetime of the process. The database is pruned by `run_rollup`,
 * but nothing ever pruned this copy, so a gateway left running held every request it had ever
 * served in RAM. Bounding it is the fix; *reporting* the eviction is the other half, because a
 * silently truncated `query({ since })` reads as "there was no traffic then" — the same blank
 * result that made a previous failure unreadable.
 *
 * Written to fail against the old code: restore `async append(e) { this.mem.push(e); ... }` with
 * no trim and tests 1-4 fail while the sink test keeps passing.
 */
import { describe, expect, it } from "vitest";
import { UsageLedger, DEFAULT_MAX_MEM_ENTRIES, type LedgerEntry } from "../src/usage-ledger.js";

function entry(ts: number): LedgerEntry {
  return {
    ts,
    modality: "text",
    source: "gateway",
    requestedModel: "openrouter/gpt-4o",
    model: "gpt-4o",
    status: "ok",
    tokensIn: 1,
    tokensOut: 1,
    costEstimateMicros: 0,
  };
}

/** A sink that remembers everything, so eviction from memory can be proven lossless. */
function recordingSink() {
  const seen: LedgerEntry[] = [];
  return { seen, sink: { async append(e: LedgerEntry) { seen.push(e); } } };
}

describe("UsageLedger in-memory cap", () => {
  it("keeps only the newest entries once the cap is reached", async () => {
    const ledger = new UsageLedger(undefined, 5);
    for (let i = 1; i <= 8; i++) await ledger.append(entry(i));

    const ts = ledger.query().map((e) => e.ts);
    expect(ts).toEqual([8, 7, 6, 5, 4]); // newest five, newest first
  });

  it("reports how many it dropped rather than truncating silently", async () => {
    const ledger = new UsageLedger(undefined, 5);
    for (let i = 1; i <= 8; i++) await ledger.append(entry(i));

    expect(ledger.evictedCount).toBe(3);
    // The oldest timestamp still answerable — anything before this is gone from memory.
    expect(ledger.oldestTs()).toBe(4);
  });

  it("a cap of one still keeps the newest entry", async () => {
    const ledger = new UsageLedger(undefined, 1);
    await ledger.append(entry(1));
    await ledger.append(entry(2));
    await ledger.append(entry(3));

    expect(ledger.query().map((e) => e.ts)).toEqual([3]);
    expect(ledger.evictedCount).toBe(2);
  });

  it("eviction from memory does not lose anything the sink was owed", async () => {
    const { seen, sink } = recordingSink();
    const ledger = new UsageLedger(sink, 3);
    for (let i = 1; i <= 10; i++) await ledger.append(entry(i));

    expect(ledger.query()).toHaveLength(3);
    expect(seen.map((e) => e.ts)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("a session well under the cap evicts nothing", async () => {
    const ledger = new UsageLedger(undefined, DEFAULT_MAX_MEM_ENTRIES);
    for (let i = 1; i <= 100; i++) await ledger.append(entry(i));

    expect(ledger.evictedCount).toBe(0);
    expect(ledger.query()).toHaveLength(100);
  });
});
