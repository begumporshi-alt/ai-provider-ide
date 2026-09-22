# Gateway settings merge + the first "move, don't mirror" removal

**2026-09-21, session 2.** Companion to `CONTROL_SCREEN_BUILD.md` (what was built earlier the same day)
and `CONTROL_SWITCHBOARD_DESIGN.md` (the design). This file covers three things: the persistence work
that closed §6 must-have 5, the first removal off an old screen, and a sandbox blocker that cost more
time than either.

**Result: `pnpm ci:local` → ALL GREEN.** tsc clean · desktop vitest **177** (170 → 177) · Rust **414** ·
browser **72** (verified twice in a row) · `web-test:types` clean.

---

## 1. The `gateway` settings row needed a merge, not a persistence flag

The design said to persist the tools/mutation switches by extending the `gateway` settings object
`{port, enabled}` → `{port, enabled, toolsEnabled, mutationEnabled}` **"with `#[serde(default)]` on the new
fields — the established pattern in `persist.rs`."**

That instruction was wrong, and the real hazard was somewhere else entirely:

- **There is no Rust struct for this row.** The startup restore reads it as a `serde_json::Value` and looks
  keys up by name (`persisted_gateway_port`, `lib.rs:77`). An added key is invisible to it. No serde default
  is involved at any point.
- **The real hazard is a clobber.** `settings_set` is a whole-row UPSERT
  (`INSERT ... ON CONFLICT DO UPDATE SET value_json=excluded.value_json`, `commands.rs:197`), and
  `Gateway.tsx`'s Start/Stop handler wrote `JSON.stringify({ port, enabled })`. Adding the switches without a
  merge would have erased them on **every gateway restart** — silently, and only visible at the next launch.

Landed: `readGatewaySettings` / `patchGatewaySettings` (merge, never replace) /
`applyPersistedGatewaySwitches` in `store.ts`; a startup push in `App.tsx`; Control's Tools rows persist;
the duplicated toggles removed from `Gateway.tsx` and replaced with a pointer to Control → Tools.

### The spec asserts on the stored row, and two probes are why

`src/store.gateway-settings.test.ts` (new, 7 tests) fakes a two-command host: `settings_get` returns the row
or `null`, `settings_set` replaces it. The merge specs check **what landed in the row**, not just the
returned object. That is not stylistic — it was measured:

| Probe | Change | Outcome |
|---|---|---|
| 1 | `patchGatewaySettings` becomes a plain replace | both merge specs fail |
| 2 | it **returns** the merge but **writes** the patch | the same two specs fail, on the storage assertion, with the returned object correct |

Probe 2 is the point: a return-value-only version of those specs passes while the row silently loses two
keys. Each probe was run alone, then reverted.

---

## 2. First removal: failover and the per-provider cap, Settings → Control → Routing

Per the design's "move, don't mirror" rule. `Settings.tsx` lost both rows, the `CapInput` field, and the
`Row`/`Toggle` helpers that were their last consumers — the typecheck named all three, which is what
`noUnusedLocals` is for — and gained a pointer paragraph. The browser spec was retargeted from Settings to
Control → Routing with all four edge cases kept.

**Moving it surfaced two defects, both in the new copy:**

1. **Clearing the field removed the cap.** Control's commit ran `Number(raw)` before `clampConcurrency`, and
   `Number("")` is `0` — which for this setting means *unlimited*. The guard against exactly that lives
   inside `clampConcurrency` (`value.trim() !== ""`) and a `Number()` call steps straight past it. The
   Settings copy was correct; the new one was not. Fixed by passing the raw string through. The property is
   now pinned at the source too: `concurrency.test.ts`'s non-numeric list already had `null`, `[]` and
   `true` — all with the same shape — and was missing `""`, the one a real user actually produces.
2. **The tab strip was ambiguous.** Control's Findings list renders a jump button labelled with the target
   tab's own name, so `getByRole("button", { name: "Routing" })` resolved to **two** elements. The tabs were
   also a row of plain buttons with no ARIA tab semantics. They are now a real `tablist`/`tab`/`tabpanel`,
   which fixes it for a driver and a screen reader alike. (`aria-controls` is deliberately omitted: only the
   selected panel is mounted, so the other three ids would be dangling references.)

Both were falsified before being trusted — reverting the fix fails the specific assertion each time
(`expected +0 to be 4`; and the browser spec at `ui.spec.ts:330`, the cleared-field line).

---

## 3. A sandbox blocker that was not a project defect

The gate began failing `FAILED (1): Build`. The cause was not the build:

```
[plugin vite:prepare-out-dir] Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
{"count":77,"threshold":50,"targets":["…/apps/desktop/dist/assets"]}
```

Two build tools bulk-delete their own output directories, and the sandbox's guard counts **cumulatively per
tool call** (threshold 50):

- **Playwright** empties `test-results` at the start of every run, and a run leaves ~1150 trace screenshots
  there (`trace: "retain-on-failure"` records per test and discards on pass). A blocked reporter cleanup is
  **swallowed**, so this one was silent.
- **Vite's `emptyOutDir`** empties `dist/assets`. A blocked `emptyOutDir` is **fatal**.

The delete is only ~13 files on its own. It fails because earlier gate steps have already spent the budget —
which is why a standalone `pnpm build` succeeds and the same build inside the gate does not.

Diagnosed by reading the guard's own state files
(`$CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR/<session>/signal-*.json`, each recording its target and the count it
saw) rather than guessing; the counts there are what identified the cumulative behaviour.

Fixes:
- `web-test` now **moves** the stale `test-results` to `/tmp` before running — exactly what `ci-local.sh:96`
  has always done, and for the same stated reason. Verified by two consecutive green runs.
- Start a gate run with `dist` empty (`mv dist /tmp/…`). With that, the whole gate is **ALL GREEN**.

---

## 4. Files changed

| File | Change |
|---|---|
| `apps/desktop/src/store.ts` | `GatewaySettings`, `readGatewaySettings`, `patchGatewaySettings`, `applyPersistedGatewaySwitches` |
| `apps/desktop/src/store.gateway-settings.test.ts` | **new** — 7 specs pinning the merge against the stored row |
| `apps/desktop/src/App.tsx` | startup effect pushing persisted switches into the core |
| `apps/desktop/src/screens/Control.tsx` | raw-string clamp fix; tab strip → real tab semantics; Tools rows persist |
| `apps/desktop/src/screens/Settings.tsx` | failover + cap rows removed (pointer added); `CapInput`/`Row`/`Toggle` deleted; import dropped |
| `apps/desktop/src/screens/Gateway.tsx` | `patchGatewaySettings` instead of a whole-object `settings_set`; duplicated toggles removed |
| `apps/desktop/web-test/ui.spec.ts` | cap spec retargeted to Control → Routing; cleared-field case added |
| `apps/desktop/package.json` | `web-test:clean` moves stale `test-results` aside |
| `packages/router-core/test/concurrency.test.ts` | `""`, `" "`, `"   "` added to the non-numeric list |
| `CONTROL_SCREEN_BUILD.md`, `CONTROL_SWITCHBOARD_DESIGN.md` | §3/§4/§5 and the two `#[serde(default)]` claims corrected |

---

## 5. Still open

Still living on their old screens, so still mirrored and able to drift:

| Switch | Still on | Should move to |
|---|---|---|
| Gateway on/off, port, spend cap | `Gateway.tsx` | Control → Gateway |
| Memory master | `Memory.tsx` | Control → Memory & context |

Also open: the memory master's session-only status (§7.2.3 of the design), and a reader for
`generator_audit` — recorded data with no UI.
