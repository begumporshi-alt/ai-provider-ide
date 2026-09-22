# Overview — product completion, decisions executed (2026-09-22)

## What was done

Answered the question *"what is left to make this a professional product?"* by auditing the repo at
`3bb7665` (written up as **`docs/PRODUCT_COMPLETION_PLAN.md`**), then — on the four decisions that
followed — implemented them and shipped.

Thirteen commits on `main` (`754a5fc`..`6327ecc`). CI run `35732995088` **green**, all 17 steps; every
follow-up commit re-ran the same gate green, and the new scheduled audit workflow was verified by
dispatching it (`35736120680`, green) rather than assumed to fire.

The three Node 20 GitHub Actions were moved onto Node 24 runtimes (`checkout@v7`, `setup-node@v7`,
`pnpm/action-setup@v6`), each checked against the new `action.yml` before bumping. Verified empirically:
CI came back **with no annotations block at all** — the deprecation warning is gone.

## The four decisions, and what each produced

| Decision | Outcome |
|---|---|
| **Apache-2.0** | `LICENSE` added; GitHub now reports `apache-2.0` (it was `null` on a public repo) |
| **Delete the updater docs/scripts** | All four v1-era files removed; README states updates are manual |
| **Yes, this goes to other people** | Made the release pipeline and notarization mandatory rather than optional |
| **Build the `cached_tokens` measurement** | Migration 0015 adds a **nullable** `ledger.cached_tokens` |

## What shipped

- **Licence and version.** Apache-2.0, and six manifests that had drifted now agree on `1.0.0` —
  enforced by a new `pnpm check-version-sync` that runs in CI. The root `package.json` and both
  workspace packages had still said `0.0.0` while the app said `1.0.0`.
- **Release pipeline.** `.github/workflows/release.yml` builds a universal (Apple Silicon + Intel)
  macOS bundle on a `v*` tag and attaches it to a **draft** release. Signing and notarization come
  from repository secrets and never from `tauri.conf.json`, because no other job runs a full
  `tauri build` — a pinned identity there would be invisible to every check in the repo.
- **CI parity.** `pnpm build` added to `ci.yml`. The local mirror had always compiled the bundle and
  CI did not, which made CI the *weaker* gate: a change could be green in CI and broken at release.
- **Migration 0015.** `ledger.cached_tokens`, **nullable on purpose**: `NULL` means the provider
  reported no cache block, which is a different finding from reporting zero. Eight tests, and two
  falsification probes, each reverted after confirming the right assertion failed for the right reason.
- **Governance.** `SECURITY.md` (scoped around credential handling, gateway auth, egress, local
  privilege, memory scoping, the tool sandbox), `CONTRIBUTING.md`, `CHANGELOG.md`.
- **Repo metadata.** Description and 10 topics set; `bundle.targets` narrowed from `"all"` to what is
  actually built and tested.

## Follow-up batch — dependency auditing (§3.2), shipped

The plan recommended "add a PR-time audit" without evidence one could pass. Measured first: `pnpm audit`
reported 2 moderate advisories sharing one root cause, so `--audit-level=moderate` failed at that moment and
`--audit-level=high` exited 0. `high` is what shipped first, and it still catches the class that matters.

**Superseded later the same day.** The shared root cause was the `vitest` devDependency, and bumping it
(`^3.2.7` / `^3.1.0` → `^4.1.11`) cleared both advisories with no test changes — all 460 tests passed on 4.1.11
as written. `--audit-level` is now `moderate` in both mirrors. The paragraph above is a dated measurement of
the first version that shipped, not the current setting.

Two things a push-triggered gate structurally *cannot* do, so `.github/workflows/audit.yml` does them:

- **Catch an advisory published against unchanged code.** Nothing changes, so no push happens, so no gate
  fires. Only a clock catches that — hence a weekly run, on `ubuntu-latest` because it reads lockfiles
  rather than compiling.
- **Audit the Rust crates at all**, which nothing did anywhere.

**First run: 0 vulnerabilities across 607 locked dependencies** (advisory DB of 1261 entries). It also
reported 9 informational warnings — 8 unmaintained (`derivative`, `instant`, `proc-macro-error`, five
`unic-*`) and 1 unsound (`glib 0.18.5`, RUSTSEC-2024-0429). Informational warnings do not fail the check,
and that is the right default: `glib` is Tauri's Linux/GTK tree, and a lockfile is target-independent while
this product ships macOS only. No `ignore` list was added — it would also hide a real advisory filed
against the same crate later.

**That the step reported 9 warnings is the proof it read our lockfile.** `rustsec/audit-check` needs
`working-directory: apps/desktop/src-tauri`. Without it the action looks for `./Cargo.lock`, finds nothing,
and reports a clean audit it never ran — a green result from a check that did nothing at all.

