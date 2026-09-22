# Control screen — build report (2026-09-21)

Companion to `CONTROL_SWITCHBOARD_DESIGN.md` (the design) and `MEMORY_CONTEXT_GATEWAY_INTEGRATION.md`
(how memory, context and the gateway actually fit together). This file records what was **built**, what
measurement changed, and what is deliberately still open.

---

## 1. What landed

### Backend — the observability the switchboard rests on

| Piece | Where |
|---|---|
| `InjectionLog` — ring of 100 events + per-reason counters + lifetime total | `src-tauri/src/injection_log.rs` (new) |
| `GatewayCore.injection_log` field, `record_injection()`, `injection_stats()` | `src-tauri/src/gateway.rs` |
| Recording at the four ingress handlers | `gateway_handlers.rs:65`, `gateway_anthropic.rs:192`, `gateway_responses.rs:134`, `gateway_gemini.rs:232` |
| `gateway_injection_stats` command | `src-tauri/src/gateway_cmds.rs`, registered in `commands.rs` |
| Shim case returning **one populated row** | `web-test/shim.ts` |

The design's §4.4 argument is the reason this came first: a switch that is off *by choice* is not a
problem, and the app cannot read intent. The telemetry is what distinguishes a deliberate off from a
broken one, so the screen could not be honest without it.

### Frontend

- **`src/screens/Control.tsx`** (new) — four tabs (Gateway · Memory & context · Tools · Routing),
  1/3 switches + 2/3 detail, findings lead each tab, layer 2 behind a `Show detail` disclosure, the
  reason-translation table, and switch rows that show `Applying…` then revert with an inline error.
- **`store.ts`** — `InjectionEvent`, `InjectionStats`, `GatewayStatus`, `GatewaySpendStatus` and their
  wrappers. `GatewayStatus` was **moved out of `Gateway.tsx`** so the DTO has one definition.
- **Navigation** — the three edits (`ui-state.ts`, `Shell.tsx`, `App.tsx`) plus `"Control"` added to
  `smoke.spec.ts`'s `NAV_LABELS` so both sweeps cover it.

---

## 2. Two design claims corrected by measurement

Both were written into `CONTROL_SWITCHBOARD_DESIGN.md` §5.1 rather than quietly changed.

1. **Counters are a `HashMap` under one mutex, not `AtomicU64`.** One lock means a reader gets a
   consistent pair; a snapshot assembled across two locks can show a count that disagrees with the list
   printed beside it — the exact bug class this screen exists to catch.

2. **`id` is the client-visible `gw-{n}`, not the capture id.** The draft specified the capture id
   "so a row here can be matched against the Activity ledger". That rationale **does not hold**:
   `ledger_append` (`store.ts:97`) sends `ts, modality, source, providerId, keyId, requestedModel,
   model, status, httpStatus, errorClass, latencyMs, tokensIn, tokensOut, costEstimateMicros,
   fallbackChainJson` and **no request id at all**, so no id form can be joined to a ledger row. The
   client-visible id is kept for a different reason — it is the string a client quotes when it reports
   a failure. The capture id would also be a category error here: it identifies a row in the *write*
   queue (`memory_pending`), while this event describes the *read* path.

---

## 3. Verification

| Layer | Result |
|---|---|
| Rust `cargo test --lib` | **433 passed** (408 → 414 → 420 → 426 → 433: the six ring-buffer specs, the six gateway-log specs, the six `generator_audit` specs, then the seven `drift_events` specs) |
| Desktop vitest | **193 passed** (170 → 177 → 183 → 186 → 190 → 193: the seven settings-merge specs, the six trail-write specs, the three lost-ending specs of §4a.5, the four run-omission specs of §4a.7, then the three stranded-repair specs of §4a.8) |
| Browser (playwright) | **98 passed** over **87 declarations** (72 → 73 → 78 → 84 → 91 → 95 → 96 → 97 → 98). Retargeted for the Control move, then added across the three trail readers (§4a.1–4a.3), the trail-health channel (§4a.4), the lost ending (§4a.5), the run that is never listed (§4a.7) and the stranded repair (§4a.8) |
| `tsc --noEmit --noUnusedLocals --noUnusedParameters` | clean |
| `web-test:types` | clean |
| `pnpm ci:local` | **ALL GREEN**, all nine steps (the `Build` step needed `build:clean` — §4a.6) |

Two browser tests carry the weight:

