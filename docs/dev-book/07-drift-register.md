# 07 — Drift register

## Why this file exists

Documentation drifts behind code, always. The damage is not the drift itself — it is a stale claim that **looks
authoritative**, because a new contributor who finds one false statement stops trusting all of them.

So the rule is not "never drift". The rule is:

> **If you change a fact, update its owner — and if you cannot, log it here.**

A claim that is known to be stale, and written down as stale, costs nothing. The same claim left unmarked is
what makes every other page suspect.

## The change checklist

The practical half of this chapter. Find your change, update every row.

| If you change | Also update |
|---|---|
| A `#[tauri::command]` | `apps/desktop/web-test/shim.ts` **the same day**, and the command count in [03](03-contracts.md) |
| A migration or a table | version + count assertions in `store.rs`, the table list in [04](04-data-model.md) |
| The product version | `pnpm check-version-sync` covers six manifests; add a `CHANGELOG.md` entry |
| The gate (`ci.yml`) | `scripts/ci-local.sh` (the mirror) and the step table in [05](05-workflow.md) |
| An HTTP route | the surface table in [03](03-contracts.md), plus a gateway test |
| An invariant | [03](03-contracts.md) **and** `ARCHITECTURE.md` §5 |
| A screen | the `NAV` constant in `components/Shell.tsx` **and** the screen map in [01](01-orientation.md) |
| A dependency's major version | the toolchain table in [01](01-orientation.md) |
| A design decision | a dated entry in `DECISIONS.md` |
| A chapter, or any link inside one | regenerate the HTML — `pnpm docs:book` fails on a broken reference |
| Any fact stated in two places | delete one of them, or add a row below |

## The register

| ID | Claim | Where | Evidence | Verdict | Status |
|---|---|---|---|---|---|
| **D1** | "Status: greenfield, pre-scaffold" | `ARCHITECTURE.md:8` | The app ships v1.0.0 with 15 migrations, a release workflow and a licence | **False** | **Fixed** |
| **D2** | OS keychain CRUD via `keyring` **v3** | `ARCHITECTURE.md:125`, `:702`, `:871` | `Cargo.toml:33` is `keyring = "2"`; `DECISIONS.md` 2026-09-16 records the v3→v2 downgrade because v3's macOS data-protection keychain breaks unsigned dev builds. Line `:782` already said v2 correctly, so the file contradicted itself | **False** | **Fixed** |
| **D3** | "Per-app gateway keys … are a stated v1 limitation — one master key for now"; "a single master key (no per-app keys) is a stated v1 limitation" | `ARCHITECTURE.md:516-518`, `:812-813` | Per-app keys **ship**: `gateway_app_key_create`, `gateway_app_keys`, `gateway_app_key_revoke`, `gateway_app_key_delete` (`commands.rs:713-716`), the `gateway_keys` table, and `CHANGELOG.md` 1.0.0 | **False** | **Fixed** |
| **D4** | "per-app keys + budgets are the follow-up" | `ARCHITECTURE.md:848-850` | Half true when written. Per-app keys shipped, but the spend cap was **global and monthly** — `gateway_spend_status` compared one `month_micros` against one `cap_micros`, with no per-key dimension | **Half** | **Fixed** — the remaining half closed 2026-09-23 (0017: `gateway_keys.cap_micros` + per-app enforcement). The `ARCHITECTURE.md` line now states both ship |
| **D5** | The local mirror "runs the same steps in the same order as `ci.yml`" | `ci-local.sh:2`, `:10`; `CONTRIBUTING.md:21` | The step **sets** were identical; the **order** differed in one place. Measured by extracting both: `dependency audit` was step 2 in `ci.yml` and step 7 in `ci-local.sh`. Every other shared step was in the same relative order | **False** (ordering only) | **Fixed** — the claim was corrected first, then the script was aligned on 2026-09-22. Both mirrors are now step-for-step identical |
| **D6** | Module map lists 7 screens from the spec era | `ARCHITECTURE.md` §1.2 | The app ships **13** screens (`ScreenId` in `ui-state.ts`; 13 files in `screens/`). Seven post-date the map — and one of those is a **rename**, not an addition: `screen-usage` no longer exists, and `Activity.tsx` is headed "the request ledger first". So the map is missing 6 genuinely new screens and stale on 1. Their subsystems are designed in `GATEWAY_MEMORY_LAYER.md` and `CONTROL_SCREEN_BUILD.md` | **Stale** | **Fixed** — a shipped-screens table was *added* below the spec map rather than replacing it, so both the plan and the difference survive |
| **D7** | "The gateway listens on port 8800" vs "a fresh install starts on 8787" | `README.md:121-122` | Both are correct and describe different things: **8787** is `DEFAULT_PORT` (`gateway.rs:36`), **8800** is this machine's persisted setting because AI Hub v2 also claims 8787. Not drift | **Correct** | **Verified** — recorded so the next person does not re-check it |
| **D8** | "The column exists; the data does not yet" (`cached_tokens`) | `PRODUCT_COMPLETION_PLAN.md:449-454` | The live database **was** at `schema_version = 14` and `ledger.cached_tokens` **was** absent (`pragma_table_info`), because the installed bundle had not been rebuilt since migration 0015 landed | **Inaccurate, now true** | **Fixed** — rebuilt, reinstalled and relaunched 2026-09-22. Measured afterwards: `schema_version = 15`, `ledger` has 17 columns, all **1530** pre-existing rows carry `cached_tokens IS NULL`, and 0 rows report a value |
| **D9** | Six relative references to the diagram assets — `diagrams/architecture.html`, `diagrams/self-construction.html`, `diagrams/gateway.html`, `diagrams/memory-context-gateway-read-path.svg`, `diagrams/memory-context-gateway-write-path.svg`, `diagrams/` | `ARCHITECTURE.md:16-18`, `AUDIT_REPORT.md:4`, `MEMORY_CONTEXT_GATEWAY_INTEGRATION.md:16,17,34,205` | The diagram assets live at the **repository root** in `diagrams/`, not under `docs/`. The 2026-09-22 reorganisation moved 19 docs into `docs/` and verified "17 markdown links across 36 files, 0 broken" — but that check validated `.md` targets only, so **every `.html`, `.svg` and directory link broke silently**. Two of the four in `MEMORY_CONTEXT_GATEWAY_INTEGRATION.md` are image embeds, so they render as broken images | **False** | **Fixed** — all six now use `../diagrams/` |
| **D10** | "closing the window stops the gateway, and the Gateway settings screen says so plainly"; "a reloading, crashed or **closed** window means `503` for every client" | `ARCHITECTURE.md:520-521`, `dev-book/09-status.md:58` | The opposite ships, and has since R1. `RunEvent::WindowEvent` (`lib.rs:262-275`) calls `prevent_close()` then `hide()` whenever `hide_on_close(app)` is true, and `hide_on_close` (`lib.rs:131-148`) reads `settings.background.hideOnClose`, **defaulting to true** — including when the store state is absent. The line it logs is "window hidden — gateway still serving in background". The UI agrees with the code (`screens/Gateway.tsx:193-199` — "closing the window hides the app and the gateway keeps serving"; `:312` — "including with the window closed, once background mode is on"), and `DECISIONS.md:541-556` records the R1 decision that fixed precisely this: "This change fixes the first; the other two need a real headless core (v2)". Both docs therefore describe pre-R1 behaviour, and `ARCHITECTURE.md` is wrong twice over — about the behaviour *and* about what the screen says. **Nothing pinned it:** `hide_on_close` appeared in exactly two places — its definition and its call site — with no test on the default. Closed by extraction: `hide_on_close_from` (`lib.rs`) now holds the decision, and `hide_on_close_defaults_on_and_only_an_explicit_false_turns_it_off` pins all 12 inputs, both arms falsified | **False** | **Fixed** |

