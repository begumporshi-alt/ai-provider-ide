/**
 * The host boundary, exercised **through the fake transport** (audit M3 + M8).
 *
 * Two things are pinned here, and they are different claims:
 *
 * 1. **The guards run on the real path.** `store.ts` reads `/admin/*` through `fetchAdminAs`, which
 *    validates before returning. These specs drive the store's own functions — not the guards
 *    directly — because a guard that is correct and a guard that is *called* are different
 *    properties, and only the second one protects anything.
 *
 * 2. **A wrong shape fails at the boundary, not in rendering.** Before M8 these reads were `as
 *    Promise<T>` assertions, so `{}` where an array was expected arrived as an array and blew up
 *    somewhere downstream. The specs below seed exactly that and assert the failure is here.
 *
 * The fake transport is the same one `store.gateway-settings.test.ts` uses. It is a **drop-in for
 * the real module**, so it must export everything the real one does — including `fetchAdminAs`.
 * That is not incidental: when it did not, every converted read threw
 * `fetchAdminAs is not a function` and the suite stayed green, because no spec reached those paths.
 * Spec 1 below is what stops that from recurring silently.
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

import { HostShapeError } from "./lib/host-boundary";
import { resetAdmin, seedAdmin } from "./lib/gateway-client.fake";
import { loadRecentLedger, memoryStats } from "./store";

/** A well-formed `HostLedgerRow`, so a spec can break exactly one field at a time. */
const ledgerRow = (over: Record<string, unknown> = {}) => ({
  ts: 1_700_000_000_000,
  modality: "text",
  source: "ui",
  providerId: "p1",
  keyId: "k1",
  requestedModel: "m",
  model: "m",
  status: "ok",
  httpStatus: 200,
  errorClass: null,
  latencyMs: 12,
  tokensIn: 3,
  tokensOut: 4,
  costEstimateMicros: 5,
  fallbackChainJson: null,
  cachedTokens: null,
  ...over,
});

beforeEach(() => {
  h.row = null;
  resetAdmin();
});

describe("a validated read succeeds on the good path", () => {
  it("returns the rows the host sent, unchanged", async () => {
    // The control. Without this, a guard that rejected *everything* would pass the specs below.
    seedAdmin("GET", "/admin/ledger?limit=200", [ledgerRow()]);

    await expect(loadRecentLedger()).resolves.toEqual([ledgerRow()]);
  });

  it("accepts an empty list — no rows is not a shape failure", async () => {
    seedAdmin("GET", "/admin/ledger?limit=200", []);

    await expect(loadRecentLedger()).resolves.toEqual([]);
  });

  it("tolerates a field the host adds beyond the contract", async () => {
    // Forward compatibility is deliberate: a host that adds a column must not break this build.
    seedAdmin("GET", "/admin/ledger?limit=200", [ledgerRow({ somethingNew: "x" })]);

    await expect(loadRecentLedger()).resolves.toHaveLength(1);
  });
});

describe("a wrong shape fails at the boundary", () => {
  it("rejects an object where the route promises an array", async () => {
    // The exact shape the old `as Promise<HostLedgerRow[]>` accepted.
    seedAdmin("GET", "/admin/ledger?limit=200", {});

    await expect(loadRecentLedger()).rejects.toBeInstanceOf(HostShapeError);
  });

  it("rejects a row missing a field the app reads", async () => {
    const { tokensIn: _omitted, ...partial } = ledgerRow();
    seedAdmin("GET", "/admin/ledger?limit=200", [partial]);

    await expect(loadRecentLedger()).rejects.toBeInstanceOf(HostShapeError);
  });

  it("rejects a field retyped by the host", async () => {
    seedAdmin("GET", "/admin/ledger?limit=200", [ledgerRow({ tokensIn: "3" })]);

    await expect(loadRecentLedger()).rejects.toBeInstanceOf(HostShapeError);
  });

  it("names the route, so the failure is not mistaken for a network fault", async () => {
    seedAdmin("GET", "/admin/ledger?limit=200", {});

    await expect(loadRecentLedger()).rejects.toThrow(/GET \/admin\/ledger\?limit=200/);
  });

  it("is not a TypeError — the boot must not read this as 'gateway unreachable'", async () => {
    // `store.ts`'s `isUnreachable` is `e instanceof TypeError` and decides whether the boot
    // *degrades* or *fails*. A shape mismatch is a real fault; classifying it as unreachable would
    // turn a broken host contract into a silent "the gateway is not running" notice.
    seedAdmin("GET", "/admin/ledger?limit=200", {});

    const err = await loadRecentLedger().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostShapeError);
    expect(err).not.toBeInstanceOf(TypeError);
  });
});

describe("the fake transport's defaults are honest shapes", () => {
  it("an unseeded memoryStats still satisfies the guard", async () => {
    // The fake's `/admin/memory/stats` default is a convenience, not a claim — but it must still be
    // a *valid* convenience, or an incidental call mid-path throws for the wrong reason.
    await expect(memoryStats()).resolves.toMatchObject({ total: 0, injectable: 0 });
  });
});
