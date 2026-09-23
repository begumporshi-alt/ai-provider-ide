# 05 — Workflow

## The gate

```bash
PATH="$HOME/.cargo/bin:$PATH" pnpm ci:local
```

`scripts/ci-local.sh` mirrors `.github/workflows/ci.yml`. Run it before opening a pull request.

**The `PATH` prefix is not optional.** Without cargo on `PATH` the gate reports `FAILED (1): Rust (cargo
missing)` even when everything else passed, which reads like a Rust failure and is not one.

### Step order, in both mirrors

| # | Step | `ci.yml` | `ci-local.sh` |
|---|---|---|---|
| — | Install JS deps | 1 | 1 (only with `--install`) |
| 1 | Dependency audit (`--audit-level=moderate`) | 2 | 2 |
| 2 | Typecheck | 3 | 3 |
| 3 | Unit tests | 4 | 4 |
| 4 | Build (`pnpm build`) | 5 | 5 |
| 5 | Tauri build (`tauri build --bundles app`) | 6 | 6 |
| 6 | Key-leak grep | 7 | 7 |
| 7 | Single TypeScript version | 8 | 8 |
| 8 | One product version | 9 | 9 |
| 9 | Doc links resolve | 10 | 10 |
| 10 | Rust formatting (`--check`) | 12 | 11 |
| 11 | Rust check | 13 | 12 |
| 12 | Rust clippy (`--all-targets -- -D warnings`) | 14 | 13 |
| 13 | Rust tests | 15 | 14 |
| 14 | Install Playwright browsers | 16 | 17 |
| 15 | Live-UI tests | 17 | 18 |
| — | Rust toolchain (`rustc --version`) | 11 | inline, not a `step` |
| — | Headless service build (`--bin aiproviderd --no-default-features`) | `headless-service` job, step 2 | 15 |
| — | Service binary runs (`aiproviderd --version`) | `headless-service` job, step 3 | 16 |

**The shared steps are in the same order in both, and that is checked rather than asserted.** They were not
until 2026-09-22: the dependency audit ran second in CI and seventh locally, while both `ci-local.sh:2` and
`CONTRIBUTING.md:21` claimed "the same steps in the same order" — false in exactly that one place. Registered
as [07](07-drift-register.md) D5 and since fixed.

**Three rows have no counterpart `step` on the other side**, and they are why the positions after `Doc links
resolve` diverge by one:

- **`Rust toolchain`** (`rustc --version`) is a CI step because a runner's toolchain is otherwise invisible;
  `ci-local.sh` prints the same line inline, since the local toolchain is the one you are already using. It
  sits at position 11 and pushes the Rust block one place later.
- **`Headless service build`** (`cargo build --bin aiproviderd --release --no-default-features`) and **`Service
  binary runs`** (`aiproviderd --version`) are the second and third steps of a *separate job* in CI —
  `headless-service`, a 3-OS matrix — so `ci-local.sh` runs them at positions 15 and 16 to answer "would CI
  pass?" for the job it would otherwise not model. They are what make `ci-local.sh` a **superset** of `checks`
  rather than an exact copy. `Service binary runs` reached `ci-local.sh` on 2026-09-23 for the reason the row
  exists in CI at all: the local gate modelled the *build* and not the *start*, so a binary that links but dies
  on startup passed locally and failed CI. The job's **first** step, the Linux-only `apt-get` install, is the
  one row with no local counterpart at all, and deliberately so.

`Build` and `Tauri build` are two steps on purpose: `pnpm build` is `tsc && vite build` and never invokes the
bundler, so a bundling error survives it — see [07](07-drift-register.md) D14. Both were added to `ci-local.sh`
on 2026-09-23, the same day `Tauri build` reached `ci.yml`; before that the local mirror was *stricter* than CI
on the bundle, and after it the reverse. **Re-measure both counts whenever a step is added** — 17 named steps in
`checks`, 18 in `ci-local.sh`, and every `checks` step has a counterpart, one of them (`Rust toolchain`) inline
rather than a `step`. Adding a step on one side only is the failure this table exists to catch.

