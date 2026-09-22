# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**The shipping version is the one in `apps/desktop/src-tauri/tauri.conf.json`** — that is what Tauri
stamps onto the bundle and what the gateway reports. Every other manifest is expected to agree with
it, and `pnpm check-version-sync` fails the build when one does not.

## [Unreleased]

### Added

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
  holding the line that matters: all 460 unit, 98 browser and 473 Rust tests must pass.

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
