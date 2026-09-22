# The audit trail gets a reader (2026-09-21)

`gateway.log` has been appended to on every gateway tool call since 2026-09-20, and nothing could read
it back. The Control → Tools card said so itself — *"Recorded today; a reader lands with §6 must-have
9"* — which is the worst version of the gap: the UI advertised it, so the trail was **evidence nobody
could consult**. §6 must-have 9 is now landed.

The same was true of `generator_audit`: every adapter the assistant ever wrote had been recorded since
the onboarding wizard existed, with no reader. **Both halves of §6 must-have 9 are now landed** — two
trails, two stores, two screens.

---

## What landed

**Host** (`src-tauri/src/gateway_cmds.rs`)

| Piece | What it does |
|---|---|
| `GatewayLogLine` | `tsMs: Option<u64>`, `text` — camelCase on the wire |
| `parse_log_tail(text, limit, truncated_head)` | Pure, so it is testable without an `AppHandle` |
| `gateway_log_tail(app, limit)` | Seeks to the last 128 KB, `from_utf8_lossy`, absent file → `Ok(vec![])` |
| six unit tests | `log_tail_tests` |

**Frontend** — `store.ts` gained `GatewayLogLine` + `gatewayLogTail(limit?)`; `Control.tsx`'s ToolsTab
gained the card (a `Read the log` / `Refresh` button, the line list, an empty state and an error state);
`web-test/audit-log.spec.ts` is new, five specs; `web-test/shim.ts` gained the `logLines` state, its
setter and the command case.

**The second trail — `generator_audit`, read on Providers** (`src-tauri/src/persist.rs`)

| Piece | What it does |
|---|---|
| `GeneratorAuditEntry` | `id`, `tsMs`, `modelUsed`, `promptTokens`, `completionTokens`, `redactionHash` — camelCase on the wire |
| `list_generator_audit(store, limit)` | `ORDER BY ts DESC, id DESC`; the tie-break matters because two rows can share a millisecond |
| `generator_audit_list(store, limit)` | Thin command, `State<Arc<Store>>`; the read path is the testable function |
| six unit tests | `generator_audit_tests`, with a `record_at` helper that inserts an **explicit** timestamp |

`store.ts` gained `GeneratorAuditEntry` + `generatorAuditList(limit?)`; Providers gained
`GenerationAuditCard`; `web-test/generation-audit.spec.ts` is new, six specs.

**Why Providers and not Control → Tools.** Both of its producers are adapter work — the wizard's
candidate generation and drift repair — and repair already lives on this screen. The rows also carry no
provider id (the INSERT omits `session_id`, so it is NULL on every row), so a per-provider panel would
have to invent an attribution the host never recorded. It is a page-level card, and it renders whether or
not any provider exists: hiding a record because the thing it describes was deleted is the failure this
trail exists to prevent.

**Two honesty caveats live in the UI, not only in the code.** The token counts are `chars / 4` estimates
rather than tokenizer counts, so both numeric headers carry `≈` *and* the copy says "estimates" — two
marks for one rule, either of which alone would leave the claim unqualified. And the redaction hash is
shown truncated to twelve characters, because it is a summary rather than a tool for verifying the digest.

Unlike Control's log card, this one reads on **mount**, and again on `tick`. Control is built as layer-1
summary plus layer-2 detail, so a card there can be layer 2 and wait for a disclosure; Providers is flat,
so a card here is layer 1 by construction. The `tick` re-read exists because this is the screen where a
row is *created* — approving a repair writes one and bumps the tick, and a mount-only read would leave the
operator looking at a trail that does not contain the generation they just approved.

---

## Three decisions inside the parser, worth keeping

1. **The head fragment is dropped only when the read was truncated.** A tail read starts mid-line and
   half a line reads as corrupt. Dropping it unconditionally would silently eat the oldest line of every
   log short enough to fit the window — which is the bug the `truncated_head` flag exists to prevent.
2. **The floor of one lives in the parser; the ceiling of 1000 in the command.** Each bound is enforced
   where it is tested, and the command cannot be unit-tested without an `AppHandle`. The floor was
   **found by the test failing**, not by review: the first draft returned zero lines for `limit: 0`.
3. **A failed read clears the lines rather than leaving them on screen.** A stale tail rendered under a
   failure notice is a claim about *now* — §4.3's rule for a metric that has not loaded applies to a list
   too. That also made the empty branch's `logError === null` guard redundant: the two states are
   mutually exclusive by construction.

