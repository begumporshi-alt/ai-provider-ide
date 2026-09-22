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

## The gate

```bash
pnpm ci:local
```

This is the same set of steps, in the same order, as `.github/workflows/ci.yml`. Run it before
opening a pull request. Two things about it are worth knowing:

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

## What CI enforces

| Step | Why |
|---|---|
| `pnpm typecheck` | TypeScript across all workspaces |
| `pnpm test` | Unit tests (router-core, adapter-spec, desktop) |
| `pnpm build` | **The bundle must compile.** The Playwright harness runs against a vite *dev* server, so without this step nothing in CI touches the production bundle |
| `pnpm key-leak-grep` | No real credential in the tree. This repository is public |
| `pnpm check-ts-version` | One TypeScript version across the workspace |
| `pnpm check-version-sync` | One product version across every manifest |
| `pnpm audit --audit-level=high` | No high-or-critical advisory in the JS dependency tree |
| `cargo check` / `cargo test` | The host |
| Playwright | The live UI harness (wizard, Tier-2 review, egress image) |

**Two steps people expect to find here are deliberately absent:** `cargo fmt --check` and
`cargo clippy -- -D warnings`. Both were measured before being adopted, and both fail at `HEAD` — fmt
across the existing Rust sources, clippy with 25 warnings. Adding either would break CI on the first
push, which is worse than having no gate. Adopting them is a deliberate change that belongs in its own
commit: rustfmt rewrites most of `apps/desktop/src-tauri/src/` and destroys `git blame` across the host
for zero behavioural change. See `docs/PRODUCT_COMPLETION_PLAN.md` §4.1.

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