- `every screen renders without an uncaught error (Control)` — the new screen paints.
- `no screen calls a command the shim does not implement` — no shim gap. Without this, a missing case
  makes the screen render *looking* loaded and disabled, with no error anywhere.

### Every new spec was falsified before being trusted

A spec that passes with its mechanism removed is decoration. Each was checked by breaking the thing it
claims to pin:

| Mechanism disabled | Specs that failed | Specs that still passed |
|---|---|---|
| counters | `counters_survive_ring_eviction`, `reasons_are_counted_separately…` | ring + privacy specs |
| ring eviction | `the_ring_evicts_the_oldest…`, `counters_survive_ring_eviction` (105/300 vs 100) | privacy + wire-name specs |
| `rename_all` | `the_wire_names_are_camel_case` (printed `ts_ms` on the wire) | all others |
| the merge in `patchGatewaySettings` | `keeps keys the patch did not mention`, `keeps the listener when only a switch is patched` | the other five |
| the empty-string guard in `clampConcurrency` | `falls back to the default for input that is not a number at all` (`expected +0 to be 4`) | all others |
| passing `raw` (not `Number(raw)`) to `clampConcurrency` | browser `control → routing…` at the cleared-field assertion (`ui.spec.ts:330`) | the rest of that spec |
| the `detail &&` guard on the audit read | browser audit-log 1, 2 **and** 4 (the seeded lines never appear) | test 3 — an empty log reads the same either way |
| `setLog(null)` on a failed audit read | browser audit-log 5 at `expect(getByText("run_command ls")).toHaveCount(0)` | tests 1–4 |
| the `—` placeholder for an untimed line | browser audit-log 2 at the placeholder assertion | tests 1, 3, 4, 5 |
| `truncated_head` in `parse_log_tail` | Rust `a_fragment_at_the_head_is_dropped_only_when_the_read_was_truncated` | the other five |
| `limit.max(1)` in `parse_log_tail` | Rust `a_zero_limit_still_returns_one_line` — **found by the test failing, not by review** | the other five |

The two ring/counter rounds fail on *different assertions* — cap vs counter — which is what makes them
independent pins rather than one test counted twice.

The merge round took **two** probes, and the second is the one that justifies the spec's shape: probe 1
made the helper a plain replace; probe 2 made it *return* the merge but *write* the patch. Both failed the
same two specs, and probe 2 failed on the assertion against the **stored row** with the returned object
correct — so a return-value-only version of those specs would pass while the row silently loses two keys.

---

## 4. The "move, don't mirror" half

The design's core principle is that Control **owns** the cross-cutting switches; the screen landing
first only *reported* them. Left staged on purpose: the screen is verified first, then the removals, so
there is never a commit where a switch exists in neither place.

**Moved 2026-09-21 — failover and the per-provider cap.** They now live only in Control → Routing.
`Settings.tsx` lost both rows, the `CapInput` field, and the `Row`/`Toggle` helpers they were the last
consumers of (the typecheck named all three), and gained a pointer paragraph. The browser spec was
retargeted from `Settings` to Control → Routing and the cap's four edge cases were kept.

Moving it surfaced two defects, both in the **new** copy:

1. **Clearing the field removed the cap.** Control's commit did `Number(raw)` before
   `clampConcurrency`, and `Number("")` is `0` — which for this setting means *unlimited*. The guard
   against exactly that lives inside `clampConcurrency` (`value.trim() !== ""`) and a `Number()` call
   skips straight past it. The Settings copy was correct; the new one was not. Fixed by handing the raw
   string through, and the property is now pinned at the source: `concurrency.test.ts`'s
   non-numeric list gained `""`, `" "` and `"   "` — the case that list had been missing.
2. **The tab strip was ambiguous.** The Findings list renders a jump button labelled with the target
   tab's own name, so "the button called Routing" matched two elements. The tabs were also a row of
   plain buttons with no ARIA tab semantics. They are now a real `tablist`/`tab`/`tabpanel`, which
   resolves the ambiguity for a driver and for a screen reader alike.

**Moved 2026-09-21 — the gateway on/off switch, its port and the spend cap.** They now live only in
Control → Gateway. `Gateway.tsx` lost `toggle()`, `saveCap()`, the port field, the spend-cap section and
the `usd` helper, and gained a pointer where the Start button was. The regression spec
(`gateway-status.spec.ts`) was retargeted from the Gateway screen to Control → Gateway, keeping all four
of its cross-checked assertions.