The card reads the log **when the disclosure is opened**, not with the rest of the tab — every other value
on this screen is a scalar the poll refreshes cheaply. A `logTried` flag, separate from `log !== null`,
stops a *failed* read from re-triggering the effect that started it.

---

## A pre-existing flake, found on the way and fixed at its source

`cargo test --lib` failed once with `injected=0;reason=deadline` in a `context_scope` test, passed in
isolation, then failed in a **different** test. The cause is `MEMORY_DEADLINE = 15 ms` — a wall-clock
budget that parallel test load can exceed, so the failure reads as a policy bug and is not one, and
because it is load-dependent it moved from test to test.

About 25 tests call `inject_context` as scaffolding for properties about recall, scope and policy; none
of them assert anything about 15 ms. Patching one call site only moved the noise, so the constant is
widened under `cfg(test)`. The deadline itself is still tested for real:
`a_deadline_that_is_already_gone_misses_and_stays_missed` drives `Deadline::new(Duration::ZERO)` and the
§5.6 tests pass explicit budgets to `inject_context_deadline` — which is what that parameter exists for.

---

## The harness gained a failure injector

`__webTest.failNext(cmd, message)` makes any command reject once. Until now a UI `catch` branch was
unreachable from a spec — every shim case either answered or threw only because the command was unknown —
so "the read failed" and "the read answered with nothing" rendered identically. That is precisely the
distinction this card exists to make, so the card could not be verified without it. One-shot and cleared
on use, so a spec arranges the exact call it means to fail; it is checked before `dispatch()` so it also
covers an unknown command, and it skips `persist()` the way the host does.

It now also takes an optional `afterMs` — see below.

---

## The supersession test was decoration, and stayed decoration through one fix

The `GenerationAuditCard` reads on mount *and* on `tick`. StrictMode fires mount effects twice
(`main.tsx:7`, and the harness runs vite **dev**), so two reads are in flight on the first render. An
older read that rejects after a newer one has resolved leaves "Could not read the trail" directly above
"Nothing recorded yet" — a pair that cannot both be true. The generation counter in `load` is what
prevents it.

The regression test for that counter **passed with the counter deleted.** Twice.

**First version** arranged an immediate failure via `failNext`. Measured cause: the shim rejects inside a
microtask, so the older read's failure always lands *before* the newer read resolves — the newer read's
`setError(null)` then wipes it, and the assertions hold whichever way the card is written. The probe
(guard removed) failed **0 of 6 tests**. The test was asserting a state the bug could not produce.

**Second version** deferred the rejection by 300 ms, so the superseded read rejects *last* — the ordering
the guard exists for. The probe still failed **0 of 6 tests**, because a deferred rejection lands *after*
the test's assertions have already run and the test has finished. Moving the failure later without moving
the assertion later proves nothing.

**Third version** defers by 200 ms *and* waits 800 ms before asserting. Now the guard is load-bearing:
with it deleted, exactly one test fails — the overlap test, on `Nothing recorded yet` — and the other five
pass. Restored, all six pass.

Two generalisable rules came out of this:

- **An injector that fails "the next call" cannot test supersession on its own.** Which read loses the
  race is a property of the microtask ordering, not of the code under test, so the failure has to be
  *deferred* to choose the ordering rather than inherit it.
- **Asserting that something does not appear requires outliving the moment it would appear.**
  `toHaveCount(0)` and `toBeVisible()` both succeed instantly on the happy path, so a test that arranges a
  *late* fault and asserts *early* is green by construction. The fixed wait is load-bearing here and is
  documented as such in the spec; the failure mode is permanent rather than transient, so there is no race
  to lose.

---

## Verification

| Layer | Result |
|---|---|
| Rust `cargo test --lib` | **426 passed** (420 → 426, the six `generator_audit` tests) |
| Browser (playwright) | **84 passed** (78 → 84) over 73 declarations |
| Desktop vitest | 177 passed |
| router-core vitest | 231 passed |
| `tsc --noEmit --noUnusedLocals --noUnusedParameters` | clean |
| `web-test:types` | clean |
| `pnpm ci:local` | **ALL GREEN** |

Every new spec was falsified by breaking the thing it claims to pin, one probe at a time:

| Mechanism disabled | Specs that failed | Specs that still passed |
|---|---|---|
| the `detail &&` guard on the read | audit-log 1, 2 **and** 4 | 3 — an empty log reads the same either way |
| `setLog(null)` on a failed read | 5, at the `toHaveCount(0)` line | 1–4 |
| the `—` placeholder for an untimed line | 2, at the placeholder assertion | 1, 3, 4, 5 |
| `truncated_head` in `parse_log_tail` | 1 Rust test (after decoupling, see below) | the other five |
| `limit.max(1)` | the zero-limit test — how the bug was found | the other five |

