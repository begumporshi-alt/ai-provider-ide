# AI-Provider Router IDE

A local desktop IDE for routing LLM requests across multiple AI providers. Providers are described by a
**declarative adapter manifest**; an unknown API is figured out by a guided probe → identify → test wizard, or
you can add one manually. A local gateway exposes an OpenAI-shaped API on `127.0.0.1` so other tools can talk
to every configured provider through one endpoint.

**API keys are stored in the OS keychain and never written to disk.** Nothing leaves your machine except the
requests you make to the providers you configure.

## Status

Developed and tested on **macOS** (CI runs `macos-14`). Windows and Linux are untested — the bundler carries
Windows/Linux icons, but the keychain-backed secret store and the gateway have only ever been exercised on
macOS.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22 | CI uses 22 |
| pnpm | 10.12.4 | pinned via `packageManager`; corepack will pick it up |
| Rust | stable | no `rust-toolchain` file, so whatever your default is |
| Xcode command line tools | — | for `codesign` |

## Install

```bash
git clone <this-repo>
cd ai-provider-ide
pnpm install
```

## Run

Frontend only (fast iteration, no Rust shell):

```bash
pnpm --filter ai-provider-router-desktop dev
```

Full desktop app:

```bash
pnpm --filter ai-provider-router-desktop tauri dev
```

## Build

```bash
cd apps/desktop
./node_modules/.bin/tauri build --bundles app
```

The signed bundle lands in
`apps/desktop/src-tauri/target/release/bundle/macos/AI-Provider Router.app`.

**Signing.** No signing identity is committed. Without one, Tauri falls back to **ad-hoc signing**, which is
fine for local use. To sign with your own certificate:

```bash
APPLE_SIGNING_IDENTITY="Apple Development: You (TEAMID)" ./node_modules/.bin/tauri build --bundles app
```

`APPLE_SIGNING_IDENTITY` overrides the config, so you never need to edit `tauri.conf.json`. Notarization is
skipped unless `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` are set.

> The `.dmg` step may fail on some machines (`hdiutil`). The signed `.app` is already complete at that point —
> the DMG failure is cosmetic.

## Test

```bash
pnpm typecheck                 # all workspaces
pnpm test                      # unit tests
pnpm ci:local                  # the full gate: leak scan, typecheck, Rust, browser
```

`pnpm ci:local` needs `PATH="$HOME/.cargo/bin:$PATH"` or it reports a bogus "Rust (cargo missing)" failure.

## First run

1. Launch the app. It starts with no providers — the home screen asks you to add one.
2. **Providers → + Add Provider**:
   - **Quick add** — OpenRouter, OpenCode Zen, b.ai (known profiles).
   - **Manual** — any OpenAI- or Anthropic-compatible API: name, base URL, auth header, dialect.
   - **Guided setup** — for anything else; it probes the API, identifies the dialect, runs free contract
     checks, and only enables the provider after you approve.
3. Add a key per provider (**+ Add key**). It goes to the keychain.
4. Enable the provider. The gateway listens on **port 8800**; check Control → Local Gateway for the current
   port and the master key.

## Layout

```
apps/desktop/            Tauri shell + React UI (screens/, src-tauri/ for Rust)
packages/router-core/    routing, adapter runtime, model catalog, onboarding orchestrator
packages/adapter-spec/   the manifest grammar (zod) — the frozen contract
```

Architecture and decisions live in `ARCHITECTURE.md` and `DECISIONS.md`.

## Notes

- The local SQLite database is **gitignored** — a fresh clone starts empty. That is correct, not a bug.
- After replacing the installed binary, macOS will prompt once before the app may read its keychain entry.
  Until you approve it, every gateway request returns `503 master key unavailable`.
- This repository is public. Never commit a real key or token; `pnpm key-leak-grep` runs in CI.