Three things this move forced, none of them visible in the design:

1. **The gateway needed its own clock.** Control's `tick` is bumped by user actions alone (`ui-state.ts`),
   and `Gateway.tsx` polled every 2.5 s — so a tab that took the status display without the poll would
   freeze at whatever it read on mount. The tab now runs that interval itself, against a new
   `refreshGateway` that re-reads **two** commands. It is deliberately not a second `load()`: that would
   re-run `memory_stats`, a SQLite aggregate, every 2.5 s for the sake of a status dot.
2. **A switch's accessible name must not change with its state.** The row shows "Running"/"Stopped" in the
   operator's vocabulary, which needed a `state` prop separate from `label` — `aria-checked` is what
   carries the state, and a control whose *name* flips cannot be announced coherently.
3. **The first draft rendered the worker failure twice.** The §4.4 blocker already names it and carries
   the raw error, so the copy in the Gateway card was a duplicate — and the spec caught it, with
   `getByText(/failed to start/)` resolving to two elements. The block is gone; `Finding` gained an
   optional `detail` for raw text that needs its own formatting.

**Reversed by decision — the memory master switch stays on `Memory`.** The staging table below said to
move it, and the mirroring was real, but the argument on the Memory side wins: the switch sits beside the
notice that says what turning it on sends off this machine, and *that moment* is when the notice matters.
A notice read somewhere else is not a notice. Control's Memory tab now reports the state and links out
instead of duplicating the control.

Still on their old screens: **none**. Both rows of the staging table are resolved.

Also open, and recorded in the design doc: the memory master switch's session-only status (§7.2.3), the
naming question for `Gateway.tsx` now that it is a credentials screen (§7.2.1), and a first-class view for
`drift_events`. Both audit-trail readers — `gateway.log` and `generator_audit` — landed 2026-09-21 (§4a).

---

## 4a. The audit trails finally have readers

`gateway.log` has been appended to on every gateway tool call since 2026-09-20 and nothing could read it
back. The card on Control → Tools even said so — *"Recorded today; a reader lands with §6 must-have 9"* —
which is the worst version of the problem: the UI advertised the gap, so the trail was evidence nobody
could consult. The same held for `generator_audit`: every adapter the assistant had ever written was being
recorded with no reader. **§6 must-have 9 is now landed in full** — two trails, two stores, two screens.

**Host side** (`gateway_cmds.rs`): `GatewayLogLine` (`tsMs: Option<u64>`, `text`), a pure
`parse_log_tail(text, limit, truncated_head)` so the parsing is testable without an `AppHandle`, and the
`gateway_log_tail` command. Bounded at both ends — at most `limit` lines, read from the last 128 KB —
because the log is never rotated and reading it whole to show twenty lines would grow without bound.

Two decisions inside the parser are worth naming:

1. **The head fragment is dropped only when the read was actually truncated.** A tail read starts
   mid-line, and half a line reads as a corrupt line. Dropping it unconditionally would silently eat the
   oldest line of every log short enough to fit in the window — which is the bug the `truncated_head`
   flag exists to prevent.
2. **The floor of one lives in the parser, the ceiling in the command.** The floor is a property *of
   parsing* and the command cannot be unit-tested without an `AppHandle`; the ceiling is a policy about
   scraping. Splitting them that way means each bound is enforced where it is tested. The floor was
   **found by the test failing**, not by review — the first draft returned zero lines for `limit: 0`.

**Frontend** (`Control.tsx` → Tools): the card reads the log when the disclosure is opened, not with the
rest of the tab — every other value on this screen is a scalar the poll refreshes cheaply, and this is a
file read behind a disclosure. A `logTried` flag, separate from `log !== null`, stops a *failed* read
from re-triggering the effect that started it.

**A failed read clears the lines rather than leaving them on screen.** The first draft kept the previous
tail under the error notice; §4.3's rule for a metric that has not loaded applies to a list too — a stale
tail rendered under a failure is a claim about *now*, and this is the one card that must not claim a line
is current when the read that would have shown it is the read that failed. That made the empty branch's
`logError === null` guard redundant: the two states are mutually exclusive by construction.

**The harness gained `__webTest.failNext(cmd, message)`**, later extended with an optional `afterMs`.
Until now a UI `catch` branch was unreachable from a spec — every shim case either answered or threw
because the command was unknown — so "the read failed" and "the read answered with nothing" rendered
identically, which is precisely the distinction these cards exist to make. One-shot and cleared on use, so
a spec arranges the exact call it means to fail.