**One probe changed the code.** Removing `truncated_head` failed *three* Rust tests, which exposed that
the untimed-line and long-line tests asserted their line by **index** and the collection's **length**. A
bug in one rule was failing tests named for two others, so a failure named nothing. Both now select their
line by content and assert nothing about the collection's size; with the bug re-applied, exactly one test
fails.

The `generator_audit` half, same method:

| Mechanism disabled | Specs that failed | Specs that still passed |
|---|---|---|
| `reverse()` in the shim's `generator_audit_list` | 1, at the newest-first assertion | 2–6 |
| the `≈` marker on both numeric headers | 2, at the columnheader assertion | 1, 3–6 |
| `setRows(null)` on a failed read | 6, at the row-gone assertion | 5 — it pins *failure ≠ empty*, not *stale rows are dropped* |
| `if (mine !== gen.current) return` in the **catch** | 4 — but only after the spec was rewritten twice; see above | 1–3, 5, 6 |

The third row is the one worth reading twice: probe C failing exactly **one** test is the point. Test 5
asserts the error is shown and that "Nothing recorded yet" is absent; with the stale rows left on screen,
both still hold — so test 5 passes and only test 6, the one named for the rule, fails. Each test names one
rule, and a failure names it.

---

## A reader cannot detect a row that was never written (follow-on, same day)

All three readers were landed before anyone asked the obvious follow-up: what does the card say when the
write it is reading never happened? The answer was nothing — **a read cannot detect a missing row**, it is
simply absent — and all three commands were issued from **four** call sites, every one with
`.catch(() => undefined)`.

That swallow was deliberate and right for what it protected: a repair that applied must not be reported as
failed because its *record* did not land. It was wrong for the other half. Each card claims completeness in
its own copy ("Every adapter the assistant wrote", "Every time a provider was detected drifting"), and a
claim like that is only as good as the writes behind it.

**The sharpest instance is the drift resolution.** `approveRepair` applies the repair, then closes the drift
event. If the close fails, the screen says three contradictory things at once: the modal says "Repaired", the
provider card shows no drift, and the drift history one card below reads **Open** in red — under copy
asserting "nothing has closed it yet". Worse, that is exactly what **declining** a repair looks like:
"Keep current adapter" (`Providers.tsx:422`) never closes the row either. A lost record and a deliberate
choice rendered identically, and the operator had no way to tell which had happened.

**The fix keeps the swallow and keeps the failure.** `writeTrail(trail, cmd, args)` in `store.ts` reports to
a per-trail channel (`src/lib/trail-health.ts`) instead of discarding; `approveRepair` returns
`resolveRecorded` so the modal can say what is in doubt; one shared `TrailWriteWarning` renders on both cards,
scoped per trail — the generation-audit card must not announce a lost drift write. `drift_events`' reader had
landed earlier the same day (`CONTROL_SCREEN_BUILD.md` §4a.3), which is what made the gap visible: the card
had begun claiming completeness, and nothing checked that it could.

**Falsified, one probe at a time.** Unit — restoring the swallow at the resolve site failed the resolve spec;
at the record site, the record spec; putting the wizard back on a local swallowing `invoke` failed the
generation spec. Browser — removing the drift card's warning failed the card assertion; pointing the audit
card at the drift trail failed the scoping assertion; dropping the modal suffix failed the modal assertion;
making the warning unconditional failed the two warning specs, each on its own assertion; and re-swapping the
wizard's `audit` callback failed the wizard spec on its card assertion while the other two browser specs
passed.

**One probe found a defect in the spec rather than the code.** With `approveRepair` hardcoded to
`resolveRecorded: false`, the cross-check still **passed** — because `expect(locator).toHaveCount(0)` retries
for 30 s and the modal dismisses itself after 1.2 s, so the assertion waited for the modal to close and
passed whatever the message had said. A negative assertion against an auto-dismissing surface cannot fail.
Rewritten to capture the text once and assert on the string; the probe then failed with the offending message
printed. The rule is now in REFERENCE.md's browser-harness traps.

**The fix's first pass missed a fourth call site.** `Onboarding.tsx:231` built its own `generator_audit_record`
payload with its own `.catch(() => undefined)`, so the wizard's audit failures stayed silent while the card
went on claiming completeness for them. A grep for the command name returned only `store.ts`; reading the
wizard's `audit` callback — after a doc comment in `Providers.tsx` contradicted the search — is what found it.
Both generator producers now call one exported `recordGeneratorAudit(...)`.

