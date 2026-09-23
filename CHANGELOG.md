# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**The shipping version is the one in `apps/desktop/src-tauri/tauri.conf.json`** — that is what Tauri
stamps onto the bundle and what the gateway reports. Every other manifest is expected to agree with
it, and `pnpm check-version-sync` fails the build when one does not.

## [Unreleased]

### Added

- **Per-app budgets.** A per-app gateway key can now carry its own monthly cap, so one runaway
  consumer — an agent loop in a connected IDE — is stopped without touching any other app, and
  without touching the owner's global budget. Until now the only cap was global and monthly: one
  `month_micros` against one `cap_micros`, which a single app could exhaust while every other app
  sat idle.

  The two limits are enforced **independently**, and the refusals are distinguishable. Both are
  `402 insufficient_quota`, but the body names which limit bound: `spend_cap_exceeded` for the
  global cap, `app_budget_exceeded` for one app's own. That distinction is load-bearing, because
  the remedies are opposite — the first is an operator problem that stops every app, the second is
  fixed by raising one key's budget or waiting for the month to turn.

  Migration 0017 adds the nullable `gateway_keys.cap_micros` and the index the per-app spend SUM
  needs, `ledger(app_key_id, ts)` — which 0016 deliberately declined to ship until a query existed
  to justify it. `cap_micros` is nullable and clearing stores `NULL` rather than `0`, so there is
  one spelling of "no budget" rather than two that behave identically until something queries
  `IS NULL`.

  Budgets are set per key on **Local Gateway**, beside the key they limit; the global cap stays on
  **Control**. Per-app *attribution* (0016) is the prerequisite and landed first — a budget has
  nothing to sum without it, and rows written before 0016 stay unattributed, so an app's total
  starts from the first request made after it.

- **Auto context compression.** Long conversations no longer overflow the model's window. Tier 1
  (hard truncation) and Tier 2 (summarization) are both included.

  Tier 1 drops the oldest **complete turns** until the prompt fits the budget, sized against the
  narrowest context window in the failover plan. Three properties are preserved, each pinned by a
  test: the `system` turn survives; the **newest** turn survives even when it alone exceeds the
  budget; and a tool call and its results are always dropped together.

  Tier 2 replaces the dropped turns with a compact summary, wired for the assistant via
  `createSummarizer`. The summarizer's own inner call sets `skipCompression: true`, because
  without it the chain would be unbounded — compressing would trigger a summary, which would
  compress again. The gateway stays on Tier 1 (stateless, latency-sensitive); Tier 2 is available
  via `generateText`'s `summarize` option for callers that want it.

  Both tiers are covered by the **same** trim: the two callers converge on `router.generateText`,
  so there is one rule rather than two that could drift apart.

- **Prompt-cache measurement.** The ledger now records `cached_tokens` for every request, read in
  whichever dialect the provider uses: OpenAI-shaped `prompt_tokens_details.cached_tokens`, or
  Anthropic's top-level `cache_read_input_tokens`.

  The column is **nullable on purpose**. `NULL` means the provider reported no cache block at all,
  which is a different finding from reporting a zero — and telling those apart is the entire point.
  Without it, every provider would look like a provider that caches nothing, and the question
  "would sending `cache_control` help?" could not be answered in either direction.

  This release is **measurement only**. No request shape changed and nothing sends `cache_control`
  yet; the data has to exist before that decision can be made honestly.

- `pnpm check-version-sync` — asserts the root `package.json`, both workspace packages,
  `apps/desktop/package.json`, `Cargo.toml` and `tauri.conf.json` all agree on one version.

- **Coverage measurement.** `pnpm test:coverage` runs all three vitest suites under
  `@vitest/coverage-v8` and prints one weighted figure across the workspace: **43.8% statements,
  37.3% branches, 31.1% functions, 45.4% lines**. Previously `coverage/` was gitignored and nothing
  produced it, so "did this change make things worse" had no answer at all.

  It is a **report, not a gate**. A coverage threshold fails unrelated refactors, and the cheapest way
  out of that failure is to lower the threshold — after which nobody reads the number. The gate keeps
  holding the line that matters: all 460 unit, 98 browser and 481 Rust tests must pass.

  Two mechanics worth knowing. The aggregate is **weighted** — counts are summed and the percentage
  recomputed, never the three `pct` values averaged, which would weight a 300-line package the same as
  a 6,000-line one. And a missing report is a hard error rather than a zero, because summing two of
  three and printing a confident percentage is the failure mode that matters most here.

