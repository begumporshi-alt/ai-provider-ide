# Contributing

## Setup

```bash
git clone https://github.com/begumporshi-alt/ai-provider-ide.git
cd ai-provider-ide
pnpm install
```

Prerequisites, and the reason each one is pinned, are in `README.md`. The short version: Node 22,
pnpm 10.12.4 (via `packageManager`, so corepack picks it up), stable Rust, and Xcode command line
tools for `codesign`.

Then install the hooks — once per clone, because `core.hooksPath` is local configuration and cannot
travel in the repository:

```bash
git config core.hooksPath scripts/git-hooks
```

`scripts/git-hooks/pre-commit` refuses to commit a `docs/dev-book/book.html` that carries
`data-page-node-id`. That attribute is injected by whatever renders the file and never by
`scripts/build-dev-book.mjs`, and the injection can land *between* `git add` and `git commit` — which
is why the check is a hook and not a gate step, since `pnpm ci:local` regenerates the book and would
pass while the staged copy stayed contaminated.

## The gate

```bash
pnpm ci:local
```

This runs the same steps as `.github/workflows/ci.yml`, **in the same order**. The two mirrors were one step
out of order until 2026-09-22 (the dependency audit ran second in CI and seventh locally), which is drift
register D5; that is fixed and the step table in `docs/dev-book/05-workflow.md` is the owner of the order. Run
it before opening a pull request. Two things about it are worth knowing:

- **It needs cargo on `PATH`.** Without it the gate reports `FAILED (1): Rust (cargo missing)`
  even when everything else passed, which reads like a Rust failure and is not one. Use
  `PATH="$HOME/.cargo/bin:$PATH" pnpm ci:local`.
- **`--install` is off by default, on purpose.** It is destructive in a sandboxed environment, and a
  working tree already has `node_modules`. See the comment in `scripts/ci-local.sh`.

Individual pieces, if you want a faster loop:

```bash
pnpm typecheck
pnpm test
pnpm --filter ai-provider-router-desktop web-test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Releasing

A release is a `v*` tag. `.github/workflows/release.yml` then runs the preflight, the gate, a
**universal** (`aarch64` + `x86_64`) build, and the artefact verification, and attaches the result to a
**draft** GitHub Release. Nothing is publicly downloadable until someone publishes the draft.

The release pipeline supports two modes:

| Mode | Secrets | What happens |
|---|---|---|
| **Ad-hoc** (default, no secrets) | None of the five required secrets set | The bundle is ad-hoc signed. `scripts/verify-release-signature.sh` is skipped (there is no stapled ticket to verify). Works on the machine that built it; macOS Gatekeeper blocks it on other Macs. Fine for development and self-distribution. |
| **Developer ID + notarization** | All five required secrets set | Full Developer ID signing and notarization. The verify step asserts the seal, the authority chain, hardened runtime, and the stapled ticket. Produces a draft release other Macs can launch. |

A half-configured state — some secrets present, others missing — is a **defect**. The preflight
script fails fast with the names of the missing secrets, and no build starts. This is deliberate:
the previous behaviour (before the two-modes model) was to refuse any build without all five; the
current model allows the no-secrets path while still catching the half-configured case that would
produce a green job and a broken draft.

### The one-time provisioning (full mode only)

These steps are required only if you want a **notarized, publicly distributable** release.
For local development and self-distribution on your own machine, the ad-hoc mode needs nothing.

This needs an **Apple Developer Program membership** (paid — **$99/year**, checked 2026-09-23) and a
**Developer ID Application** certificate. Neither can be created by a script, and neither is in the repository
— the certificate is a secret, and this repository is public, so `pnpm key-leak-grep` is a gate step for
exactly this reason.

**Without the membership there is no path to a notarized release, and none of the steps below can start.** This
is a purchase, not a task. Local builds and ad-hoc releases are unaffected.

1. Create a **Developer ID Application** certificate (Xcode → Settings → Accounts → Manage Certificates, or
   the Developer portal), then export it from Keychain Access as a `.p12` **with a password**.
2. Create an **app-specific password** for the Apple ID at <https://appleid.apple.com> → Sign-In and
   Security → App-Specific Passwords. This is `APPLE_PASSWORD`; the Apple ID's own password will not work.
3. Base64 the certificate and set the secrets:

   ```bash
   base64 -i DeveloperIDApplication.p12 | tr -d '\n' > cert.b64
   gh secret set APPLE_CERTIFICATE              < cert.b64
   gh secret set APPLE_CERTIFICATE_PASSWORD      # the .p12 export password
   gh secret set APPLE_ID                        # the Apple ID email
   gh secret set APPLE_PASSWORD                  # the app-specific password from step 2
   gh secret set APPLE_TEAM_ID                   # 10 chars, from the portal
   rm cert.b64
   ```

   `APPLE_SIGNING_IDENTITY` is **optional** — Tauri derives it from the certificate. Set it only to
   disambiguate when the `.p12` holds more than one identity.

4. Cutting the release: `git tag v1.2.3 && git push origin v1.2.3`.

### What the two guards are for

Both live in `scripts/`, and both exist because of the same defect: **`tauri build` succeeds with no Apple
secrets at all**, emitting an *ad-hoc signed* app. That build launches fine locally — where Gatekeeper does
not assess it — and is refused on a user's machine.

- **`release-preflight.sh`** runs first, before the toolchain download, and costs about a second. It detects
  three states:

  | State | Action |
  |---|---|
  | No secrets | Prints informational lines about ad-hoc mode. Exits 0. |
  | All five secrets present | Validates the `.p12` is valid base64 and opens with the password, checks `tauri.conf.json` has no pinned identity. Exits 0. |
  | Some but not all | Fails with the list of missing secrets. Exits 1. |

  The "no pinned identity in `tauri.conf.json`" check runs in both ad-hoc and full modes: a pinned
  identity is invisible to every other check, because no job outside `release.yml` runs a full `tauri build`,
  and a green push would prove nothing about signing.

- **`verify-release-signature.sh`** runs after the build, **only when all five secrets are present**.
  In the no-secrets (ad-hoc) path there is no stapled ticket to verify; the WebKit-link check
  (`scripts/check-bundled-aiproviderd-links.sh`) is the meaningful gate for that state.

  Run it by hand the same way:

  ```bash
  ./scripts/verify-release-signature.sh                       # discovers bundles under target/
  ./scripts/verify-release-signature.sh path/to/App.app ABCD123456
  ```

  It asserts the seal is consistent, that the signature is **not** ad-hoc, that the authority chain is a
  `Developer ID Application`, that the hardened-runtime bit is set, that the team identifier is present and
  matches, that `spctl` accepts the artefact **as** `Notarized Developer ID`, and that the notarization
  ticket is stapled.

  **Do not "simplify" it to `codesign --verify`.** An ad-hoc signature *is* a valid signature: measured
  2026-09-23, `codesign --verify --deep --strict` prints `valid on disk` and `satisfies its Designated
  Requirement` and **exits 0** on an ad-hoc bundle. The checks that actually separate signed-and-notarized
  from ad-hoc are `spctl` (exit 3 vs 0), `stapler validate` (exit 65 vs 0), the `CodeDirectory` flags word
  (`0x2(adhoc)` vs `0x12a00(…,runtime)`), and the `Authority=` chain. A verifier that stops at `codesign`
  is decoration.

If the verify step fails in the full path, the job goes red **and** the draft release is deleted, so a bad
artefact cannot be published by someone who only sees that a release exists. **Do not publish a draft whose
verification step is not green.**

### Ad-hoc mode (no secrets)

The preflight prints informational lines and exits 0 — no build is blocked. The `tauri-action` step
produces an ad-hoc signed bundle. `verify-release-signature.sh` is skipped (its `if:` condition is
false when no secrets are set). The only meaningful gate in that path is the WebKit-link check.

**Trust model.** For an open-source project, the trust path is building from source, not downloading
an unidentified-developer app from GitHub. An ad-hoc release is valid for the person who built it;
a notarized release is what you ship when you want other Macs to launch the downloaded file without
Gatekeeper blocking it.

## What CI enforces

| Step | Why |
|---|---|
| `pnpm typecheck` | TypeScript across all workspaces |
| `pnpm test` | Unit tests (router-core, adapter-spec, desktop) |
| `pnpm build` | **The bundle must compile.** The Playwright harness runs against a vite *dev* server, so without this step nothing in CI touches the production bundle |
| `pnpm key-leak-grep` | No real credential in the tree. This repository is public |
| `pnpm check-ts-version` | One TypeScript version across the workspace |
| `pnpm check-version-sync` | One product version across every manifest |
| `pnpm check-doc-links` | Every relative link **and image** in every markdown file resolves, including non-`.md` targets and bare directories. Added after D9 |
| `pnpm audit --audit-level=moderate` | No moderate-or-worse advisory in the JS dependency tree. Raised from `high` on 2026-09-22, once the `vitest` bump cleared the two advisories that had made `moderate` unsatisfiable |
| `cargo check` / `cargo test` | The host |
| `cargo clippy --all-targets -- -D warnings` | No lint warning anywhere in the host, test targets included. Adopted 2026-09-22 — 64 warnings had been hiding two real dead branches |
| `cargo fmt --check` | The Rust host is formatted, under `apps/desktop/src-tauri/rustfmt.toml`. Adopted 2026-09-22 — a stock config would have rewritten 42.2% of the host, this one 30.1% |
| Playwright | The live UI harness (wizard, Tier-2 review, egress image) |

**No step is deliberately absent on the Rust side any more.** `cargo fmt --check` was the last one, and it
joined the table on 2026-09-22. It had been held back because a stock config rewrites most of the host and
destroys `git blame` for no behavioural change — true, and the reason `apps/desktop/src-tauri/rustfmt.toml`
exists. `use_small_heuristics = "Max"` keeps the compact "one line if it fits" style the code already uses,
cutting the rewrite from 42.2% of the host to 30.1%, and that is what made the cost payable. **ESLint is the
one thing still missing**, and it is missing because it is not installed in any of the four manifests — that is
new work rather than a rejected gate.

**Clippy sat in that absent-step paragraph until 2026-09-22, and the measurement did not support it.** The
"25 warnings" figure was accurate and misleading at once: `cargo clippy --fix` applied 15 of them
automatically, and only two carried any signal — both `if_same_then_else`, a branch whose two arms were
identical. One sat in crash reporting; the other in the Gemini dialect adapter, on a code path no test
reached at all. So the real obstacle was never the warning count. It was that no test could tell a
correct fix from a plausible-looking wrong one, and writing that test had to come first.

**Coverage is measured but deliberately not enforced.** `pnpm test:coverage` runs all three vitest suites
under `@vitest/coverage-v8` and prints one weighted figure — 43.8% statements, 37.3% branches, 31.1%
functions, 45.4% lines, measured 2026-09-22. It is not a step in the table above, and that is a decision
rather than an omission: a coverage threshold fails an unrelated refactor, the cheapest way out is to lower
the threshold, and the number stops being read. Every test the gate does run must still *pass*. See
`docs/PRODUCT_COMPLETION_PLAN.md` §4.2.

**A weekly job covers what a push-triggered gate cannot.** `.github/workflows/audit.yml` runs both
audits on `ubuntu-latest` every Monday, because an advisory can be published against code that has not
changed — nothing changes, no push happens, so no gate fires. That is also the only place the Rust
crates are audited.

## Conventions this codebase actually follows

These are not preferences — each one was paid for by a bug, and most are recorded in
`.workbuddy-ai/memory/MEMORY.md` and `REFERENCE.md`:

- **Verify an edit by reading it back.** A success message is not evidence the file changed.
- **Prove a test fails before trusting it passes.** Flip the code back and watch the specific
  assertion fail for the *right reason*. A probe must be a working implementation of the wrong thing.
- **One edit per file per batch.** A second edit lands on a stale snapshot and clobbers the first,
  and both report success.
- **Assert JSON and SSE by parsing, never by substring.** `serde_json` writes keys sorted, so a
  substring test binds to key order and silently tests nothing.
- **Never match on a label.** Labels are truncated to 80 characters. Pass the identity a thing
  already has.
- **Absence claims need the Grep tool, not a shell `grep`.** And a hit is not proof of completeness —
  chase the doc comment.

## Commits

The message convention is `type(scope): what changed`, where the body explains *why* rather than
restating the diff. Keep unrelated changes in separate commits — in particular, a mechanical
reformat belongs in its own commit, not mixed with behaviour.

## Licence

By contributing, you agree that your contributions are licensed under the Apache License 2.0. See
`LICENSE`.

## Security

Do not open a public issue for a vulnerability. See `SECURITY.md`.