**Both producers are now covered, and the "still uncovered" note was wrong.** It claimed the repair path
needed a scripted repair round that `mock.mjs` does not provide. It provides one: the mock matches the
generator round on its system prompt (`mock.mjs:152`), and `adapter-generator.ts:99` builds that prompt
identically for the wizard and for the repair, so both have always been served — and the audit is awaited
*before* the output is parsed (`:254`), so an unusable reply still writes a row. The real gate was **state**:
the repair AI round needs a provider whose re-fingerprint fails *and* another enabled provider
(`store.ts:221`), and no seed had both. `?seed=repair-ai` supplies them, and a browser spec now drives a real
`Check health` on the drifted provider. Two specs cover the trail's two producers.

---

## The same class, one surface over: a lost *ending* (follow-on, same day)

The trail fix was about an omission — a row that never arrived — so its channel counts. The next surface in
the same class needed the opposite shape, and finding it was the point of asking whether the *class* exists
elsewhere rather than whether the fix was complete.

`orchestrator.endRun` (`lib/agent/orchestrator.ts:63`) drops the run's controller **before** it writes the
finish, and swallows the write — one of ~45 `.catch(() => undefined)` sites in `apps/desktop/src`. A finish
that does not land therefore leaves a row that says `running` with no controller: the identical picture a
session closed mid-run leaves.

The Agents screen did not merely omit. It *explained*: "A run left **running** means the app was closed
mid-run — it is not marked failed, because no failure was observed", with a `no handle` cell saying the same.
A failed finish write makes that cause false — which is worse than the bug it resembles, because an absent row
is silent while a wrong cause is asserted, in bold, with a reason attached.

**The status was never in doubt.** `endRun` was handed it; only the write failed. So the failure is kept per
run — `useTrailHealth().unrecordedEnd: Record<runId, status>` — rather than counted. A count answers a question
nobody asks; the row can still show what actually happened. `shownStatus(r, unrecorded)` is the one place the
row and the header tally both read, so the tally cannot drift from the row it summarises, and the `no handle`
branch additionally requires that no ending was observed.

**Falsified, one probe at a time.** Restoring `endRun`'s swallow failed exactly the two unit specs that assert
the observation — and left *"keeps nothing when the finish write lands"* passing, which is the correct shape,
since that spec asserts the other branch. The browser spec failed on the row assertion. Then, separately:
making the screen ignore the channel failed the row assertion; making only the *tally* ignore it failed the
tally assertion while the row assertion still passed. Two screen probes, because one would have hidden whether
the tally assertion had any teeth — the first run stopped at the earlier assertion and never reached it.

**One probe found a defect in a spec I had just written, and in one I had not touched.** Adding the phrase
"no handle" to the screen's footer legend made `expect(page.getByText("no handle")).toHaveCount(0)` match the
*legend* rather than the row, asserting nothing. The same copy change silently did the same to the
pre-existing `toBeVisible()` at `context-skills-agents.spec.ts:146`, which had been sound until then. Both are
scoped to `tbody` now. The general rule: a legend that *names* a state satisfies an unscoped assertion about
that state.

**Measured and left open** at the time — resolved in the next two sections.

**The survey result.** Of ~45 swallow sites in `apps/desktop/src`, the two-part test — a swallowed write *plus*
a visible surface claiming something the missing write falsifies — selects this surface and the trail. The rest
are read/refresh paths (a stale value is honest), best-effort writes after an action, and streaming transport.
That is the useful outcome: the class is real but narrow, and the two-part test is what separates it from the
deliberate swallows that are correct.

---

## The third shape: a run the dashboard will never list (follow-on, same day)

A lost *start* is the one loss that leaves nothing behind. `agent_run_start` failing means no row, no status
and no ending to mark — the run is absent from the list entirely. And it is not one write: **every later step
append for that run fails for the same reason** (a foreign key in Rust, `unknown run` at `shim.ts:1262`), so
counting each failure would report "4 writes could not be recorded" for one lost run with three steps, and a
two-run outage as eight separate faults. A count the operator cannot act on is worse than no count.

- `startRun` records the id in a module-level `unrecordedStarts` set; `recordStep` reports a failure **only
  when its run was recorded**. One cause, one count.