That difference was harmless in practice — the audit is a read — but it is the class of claim this book exists
to catch: a mirror that is *almost* faithful is a mirror you stop trusting.

`Rust formatting` is the newest step, and the cheapest: `--check` never writes, and it is a no-op whenever the
tree is already formatted. It reads `apps/desktop/src-tauri/rustfmt.toml`, whose single non-default setting
exists to keep the host's existing compact style rather than replace it — stock rustfmt would have rewritten
42.2% of the host, and this config 30.1%.

`Rust clippy` came just before it. `--all-targets` there is deliberate: the test code is where a lint earns its
keep, and the two warnings that motivated the step sat in crash reporting and on a dialect code path no test
reached. `-D warnings` rather than a tolerated count, because a gate that accepts warnings stops being read once
there are 25 of them.

## What the gate deliberately does not enforce

One thing, and it is a decision rather than an omission.

**Coverage.** `pnpm test:coverage` measures all three vitest suites and prints one weighted figure — 43.8%
statements, 37.3% branches, 31.1% functions, 45.4% lines (2026-09-22). It is not a step in the table above. A
coverage threshold fails an unrelated refactor, the cheapest way out of that failure is to lower the
threshold, and the number stops being read. Every test the gate runs must still *pass*; coverage answers a
different question, and a question is not a threshold. Detail:
[`../PRODUCT_COMPLETION_PLAN.md`](../PRODUCT_COMPLETION_PLAN.md) §4.2.

`cargo fmt --check` sat here until 2026-09-22 and has left — it is step 9 above now. It was the one entry in
this section that was a *cost* rather than a decision: the objection was `git blame`, and a blame cost is
answerable by measurement. `rustfmt.toml` carries the measurement.

## Why the browser step clears vite's dep cache

`web-test:clean` moves `node_modules/.vite` aside along with `test-results`. That is not housekeeping for its
own sake. vite's dev server removes `node_modules/.vite/deps` while loading it
(`loadCachedDepOptimizationMetadata`), and in a sandboxed environment a bulk-delete guard can refuse that
removal — vite then exits 1 before it ever serves, and Playwright reports the symptom as a **60-second
`webServer` timeout** rather than as vite's error.

**The ordering is the easy part to get wrong.** The clean must run *after* `pnpm build`, because `vite build`
writes the same dependency cache the dev server later tries to remove. That is why it lives in
`web-test:clean` — the first thing `pnpm web-test` runs — and not somewhere done once by hand before the gate.
The cost is a cold dependency optimisation, measured at **~300 ms** (vite: `ready in 303 ms`).

`Doc links resolve` is the mechanical answer to the failure D9 records. It resolves every relative link *and
image* in every markdown file — including non-`.md` targets and bare directories — and fails on a miss. It
strips fenced blocks and inline code spans first, because several documents *quote* link syntax in order to
discuss it, and a checker that reports quotations is a checker people learn to ignore.

### Options

| Flag | Effect |
|---|---|
| `--skip-browser` | Omit the Playwright harness (~48s saved) |
| `--install` | Also run `pnpm install --frozen-lockfile` first |

**`--install` is off by default on purpose, and it is destructive here, not merely redundant.** The sandbox
broker denies pnpm's symlink writes (`ERR_PNPM_CODEBUDDY_BROKER_DENY`, `EEXIST`) and the install fails *half way
through*, having already unlinked entries — it has left `packages/*/node_modules/typescript` missing, which then
breaks `pnpm typecheck` with `MODULE_NOT_FOUND`. Run it only when dependencies genuinely changed.

## Fast loops