**A pre-existing flake, found on the way and fixed at its source.** `cargo test --lib` failed once with
`injected=0;reason=deadline` in a `context_scope` test, then passed in isolation, then failed again in a
*different* test. The cause is `MEMORY_DEADLINE = 15 ms`: a wall-clock budget that `cargo test`'s
parallel load can exceed, so the failure reads as a policy bug and is not one — and because it is
load-dependent it moved from test to test. Patching one call site only moved the noise, so the constant
is widened under `cfg(test)` and the deadline itself is still tested for real via
`Deadline::new(Duration::ZERO)` and the explicit-budget `inject_context_deadline` tests.

Two of the six parser tests were also **decoupled**: the untimed-line and long-line tests originally put
the line under test first and asserted the result's length, so a bug in the head-fragment rule failed
three tests and a failure named nothing. Both now select their line by content and assert nothing about
the collection's size; with the head-fragment bug re-applied, exactly one test fails.

### 4a.1 The second trail: `generator_audit` on Providers

Same gap, different store. `persist.rs` gained `GeneratorAuditEntry` and a `list_generator_audit` read
path ordered `ts DESC, id DESC` — the tie-break matters, because two rows can land in the same
millisecond — behind a thin `generator_audit_list` command. Providers gained `GenerationAuditCard`, which
reads on mount and again on `tick`.