- **Dependency auditing.** `pnpm audit --audit-level=moderate` now runs in `ci.yml` and in the local
  mirror, and a weekly `.github/workflows/audit.yml` re-runs it alongside a RustSec audit of the
  Tauri host on `ubuntu-latest`.

  The level started at `high` earlier the same day, and that was a measurement rather than a
  preference: two moderate advisories shared a single root cause — a `vitest` devDependency whose
  patched line (`>=4.1.11`) was a whole major version away — so `moderate` could not pass without a
  test-runner migration first. That migration landed the same day (see `### Changed`), so the level
  was raised to `moderate` and both mirrors re-verified. The scheduled job exists because an
  advisory can be published against code that has not changed, and a push-triggered gate never
  fires for that.

- **Per-app spend attribution.** The ledger now records *which* app key paid for a request
  (`ledger.app_key_id`, migration 0016), so a per-app budget finally has something to sum. The
  gateway's own app key (`gateway_keys.id`) previously appeared in no column at all: `ledger.key_id`
  holds the *provider* credential, and the two are different ids that both answer to "key".

  The column is only half of it. The identity is now returned by the gateway's auth check instead of
  being looked up a second time, threaded through all six dispatch sites, carried across the bridge
  to the webview, and mapped into the ledger write — and that last hop is the one that mattered,
  because the ledger is written on the webview side. A column, a TypeScript field and a sink mapping
  together would still have recorded nothing. Four tests cover it, each falsified before being
  trusted.

  This is **attribution only**. Nothing yet sets or enforces a per-app cap, and existing rows stay
  `NULL` — nothing can reconstruct which app paid for them.

- **A self-verifying release pipeline.** A release build can no longer succeed into a broken
  artefact. `scripts/release-preflight.sh` runs first and refuses to start the build when an Apple
  secret is missing, when the `.p12` will not open with the given password, or when a signing
  identity has been pinned in `tauri.conf.json`. `scripts/verify-release-signature.sh` then reads
  the built artefacts back and requires them to be Developer ID signed, hardened, and notarized; if
  they are not, the job fails and the draft release is deleted.

  The defect this closes was silent rather than loud. `tauri build` succeeds with **no** Apple
  secrets at all and emits an **ad-hoc signed** app, which launches fine locally — where Gatekeeper
  does not assess it — and is refused on a user's machine. A tag push therefore produced a green
  job and a draft Release containing something macOS refuses to open, and the failure surfaced for
  a user instead of in CI.

  **`codesign --verify` is not sufficient, which is why the verifier does not rely on it.** Measured
  against an ad-hoc bundle, it prints `valid on disk` and `satisfies its Designated Requirement` and
  **exits 0** — an ad-hoc signature is a valid signature. The checks that separate signed and
  notarized from ad-hoc are `spctl` (exit 3 vs 0), `stapler validate` (exit 65 vs 0), the
  `CodeDirectory` flags word (`0x2(adhoc)` versus `0x12a00(…,runtime)`) and the `Authority=` chain.
  Both scripts were falsified against both states before being written into the workflow.

  Provisioning the certificate and the six repository secrets remains a one-time manual step,
  written out in `CONTRIBUTING.md` under "Releasing" — it is an Apple Developer account action that
  no code change can perform.

### Fixed

- **A client-facing `Retry-After` is now the shortest wait, not the longest.** The route planner
  *drops* a cooled key rather than deprioritising it, so the earliest a retry can be served is when
  the first cooled key frees up. The gateway was telling clients to wait for the last one, which was
  longer than necessary. The value is still floored so a client is never told to retry into a window
  that has not closed.

### Changed

- **Licensed under Apache-2.0** (`LICENSE`), with a `license` field added to every manifest.
- `bundle.targets` narrowed to what is actually built and tested (macOS). The previous `"all"` also
  produced Windows and Linux installers that this project has never run.
- CI now runs `pnpm build`, so a bundle that no longer compiles cannot pass. Previously the
  Playwright harness exercised a **dev server**, which meant nothing in CI touched the production
  bundle — the local gate (`pnpm ci:local`) was the stricter of the two.