| **D11** | "Required secrets (see CONTRIBUTING.md)" | `.github/workflows/release.yml:52` (as written 2026-09-22) | `CONTRIBUTING.md` documented **no** `APPLE_*` secrets at all. A Grep for `APPLE_\|secret\|release\|sign` returned two unrelated hits — `:13` ("Xcode command line tools for `codesign`") and `:68` (a clippy note). The six secrets were documented only in `docs/dev-book/05-workflow.md:166-167`, so a maintainer following the workflow's own pointer found nothing and had no way to provision a release. The gap was compounded by `09-status.md`'s "**No notarized release**" row, which named the *symptom* and implied the pipeline was missing — when the real defect was that it was **unfalsifiable**: `tauri build` succeeds with no secrets and emits an ad-hoc signed app, so the job went green and a draft appeared | **False** | **Fixed** — a "Releasing" section was added to `CONTRIBUTING.md` on 2026-09-23 with the one-time provisioning; `release-preflight.sh` and `verify-release-signature.sh` make the pipeline fail loudly instead of silently emitting an unusable artefact; the gap row was reworded to "Release not provisioned" |

| **D12** | The Phase 1 task prompt's module layout: "`persist.rs` … MOVED" to `core/` and "`egress.rs` … MOVED" to `core/` — as files that can move **unchanged**; and "104 Rust tests + 460 TS unit tests + 27 e2e tests" | `AGENT_PROMPT_HEADLESS_SERVICE.md:99,103,55` | Both placements are impossible as stated. `gateway.rs` calls `crate::persist::{active_gateway_key_ids, gateway_key_cap, month_spend_micros, app_month_spend_micros, spend_cap_micros}` in **non-test** code (`gateway.rs:217,316,907`), so `persist` in `tauri/` makes `core/` depend on the glue; and `persist` in `core/` fails from the other side because `persist.rs` imports `crate::egress::EgressState` and `crate::commands::CommandError`. `{persist, egress, CommandError}` is one cluster — all three moved and `CommandError` was extracted to `core/error.rs`. The test count is **489**, not 104 (measured `cargo test`, 2026-09-23), and the prompt's file list covers **15 of 29** `.rs` files | **False** | **Fixed** — see [10](10-headless-service.md) §2.1.1 |
| **D13** | Every `file:line` citation in the docs that names a module moved by the Phase 1 split — `gateway.rs`, `store.rs`, `persist.rs`, `commands.rs`, `gateway_cmds.rs`, `egress.rs`, `vault.rs`, `tools.rs`, `memory.rs`, `crash_report.rs`, `context_scope.rs`, `lib.rs` | ~230 matches across 23 markdown files (Grep, 2026-09-23) | The split moved 27 of 29 modules into `src/core/` or `src/tauri/`, so a reader following "`gateway.rs:1755`" lands on nothing. **Scoped deliberately rather than swept:** the *live* docs were updated — `09-status.md` (5 references plus a new Phase 1 row), `03-contracts.md`, `02-architecture.md`, `04-data-model.md`, `10-headless-service.md`. The **dated** audit and plan files (`SECURITY_AUDIT_2026-09-20.md`, `ARCHITECTURE_AUDIT.md`, `AUDIT_TRAIL_READER_2026-09-21.md`, the `*_PLAN.md` files and similar) are point-in-time records with the date in the filename, and rewriting their citations would misrepresent what was measured and when. Earlier entries in this register are in that second class: their `lib.rs` and `gateway.rs` citations describe the tree as it was | **Stale** | **Partly fixed** — live docs current, dated snapshots left as history |