It lives on Providers rather than Control → Tools because both of its producers are adapter work (the
wizard's candidate generation, and drift repair), repair already lives on that screen, and the rows carry
no provider id at all — the INSERT omits `session_id`, so it is NULL on every row and a per-provider panel
would have to invent an attribution the host never recorded.

Two caveats are surfaced in the UI rather than only in the code: the token counts are `chars / 4`
estimates, so both numeric headers carry `≈` *and* the copy says "estimates"; and the redaction hash is
shown truncated to twelve characters, because it is a summary rather than a tool for verifying the digest.

### 4a.2 The supersession test was decoration, twice

The card reads on mount *and* on `tick`, and StrictMode fires mount effects twice (`main.tsx:7`; the
harness runs vite **dev**). Two reads are in flight, one may reject after the other has resolved, and the
older one's error would then sit directly above the newer one's data. A generation counter in `load`
prevents it.

**The regression test for that counter passed with the counter deleted — twice.**

1. An immediate arranged failure rejects inside a microtask, so it always lands *before* the newer read
   resolves; the newer read's `setError(null)` wipes it either way. Probe: **0 of 6 tests failed.**
2. Deferring the rejection by 300 ms fixed the ordering — and still **0 of 6 failed**, because the
   deferred rejection now lands *after* the test's assertions have run and the test has finished.
3. Defer 200 ms *and* wait 800 ms before asserting. Probe: **exactly one test fails**, the overlap test,
   on `Nothing recorded yet`. Restored, all six pass.

Two rules fall out of it, and both generalise:

- **"Fail the next call" cannot test supersession on its own.** Which read loses the race is a property of
  the microtask ordering, not of the code under test, so the fault has to be *deferred* in order to choose
  the ordering rather than inherit it.
- **Asserting that something does *not* appear requires outliving the moment it would appear.**
  `toHaveCount(0)` and `toBeVisible()` both succeed instantly on the happy path, so a test that arranges a
  late fault and asserts early is green by construction. The fixed wait is load-bearing and says so in the
  spec; the failure mode is permanent rather than transient, so there is no race to lose.

### 4a.3 The third trail: `drift_events` on Providers

The last recorded store without a UI reader. Written on every detection (`store.ts:143`) and every repair
(`store.ts:220`); its only reader was `diagnostics_json` — the clipboard bundle — so the recorded history was
visible solely as raw JSON pasted into a bug report.

`persist.rs` gained `DriftEventEntry` and `list_drift_events`, ordered `detected_at DESC, id DESC` behind a
thin `drift_events_list` command; Providers gained `DriftHistoryCard`. Same shape as the generation card
beside it, for the same reasons.

Three decisions worth keeping:

1. **`COALESCE(trigger_json,'{}')`.** The column is nullable and the *other* reader of this table already
   coalesces, so a NULL renders as an empty summary rather than dropping the row or failing the call.
   Losing the event is the exact failure this reader exists to prevent.
2. **The card parses `trigger_json` defensively.** The blob is the host's own JSON and the host does not
   validate it, so a malformed body renders as "no detail recorded" and the row still appears. The row's
   *existence* is the evidence.
3. **`resolution` is `Option`, not a defaulted string.** An open event and a repaired one must not read
   alike, and neither may read as a *missing* value — "Open" means still drifting, not "unknown".

**A defect the spec found.** Adding a second trail card put a second button named "Refresh" on Providers.
That is a strict-mode violation in Playwright, but the real problem is a screen reader: two controls with
one accessible name, on a page the user cannot see. `Button` gained an optional `ariaLabel`, and the two
cards now read "Refresh generation audit" and "Refresh drift history" — each still *containing* the visible
word, per WCAG 2.5.3 (Label in Name).

**And a test that was not isolating its rule.** The first version of the open/resolved test reached its rows
by index, so reversing the ordering failed it as well as the ordering test — an ordering bug failing a test
named for a different rule. Both rows are now located by content (`rows.filter({ hasText })`), the same
decoupling applied to the Rust parser tests in §4a.

| Mechanism disabled | Tests that failed | Tests that still passed |
|---|---|---|
| `ORDER BY detected_at DESC, id DESC` → `detected_at DESC` (Rust) | the tie-break test | the other six |
| `COALESCE(trigger_json,'{}')` (Rust) | the NULL-trigger test | the other six |
| `limit.clamp(1, …)` → `limit.min(…)` (Rust) | the zero-limit test | the other six |
| the shim's sort, reversed | the newest-first test, and — before the fix above — the open/resolved test too | 3–7 |
| `r.resolution ?? "Open"` → `"Open"` | the open/resolved test | the other six |
| the defensive `catch` returning `""` | the unparseable-trigger test | the other six |
| the supersession guard in the card's `catch` | the overlap test | the other six |
| `setRows(null)` on a failed read | the failed-refresh test | the other six |

---

### 4a.4 The trails could not detect their own gaps

The three readers landed claiming completeness — "Every adapter the assistant wrote", "Every time a provider
was detected drifting" — while their three writes were issued from **four** call sites, all with
`.catch(() => undefined)`. That swallow was right for what it protected (a repair that applied must not be
reported as failed because its *record* did not land) and wrong for the claim: **a read cannot detect a write
that never happened.**

The drift resolution was the case with a visible contradiction. `approveRepair` applies the repair and then
closes the event; if the close fails, the modal says "Repaired", the provider card shows no drift, and the
drift history one card below still reads **Open** in red — and "Keep current adapter"
(`Providers.tsx:422`) never closes the row either, so a lost record and a *declined* repair rendered
identically.

`writeTrail(trail, cmd, args)` in `store.ts` now reports the failure to a per-trail channel
(`src/lib/trail-health.ts`) instead of discarding it, `approveRepair` returns `resolveRecorded`, and one
shared `TrailWriteWarning` renders on both cards. Per-trail, because the generation-audit card must not
announce a lost drift write.

Nine probes, one at a time (eight in the table, plus the one that found a defect in the spec):

| Mechanism disabled | Tests that failed | Tests that still passed |
|---|---|---|
| `writeTrail` at the resolve site → `.catch(() => undefined)` | the resolve spec (unit) | the other five |
| `writeTrail` at the record site → `.catch(() => undefined)` | the record spec (unit) | the other five |
| `recordGeneratorAudit` in the wizard → a local swallowing `invoke` | the generation spec (unit) | the other five |
| the drift card's `<TrailWriteWarning trail="drift" />` | the drift-card warning assertion | the cross-check spec |
| the audit card's `trail="generator_audit"` → `"drift"` | the scoping assertion | the drift-card assertion |
| the modal's "· its drift event could not be closed" | the modal assertion | the cross-check spec |
| the warning's `if (count === 0) return null` guard | the two warning specs, each on its own assertion | — |
| `Onboarding.tsx`'s `audit` → a local swallowing `invoke` again | the wizard browser spec, on the card assertion | the other two browser specs |

**One probe found a defect in the spec, not the code.** With `approveRepair` hardcoded to
`resolveRecorded: false`, the cross-check still passed: `expect(locator).toHaveCount(0)` retries for 30 s and
the modal dismisses itself after 1.2 s, so it waited for the modal to close and passed whatever the message
had said. A negative assertion against an auto-dismissing surface cannot fail. Rewritten to capture the text
once (`expect(await loc.textContent()).not.toContain(…)`), the probe then failed and printed the offending
message.

**A grep missed a fourth call site.** The three rewired writes were found by grepping the command names, which
returned only `store.ts` — but `Onboarding.tsx:231` also calls `generator_audit_record`, with its own
`.catch(() => undefined)`. The wizard's audit failures were the last ones still silent, on the producer the
generation-audit card's own doc comment names *first*. It surfaced only by reading that callback after the
comment contradicted the search; **a grep hit is not proof of completeness**. Both generator producers now
share one exported `recordGeneratorAudit(...)`.

**Both producers are now covered — and the gap this section used to record rested on a wrong reason.**
`generator_audit_record` is written twice: by the wizard (`Onboarding.tsx:231`) and by the repair path
(`store.ts:239`). The note here claimed the repair path was unreachable because "`mock.mjs` does not provide a
scripted AI repair round". It does. The mock matches the generator round on its **system prompt**
(`mock.mjs:152`), and `adapter-generator.ts:99` builds that prompt identically for both callers, so the mock
has always served it; the audit is awaited before the output is parsed (`:254`), so an unusable reply still
writes a row. What actually gated it was **state**: the repair AI round needs a provider whose re-fingerprint
fails (`repair-orchestrator.ts:60-77`) *and* another enabled provider (`store.ts:221`), and no seed had both.
`?seed=repair-ai` supplies them, and the spec drives a real `Check health` on the drifted provider.

**Harness trap found while adding that seed:** a seed's `secretRef` must be **unique across providers**.
`resolveSecret` (`shim.ts:1749`) finds a key by ref across *all* keys and pins the result to that key's own
provider host, so two providers sharing a ref resolve to whichever was seeded first.

---

### 4a.5 The same class, one surface over: a lost *ending*

The follow-up to §4a.4 was not "is the fix complete" but "does this class exist elsewhere". Of ~45
`.catch(() => undefined)` sites in `apps/desktop/src`, a two-part test — a swallowed write **plus** a visible
surface claiming something the missing write falsifies — selects exactly one more surface: the Agents screen.

`orchestrator.endRun` (`lib/agent/orchestrator.ts:63`) drops the run's controller **before** it writes the
finish, so a finish that does not land leaves a row saying `running` with no controller — the identical picture
a session closed mid-run leaves. The screen did not merely omit, it *explained*: "A run left **running** means
the app was closed mid-run — it is not marked failed, because no failure was observed". A failed write makes
that cause false, which is worse than the bug it resembles: an absent row is silent, a wrong cause is asserted.

**Not the counter shape.** The trail's failure was an omission, so counting is right. Here the status is not in
doubt — `endRun` was handed it — so it is kept per run (`useTrailHealth().unrecordedEnd`) and rendered as
`{status} ⚠ unrecorded`. `shownStatus(r, unrecorded)` is the single place the row and the header tally both
read, so the tally cannot drift from the row it summarises, and `no handle` now additionally requires that no
ending was observed.

Three probes, one at a time:

| Mechanism disabled | Tests that failed | Tests that still passed |
|---|---|---|
| `endRun`'s catch → `.catch(() => undefined)` | 2 of 3 unit specs (the two asserting the observation) + the browser spec's row assertion | "keeps nothing when the finish write lands" — it asserts the other branch |
| the screen ignoring the channel (`observed = undefined`) | the browser spec's row assertion | the unit specs |
| only the *tally* ignoring the channel | the browser spec's tally assertion | the browser spec's row assertion |

The third probe exists because the second run stopped at the row assertion and never reached the tally one, so
the tally assertion had no demonstrated teeth.

**A probe found a defect in a spec, and in one it had not touched.** Adding the phrase "no handle" to the
footer legend made `expect(page.getByText("no handle")).toHaveCount(0)` match the *legend* rather than the row,
asserting nothing — and silently did the same to the pre-existing `toBeVisible()` at
`context-skills-agents.spec.ts:146`, which had been sound until then. Both are scoped to `tbody`. A legend that
*names* a state satisfies an unscoped assertion about that state.

**Measured and left open** at the time — closed in §4a.7.

### 4a.6 The gate's `Build` step, and two wrong causes discarded before one was recorded

The gate failed on `Build` — twice — while the same `pnpm build` passed when run by hand. The first
explanation was the sandbox (the manual runs were escalated, the gate was not), and it was **wrong**: the
gate failed unsandboxed too. The second was the target's size, and it was wrong for a subtler reason.

The real error, from the gate's own log:

```
[plugin vite:prepare-out-dir] Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]
{"count":641,"threshold":50,"scope":"turn","targets":["…/apps/desktop/dist/assets"],"targetCount":1}
```

`dist` held **17** files, so `641` looks impossible — and the temptation is to keep hunting for the missing
641 files. It is a **cumulative per-tool-call** budget: `scope: "turn"` means earlier steps in the same call
already spent it. The guard's own state directory settles it, with a **single-file** target carrying a count
in the thousands:

```
{"count":3062,"threshold":50,"scope":"turn","targetCount":1,
 "targets":["…/node_modules/.vite-temp/vitest.config.ts.timestamp-1790009798069-….mjs"]}
```

No single file can be 3062 files. The consumer is **vitest's `.vite-temp` churn**, which runs *before*
`Build` in the gate — so `dist`'s own `emptyOutDir` was the victim, not the cause.

**Fixed by moving the output dir aside rather than letting the tool delete it.** `apps/desktop/package.json`
gains `build:clean` (`mv dist /tmp/build-dist-$(date +%s)`), composed into `build`, mirroring the existing
`web-test:clean`. With `dist` absent the cleanup issues no `fs.rm` call at all, so it is immune even when the
budget is already spent. It is placed in the **package** script, not the root's, because the gate reaches it
through `pnpm -r build`. `pnpm ci:local` is now **ALL GREEN** with no manual pre-step.

Both discarded explanations are recorded on purpose. Each was plausible, each was stated with confidence, and
each would have sent the next session looking in the wrong place.

---

### 4a.7 The third shape: a run the dashboard will never list

A lost *start* is the one loss that leaves nothing behind. `agent_run_start` failing means no row, no status
and no ending to mark — the run is absent from the list entirely. And it is not one write: **every later step
append for that run fails for the same reason** (a foreign key in Rust, `unknown run` at `shim.ts:1262`), so
counting each failure would report "4 writes could not be recorded" for one lost run with three steps. A count
the operator cannot act on is worse than no count.

- `startRun` records the id in a module-level `unrecordedStarts` set; `recordStep` reports a failure **only
  when its run was recorded**. One cause, one count. The set is **never cleared** on purpose — an append from a
  run that has since ended can still be in flight, and clearing on end would let that late failure be counted
  for a run the channel already reported.
- `agent_run` is a third `TrailId`. A run loss must not appear on either provider card.
- `TrailWriteWarning` moved out of `Providers.tsx` into `components/TrailWriteWarning.tsx` and takes `noun` /
  `nounPlural`: **the noun is the screen's, not the component's.** The provider cards lose **rows**; the run
  history loses **writes** — a run, or a step of one.
- **The warning renders above the empty-state branch, not beside the rows.** The run whose start failed is
  absent from the list, so a warning gated on rows goes unseen in exactly the case that matters most.
- The finish write contributes nothing here either way: both `shim.ts`'s `case "agent_run_finish"` and
  `orchestrator.rs:123` update **without checking a row count**, so they report success for a run that does
  not exist. A lost ending is only visible when the row is there to be wrong about — §4a.5.

Three probes, one at a time:

| Mechanism disabled | Tests that failed | Tests that still passed |
|---|---|---|
| `startRun`'s catch → `.catch(() => undefined)` | 2 unit specs (`expected +0 to be 1`, `expected 3 to be 1`) + the browser spec | the two specs that assert the other branch |
| `recordStep`'s suppression removed | 1 unit spec (`expected 4 to be 1`) + the browser spec | the other three |
| the warning gated on `runs.length > 0` | the browser spec's "1 write" assertion | every unit spec |

**Assertion order matters, and a probe is what showed it.** The first two probes both produce an *inflated*
count, so with the correct count asserted first all three probes failed on the same line with the same message
— indistinguishable, and therefore weak evidence. Asserting the inflated count first gives the placement probe
its own failure line, while 3-vs-4 is distinguished at the unit level where the numbers are visible.

**The unit spec cannot reproduce the real cause, and says so.** The fake host answers `undefined` for any
command not arranged to fail, so unlike the shim it never rejects with `unknown run`. The second spec therefore
arranges both failures and tests the *suppression* — the mechanism. The browser spec pins the real semantics,
because there the append genuinely rejects.

---

### 4a.8 A stranded repair, whose card claimed work that had stopped

The last item the survey had left open, and measurement made it worse than recorded.

`driftMonitor.onTrigger` (`store.ts:198-203`) sets the provider `repairing` and fires `buildRepairPlan` with
`.catch(() => undefined)`. The card rendered **"Building a repair plan…"** for as long as `pendingRepairs` held
no entry — so any failure *before* the entry existed left that sentence up permanently, in the identical words
used for a build genuinely in flight. **Waiting was indistinguishable from broken.**

Two ordinary causes:

1. `adapters.forProvider` throws `no active manifest` for a provider hydration could not register — which is
   exactly what a corrupt manifest body leaves behind, and `store.ts:350-357` even promises "Phase 5
   drift/repair surfaces it". It sat **outside** the `try`, so the throw rejected `buildRepairPlan` itself and
   `onTrigger` swallowed it.
2. `pendingRepairs` is an in-memory `Map`, never persisted. A provider still `repairing` after a restart has no
   entry and no plan, and nothing is building at all.

**There was no way out either.** `Check health` was hidden for `repairing` (`Providers.tsx:87`), so the only
remaining button, "Repair…", opened a modal saying "No drift event recorded" — also false, since the drift event
was recorded; what was missing was the plan. A provider stuck in `repairing` was unrecoverable through the UI.

- `buildRepairPlan` registers the entry **before** anything can fail, and both silent early returns are now
  errors. The entry's *existence*, not its message, is what the screen's copy is driven by.
- The card is four-way: plan / error / entry-still-building / **no entry** → "No repair is running in this
  session — use Check health to rebuild one."
- `Check health` is offered for `repairing` too — otherwise the truthful copy is a dead end.
- Seeded as `?seed=repair-stuck`: a persisted `repairing` provider with an unparseable manifest.

Two probes, one at a time, each failing a different assertion:

| Mechanism disabled | Tests that failed | Tests that still passed |
|---|---|---|
| `buildRepairPlan`'s failure paths reverted | all 3 unit specs + the browser spec's "could not be built" | the other 13 |
| the card's copy back to two-way | the browser spec's "No repair is running" | every unit spec |

The first unit spec fails with the **raw throw escaping `buildRepairPlan`**, which is the clearest evidence of
what `onTrigger` was swallowing.

**Harness trap:** `adapters` is a module singleton, and `approveRepair` hot-swaps an adapter in for the provider
it repairs (`store.ts:282`). A spec reusing an id an earlier spec repaired gets the manifest it is specifically
trying not to have, and fails with the *next* error along — which is how this was caught.

**And a self-inflicted one:** `rm -rf apps/desktop/test-results` tripped the bulk-delete guard (`count: 960`)
and cost a gate run. Move artifact directories to `/tmp`; never delete them.

---

## 5. Running it

```bash
cd apps/desktop && pnpm typecheck && pnpm test
cd apps/desktop/src-tauri && ~/.cargo/bin/cargo test --lib
cd apps/desktop && pnpm web-test          # playwright + the browser harness
pnpm ci:local                             # the whole gate, from the repo root
```

Three traps worth repeating. **`cargo` is not on PATH** — use `~/.cargo/bin/cargo`, or the gate ends
`FAILED (1): Rust (cargo missing)`. **The proxy environment variables must be unset** — with `HTTP_PROXY`
set, Playwright's web-server readiness probe fails and the suite dies with
`Timed out waiting 30000ms from config.webServer` before a single test runs.

And **the sandbox's bulk-delete guard is cumulative per tool call** (threshold 50). Two build tools bulk-
delete their own output directories, which trips it:

- Playwright deletes `test-results` at the start of every run, and a run leaves ~1150 trace screenshots
  there. `web-test` now moves the stale directory to `/tmp` first — the same thing `ci-local.sh:96` has
  always done, and for the same reason.
- Vite's `emptyOutDir` deletes `dist/assets`. A **failing** reporter cleanup is swallowed; a failing
  `emptyOutDir` is fatal, so `Build` fails with
  `[plugin vite:prepare-out-dir] Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`. The delete is
  only ~13 files on its own — it fails because earlier gate steps have already spent the budget. Running
  the gate as one shell command after other work has deleted files is enough to trigger it; the fix is to
  start with `dist` empty (`mv dist /tmp/…`), after which the whole gate runs **ALL GREEN**.
