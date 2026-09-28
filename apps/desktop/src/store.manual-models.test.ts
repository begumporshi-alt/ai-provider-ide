/**
 * Manually added models: what the UI sends to the host, and what a model test concludes (2026-09-28).
 *
 * The property that matters is the `origin` on the wire. A manual row survives a catalog refresh
 * only because the caller re-sends it — the host's replace deletes a provider's discovered rows and
 * keeps `manual` ones. So a payload that carried the right model with the wrong origin would look
 * correct in the UI and be erased at the next Refresh. That is invisible until it happens, which is
 * exactly the kind of thing a spec has to hold down.
 *
 * `testModel`'s specs are about what counts as an answer. It is the only place the operator asks
 * "does this model work?", so a failure reported as a success is worse than no test at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  // `publishModelContext` reaches the host over IPC; nothing here asserts on it.
  invoke: async () => 0,
}));

vi.mock("./lib/gateway-client", async () => await import("./lib/gateway-client.fake"));

import { adminBodies, resetAdmin } from "./lib/gateway-client.fake";
import { addManualModel, catalog, removeManualModel, testModel } from "./store";

const PROVIDER = "p-manual";

/** Every `rows` entry the last `POST /admin/models-cache` carried for this provider. */
function lastRows(): Array<{ nativeId: string; origin: string }> {
  const bodies = adminBodies("POST", "/admin/models-cache") as Array<{
    providerId: string; rows: Array<{ nativeId: string; origin: string }>;
  }>;
  const last = bodies[bodies.length - 1];
  return last?.providerId === PROVIDER ? last.rows : [];
}

beforeEach(() => {
  resetAdmin();
  // `catalog` is a module singleton; one spec's rows must not leak into the next.
  catalog.hydrate([], {});
});

describe("a manually added model", () => {
  it("is written to the host as manual, so a refresh keeps it", async () => {
    await addManualModel({
      providerId: PROVIDER, nativeId: "typed-by-hand", modality: "text", contextWindow: 32_000,
    });

    expect(lastRows()).toEqual([
      expect.objectContaining({ nativeId: "typed-by-hand", origin: "manual" }),
    ]);
    // The window is what the router plans a budget against; dropping it silently would under-send.
    expect(catalog.all()[0]?.contextWindow).toBe(32_000);
  });

  it("is gone from the payload once removed, which is what deletes the row", async () => {
    await addManualModel({ providerId: PROVIDER, nativeId: "typed-by-hand", modality: "text" });
    expect(await removeManualModel(PROVIDER, "typed-by-hand")).toBe(true);

    expect(lastRows()).toEqual([]);
  });

  it("is not removed when the id belongs to a discovered row", async () => {
    catalog.hydrate(
      [{ providerId: PROVIDER, nativeId: "listed", modality: "text", fetchedAt: 1, origin: "discovered" }],
      {},
    );
    expect(await removeManualModel(PROVIDER, "listed")).toBe(false);
    expect(catalog.all()).toHaveLength(1);
  });

  it("keeps a blank context window unknown rather than zero", async () => {
    await addManualModel({ providerId: PROVIDER, nativeId: "no-window", modality: "text" });
    expect(catalog.all()[0]?.contextWindow).toBeUndefined();
  });
});

describe("testModel", () => {
  it("refuses to answer when the provider has no active key", async () => {
    // A precondition, not a verdict: without a key there is nothing to send, and reporting "the
    // model does not work" would send the operator to change the model rather than add a key.
    await expect(testModel("p-with-no-keys", "whatever")).rejects.toThrow(/no active key/);
  });
});