- CI now runs `pnpm check-version-sync`, which fails when any manifest disagrees with
  `tauri.conf.json` about the product version.
- **`vitest` 3.2.7 → 4.1.11 across all three packages**, clearing GHSA-82fw-gwwq-j7x9 (a path
  traversal in `@vitest/mocker`, vulnerable `>=2.1.0 <4.1.11`). **No test changed**: every vitest
  config used only long-stable options, so all 460 tests passed on 4.1.11 as written.

  The one real cost had nothing to do with vitest. `pnpm typecheck` then failed with
  `TS2591: Cannot find name 'node:child_process'` in `e2e/mock-servers.ts` and
  `src/lib/tools/agentLoop.test.ts`, while `@types/node@26.6.0` sat in the tree complete (89 `.d.ts`)
  and correctly symlinked. `tsc --listFilesOnly` enumerated **409 files including 83 `@types/node`
  files** before the bump and **238 including zero** after, so the reshaped dependency graph had
  stopped `@types/node` being auto-included at all. `apps/desktop/tsconfig.json` now states
  `"types": ["node"]` rather than inferring it: an implicit default is a dependency on the install,
  not on the code.

- **The Rust host is now rustfmt-formatted, and the gate enforces it.** `cargo fmt --check` runs in both
  mirrors, first in the Rust block. Adoption had been deferred because a stock config rewrites most of
  the host and destroys `git blame` for no behavioural change — measured on the 24,006-line host, that
  is **638 hunks / 42.2% of it**. `use_small_heuristics = "Max"`, the single non-default setting in the
  new `apps/desktop/src-tauri/rustfmt.toml`, cuts that to **354 hunks / 30.1%** by keeping the compact
  "one line if it fits" style the code already uses — so the rewrite preserves the host's look rather
  than replacing it. The 24 files, 4,172 insertions and 3,473 deletions it did touch carry no meaning
  whatsoever, which is exactly why they are their own commit rather than part of a release batch.

### Removed

- **The auto-updater documentation and scripts.** They described a mechanism that was never
  implemented, and three details were wrong in ways that would have cost real time:
  `SIGNING.md` claimed `tauri.conf.json` contained an `updater` block it did not contain, and put it
  at the top level where Tauri v1 kept it rather than under `plugins.updater` where Tauri v2 keeps
  it; it exported `TAURI_SIGNING_PUBLIC_KEY`, which is not a variable Tauri reads; and
  `generate-updater-keys.sh` produced an **RSA** keypair with `openssl`, while Tauri's updater
  verifies **minisign/ed25519** keys produced by `tauri signer generate` — so keys from that script
  could never have verified an update.

  A document that describes update signing incorrectly is worse than no document, because it is what
  the next contributor trusts. Updates are manual for now; see `README.md`.

- Three empty directories at the repository root (`IDE/`, `ai/`, `provider/`), untracked and so
  invisible to `git status`.

## [1.0.0] - 2026-09-22

The first release. A local-first desktop app that routes LLM requests across the user's own AI
provider accounts.

### Added

- **Provider management.** Providers are described by a declarative adapter manifest. Known profiles
  are available as quick-add; anything else can be added manually, or discovered by a guided
  probe → identify → contract-test → approve wizard that only enables a provider after you confirm
  it.
- **Local OpenAI-shaped gateway** on `127.0.0.1`, so other tools can reach every configured provider
  through one endpoint. Per-app gateway keys mean a leaked or retired client can be revoked without
  rotating the master key.
- **Keychain-backed secrets.** API keys are held in the OS keychain and never written to disk.
- **Usage ledger** with per-request tokens, cost estimates, latency and error class, plus monthly
  rollups — including source attribution, so UI, gateway and internal generator traffic are
  distinguishable.
- **Drift detection and repair** for providers whose API changes under them.
- **A memory layer** with scoped recall, plus a context graph of artifacts, memories, skills and
  messages.
- **An agent loop** with sandboxed tool execution and a visible step trail.

### Known limitations

- Developed and tested on **macOS only**. Windows and Linux are untested: the keychain-backed secret
  store and the gateway have never been exercised there.
- Updates are manual — there is no auto-updater.
- Distribution is not yet notarized; see `SECURITY.md` and `CONTRIBUTING.md`.