**A document asserting a gate that did not exist was found and corrected.** `CONTRIBUTING.md`'s CI table
listed `cargo fmt --check` and `cargo clippy -- -D warnings` as enforced steps. Neither was in `ci.yml`;
both were measured and deliberately withheld at the time. That is the same defect class as the updater docs
that described a mechanism nobody had built — a doc claiming a control stops anyone looking for it. (The
clippy half later became real, hours after this was written: it is now a gate in both mirrors, so
`CONTRIBUTING.md`'s row is accurate on its own terms.)

## Also done: the root docs reorganisation (§5.1)

The root held 25 `.md` files and now holds six — `README`, `CHANGELOG`, `CONTRIBUTING`, `SECURITY`, plus the
two overview artefacts the tooling writes there. The other 19 moved to `docs/`, flat.

**The measurement that mattered.** 54 references to those files live in project memory, cited by bare
filename (`GATEWAY_MEMORY_LAYER.md` ×10, `CONTROL_SCREEN_BUILD.md` ×6), in daily logs that are **append-only
by policy** and so cannot be rewritten to match. That cost is paid with a mapping note in `MEMORY.md`, not
by editing history that should stay as written.

**What made the move safe.** These docs cross-link each other by bare relative path, so moving them only
works if they all land in the same directory — they did. Scanned afterwards rather than assumed: **17
markdown links across 36 files, 0 broken**, and exactly one reference needed editing. Every rename is
`R100`, so each file keeps its full history.

## Deliberately left, with the reason

- **`cargo fmt --check` and `cargo clippy -D warnings`.** Measured before adding, rather than assumed:
  `cargo fmt --check` fails across the existing Rust sources and clippy reports **25 warnings**. A
  gate that fails on the first push is worse than no gate. Adopting rustfmt rewrites most of
  `src-tauri/src/` and destroys `git blame` across the whole host for a change with no behavioural
  content — a deliberate decision, not a free win.
  **Superseded for clippy later the same day.** `cargo clippy --all-targets -- -D warnings` is now a gate in
  both mirrors. `--fix` applied 25 of the warnings mechanically; the two that needed judgement were both
  real `if_same_then_else` dead branches, one of them on a path no test reached. Only rustfmt remains
  withheld.
- **`IDE/`.** Not empty: it holds an empty `.workbuddy-ai/memory/` skeleton from a session that ran
  with the wrong working directory. Left for a human, since this project treats `.workbuddy-ai` as
  data rather than cache. (`ai/` and `provider/` were genuinely empty and went.)
- **The `vitest` bump — landed 2026-09-22, and cheaper than this bullet predicted.** The two moderate
  advisories were a devDependency that never enters the bundle, and the patched line (`>=4.1.11`) is a whole
  major version from latest (`5.0.1`). "A whole major version" was true of the number and wrong about the
  work: **no test changed.** The configs used only long-stable options, so all 460 tests passed on 4.1.11 as
  written, and the audit level rose from `high` to `moderate` as a result. The one real cost was a typecheck
  failure with nothing to do with vitest — see `docs/PRODUCT_COMPLETION_PLAN.md` §3.2.
- **Coverage (§4.2) — landed 2026-09-22.** This was the last untouched plan item. `pnpm test:coverage` now
  runs all three vitest suites under `@vitest/coverage-v8` and prints one weighted figure: **43.8% statements**,
  37.3% branches, 31.1% functions, 45.4% lines. Deliberately a **report, not a gate** — a threshold fails
  unrelated refactors and the cheapest fix is to lower it, after which nobody reads it. The `desktop` row is
  the one to read carefully: 21% there measures what *vitest* covers in that package, not how tested the app
  is, because the screens are the Playwright suite's job.

## The three things worth carrying forward

**`vitest` does not typecheck.** Adding a field to `BridgeMsg::Usage` broke **eight** pattern matches
across four gateway modules, and `cachedTokens` was missing from `LedgerEntry` so `model-router.ts`
failed to typecheck in three places. 249 green router-core tests said nothing about either —
`pnpm typecheck`, `pnpm build` and `cargo clippy` found both.

**`git commit` with no pathspec commits everything staged.** A `git rm` from earlier had staged four
deletions, so the first attempt at the licence commit silently carried them. Caught by reading
`git show --stat` per commit; fixed by resetting and re-committing with explicit paths per batch.

**An absence claim is worthless until you have checked the search reached the directory.** Search tools
skip dot-directories, so three separate scans this session reported "no references" while never looking
inside `.github/` or `.workbuddy-ai/` — the directories that actually held them. One produced a confident
recommendation to move 6 files that turned out to have 14 references, and had to be retracted. For
anything hidden, read the file or `cat <dir>/* | grep`; do not trust a tool-level search to have looked.
