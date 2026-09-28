/**
 * Onboarding's first write is atomic (2026-09-28).
 *
 * `createPendingProvider` writes the provider row host-side, and that row is what makes the host
 * allowlist the base URL — its call site says "pending = host allowlisted for probes", and the
 * orchestrator's very next action is to probe. It did **not** roll back when the host refused the
 * write, while `addProvider` eleven lines up has done so since 26j and the note above `addKey` names
 * the same hazard for a credential.
 *
 * What the operator saw was therefore not an error about the gateway. `addKey` ran against a
 * provider id the host had never heard of, every probe was refused for a host the allowlist never
 * received, and the screen reported "could not identify this API" — a claim about the API, produced
 * by a local bookkeeping failure.
 *
 * **Asserted against `registry`, because that is the property.** A spec that only asserted the throw
 * would stay green with the ghost still in the registry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  // `publishModelContext` reaches the host over IPC; nothing here asserts on it.
  invoke: async () => 0,
}));

vi.mock("./lib/gateway-client", async () => await import("./lib/gateway-client.fake"));

import { failAdmin, resetAdmin } from "./lib/gateway-client.fake";
import { createPendingProvider, registry } from "./store";

beforeEach(() => {
  resetAdmin();
  // The registry is a module singleton; one spec's providers must not leak into the next.
  registry.hydrate([], []);
});

describe("onboarding's provider row", () => {
  it("is not left in the registry when the host refuses the write", async () => {
    failAdmin("POST", "/admin/providers", "gateway unreachable");

    await expect(createPendingProvider("Ghost", "https://ghost.example")).rejects.toThrow(
      /unreachable/,
    );

    expect(registry.listProviders()).toHaveLength(0);
  });

  it("is kept when the host accepts it, so the rollback is not a delete-everything", async () => {
    const id = await createPendingProvider("Real", "https://real.example");

    expect(registry.listProviders().map((p) => p.id)).toEqual([id]);
  });
});