```bash
pnpm typecheck                                        # all workspaces
pnpm test                                             # unit tests
pnpm --filter ai-provider-router-desktop web-test     # the browser harness
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Three environment facts that produce misleading failures if you get them wrong:

- **Use the managed Node 22, and put it first on `PATH`.** Node 18 makes 27 router-core tests fail with
  `crypto is not defined`, which looks exactly like a regression. The preflight checks the major version because
  probing for `globalThis.crypto` does not detect Node 18.
- **`./node_modules/.bin/tsc`, never `npx tsc`.** `npx` may resolve a different compiler than the pinned 6.0.3.
- **Unset the five proxy variables on any probe *and* on the app.** `HTTP_PROXY HTTPS_PROXY http_proxy
  https_proxy ALL_PROXY all_proxy` — the sandbox proxy turns every outbound call into `502 upstream connect
  failed`, which looks like a broken upstream rather than a proxy that should not be there. A *partial* unset is
  worse: `curl` then returns `000`, which reads like a crash. `ci-local.sh:43` does this for the gate.

**`pnpm build` moves `dist` aside rather than deleting it.** `build:clean` runs first because Vite's
`emptyOutDir` trips the sandbox bulk-delete guard. That is why a `dist/` directory can appear under `/tmp`.

## The test suites, and what each is for

Four suites, and they fail in different ways on purpose.

| Suite | Covers | Cannot catch |
|---|---|---|
| `packages/router-core` + `adapter-spec` + desktop vitest | Routing, adapters, ledger, memory engine, pure logic — with fake ports | Anything requiring the network, the keychain, or a real SQLite file |
| Rust `cargo test` | Gateway auth and dialects, egress invariants, store and migrations, persistence, tools | UI behaviour |
| `web-test` (Playwright + a Tauri IPC shim) | Screens against a faked host, 14 spec files | The real Rust host |
| `e2e` (Playwright, real stack) | Acceptance, onboarding, drift repair, code adapters, 7 spec files | — |

> **`vitest` does not typecheck.** This has bitten twice: adding a field to `BridgeMsg::Usage` broke eight
> pattern matches across four gateway modules, and a missing `cachedTokens` on `LedgerEntry` broke
> `model-router.ts` in three places. **249 green router-core tests said nothing about either.** They were found
> by `pnpm typecheck`, `pnpm build` and `cargo clippy`. Run the gate, not just the unit tests.

## Verification discipline

Three rules, each paid for by a wrong conclusion that had already been written down.

**1. Prove the test fails before trusting it passes.** A spec written *after* a fix only proves the author's
model of the bug. Flip the code back, watch the specific assertion fail, and check it fails for the *right*
reason. Falsify one probe at a time — two changes at once and you cannot tell which one mattered.

**2. A negative result needs a positive control.** `cargo tree -i glib` prints nothing on macOS — but "nothing
to print" is also what you get for a crate that was never a dependency, or for a typo. Running the same query
against `x86_64-unknown-linux-gnu`, where `glib` *is* present, is what makes the macOS negatives mean *absent*
rather than *not found*.

**3. An absence claim is worthless until you have checked the search reached the directory.** Search tools skip
dot-directories, so `.github/` and `.workbuddy-ai/` need `cat <dir>/* | grep` or a read. This produced three
wrong conclusions in one session, including a confident recommendation that had to be retracted.

**A success message is not evidence.** Verify an edit by reading it back. Long, multi-line anchors have failed
silently before; prefer short anchors and confirm with a read.

## Releasing

`.github/workflows/release.yml` builds a **universal** (Apple Silicon + Intel) macOS bundle on a `v*` tag and
attaches it to a **draft** GitHub Release, so artefacts can be checked before anyone downloads them.

**Signing and notarization come entirely from the environment, never from `tauri.conf.json`.** No job outside
that workflow runs a full `tauri build`, so an identity pinned in the config would be **invisible to every other
check in this repository** — a green push would prove nothing about signing. Build to verify it.

Repository secrets: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, optionally `APPLE_SIGNING_IDENTITY`, and
`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` for notarization. The one-time provisioning — creating the
Developer ID certificate, base64-ing the `.p12`, setting the secrets — is written out in `CONTRIBUTING.md`,
"Releasing", because it is an account action and every step of it is manual.

### Two guards, and the defect they close

Without a certificate the build still succeeds and emits an **ad-hoc signed** app — fine locally, not fine for
a download, because macOS refuses to launch an unnotarized app from an unidentified developer. Until
2026-09-23 that failure was silent: the job went green and a draft appeared, and the problem surfaced on a
user's machine. The workflow now refuses to reach that state.

- **`scripts/release-preflight.sh`** runs **first**, before the Rust toolchain is even downloaded, because it
  costs about a second and catches the only mistake that otherwise survives the whole build. It fails when a
  required secret is absent or empty; decodes the `.p12` and opens it with the given password, which catches a
  truncated paste or a mismatched password twenty minutes earlier than the signing step would; and asserts
  `bundle.macOS.signingIdentity` is **not** pinned in `tauri.conf.json`. That last check is the rule above,
  now enforced mechanically — nothing else in the repository runs a full `tauri build`, so a pinned identity
  would otherwise be invisible to every other check.
- **`scripts/verify-release-signature.sh`** runs **after** the build and reads the artefacts back, asserting
  the signature is not ad-hoc, the authority is a `Developer ID Application`, the hardened-runtime bit is set,
  the team identifier matches, `spctl` accepts the artefact **as** `Notarized Developer ID`, and the
  notarization ticket is stapled. If it fails, the job goes red and the draft release is **deleted**, so a bad
  artefact cannot be published by someone who only sees that a release exists.
- **…and, since 2026-09-23, the same three signature properties for every Mach-O *inside* the bundle.** All of
  the checks above describe the *bundle*, which means they describe the main executable — so a second binary
  sitting beside it in `Contents/MacOS/` was invisible to every one of them. That is not hypothetical: adding a
  second `[[bin]]` to the package makes `tauri build` copy it in undeclared ([10](10-headless-service.md)
  §2.1.1, deviation 4). `codesign --verify --deep --strict` cannot be relied on to cover it either — measured
  on an ad-hoc bundle, it exits 1 for an unrelated reason and its output is **byte-identical** whether the
  nested binary is signed or has had its signature removed, so two failures were masking each other.
  Notarization remains the primary guard (Apple rejects improperly signed nested code), but the verifier now
  names the offending file instead of leaving it to a notary error to explain.

**`codesign --verify` cannot stand in for either of them, and this was measured, not assumed.** Against an
ad-hoc bundle it prints `valid on disk` and `satisfies its Designated Requirement` and **exits 0** — an ad-hoc
signature is a *valid* signature. What separates the two states is `spctl` (exit 3 vs 0), `stapler validate`
(exit 65 vs 0), the `CodeDirectory` flags word (`0x2(adhoc)` vs `0x12a00(…,runtime)`) and the `Authority=`
chain. Run either script by hand the same way the workflow does:

```bash
./scripts/verify-release-signature.sh                  # discovers bundles under target/
./scripts/verify-release-signature.sh path/to/App.app ABCD123456
```

### The one-time keychain prompt

A notarized release is a **different signing identity** from a local ad-hoc build, and keychain access is bound
to the identity. So the first launch after switching between them prompts once — and **until the user approves
it, every request answers `503 master key unavailable`**, including unauthenticated ones, because the master-key
check precedes auth. `401` is the signal that the gateway is healthy. Worth a line in release notes, because it
looks like a bug.

### Version

`tauri.conf.json` is authoritative — it is what Tauri stamps onto the bundle. Six manifests are expected to
agree, and `pnpm check-version-sync` fails the build when one does not.

### There is no auto-updater

Updates are manual. The v1-era updater docs and scripts were deleted in 1.0.0 because they described a
mechanism nobody had built, and described it wrongly (a v1-shaped config block, a `TAURI_SIGNING_PUBLIC_KEY`
variable Tauri does not read, and an RSA keypair where Tauri verifies minisign/ed25519). **A document that
describes update signing incorrectly is worse than no document**, because it is what the next contributor
trusts.

## Next

[06 Conventions](06-conventions.md) — the rules that keep the codebase consistent.