### Notes on the entries

**D5 — closed.** The claim was corrected first, deliberately, and the script was aligned in a later pass once
the doc-link step was being added to both mirrors anyway. The audit now runs second in both, so a bad advisory
fails the local gate in seconds rather than after the whole suite has run.

That two-step sequence is the point worth keeping: a false *claim* and a divergent *script* were two separate
defects. Correcting the claim did not fix the script, and recording the residual in the register is what kept
the second one from being forgotten.

**D6 — the module map, closed as an addition.** `ARCHITECTURE.md` is a spec document with a dated provenance,
and §1.2 is a spec-era module map. Rewriting it to match the shipped app would erase the record of what was
planned, so a **shipped-screens table was appended below the map instead** — six new screens plus the one
rename, each with its relation to the original row stated explicitly.

Checking the map against `ScreenId` *before* writing that table corrected this entry's own wording. It had said
Activity was "absent from the map"; Activity in fact **replaced** `screen-usage`, which no longer has a file.
An absence and a rename are different facts, and a register is the wrong place to be approximately right.

**D8 — closed, and the closing taught something.** The prompt-cache measurement exists to accumulate
`cached_tokens` across real traffic. Migration 0015 had added the column; the installed bundle simply had not
been rebuilt since it landed, so the column was absent and the measurement could not record a single row.

Rebuilding was necessary but, on its own, **not sufficient** — which is the part worth keeping. A migration that
adds a column proves nothing about whether anything writes to it. So before calling D8 fixed, the whole producer
chain was traced, not just the schema:

```
manifest-interpreter.ts   reads prompt_tokens_details.cached_tokens (OpenAI) and Anthropic's cache blocks
  → model-router.ts:353   carries the value through as-is, `undefined` included
  → usage-ledger.ts:38    `cachedTokens?: number` — optional, never defaulted
  → store.ts:118          `e.cachedTokens ?? null` — `undefined` becomes SQL NULL, `0` stays `0`
  → persist.rs:440        INSERT … cached_tokens …
  → store.rs:830          ALTER TABLE ledger ADD COLUMN cached_tokens INTEGER (no default)
```

That chain was already complete. The gap was purely that the schema on disk sat one version behind the schema
in the source.

The measured state after the relaunch is exactly what the column was designed to produce: `schema_version = 15`,
`ledger` at 17 columns, **1530 rows preserved and every one of them `NULL`**. All 1530 predate the column, so
`NULL` is the correct value for them — and it is a different statement from "the providers reported zero cached
tokens". The open question is now empirical rather than structural: under real traffic, is `cached_tokens` mostly
`0` or mostly `NULL`? That needs traffic, not another rebuild.

**D10 — the docs understated the product.** This entry is unusual: the code is right, the UI is right, and
`DECISIONS.md` is right — only two prose claims lagged, and they lagged in the direction of making the app sound
*less* capable than it is. `ARCHITECTURE.md` told a reader the gateway dies when they close the window; in fact
background mode is on by default and the gateway keeps serving, which is the entire point of R1.

