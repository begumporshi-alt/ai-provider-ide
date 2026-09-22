# Product Completion Plan

**Question answered:** what remains to take this from a working prototype to a professional, shippable product.

**Date:** 2026-09-22
**Assessed tree:** `3bb7665` (clean, `main` == `origin/main`, CI green)
**Method:** every claim below carries a `file:line` or the command that produced it. External claims are
checked against the Tauri v2 documentation, not recalled.

---

## 0. The headline

**The engineering is much further along than the packaging.**

The code has four test suites, a real local gate, an audit trail, and a working gateway. What is missing is the
*product wrapper*: a licence, a release pipeline, a changelog, a disclosure policy, and a tidier docs surface.
Two facts make this concrete:

- The repo is **public** (`gh repo view` → `visibility: PUBLIC`) and has **no licence**
  (`licenseInfo: null`; no `LICENSE*` tracked).
- There is **no automated way to produce a release**. `.github/workflows/` contains exactly one file —
  `ci.yml`. `v1.0.0` is a tag with nothing attached to it.

Neither is a code problem. Both are the difference between "a repo" and "a product".

---

## 1. Release-blocking

### 1.1 No licence on a public repo

| Evidence | `gh repo view begumporshi-alt/ai-provider-ide` → `"licenseInfo": null`, `"visibility": "PUBLIC"`; `git ls-files \| grep -i license` → nothing |
|---|---|

A public repository with no licence is legally **all rights reserved**. Nobody may fork it, ship it, or
contribute to it — the default is not permissive, it is restrictive. `README.md:108` states the repo is public,
so this is not a theoretical audience.

**Action:** add `LICENSE`; add a `license` field to the root `package.json` and `Cargo.toml`; set the GitHub
description and topics (both currently empty — `"description": ""`).

> Apache-2.0 is the better default here: it carries an explicit patent grant and a `NOTICE` mechanism, which
> suits a tool that handles credentials. MIT is simpler if you want maximum permissiveness. Either is fine; the
> current state is the only wrong answer.

### 1.2 No release pipeline

| Evidence | `find .github -type f` → `ci.yml` only. No tag trigger, no `tauri-action`, no artifact upload. |
|---|---|

`ci.yml:3-6` triggers on `push: branches: [main]` and `pull_request` — never on tags. So tagging `v1.0.0`
produces a label, not a download. A user cannot install this.

**Action:** add `.github/workflows/release.yml` triggered on `push: tags: ["v*"]`, building with
`tauri-apps/tauri-action`, which uploads bundles and can open the GitHub Release.

### 1.3 CI never builds the bundle

| Evidence | `ci.yml` has no `pnpm build` step. `playwright.config.ts` `webServer[1].command` is `pnpm exec vite --port 1430` — a **dev server**, not a built bundle. `scripts/ci-local.sh:83-85` says it outright: *"ci.yml has no build step at all, so nothing in CI would catch a bundle that no longer compiles"*. |
|---|---|

`ci-local.sh:85` runs `pnpm build`; `ci.yml` does not. **The local mirror is stricter than CI** — which means a
change can be green in CI and broken at release time. That is the exact failure mode a release pipeline is
supposed to prevent, and it is currently undetected.

**Action:** add a `Build` step to `ci.yml` between typecheck and the Rust steps, matching `ci-local.sh` order.

### 1.4 The auto-updater is documented but not implemented — and the docs describe a mechanism that is not there

This is the most serious item, because it is a *documented security mechanism* that does not exist.

What is present: `SIGNING.md`, `UPDATER.md`, `generate-updater-keys.sh`, `release-server.sh`.
What is absent:

| Missing piece | Evidence |
|---|---|
| The plugin crate | `Cargo.toml` has no `tauri-plugin-updater` (`grep -n updater Cargo.toml` → none) |
| The npm package | `apps/desktop/package.json` has no `@tauri-apps/plugin-updater` |
| The config block | `tauri.conf.json` has no `plugins` key at all |
| `bundle.createUpdaterArtifacts` | absent from `tauri.conf.json:24-34` |
| The capability | `capabilities/default.json:6-9` grants only `core:default`, `opener:default` — no `updater:default` |
| The keypair | no `signing-keys/` directory |

