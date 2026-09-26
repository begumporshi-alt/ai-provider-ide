/**
 * Adding a key, and what happens when its row does not land (2026-09-27).
 *
 * `addKey` is a two-store write. The secret goes to the keychain inside `registry.addKey`, and the
 * `api_keys` row goes to the host on the very next line. The second can fail — a 500 from the FK to
 * `providers`, a dead gateway, a 401 — and until this change the first was **not undone** when it
 * did. The secret then sat in the vault under `key:<uuid>` with no row to reach it: the keys list
 * reads `api_keys`, so nothing in the app could show it, select it, or revoke it.
 *
 * That is the "unrevokable ghost" the host's own `key_create_h` rolls back to prevent
 * (`core/gateway_admin.rs:359`), and the same guard `addProvider` — eleven lines up in `store.ts` —
 * already had. These specs pin it on the path that strands a *credential* rather than in-memory
 * state, which is why the failure is worse than its sibling's and why it went unnoticed longer.
 *
 * **Both directions, because one is not enough.** "No vault entry survives a failed add" also
 * passes against an `addKey` that deletes the secret unconditionally — which would break every
 * successful add. The third spec is what makes the first two mean something.
 *
 * **Falsified 2026-09-27, before it was trusted:** with the `catch` block removed, the first two
 * specs redden (no `vault_delete`; the registry keeps the key) and the control stays green. A spec
 * written after a fix only proves the author's model of the bug, so the fix was reverted and this
 * file was watched to fail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` because vi.mock factories run before any top-level `const` exists.
const h = vi.hoisted(() => ({
  /** Every IPC command the store issued, in order — the vault writes are what these specs read. */
  invokes: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    h.invokes.push({ cmd, args });
    // No per-command switch: the store's `KeyVaultPort.put` returns its own `label` and ignores
    // this value, so the honest default is `undefined`.
    return undefined;
  },
}));

/**
 * The transport, replaced at the module boundary. `addKey` reaches the host over `fetchAdmin`, so a
 * spec that mocks only IPC dials a real port and gets `ECONNREFUSED`. `failAdmin` is the lever that
 * makes the row insert fail the way a 500 does.
 */
vi.mock("./lib/gateway-client", async () => await import("./lib/gateway-client.fake"));

import { failAdmin, resetAdmin } from "./lib/gateway-client.fake";
import { addKey, registry } from "./store";

const PROVIDER = "p-rollback";
const INSERT_FAILED = "500 /admin/api-keys → insert failed";

/** The `account` of every call to a `vault_*` command — the identity of the entry, not a count. */
const accounts = (cmd: string) =>
  h.invokes.filter((i) => i.cmd === cmd).map((i) => i.args.account);

beforeEach(() => {
  h.invokes = [];
  resetAdmin();
  // `registry` is a module singleton; clear both maps so one spec cannot seed another.
  registry.hydrate([], []);
  registry.addProvider({
    id: PROVIDER,
    slug: "p-rollback",
    name: "Rollback",
    type: "manifest",
    baseUrl: "https://example.test/v1",
    status: "enabled",
    rotationStrategy: "round_robin",
  });
});

describe("addKey's vault rollback", () => {
  it("takes the secret back out of the vault when the row does not land", async () => {
    failAdmin("POST", "/admin/api-keys", INSERT_FAILED);

    await expect(addKey(PROVIDER, "k", "sk-secret-value")).rejects.toThrow("insert failed");

    // Same account, not merely the same number of calls: a delete of a *different* account would
    // satisfy a count assertion while leaving the ghost exactly where it was.
    expect(accounts("vault_put")).toHaveLength(1);
    expect(accounts("vault_delete")).toEqual(accounts("vault_put"));
  });

  it("leaves no key in the registry when the row does not land", async () => {
    failAdmin("POST", "/admin/api-keys", INSERT_FAILED);

    await expect(addKey(PROVIDER, "k", "sk-secret-value")).rejects.toThrow("insert failed");

    // The second ghost, and the one that outlives the error: `registry.addKey` had already accepted
    // the key, so the UI would list a key the host has never heard of.
    expect(registry.keysOf(PROVIDER)).toEqual([]);
  });

  it("keeps the secret when the row does land", async () => {
    const k = await addKey(PROVIDER, "k", "sk-secret-value");

    expect(accounts("vault_put")).toEqual([`key:${k.id}`]);
    expect(accounts("vault_delete")).toEqual([]);
    expect(registry.getKey(k.id)?.secretRef).toBe(`key:${k.id}`);
  });
});
