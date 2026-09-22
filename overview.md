# Overview — a swallowed write, three shapes (2026-09-21, evening)

## What was done

Two follow-on sessions on one question: **a read cannot detect a write that never happened.** Three recorded
trails had readers claiming completeness while every write behind them was issued with
`.catch(() => undefined)`, so a dropped row was simply invisible.

The first session asked the **class** question rather than the completeness question — *does a swallowed failure
invisible to whatever claims to report it exist anywhere else?* Of ~45 swallow sites in `apps/desktop/src`, a
two-part test (**a swallowed write** *plus* **a visible surface claiming something the missing write
falsifies**) selects exactly one more surface: the Agents dashboard. The second session closed the other half of
that same surface.

Three surfaces met the test: **the trail**, **the Agents dashboard**, and **the provider repair card**. Four
losses turned out to need four different shapes:

| Loss | What is left behind | Shape |
|---|---|---|
| a lost **row** | nothing | counted, per trail |
| a lost **ending** | a row that says `running` | the observed status, kept per run — never a count |
| a lost **start** | nothing, *and* every step append fails for the same cause | counted **once** for the run, not once per write |
| a stranded **state** | a card claiming work in progress | register the failure **before** anything can fail |

## Shape 1 — the trail

`drift_event_record`, `drift_event_resolve` and `generator_audit_record` were written from **four** call sites,
all four swallowing. A grep for the command names returned only `store.ts` and missed the wizard's own copy at
`Onboarding.tsx:231` — **a grep hit is not proof of completeness**. Both generator producers now share one
exported `recordGeneratorAudit`.

`writeTrail` reports to a channel scoped **per trail**, because a single global counter would make both cards
wrong. The swallow stays: the work happened, only the record did not.

## Shape 2 — a lost ending, which is a lie rather than an omission

`orchestrator.endRun` drops the controller **before** it writes the finish. A finish that does not land leaves a
row saying `running` with no controller — the identical picture a session closed mid-run leaves.

The screen did not merely omit. It *explained*: *"A run left **running** means the app was closed mid-run — it
is not marked failed, because no failure was observed."* A transient database error makes that cause false.
**An absent row is silent; a wrong cause is asserted**, in bold, with a reason attached.

The status was never in doubt — `endRun` was handed it — so it is kept per run (`unrecordedEnd`) and rendered
`{status} ⚠ unrecorded`. `shownStatus(r, unrecorded)` is the single place the row and the header tally both
read, so the tally cannot drift from the row it summarises.

## Shape 3 — a run the dashboard will never list

`agent_run_start` failing leaves nothing at all, and every later step append for that run fails **for the same
cause** (a foreign key in Rust, `unknown run` at `shim.ts:1262`). Counting each would report *"4 writes could
not be recorded"* for one lost run with three steps, and a two-run outage as eight separate faults. A count the
operator cannot act on is worse than no count.

- `startRun` records the id in a module-level `unrecordedStarts` set; `recordStep` reports **only when its run
  was recorded**. The set is **never cleared** — an append from a run that has since ended can still be in
  flight, and clearing on end would let a late failure be counted for a run already reported.
- `agent_run` is a third `TrailId`: a run loss must not appear on either provider card.
- `TrailWriteWarning` moved out of `Providers.tsx` into `components/TrailWriteWarning.tsx` and takes `noun` /
  `nounPlural`, because **the noun is the screen's, not the component's** — the provider cards lose **rows**,
  the run history loses **writes**, and a hardcoded "row" would have made the Agents warning say something false
  about which thing went missing.
- **The warning renders above the empty-state branch, not beside the rows.** The run whose start failed is
  absent from the list, so a warning gated on rows goes unseen in exactly the case that matters most.
- The finish write contributes nothing here either way: both `shim.ts`'s `case "agent_run_finish"` and
  `orchestrator.rs:123` update **without checking a row count**, so they report success for a run that does not
  exist. A lost ending is only visible when the row is there to be wrong about.