The failure mode is worth naming: **a doc describing a limitation you have already removed is as harmful as one
describing a feature you never built.** Both send the reader to the wrong conclusion, and this one would have
had a user keeping a window open for no reason.

It surfaced while reading the lifecycle in `lib.rs` to assess the backlog — not by looking for drift. That is
the honest argument for keeping this register beside the code rather than trusting a periodic sweep.

It also settles two things:

- **The "main structural risk" framing survives, narrowed.** The gateway is still bound to the webview's
  *process*: a reloading or crashed renderer is `503`, and quitting the app takes it down. That is the real
  limitation, and it is now stated as such instead of being conflated with closing a window.
- **`hide_on_close` was untested — and my first reason for leaving it that way was wrong.** I wrote that
  pinning it "needs a window-lifecycle harness, not a unit assertion". That is half true, and the wrong half
  was the one I acted on. The end-to-end behaviour (close → hidden → still serving) does need a harness. The
  *default*, which is the part that decides whether the headline feature works, is a pure parse over one
  settings string — and this repository already had a house pattern for exactly that split.

  So the note recorded a limitation that did not exist. Fixed rather than re-recorded: the decision moved into
  `hide_on_close_from(raw: Option<&str>)` and a 12-input table test now pins it. Both arms were falsified
  before being trusted — flipping `None` fails the first case, flipping `unwrap_or` fails on `key absent`.
  Rust suite 472 → **473**, clippy clean.

  The lesson is the register's own: **a reason is a claim too.** "Cannot be tested" deserved the same evidence
  as "is not tested", and it did not get it.

## The control that was added

D9 is the strongest argument in this file for a mechanical check. A claim about links was made, verified, and
still wrong — because the verification only looked at `.md` targets. The same is true of any property asserted
by hand.

**And it recurred the same day.** Adding [08 Flows](08-flows.md) introduced the identical bug — `../diagrams/`
written from a chapter two levels deep resolves to `docs/diagrams/`, which does not exist. Seven references,
caught only by re-running the scan. **Two instances in one day is the argument: a property you check by hand is
a property you will get wrong.**

**Partly built — 2026-09-22.** `scripts/build-dev-book.mjs` now enforces exactly this for the book itself:
it resolves every relative link *and image*, checks every in-page anchor against a real `id`, and fails on a
miss. Run it with `pnpm docs:book`. It is not a general `.md` linter — it validates the *rendered* book, so it
catches a broken reference inside `docs/dev-book/` and nowhere else.

Two further defects surfaced the moment it ran, both invisible to a by-eye check:

- **Colliding SVG ids.** Every diagram in `diagrams/` defines its own `<marker id="arrow">`. Inlining three of
  them into one page makes `marker-end="url(#arrow)"` resolve to whichever definition comes first, so the
  others render with the wrong arrowhead — silently. The generator now namespaces every id, and every
  `url(#…)` / `aria-labelledby` reference to it, per diagram.
- **A duplicate `id="next"`.** Seven chapters end with a `## Next` heading, and an unscoped slug gives all
  seven the same id. Heading ids are now scoped to their chapter, and disambiguated within it.

Neither is documentation drift. Both are the same lesson as D9 in a different medium: a property nobody checks
mechanically is a property that is already wrong.

**Now built — 2026-09-22.** `scripts/check-doc-links.mjs` resolves every relative link *and image* in every
markdown file in the repository, including non-`.md` targets and bare directories, and fails the gate on a
miss. It is wired into both mirrors, so this is the one entry in this file whose fix is mechanical rather than
editorial. Two details are worth keeping:

- **It strips fenced blocks and inline code spans before looking.** The memory logs and
  `PRODUCT_COMPLETION_PLAN.md` *quote* link syntax in order to discuss it, and those quotations are not
  references. A checker that reports them is a checker people learn to ignore.
- **It refuses to report success on an implausible scan** — fewer than 10 files or 20 links and it exits 1
  rather than print a confident zero. This repository has already produced wrong conclusions from searches
  that never reached the directory.

`scripts/build-dev-book.mjs` stays the stricter check for the book: it also validates in-page anchors against
generated ids and refuses duplicate ids, which the repo-wide check cannot see.

## Adding an entry

```
| **D<n>** | the claim, quoted | file:line | what you measured, and with what | False / Half / Stale / Correct | Open / Fixed |
```

Three rules for an entry:

1. **Quote the claim.** A paraphrase cannot be verified later.
2. **Carry the evidence, not the reasoning.** "`Cargo.toml:33` says `keyring = "2"`" is checkable. "The docs
   are out of date" is not.
3. **`Correct` is a valid verdict.** D7 is in the register precisely because it was *checked and found fine* —
   recording that stops the next person spending the same effort.