And three of the documents are wrong:

1. **`SIGNING.md:35`** — *"The `tauri.conf.json` now includes:"* followed by a top-level `"updater": { … }`
   block. It does not include it, and in **Tauri v2 the block belongs under `plugins.updater`**, with
   `createUpdaterArtifacts` under `bundle` ([v2 updater docs](https://v2.tauri.app/plugin/updater/)). The shape
   in this file is v1-era.
2. **`SIGNING.md:29-30`** — instructs `export TAURI_SIGNING_PUBLIC_KEY=…`. That variable **does not exist**.
   Tauri reads `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Following this doc wastes
   an afternoon.
3. **`generate-updater-keys.sh:9-14`** — generates an **RSA** pair with `openssl genrsa` + `openssl rsa
   -pubout`. Tauri's signer produces a **minisign (ed25519)** keypair via `tauri signer generate`, and the
   verifier accepts that format. **Keys from this script cannot verify an update** — the script is a working
   implementation of the wrong thing.

The endpoint template is also v1-shaped: `SIGNING.md:42` uses `{target}/{arch}/{version}`; v2 uses
`{{target}}/{{arch}}/{{current_version}}`.

**Action — one of two, and pick deliberately:**

- **(a) Implement it properly.** `pnpm tauri add updater`; `tauri signer generate`; put the public key under
  `plugins.updater.pubkey`; set `bundle.createUpdaterArtifacts: true`; add `updater:default` to
  `capabilities/default.json`; host a real endpoint. Delete `generate-updater-keys.sh` and rewrite both docs.
- **(b) Delete the claim.** Remove `SIGNING.md`'s updater section, `UPDATER.md`, `generate-updater-keys.sh`,
  `release-server.sh`, and state in `README.md` that updates are manual.

**My recommendation is (b) now, (a) when you have a distribution audience.** A document that describes update
signing incorrectly is worse than no document: it is the artefact a future contributor trusts.

---

## 2. Versioning and release hygiene

### 2.1 The version is stated in four places and they disagree

| File | Line | Value |
|---|---|---|
| `package.json` (root) | 4 | `0.0.0` |
| `apps/desktop/package.json` | 4 | `1.0.0` |
| `apps/desktop/src-tauri/Cargo.toml` | 3 | `1.0.0` |
| `apps/desktop/src-tauri/tauri.conf.json` | 4 | `1.0.0` |

Git tag: `v1.0.0`.

**`tauri.conf.json` is authoritative for the bundle.** The root `0.0.0` is the visible drift. Action: make one
the source of truth (tauri.conf.json is the natural one) and either sync or generate the rest, so a release
cannot ship a bundle whose version disagrees with its tag.

### 2.2 No CHANGELOG

A `v1.0.0` tag exists; a user-facing changelog does not. Twenty-one root docs describe internal plans, none
describe what changed for a user. Action: add `CHANGELOG.md` (Keep a Changelog shape), seed it from
`git log --oneline`.

### 2.3 `bundle.targets: "all"` over-promises

`tauri.conf.json:26` is `"all"` — dmg, app, msi, nsis, deb, rpm, AppImage. But `README.md:13-15` says *"Windows
and Linux are untested"* and CI is `macos-14` only (`ci.yml:10`). Shipping installers you have never run is a
support burden and an implicit promise.

**Action:** either narrow to `["app", "dmg"]`, or keep `"all"` and say plainly in `README.md` that only the
macOS artefact is supported. The icons already imply cross-platform intent (`icons/` carries `.ico` and the
Windows Store logos) — that intent should be a stated decision, not an accident of the bundler default.

---

## 3. Security and disclosure

### 3.1 No SECURITY.md

The product's core promise is *"API keys are stored in the OS keychain and never written to disk"*
(`README.md:8-9`). There is no channel to report a break of that promise. For a tool whose whole premise is
credential safety, this is the most conspicuous governance gap after the licence.

**Action:** add `SECURITY.md` — private reporting route, scope (gateway auth and the master-key check, keychain
handling, the egress allowlist, the memory layer's scoping), and an explicit out-of-scope list.

### 3.2 No dependency-vulnerability scanning

No `pnpm audit` or `cargo audit` anywhere in CI or `scripts/`. The dependency surface is non-trivial
(`Cargo.toml:20-40` pulls `reqwest`, `rusqlite` with a bundled SQLite, `keyring`, `axum`, `arboard`, …).

**Action:** add a PR-time audit plus a scheduled job.

**Measured 2026-09-22, and the naive version of this gate cannot pass.** `pnpm audit` reports **2 moderate**
advisories with a single root cause — `vitest` (`>=2.1.0 <4.1.11`, GHSA-82fw-gwwq-j7x9, a path traversal in
`@vitest/mocker`). All three packages that declare it are inside that range: `apps/desktop` pins `^3.2.7`,
`router-core` and `adapter-spec` pin `^3.1.0`. So `--audit-level=moderate` fails today, and `--audit-level=high`
**exits 0 today** — that is the version that can be added without breaking CI:

```
pnpm audit --audit-level=high      # exit 0 measured at 33c522f
```

Two things make the Rust half cheap and worth pairing with it: `apps/desktop/src-tauri/Cargo.lock` **is
tracked** (no `.gitignore` rule for it), so a RustSec audit is reproducible rather than resolving fresh each
run. `rustsec/audit-check` avoids the multi-minute `cargo install cargo-audit` compile.

**The vitest bump is its own decision, not part of the gate.** The advisory is a devDependency that never
enters the bundle, and exploiting it requires running a hostile test — which is not this repo's threat model.
The patched line is `>=4.1.11` while latest is `5.0.1`, so fixing it means a **major** test-runner migration
across all three packages and 460 TypeScript tests. Worth doing deliberately, with the full gate, not folded
into a security-gate commit.

**Implemented.** `pnpm audit --audit-level=high` runs in `ci.yml` and in `scripts/ci-local.sh`, and
`.github/workflows/audit.yml` re-runs it weekly on `ubuntu-latest` alongside `rustsec/audit-check`
against the Tauri host. Two details worth recording: the RustSec action needs
`working-directory: apps/desktop/src-tauri` because the lockfile is not at the repo root — without it the
action looks for `./Cargo.lock`, finds nothing, and reports a clean audit it never ran. And on a cron
trigger the action **files an issue** per advisory rather than failing the run, which is why `audit.yml`
requests `issues: write`; on push it fails instead.

That scheduled job is not redundant with the `ci.yml` step. The `ci.yml` step only fires when something
is pushed, so it cannot see an advisory published against code that has not changed — the one case where
nobody is looking.

**First run, 2026-09-22** (run `35736120680`, triggered by `workflow_dispatch`): **0 vulnerabilities** across
607 locked dependencies, against an advisory database of 1261 entries. It also reported **9 informational
warnings** — 8 unmaintained (`derivative`, `instant`, `proc-macro-error`, and five `unic-*` crates) and 1
unsound (`glib 0.18.5`, RUSTSEC-2024-0429, unsound `Iterator`/`DoubleEndedIterator` impls for
`glib::VariantStrIter`).

Informational warnings do not fail the check, and that is the right default here — and the reason was
verified rather than assumed. `glib` is **not in the macOS build at all**:

```
cargo tree --target aarch64-apple-darwin -i glib    # nothing to print
cargo tree --target x86_64-apple-darwin  -i glib    # nothing to print
cargo tree --target x86_64-unknown-linux-gnu -i glib
  glib v0.18.5
  └── gtk v0.18.2 → … → tauri v2.11.5 → ai-provider-router v1.0.0
```

The Linux command is the positive control: it proves the query finds `glib` when `glib` is present, so the
two macOS negatives mean absent rather than mistyped. A lockfile is target-independent, which is why RustSec
reports a crate this product never compiles.
The other eight are transitive proc-macro and Unicode-table crates with no advisory against them, only an
abandonment notice. Worth knowing; not worth a gate, and not worth an `ignore` list that would also hide a
real advisory filed against the same crate later.

The step reporting those warnings is itself the proof that `working-directory` is right. A wrong path finds
no lockfile and reports a clean audit it never ran — the same failure shape as a spec that asserts nothing.

### 3.3 What is already good — and one thing that only *looks* broken

- **CSP** is set (`tauri.conf.json:21`) and is not vacuous.
- **`connect-src` does not list `http://127.0.0.1:*`, but that is correct, not a bug.** I checked: there is no
  `fetch(` in `apps/desktop/src` — the UI reaches the gateway through Tauri IPC, not HTTP. `Gateway.tsx:119`
  builds an `http://127.0.0.1:${port}` string only to *display* it for copying. Only `img-src` needs the
  loopback entry, and it has it.
- **Least privilege is real.** `capabilities/gateway.json:6-9` grants the hidden worker window only
  `core:event:allow-listen` and `allow-unlisten` — no filesystem, no shell, no opener. The comment at
  `gateway.json:4` documents why the capability exists at all.
- **`key-leak-grep` runs in CI** (`ci.yml:28-29`) and `.gitignore:23-27` covers `.env*`, `*.pem`, `*.key`.

### 3.4 A distribution consequence worth stating in the docs

A notarized Developer ID release is a **different signing identity** from a local ad-hoc build. Since keychain
ACLs are bound to the signing identity, a user moving from a local build to a release will hit the one-time
approval prompt that `README.md:106-107` already documents — and until they approve it, every request answers
`503 master key unavailable`. Worth a line in the release notes, because it looks like a bug.

### 3.5 Adjacent, not this repo

`ANTHROPIC_AUTH_TOKEN` sits in `~/.codex/config.toml` under `[shell_environment_policy.set]` (mode `0600`). It
is not this repo's leak, but it is inherited by every shell this project spawns.

---

## 4. Quality gates that do not exist

### 4.1 No linter or formatter anywhere

No `eslint.config.*`, no `.eslintrc*`, no `.prettierrc*`, no `rustfmt.toml`, no `clippy.toml`, no
`.editorconfig` — and `grep -rn '"eslint"\|"prettier"'` across all `package.json` files returns nothing.

That is a deliberate-looking omission, but it should be a **decision**, not an accident. The cheapest high-value
half:

```
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
```

Both are near-free in CI and catch a class of Rust defect the test suite cannot. ESLint on the TS side is a
larger conversation — worth having explicitly.

### 4.2 No coverage measurement

`coverage/` is gitignored (`.gitignore:5`) but nothing produces it. Four suites exist — router-core,
adapter-spec, desktop vitest, and the Playwright harness — with no aggregate number. Coverage is a weak signal,
but *no* number means you cannot answer "did this change make things worse".

### 4.3 No `.env.example` — low priority

Only one env var is read: `GW_LOG` (`lib.rs:157`). The frontend reads no `import.meta.env` at all. Documenting
`GW_LOG` is a nicety, not a gap.

---

## 5. Documentation hygiene

### 5.1 Twenty-five root-level `.md` files, and `docs/` holds two

Root currently mixes permanent docs (`README.md`, `ARCHITECTURE.md`, `DECISIONS.md`, `MASTER_PROMPT.md`) with
dated audit artefacts (`AUDIT_REPORT.md`, `ARCHITECTURE_AUDIT.md`, `AUDIT_TRAIL_READER_2026-09-21.md`,
`CONTROL_*_2026-09-21.md`, `SECURITY_AUDIT_2026-09-20.md`, `TOOL_CALL_DIAGNOSIS_2026-09-20.md`, …) and plan
files (`COUNT_TOKENS_PLAN.md`, `STAGE2_RETRY_AFTER_PLAN.md`, `UI_UX_PLAN.md`).

**Measured 2026-09-22, and it is not as free as "mechanical and reversible" suggests.** The root holds
**25** `.md` files, and **54 references** to them live in `.workbuddy-ai/memory/` — `GATEWAY_MEMORY_LAYER.md`
is cited 10 times, `CONTROL_SCREEN_BUILD.md` 6, `ARCHITECTURE.md` and `DECISIONS.md` 5 each, spread across
`MEMORY.md`, `REFERENCE.md` and the dated logs. They are cited **by bare filename**, and the daily logs are
append-only by policy, so a move cannot come back and rewrite them.

Only **4 of the 19** non-governance files are uncited at all: `AUDIT_REPORT.md`, `UI_UX_PLAN.md`, and the two
`CONTROL_*_2026-09-21.md` records.

So the cost is not the `git mv`; it is 54 stale pointers in the very files that orient the next session.
Three honest options: leave the root alone; move everything and budget for a permanent mapping note in
`MEMORY.md`; or move only the four uncited files, which barely changes how the root reads.

Worth recording how the first pass got this wrong. The scan that produced "only 2 references" ran through a
tool that **skips hidden directories**, so it never looked inside `.workbuddy-ai/` at all — the same trap as
searching for `audit-level=high` and missing `.github/`. An absence claim is worthless until you have checked
that the search reached the directory.

### 5.2 `README.md:90` still hardcodes the port

> *"The gateway listens on **port 8800**"*

This is the same class of bug as the 8787 sweep: **8800 is a persisted setting, 8787 is the compiled default**
(`gateway.rs:33`). A fresh clone is not on 8800. It should read `<port>` with the "check Control → Local
Gateway" pointer that already follows it.

### 5.3 Three empty junk directories at the repo root

`IDE/`, `ai/`, `provider/` — all empty. Root is named `open ai provider IDE`, so these are almost certainly the
result of a `mkdir ai provider IDE` run from inside that directory. They are untracked, so `git status` is
clean and nothing will ever flag them.

**Action:** remove them.

### 5.4 A plan whose evidence is gone

`docs/gateway-flexibility-plan.md:6` cites a shallow clone at `/tmp/OmniRoute`. That reference is
unreproducible now. Not urgent, but it is the kind of citation that ages into a false claim.

---

## 6. Functional backlog — the five items, restated with current evidence

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Retry-After plumbing | **DONE** | `e5dcf62`; `minRetryAfterMs()` in `execution-engine.ts`; 3 tests |
| 2 | `count_tokens` | **DONE** | route at `gateway.rs:1757`, handler `gateway_anthropic.rs:135`, three 200-proving tests |
| 3 | `previous_response_id` | **CLOSED — not applicable** | Codex points at OmniRoute, not this gateway, and sets `wire_api = "responses"` + `disable_response_storage = true` |
| 4 | `cache_control` | **BLOCKED on measurement** | see below |
| 5 | `thinking` blocks | **NOT STARTED** | quality-only, last |

**On `cache_control` specifically.** The feature is real but currently unmeasurable: the signal is
`prompt_tokens_details.cached_tokens`, which appears **nowhere** in the codebase, and the `ledger` table has no
column for it. The ledger does show the shape of the problem — `agnes-2.5-flash` has 648 requests, ~35.9M input
tokens against ~213K output, roughly 55.5K input per request — so caching would pay. But no active manifest
mentions caching either. The order is **measure → decide → rework**, and measuring needs a real migration.
This is parked pending your call (see §8).

---

## 7. Suggested order

**Phase A — "this is a product" (~half a day).** Licence + repo metadata; `CHANGELOG.md`; version
single-source; the `pnpm build` step in `ci.yml`; delete the three junk directories; fix `README.md:90`.
*Nothing here is architectural, and together they change what the repo is.*

**Phase B — "this is distributable" (~a day).** `release.yml` + `tauri-action`; decide the updater (§1.4);
narrow `bundle.targets` or state the macOS-only support; `SECURITY.md`.

**Phase C — "this is maintainable" (~a day).** `cargo fmt --check` + `cargo clippy -D warnings` in CI;
dependency audit job; the `docs/` reorganisation; `CONTRIBUTING.md`.

**Phase D — optional.** ESLint; coverage measurement; the `cache_control` migration; `thinking` blocks.

---

## 8. Decisions needed from you

1. **Licence** — MIT, Apache-2.0, or something else? *(Apache-2.0 recommended: patent grant, suits a
   credential-handling tool.)*
2. **Updater** — implement it properly, or delete the docs and scripts and declare manual updates?
   *(Recommendation: delete now. A wrong document about update signing is a liability.)*
3. **Audience** — is this going to other people (which makes Phase B mandatory and implies the Apple Developer
   Program for notarization), or is it a local/portfolio tool (which makes Phase B optional)? This single answer
   changes the size of the remaining work more than anything else.
4. **`cache_control`** — build the `cached_tokens` measurement migration now, or keep it parked?

---

## Status — decisions taken 2026-09-22

All four were answered: **Apache-2.0**; **delete** the updater docs and scripts; **yes, this goes to
other people**; and **build** the measurement.

| § | Item | State |
|---|---|---|
| 1.1 | Licence | **Done** — `LICENSE` (Apache-2.0); GitHub reports `apache-2.0`; description and 10 topics set |
| 1.2 | Release pipeline | **Done** — `.github/workflows/release.yml`, tag-triggered, `tauri-action`, draft release |
| 1.3 | CI compiles the bundle | **Done** — `pnpm build` added to `ci.yml` *and* the local mirror |
| 1.4 | Updater docs and scripts | **Done** — all four files deleted; README states updates are manual |
| 2.1 | Version drift | **Done** — six manifests agree on `1.0.0`, enforced by `pnpm check-version-sync` |
| 2.2 | `CHANGELOG.md` | **Done** |
| 2.3 | `bundle.targets` | **Done** — narrowed to `app` + `dmg` |
| 3.1 | `SECURITY.md` | **Done** |
| 3.2 | Dependency audit | **Done** — `pnpm audit --audit-level=high` in `ci.yml` and the local mirror; weekly `audit.yml` adds the RustSec pass |
| 4.1 | Linter and formatter | **Deliberately not added** — see below |
| 4.2 | Coverage | **Still open** |
| 5.1 | Docs reorganisation | **Still open, and measured** — 54 references in `.workbuddy-ai/memory/` are cited by bare filename; see §5.1 |
| 5.2 | README port hardcode | **Done** |
| 5.3 | Junk directories | **Partly** — `ai/` and `provider/` removed; `IDE/` left alone, see below |
| 6.4 | `cache_control` measurement | **Done** — migration 0015 plus 8 tests |

### Two items deliberately left, with the reason

**The `cargo fmt --check` / `cargo clippy -D warnings` gate was not added.** Measured rather than
assumed: `cargo fmt --check` fails across the existing Rust sources, and `cargo clippy` reports **25
warnings** at `HEAD`. Adding either as a gate would have broken CI on the first push, which is worse
than having no gate at all.

Adopting rustfmt is therefore a real decision, not a free win. It rewrites most of
`apps/desktop/src-tauri/src/`, which destroys `git blame` across the entire host for a change with no
behavioural content. That is worth doing deliberately, as its own commit, when the blame cost is
acceptable — not smuggled into a release-preparation batch. The same applies to the 25 clippy
warnings: several (`too many arguments (8/7)`, three `very complex type`) need judgement rather than
a mechanical fix.

**`IDE/` was not removed.** It is not empty — it contains `IDE/.workbuddy-ai/memory/`, an empty
directory skeleton left by a session that ran with the wrong working directory. No files are at risk,
but it is named `.workbuddy-ai`, which this project treats as data rather than cache, so it was left
for a human to decide rather than deleted on a guess.

### What the gate caught that the unit tests could not

Both are the same class of failure, and both were invisible to a green `vitest` run:

1. Adding a field to `BridgeMsg::Usage` broke **eight** pattern matches across four gateway modules.
2. `cachedTokens` was missing from `LedgerEntry`, so `model-router.ts` failed to typecheck in three
   places.

`vitest` does not typecheck, so 249 passing router-core tests said nothing about either. They were
found by `pnpm typecheck`, `pnpm build` and `cargo clippy` — which is the argument for §1.3 in this
same plan. The fix for (1) was to remove the enum field entirely: the ledger already receives
`cached_tokens` through the TS router path, so the field was dead weight.

### What the measurement now needs to answer

The column exists; the data does not yet. Before `cache_control` can be decided, the ledger has to
accumulate `cached_tokens` across real traffic — and the question to ask of it is the one the
nullability was designed for: **is the column mostly `NULL` (no provider reports caching) or mostly
`0` (providers report it and we are not using it)?** Only the second justifies reworking request
bodies.
