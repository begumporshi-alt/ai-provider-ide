/**
 * The ledger append body — the one place a failure's evidence can be lost (drift D81).
 *
 * Measured against the live database on 2026-10-01: `SELECT count(*) FROM ledger` = **2562** and
 * `sum(failure_detail IS NOT NULL AND failure_detail <> '')` = **0**. Every link but one was in
 * place — the engine sets `failureDetail` (`model-router.ts`, the drained arm), the Rust row has
 * `#[serde(default)] failure_detail`, the INSERT binds it at position 18, and Activity renders it —
 * and the object literal that actually crosses the host boundary omitted the field. `LedgerRow` has
 * `deny_unknown_fields`, which catches a *misspelled* key; nothing catches an *absent* one. So the
 * column stayed NULL for every row and a drained stream stayed a dead end.
 *
 * These specs drive the store's real `ledger` singleton through the fake admin transport, because
 * "the field is set" and "the field is sent" are different properties, and only the second one
 * reaches the database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ row: null as string | null }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd === "settings_get") return h.row;
    return undefined;
  },
}));

vi.mock("./lib/gateway-client", async () => await import("./lib/gateway-client.fake"));

import { resetAdmin, adminBodies } from "./lib/gateway-client.fake";
import { ledger } from "./store";

const entry = (over: Record<string, unknown> = {}) => ({
  ts: 1_700_000_000_000,
  modality: "text" as const,
  source: "ui" as const,
  requestedModel: "agent-router/deepseek-v4-flash",
  model: "agent-router/deepseek-v4-flash",
  status: "error" as const,
  errorClass: "PARSE_ERROR" as const,
  latencyMs: 4054,
  tokensIn: 0,
  tokensOut: 0,
  costEstimateMicros: 0,
  cachedTokens: null,
  fallbackChain: [],
  ...over,
});

beforeEach(() => {
  h.row = null;
  resetAdmin();
});

describe("the ledger append body carries the failure's evidence", () => {
  it("sends failureDetail when the entry has one", async () => {
    await ledger.append(entry({ failureDetail: "stream carried no SSE events at all" }) as never);
    const [body] = adminBodies("POST", "/admin/ledger") as Array<Record<string, unknown>>;
    expect(body!.failureDetail).toBe("stream carried no SSE events at all");
  });

  it("sends an explicit null when it does not, rather than omitting the key", async () => {
    // The distinction matters: an omitted key is what a dropped field looks like, and this column
    // was NULL on 2562 rows precisely because nobody could tell the two apart in the payload.
    await ledger.append(entry() as never);
    const [body] = adminBodies("POST", "/admin/ledger") as Array<Record<string, unknown>>;
    expect(body).toHaveProperty("failureDetail");
    expect(body!.failureDetail).toBeNull();
  });
});
