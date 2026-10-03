# AI-Provider Router IDE

A local desktop IDE for routing LLM requests across multiple AI providers. Providers are described by a
**declarative adapter manifest**; an unknown API is figured out by a guided probe → identify → test wizard, or
you can add one manually. A local gateway exposes an OpenAI-shaped API on `127.0.0.1` so other tools can talk
to every configured provider through one endpoint.

**API keys are stored in a local secrets file (mode 600), never in the database.** Nothing leaves your machine
except the requests you make to the providers you configure.

## Status

Developed and tested on **macOS** (CI runs `macos-14`). Windows and Linux are untested — the bundler carries
Windows/Linux icons, but the file-backed secret store and the gateway have only ever been exercised on
macOS.

**There is no downloadable release yet.** A build another Mac will launch has to be Developer ID signed and
notarized by Apple, which needs a paid Apple Developer Program membership; until then the release workflow
attaches its artefacts to a **draft**. The supported path is building from source.

## Getting started

| I want to… | Start here |
|---|---|
| **use the app** | [`USER_GUIDE.md`](USER_GUIDE.md) — build from source, first run, pointing another tool at the gateway, what each error code means |
| **change the code** | Prerequisites and Quickstart below, then [`CONTRIBUTING.md`](CONTRIBUTING.md) for the gate, and the [developer book](docs/dev-book/README.md) for the rules |
| **understand the design** | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/DECISIONS.md`](docs/DECISIONS.md) |

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 22 | CI uses 22 |
| pnpm | 10.12.4 | pinned via `packageManager`; corepack will pick it up |
| Rust | stable | no `rust-toolchain` file, so whatever your default is |
| Xcode command line tools | — | for `codesign` |

## Quickstart

```bash
git clone https://github.com/begumporshi-alt/ai-provider-ide.git
cd ai-provider-ide
pnpm install
pnpm --filter ai-provider-router-desktop tauri dev    # full desktop app
```

`pnpm --filter ai-provider-router-desktop dev` runs the frontend alone, with no Rust shell — faster to start,
but the gateway and the secret store are absent.

## First run

Add a provider, add its key, enable it, then switch the gateway on under **Control → Local Gateway**. It
listens on `127.0.0.1:8787` by default and shows the master key to paste into whichever other tool you want
to route through it.

The full walkthrough — provider setup, pointing Cursor or a script at the gateway, where your data lives,
and every error code — is in [`USER_GUIDE.md`](USER_GUIDE.md).

## Build, sign and release

To bundle, sign, or cut a release, see [`CONTRIBUTING.md`](CONTRIBUTING.md) — "Building a bundle" and
"Releasing". In short, `./node_modules/.bin/tauri build --bundles app` from `apps/desktop`.

## Test

```bash
pnpm typecheck                 # all workspaces
pnpm test                      # unit tests
pnpm ci:local                  # the full gate: leak scan, version sync, build, Rust, browser
```

`pnpm ci:local` needs `PATH="$HOME/.cargo/bin:$PATH"` or it reports a bogus "Rust (cargo missing)" failure.
The step-by-step version, and what each step exists to catch, is in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Layout

```
apps/desktop/            Tauri shell + React UI (screens/, src-tauri/ for Rust)
packages/router-core/    routing, adapter runtime, model catalog, onboarding orchestrator
packages/adapter-spec/   the manifest grammar (zod) — the frozen contract
```

Inside `apps/desktop/src-tauri/`, the `src/core/` half is deliberately Tauri-free, and a headless
binary target (`aiproviderd`) builds from it — the gateway detached from the UI process, tracked in
[the dev book's headless chapter](docs/dev-book/10-headless-service.md). The daemon serves the same
routes as the in-app gateway (`/v1/chat/completions`, `/health`, the admin API), reads the **same**
data directory (providers, manifests, keys, settings), and on macOS installs as a launchd service
(`aiproviderd install` / `status` / `uninstall`; default port 8800 unless the store carries one).
The desktop app runs the identical gateway in-process — so run one *or* the other against a data
directory, not both at once (same port, same SQLite store).

The repository root holds only the audience-facing documents — `README.md`, `USER_GUIDE.md`,
`CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md` and `LICENSE`. Everything else is in
[`docs/`](docs/) — design notes, session records, audits — with the visual diagrams in
[`diagrams/`](diagrams/).

**Developers: start with the [developer book](docs/dev-book/README.md).** It owns the rules, the interfaces and
the conventions, and it tracks every known doc-versus-code disagreement.

## Security model

The gateway binds to `127.0.0.1` only — it is not reachable from the network. Every admin route
(`POST /admin/*`, `GET /admin/*`) requires the master key (or a per-app key) in the `Authorization`
header; the only unauthenticated route is `GET /health`, by design, so a client that does not yet
hold a key can still discover that the service is up.

API keys are stored in the local secrets file (mode 600) and are never put in the database. The egress
allowlist derives from the providers the user has configured; a request to a host that is not
allowlisted is refused locally and reported as `NETWORK`, not forwarded.

## Notes

- The local SQLite database is **gitignored** — a fresh clone starts empty. That is correct, not a bug.
- There is no keychain, so replacing the installed binary prompts for nothing: the vault is a file
  (`<data_dir>/.secrets.json`, mode 600) owned by your account. A `503 master key unavailable` therefore means
  the secrets file could not be read — a local fault, not a rejected credential.
- This repository is public. Never commit a real key or token; `pnpm key-leak-grep` runs in CI.

## Contributing

See `CONTRIBUTING.md` for the gate, and for the conventions this codebase follows — each one was paid
for by a bug. For a vulnerability, do **not** open a public issue; see `SECURITY.md`.

## Licence

Apache License 2.0 — see `LICENSE`.