## Shape 4 — a stranded repair, whose card claimed work that had stopped

`driftMonitor.onTrigger` (`store.ts:198-203`) sets the provider `repairing` and fires `buildRepairPlan` with
`.catch(() => undefined)`. The card rendered **"Building a repair plan…"** for as long as `pendingRepairs` held
no entry — so a failure *before* the entry existed left that sentence up permanently, in the identical words used
for a build genuinely in flight. **Waiting was indistinguishable from broken.**

Two ordinary causes. `adapters.forProvider` throws `no active manifest` for a provider hydration could not
register — exactly what a corrupt manifest body leaves behind, and `store.ts:350-357` even promises *"Phase 5
drift/repair surfaces it"*. It sat **outside** the `try`, so the throw rejected `buildRepairPlan` itself. And
`pendingRepairs` is an in-memory `Map`, never persisted: a provider still `repairing` after a restart has no
entry and no plan, and nothing is building at all.

**There was no way out either.** `Check health` was hidden for `repairing`, so the only button left, "Repair…",
opened a modal saying *"No drift event recorded"* — also false, since the event *was* recorded; the plan was
what was missing. A provider stuck in `repairing` was unrecoverable through the UI.

- `buildRepairPlan` registers the entry **before** anything can fail. The entry's *existence*, not its message,
  is what the screen's copy is driven by.
- The card is four-way: plan / error / still-building / **no entry** → "No repair is running in this session".
- `Check health` is offered for `repairing` too — otherwise telling the truth is a dead end.

## Files

| File | Change |
|---|---|
| `src/lib/trail-health.ts` | the per-trail channel; `unrecordedEnd`; the `agent_run` trail |
| `src/lib/agent/orchestrator.ts` | `endRun` keeps the observed ending; `startRun` / `recordStep` report one run, once |
| `src/components/TrailWriteWarning.tsx` | new — extracted from `Providers.tsx`, takes the noun |
| `src/screens/Agents.tsx` | `shownStatus`, the `⚠ unrecorded` row, the run-trail warning above the empty state |
| `src/screens/Providers.tsx` | imports the shared warning; both cards still say "rows" |
| `src/store.ts` | `writeTrail`, `recordGeneratorAudit`, `resolveRecorded` |
| `src/screens/Onboarding.tsx` | the wizard's audit → the shared `recordGeneratorAudit` |
| `src/store.trail-writes.test.ts` | 13 specs (6 trail writes + 3 endings + 4 run omissions) |
| `web-test/trail-health.spec.ts` | 4 specs — both cards, both generator producers |
| `web-test/agent-turn.spec.ts` | +2 specs — a real loop with `failNext("agent_run_finish")` / `("agent_run_start")` |
| `web-test/seeds.ts` | `?seed=repair-ai`: an unknown dialect plus a second enabled provider |
| `web-test/context-skills-agents.spec.ts` | a `no handle` assertion scoped to `tbody` |
| `apps/desktop/package.json` | `build:clean`, composed into `build` |

## Verification — `pnpm ci:local` **ALL GREEN**, all nine steps *(the gate stood at nine then; it has grown since — see [docs/dev-book/05-workflow.md](docs/dev-book/05-workflow.md))*

| Layer | Result |
|---|---|
| Desktop vitest | **193 passed** (183 → 186 → 190 → 193) |
| Browser (playwright) | **98 passed** (95 → 96 → 97 → 98) over **87 declarations** |
| router-core · adapter-spec | 231 · 18 — unchanged |
| Rust `cargo test --lib` | **433** — unchanged; no Rust was touched |
| `tsc` · `web-test:types` | clean |

The declaration arithmetic closes, which is how it is checked: 87 − 1 (the smoke loop) + 12 (the screen sweep)
= **98**.