- The set is deliberately **never cleared**: an append from a run that has since ended can still be in flight,
  and clearing on end would let that late failure be counted for a run the channel already reported.
- `agent_run` is a third `TrailId`, not the `drift` / `generator_audit` counts — a run loss must not appear on
  either provider card.
- `TrailWriteWarning` moved out of `Providers.tsx` to `components/TrailWriteWarning.tsx` and takes `noun` /
  `nounPlural`. **The noun is the screen's, not the component's**: the provider cards lose **rows**, the run
  history loses **writes**, and a component that hardcoded "row" would have made the Agents warning say
  something false about which thing went missing.
- **The warning renders above the empty-state branch, not beside the rows.** The run whose start failed is
  absent from the list, so a warning gated on rows goes unseen in exactly the case that matters most.
- The finish write contributes nothing here either way: both `shim.ts`'s `case "agent_run_finish"` and
  `orchestrator.rs:123` update **without checking a row count**, so they report success for a run that does
  not exist. A lost ending is only visible when the row is there to be wrong about — the second shape.

**Falsified, one probe at a time.** Reverting `startRun`'s catch → 2 unit specs fail ("expected +0 to be 1",
"expected 3 to be 1") plus the browser spec. Removing `recordStep`'s suppression → 1 unit spec fails ("expected
4 to be 1") plus the browser spec. Gating the warning on `runs.length > 0` → the browser spec fails at the "1
write" assertion.

**Assertion order turned out to matter.** The first two probes both produce an inflated count, so with the
correct count asserted first all three probes failed on the same line with the same message — indistinguishable,
and therefore weak evidence. Asserting the **inflated** count first gives the placement probe its own failure
line, while 3-vs-4 is distinguished at the unit level where the numbers are visible.

---

## The fourth shape: a stranded repair, whose card claimed work that had stopped (follow-on, same day)

`driftMonitor.onTrigger` (`store.ts:198-203`) sets the provider `repairing` and fires `buildRepairPlan` with
`.catch(() => undefined)`. The card rendered **"Building a repair plan…"** for as long as `pendingRepairs` held
no entry, so any failure before the entry existed left that sentence up permanently — in the identical words
used for a build genuinely in flight. **Waiting was indistinguishable from broken.**

Two ordinary causes. `adapters.forProvider` throws `no active manifest` for a provider hydration could not
register, which is exactly what a corrupt manifest body leaves behind — `store.ts:350-357` even promises "Phase
5 drift/repair surfaces it". It sat **outside** the `try`, so the throw rejected `buildRepairPlan` itself and
`onTrigger` swallowed it. And `pendingRepairs` is an in-memory `Map`, never persisted: a provider still
`repairing` after a restart has no entry and no plan, and nothing is building at all.

**There was no way out either.** `Check health` was hidden for `repairing` (`Providers.tsx:87`), so the only
remaining button, "Repair…", opened a modal saying "No drift event recorded" — which is *also* false, since the
drift event was recorded; what was missing was the plan. A provider stuck in `repairing` was unrecoverable
through the UI.

- `buildRepairPlan` registers the entry **before** anything can fail, and both silent early returns are now
  errors. The entry's *existence*, not its message, is what the screen's copy is driven by.
- The card is four-way: plan / error / entry-still-building / **no entry** → "No repair is running in this
  session — use Check health to rebuild one."
- `Check health` is offered for `repairing` too — otherwise the truthful copy is a dead end.
- Seeded as `?seed=repair-stuck`: a persisted `repairing` provider with an unparseable manifest.

**Probes.** Reverting the failure paths fails all 3 unit specs (the first with the raw throw escaping
`buildRepairPlan`, which is the clearest evidence of what `onTrigger` was swallowing) and the browser spec at
the "could not be built" assertion. Restoring the old two-way copy fails it at the "No repair is running"
assertion — a different line, so each branch has teeth.

**Harness trap:** `adapters` is a module singleton and `approveRepair` hot-swaps an adapter in for the provider
it repairs (`store.ts:282`). A spec reusing an id an earlier spec repaired gets the manifest it is trying not to
have, and fails with the *next* error along — which is how this was caught.

---

## Still open

- **Nothing in this class remains known-unfixed.** The survey's two-part test selected the trail, the Agents
  dashboard and this card; all three are closed. A further sweep would be a new survey, not a continuation.
- **54 uncommitted files on `main`** (last commit `4b65e5c`) — the verified work in this document is not
  committed.
- **The memory master switch stays session-only by decision** — its non-persistence is what stops traffic
  being recorded because it was enabled once, and the UI says so.
