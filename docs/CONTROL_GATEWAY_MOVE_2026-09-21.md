# The gateway move — and one design reversal (2026-09-21, evening)

Follows `CONTROL_MERGE_AND_REMOVAL_2026-09-21.md`. That session left two rows in the staging table: the
gateway switches, and the memory master switch. Both are now resolved — one by moving, one by **not**
moving.

---

## 1. What landed

### The memory master switch stays on `Memory` — the design doc is overruled here

The staging table said move it. The mirroring was real: the same switch rendered on Memory and on
Control → Memory & context. But the argument on the Memory side is stronger, and it is the same argument
this screen's own header makes about itself:

> The switch sits beside the notice that says what turning it on sends off this machine. The moment you
> flip it is the moment that notice matters — and a notice read on another screen is not a notice.

So Control's Memory tab is now a **read-only report plus a link**: the state, whether it survives a
restart, where the per-app policy lives, and `Open Memory`. `SwitchRow`'s `sessionOnly` prop and badge
were deleted with it. This is the one case where the duplicate would have been the *destination* rather
than the source, which is why "link, don't mirror" still holds.

### The gateway on/off switch, port and spend cap moved to Control → Gateway

`Gateway.tsx` lost `toggle()`, `saveCap()`, the port field, the spend-cap section and the `usd` helper.
It keeps the master key, the per-app keys, background mode, the endpoint URL, the copy-paste presets and
"How it behaves" — it is now the **credentials screen** the design predicted, with a read-only
"Running"/"Stopped" line and a pointer where the Start button was.

State stays on both screens on purpose. A *read* of the host's own report is not a mirrored *control*:
both screens read one command, so they cannot drift. What would drift is a second place to change the
value.

---

## 2. Three things the move forced, none of them in the design

**The gateway needed its own clock.** Control's `tick` is bumped by user actions alone (`ui-state.ts`),
while `Gateway.tsx` polled every 2.5 s. A tab that took the status display without the poll would have
frozen at whatever it read on mount. `GatewayTab` now runs that interval itself, against a new
`refreshGateway` that re-reads **two** commands — deliberately not a second `load()`, which would re-run
`memory_stats`, a SQLite aggregate, every 2.5 s for the sake of a status dot.

**A switch's accessible name must not change with its state.** The row shows "Running"/"Stopped" in the
operator's vocabulary, so `SwitchRow` needed a `state` prop separate from `label`. `aria-checked` is what
carries the state; a control whose *name* flips between the two cannot be announced coherently.

**The first draft rendered the worker failure twice.** The §4.4 blocker already names it and carries the
raw error, so the block copied into the Gateway card was a duplicate — and the browser spec said so, with
`getByText(/failed to start/)` resolving to two elements. The block is gone; `Finding` gained an optional
`detail` for raw text that needs its own formatting.

That third one is worth keeping: **the test found a design defect, not a test defect.** The temptation is
to disambiguate the selector. The correct response was to delete the second copy.

---

## 3. Verification

| Layer | Result |
|---|---|
| `tsc --noEmit --noUnusedLocals --noUnusedParameters` | clean |
| `web-test:types` | clean |
| Desktop vitest | **177 passed** |
| Browser (playwright) | **73 passed** (72 → 73) |
| `pnpm ci:local` | **ALL GREEN** |

**Run the gate with `PATH="$HOME/.cargo/bin:$PATH"`.** Without it the gate ends
`FAILED (1): Rust (cargo missing)` while every other stage passes — it reads like a Rust failure and is
not one. Cost two ~4-minute runs. Move `dist` aside first (the sandbox bulk-delete guard).

### The new spec was falsified before it was trusted

`control → gateway: the switch starts the gateway without erasing the rest of the row` (`ui.spec.ts:359`)
pre-seeds the `gateway` settings row with `toolsEnabled`/`mutationEnabled`, flips the switch, and asserts
both that `port`/`enabled` were written **and** that the pre-existing keys survived — the write-clobber
that `settings_set`'s whole-row UPSERT makes possible, pinned end-to-end through the real `store.ts`
helpers rather than a mock.

With the merge in `patchGatewaySettings` replaced by a plain spread, the spec fails on line 400
(`toolsEnabled`/`mutationEnabled` lost) **while line 398 (`port: 8899`) still passes**. The two assertions
are independent pins, not one claim counted twice. Reverted; `store.ts:1159` verified back.

One trap inside the spec itself: it waits for `expect(port).not.toHaveValue("")` before `fill`, because
the field is seeded asynchronously and a racing `fill` would be overwritten by the seed — after which the
assertion would pass against `8787`, the value the fallback prints anyway.

---

## 4. Files changed

| File | Change |
|---|---|
| `apps/desktop/src/screens/Control.tsx` | `refreshGateway` in `useControlData`; `SwitchRow` gained `state`; `GatewayTab` rewritten with the switch, port, spend cap and diagnostics; `Finding` gained `detail`; Memory tab reduced to a report + link |
| `apps/desktop/src/screens/Gateway.tsx` | `toggle`, `saveCap`, the port field, the spend-cap section and `usd` removed; status line and pointer added |
| `apps/desktop/web-test/gateway-status.spec.ts` | retargeted Gateway → Control → Gateway; all four assertions kept |
| `apps/desktop/web-test/ui.spec.ts` | new `control → gateway` spec |
| `CONTROL_SCREEN_BUILD.md` | §3 counts; §4 rewritten — the staging table is now empty |
| `CONTROL_SWITCHBOARD_DESIGN.md` | §6 must-have 2 marked landed with the memory exception; §7.2 item 1 now live, new item 4 for the memory location |

---

## 5. Still open

1. **Persisting the memory master switch** — recommended *against*. Its non-persistence is what stops
   traffic being recorded because it was enabled once, and the UI already says so.
2. **The naming question for `Gateway.tsx`** (§7.2.1). Now live rather than hypothetical: it is a
   credentials screen, and the app has two screens both called some flavour of "Gateway". One seam the
   move created — starting the gateway is on a different screen from the endpoint URL it makes usable, so
   first run crosses between them.
3. **A reader for `generator_audit`** — already recorded, needs only a reader.