**Eight falsification probes, one at a time.** Each failed exactly the assertions that name its mechanism and
left the others passing. Two rows exist below for shape 2 because the first screen probe stopped at the row
assertion and never reached the tally one — so the tally assertion had no demonstrated teeth until its own probe.

| Mechanism disabled | Failed | Still passed |
|---|---|---|
| `endRun`'s catch → `.catch(() => undefined)` | 2 of 3 unit specs + the browser row assertion | *"keeps nothing when the finish write lands"* |
| the screen ignoring the channel | the browser row assertion | the unit specs |
| only the **tally** ignoring the channel | the browser tally assertion | the browser row assertion |
| `startRun`'s catch → `.catch(() => undefined)` | 2 unit specs (`+0 to be 1`, `3 to be 1`) + the browser spec | the two specs asserting the other branch |
| `recordStep`'s suppression removed | 1 unit spec (`4 to be 1`) + the browser spec | the other three |
| the warning gated on `runs.length > 0` | the browser "1 write" assertion | every unit spec |
| `buildRepairPlan`'s failure paths reverted | all 3 unit specs + the browser "could not be built" | the other 13 |
| the repair card's copy back to two-way | the browser "No repair is running" | every unit spec |

## Three findings worth carrying forward

**Assertion order is a property of the evidence, not of style.** The two shape-3 code probes both produce an
*inflated* count, so with the correct count asserted first all three failed on the same line with the same
message — indistinguishable, and therefore weak evidence. Asserting the **inflated** count first gives the
placement probe its own failure line, while 3-vs-4 is distinguished at the unit level where the numbers are
visible.

**A probe found a defect in a spec, and in one it had not touched.** Adding the phrase "no handle" to the footer
*legend* made `expect(page.getByText("no handle")).toHaveCount(0)` match the legend rather than the row —
asserting nothing. The same copy change silently did the same to the pre-existing `toBeVisible()` at
`context-skills-agents.spec.ts:146`, which had been sound until then. **A legend that names a state satisfies an
unscoped assertion about that state.**

**The gate's `Build` step failed, and two explanations were discarded before one was recorded.** The sandbox
hypothesis was falsified (the gate failed unsandboxed too). The size hypothesis was falsified for a subtler
reason: the guard's `count` of **641** is a *cumulative per-tool-call* budget, not the target's file count, and
`dist` held **17** files. Decisive evidence: a **single-file** target carrying `count: 3062`. The real consumer
is **vitest's `.vite-temp` churn**, which runs before `Build`, so `dist`'s `emptyOutDir` was the victim. Fixed
at the source with `build:clean`, mirroring the project's existing `web-test:clean`.

## Open, measured

- **The class sweep is closed.** The two-part test selected three surfaces — the trail, the Agents dashboard and
  the repair card — and all three are fixed and covered. A further sweep would be a new survey, not a
  continuation.
- **Committed, not pushed.** Five commits on `main`, ahead of `origin/main` by 5:

  | Commit | Theme |
  |---|---|
  | `b8f169d` | Rust: gateway recording, memory scope, three trail readers |
  | `8865a2b` | memory capture + gateway policy + the merging settings write |
  | `8091721` | the Control switchboard; Gateway becomes credentials only |
  | `0ee6656` | the trail readers' cards and the trail-health channel (all four shapes) |
  | `0a9edab` | docs, diagrams and project memory |

  `store.ts` was split at **hunk** level, not by file: it carried 7 trail-health hunks and
  2 memory/gateway hunks, one of them 250 lines, so a file-level split would have dumped the
  gateway-memory work into a trail commit. All other files went whole.
- **`MEMORY.md` is under its ceiling**: **7,961 bytes / 38 rules**, 39 bytes of headroom. The shapes were folded
  into the existing rule rather than added as new ones — the file grows only by trade now.
- The `sandbox-bulk-delete-guard` skill was refined with the three things this session earned: the single-file
  proof, the named vitest consumer, and the pnpm-workspace placement rule.