- **The naming question for `Gateway.tsx`** (§7.2.1), now that it is a credentials screen rather than a
  control surface.
- ~~`MEMORY.md` over its injected ceiling~~ — **resolved 2026-09-21, second pass.** Compression alone could not
  do it: the file reached 8,404 bytes and the *newest* rules were the ones being truncated, because the tail
  is what gets cut. So three rules whose full depth already had its own `REFERENCE.md` section were **moved
  out, not reworded** — capture ids (§Capture ids), the `ts` millisecond ordering, and the queue-budget
  planting recipe. With the two rules this session added (the grep-completeness trap and the
  swallowed-write rule), the file is now **7,827 bytes / 38 rules**, leaving ~170 bytes of headroom. The
  trade is fewer auto-injected rules, but every remaining one has no home elsewhere — which beats
  truncating the newest rule.

---

## Files changed

```
apps/desktop/src-tauri/src/gateway_cmds.rs   + GatewayLogLine, parse_log_tail, gateway_log_tail, 6 tests
apps/desktop/src-tauri/src/persist.rs        + GeneratorAuditEntry, list_generator_audit, 6 tests
apps/desktop/src-tauri/src/commands.rs       + registration for both readers
apps/desktop/src-tauri/src/context_scope.rs  MEMORY_DEADLINE widened under cfg(test)
apps/desktop/src/store.ts                    + GatewayLogLine, gatewayLogTail, GeneratorAuditEntry, generatorAuditList
apps/desktop/src/screens/Control.tsx         + the gateway-log card, logStamp, the on-demand read
apps/desktop/src/screens/Providers.tsx       + GenerationAuditCard, the generation counter, the tick re-read
apps/desktop/web-test/shim.ts                + logLines state/setter/case, failNext (+ its deferred variant)
apps/desktop/web-test/audit-log.spec.ts      new — 5 specs
apps/desktop/web-test/generation-audit.spec.ts  new — 6 specs
apps/desktop/src/lib/trail-health.ts         new — the per-trail channel, and `unrecordedEnd` (second shape)
apps/desktop/src/store.trail-writes.test.ts  new — 9 specs (6 trail writes + 3 for a lost ending)
apps/desktop/web-test/trail-health.spec.ts   new — 4 specs (both cards, both generator producers)
apps/desktop/web-test/seeds.ts               + `repair-ai`: an unknown dialect plus a second enabled provider
apps/desktop/src/screens/Onboarding.tsx      audit → the shared recordGeneratorAudit
apps/desktop/src/screens/Providers.tsx       + TrailWriteWarning on both cards, the modal suffix
apps/desktop/src/store.ts                    + writeTrail, recordGeneratorAudit, resolveRecorded
apps/desktop/src/lib/agent/orchestrator.ts   endRun keeps the observed ending instead of discarding it
apps/desktop/src/screens/Agents.tsx          shownStatus, the `⚠ unrecorded` row, the corrected legend
apps/desktop/web-test/agent-turn.spec.ts     + 2 specs: failNext("agent_run_finish"), failNext("agent_run_start")
apps/desktop/web-test/context-skills-agents.spec.ts  "no handle" assertion scoped to tbody
apps/desktop/src/components/TrailWriteWarning.tsx  new — extracted from Providers.tsx, takes the noun
apps/desktop/src/lib/agent/orchestrator.ts   startRun/recordStep report a run the dashboard never lists, once
apps/desktop/src/screens/Agents.tsx          the run-trail warning, above the empty-state branch
apps/desktop/src/screens/Providers.tsx       TrailWriteWarning imported rather than defined locally; the
                                             repair card's four-way copy; Check health for `repairing`
apps/desktop/src/store.ts                    buildRepairPlan registers its entry before it can fail
apps/desktop/web-test/seeds.ts               + `repair-stuck`: a persisted `repairing` provider, bad manifest
apps/desktop/web-test/drift-history.spec.ts  + 1 spec: a stranded repair must not claim it is building
apps/desktop/package.json                    + build:clean (mirrors web-test:clean) — fixes the gate's Build
CONTROL_SCREEN_BUILD.md                      §3 counts, new §4a, ten falsification rows
CONTROL_SWITCHBOARD_DESIGN.md                §2.3 closed for both trails, §6 item 9 landed
.workbuddy-ai/memory/MEMORY.md               consolidated under the ceiling; the ending rule added by trade
.workbuddy-ai/memory/REFERENCE.md            test counts, MEMORY_DEADLINE, Trail health, the deferred injector
```
