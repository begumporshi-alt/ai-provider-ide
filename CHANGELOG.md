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

- **Dependency auditing.** `pnpm audit --audit-level=high` now runs in `ci.yml` and in the local
  mirror, and a weekly `.github/workflows/audit.yml` re-runs it alongside a RustSec audit of the
  Tauri host on `ubuntu-latest`.

  The level is `high`, not `moderate`, and that is a measurement rather than a preference: the two
  moderate advisories share a single root cause — a `vitest` devDependency whose patched line
  (`>=4.1.11`) is a whole major version away — so `moderate` cannot pass without a test-runner
  migration first. The scheduled job exists because an advisory can be published against code that
  has not changed, and a push-triggered gate never fires for that.

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
