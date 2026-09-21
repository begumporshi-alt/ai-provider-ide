/**
 * The `gateway` settings row (2026-09-21).
 *
 * One JSON object under one key, shared by concerns that do not know about each other: the listener
 * (`port`/`enabled`) and the tool switches (`toolsEnabled`/`mutationEnabled`). The host writes it with
 * a whole-row UPSERT — `settings_set` is `INSERT ... ON CONFLICT DO UPDATE SET value_json=excluded`,
 * `commands.rs:197` — so **every** write replaces the entire object at the storage layer. The only
 * thing between a caller and the silent loss of a key it never mentioned is the merge inside
 * `patchGatewaySettings`.
 *
 * That shapes how these specs assert. Each one checks **what landed in the row**, not just the
 * returned object: a helper that returned a merge but wrote the patch would satisfy a return-value
 * assertion and still lose the key. The regression is not hypothetical — Gateway.tsx's Start/Stop
 * handler wrote `JSON.stringify({ port, enabled })` before this helper existed, so adding the tool
 * switches without it would have wiped them on every gateway restart.
 *
 * The fake below is a two-command host: `settings_get` returns the row or `null`, `settings_set`
 * replaces it. Everything else (the two `set_tools_*` commands) resolves and is recorded, so the
 * startup-push specs can assert on the calls without a second mock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` because vi.mock factories run before any top-level `const` exists.
const h = vi.hoisted(() => ({
  /** The single `settings` row, exactly as SQLite would hold it: a JSON string, or absent. */
  row: null as string | null,
  invokes: [] as Array<{ cmd: string; args: Record<string, unknown> }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    h.invokes.push({ cmd, args });
    switch (cmd) {
      case "settings_get":
        return h.row;
      case "settings_set":
        h.row = args.valueJson as string; // whole-row replace, as the host does it
        return undefined;
      default:
        return undefined; // set_tools_enabled / set_tools_mutation_enabled
    }
  },
}));

import {
  applyPersistedGatewaySwitches,
  patchGatewaySettings,
  readGatewaySettings,
} from "./store";

/**
 * The row as it now stands, parsed — what the next launch would read.
 *
 * Measured 2026-09-21, two probes, one at a time: (1) making the helper a plain replace fails both
 * merge specs; (2) making it *return* the merge but *write* the patch fails the same two specs — on
 * this assertion, with the returned object correct. Probe 2 is the reason the storage assertion is
 * here: a return-value-only version of these specs passes while the row loses two keys.
 */
const stored = () => JSON.parse(h.row ?? "{}") as Record<string, unknown>;
const calls = (cmd: string) => h.invokes.filter((i) => i.cmd === cmd);

beforeEach(() => {
  h.row = null;
  h.invokes = [];
});

describe("patchGatewaySettings merges, never replaces", () => {
  it("keeps keys the patch did not mention", async () => {
    // The exact write the Start/Stop handler makes: a listener change that knows nothing about tools.
    h.row = JSON.stringify({
      port: 8800,
      enabled: true,
      toolsEnabled: true,
      mutationEnabled: false,
    });

    const next = await patchGatewaySettings({ port: 9000, enabled: false });

    expect(next).toEqual({
      port: 9000,
      enabled: false,
      toolsEnabled: true,
      mutationEnabled: false,
    });
    // The assertion that actually protects the next launch:
    expect(stored()).toEqual({
      port: 9000,
      enabled: false,
      toolsEnabled: true,
      mutationEnabled: false,
    });
  });

  it("keeps the listener when only a switch is patched", async () => {
    // The reverse direction — this is the write Control → Tools makes.
    h.row = JSON.stringify({
      port: 8800,
      enabled: true,
      toolsEnabled: false,
      mutationEnabled: false,
    });

    await patchGatewaySettings({ toolsEnabled: true });

    expect(stored()).toEqual({
      port: 8800,
      enabled: true,
      toolsEnabled: true,
      mutationEnabled: false,
    });
  });

  it("writes the patch when there is no row yet", async () => {
    expect(h.row).toBeNull();

    const next = await patchGatewaySettings({ port: 8800, enabled: true });

    expect(next).toEqual({ port: 8800, enabled: true });
    expect(stored()).toEqual({ port: 8800, enabled: true });
  });

  it("survives a corrupt row instead of taking the screen down", async () => {
    h.row = "{not json";

    // Unparseable, so there is nothing to merge from — the patch becomes the new row. Losing the
    // garbage is the point; a throw here would blank whichever screen called it.
    expect(await readGatewaySettings()).toEqual({});
    await patchGatewaySettings({ enabled: false });

    expect(stored()).toEqual({ enabled: false });
  });
});

describe("applyPersistedGatewaySwitches pushes persisted state into the core", () => {
  it("pushes a persisted false rather than skipping it", async () => {
    // The truthiness trap: `if (s.toolsEnabled)` would drop this one and leave tools on.
    h.row = JSON.stringify({ toolsEnabled: false, mutationEnabled: true });

    await applyPersistedGatewaySwitches();

    expect(calls("set_tools_enabled")).toHaveLength(1);
    expect(calls("set_tools_enabled")[0]?.args).toEqual({ enabled: false });
    expect(calls("set_tools_mutation_enabled")).toHaveLength(1);
    expect(calls("set_tools_mutation_enabled")[0]?.args).toEqual({ enabled: true });
  });

  it("leaves a switch alone when the row predates it", async () => {
    // A row written before the tool switches existed. Forcing them to false here would silently
    // disable tools on upgrade — the guard must be a type check, not a default.
    h.row = JSON.stringify({ port: 8800, enabled: true });

    await applyPersistedGatewaySwitches();

    expect(calls("set_tools_enabled")).toHaveLength(0);
    expect(calls("set_tools_mutation_enabled")).toHaveLength(0);
  });

  it("does not write the row it is reading", async () => {
    // A startup path that writes is a startup path that can clobber. This one is read-only.
    h.row = JSON.stringify({ port: 8800, enabled: true, toolsEnabled: true });

    await applyPersistedGatewaySwitches();

    expect(calls("settings_set")).toHaveLength(0);
    expect(stored()).toEqual({ port: 8800, enabled: true, toolsEnabled: true });
  });
});
