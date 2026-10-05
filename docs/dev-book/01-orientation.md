# 01 — Orientation

## What the product is

A macOS desktop application that turns the user's own third-party AI provider accounts into one normalised
local layer. Providers are described by a **declarative JSON manifest**, so adding one is normally data rather
than code. An unknown API is onboarded by a guided `probe → fingerprint → contract-test → approve` wizard, with
an AI generator as the fallback when no builtin dialect template fits.

A Rust HTTP gateway re-exposes the whole router as a single OpenAI-shaped endpoint on `127.0.0.1`, so ZCode,
Claude Code, Cursor, a script or a chat UI can reach every configured provider through one URL and one
credential, with the same key rotation and provider failover the built-in UI gets — and the app itself runs
headless as a launchd service (`aiproviderd`) when a window is not wanted. Since the 2026-10-04/05 A1
consolidation the *serving* router is Rust (`RouterBridge`); the TypeScript `router-core` package is the
differential oracle for tests and the config-time layer, not the request path.

**The security promise that shapes the whole design:** API keys live in a file-backed vault on your machine
(`.secrets.json`, mode 600) — never in the database or logs — nothing leaves the machine, and the
TypeScript layer cannot read them even if it wanted to. See [02](02-architecture.md).

## Repository map

Three workspace packages. The split is not cosmetic — it is what keeps the router testable without a UI.

| Path | What it owns | Size |
|---|---|---|
| `apps/desktop` | Tauri shell, React UI (`src/screens/`, 13 screens), and the Rust host + serving router (`src-tauri/src/`, 73 files) | ~75,200 lines Rust, ~15,300 lines TS/TSX |
| `packages/router-core` | The differential/oracle engine (tests + config-time), model catalog, repair orchestration | 39 files, ~8,800 lines |
| `packages/adapter-spec` | The manifest grammar (zod) — the frozen contract | 2 files, ~220 lines |

`router-core` is UI-agnostic on purpose: it is exercised by unit tests with fake ports, with no webview and no
network. Anything that needs the network, the vault or SQLite is a port, implemented in Rust. Since A1 it is
also off the production request path — the Rust engine serves; `router-core` remains the second
implementation that keeps the Rust one honest in tests.

## Toolchain

Pinned, and each pin is enforced rather than documented.

| Tool | Version | Enforced by |
|---|---|---|
| Node.js | 22 (minimum 19) | `ci-local.sh` preflight; CI `setup-node` |
| pnpm | 10.12.4 | `packageManager` field, so corepack picks it up |
| Rust | stable | `dtolnay/rust-toolchain@stable` |
| TypeScript | 6.0.3, exact | `pnpm check-ts-version` |
| React | 19 | — |
| Vite | 8 | — |
| Tailwind | 4 | — |
| vitest | 4.1.11 | — |
| Playwright | 1.63 | — |

> **Node 19 is a hard floor, and the failure it prevents is misleading.** Under Node 18 every
> `crypto.randomUUID()` in `provider-registry.ts` throws `crypto is not defined` and 27 router-core tests fail
> in a way that looks exactly like a regression. Probing for `globalThis.crypto` does **not** detect it, because
> Node 18 exposes it. The preflight in `scripts/ci-local.sh` checks the major version instead.

## Getting it running

Install, run, build and signing instructions live in [`../../README.md`](../../README.md). This book does not
duplicate them. The short version:

```bash
pnpm install
pnpm --filter ai-provider-router-desktop dev     # frontend only, fast loop
pnpm --filter ai-provider-router-desktop tauri dev  # full desktop app
```

## The screen map

Thirteen screens, reached from the sidebar in `apps/desktop/src/components/Shell.tsx`. The `NAV` constant there
is the source of truth for the sidebar; this table adds which subsystem each screen belongs to.

| Group | Screen | File | Belongs to |
|---|---|---|---|
| Providers | AI Providers | `screens/Providers.tsx` | Provider registry, keys, contracts, manifests, drift |
| Tools | Model Browser | `screens/Models.tsx` | Model catalog, aliases, modality tags |
| Tools | Assistant | `screens/Assistant.tsx` | The playground — text, image, agent mode |
| Tools | Activity | `screens/Activity.tsx` | Usage ledger, failures, fallbacks |
| Tools | Context | `screens/Context.tsx` | Context graph of artifacts, memories, skills, messages |
| Tools | History | `screens/History.tsx` | Session turns and timelines |
| Tools | Skills | `screens/Skills.tsx` | Skill catalog and install |
| Tools | Agents | `screens/Agents.tsx` | Agent runs and their step trail |
| Tools | Memory | `screens/Memory.tsx` | Memory atoms, scopes, recall, retention |
| System | Control | `screens/Control.tsx` | The switchboard for cross-cutting switches |
| System | Router Settings | `screens/Settings.tsx` | Failover, rotation, timeouts, system-AI pick |
| System | Local Gateway | `screens/Gateway.tsx` | Endpoint URL, master and per-app keys, the Connect-your-IDE setup panel, copy-paste presets |
| — | Onboarding | `screens/Onboarding.tsx` | Reached from Providers, not in the sidebar |

**The sidebar is not the full list.** `Onboarding.tsx` is a screen with no `NAV` entry — it is entered from the
Providers screen. When you add a screen, add it to `NAV` *and* to this table.

> **The architecture document's module map is narrower than this table.** `ARCHITECTURE.md` §1.2 lists seven
> screens from the spec era; Activity, Context, History, Skills, Agents, Memory and Control are not in it.
> Those subsystems are designed in `GATEWAY_MEMORY_LAYER.md` and `CONTROL_SCREEN_BUILD.md`. Registered as
> [07](07-drift-register.md) D6.

## Scale, as measured

Useful for judging whether a change is proportionate. Counted from the tree, not quoted from docs — the
documented test counts had drifted twice before this was written.

| Thing | Count |
|---|---|
| Rust source files / lines | 73 / ~75,200 |
| Screens | 13 / ~7,300 lines |
| Registered IPC commands | 131 (143 `#[tauri::command]` defined) |
| HTTP routes on the gateway | 8 public + 36 `/admin/*` |
| SQLite tables | 29 |
| Migration versions | 23 (6 schema + 17 data) |
| TypeScript unit cases | 921 (23 adapter-spec · 463 router-core · 435 desktop src) |
| Browser harness specs | 190 cases |
| Playwright end-to-end specs | 4 spec files, 27 cases |
| Rust `#[test]` | 1,527 |

Re-measured 2026-10-05; the previous row (29 files / 125 commands / 15 migrations / ~425 TS cases…) was the
2026-09-22 tree held forward for a month while the Rust serving path, headless daemon, retention, idempotency
and drift work landed.

## Next

[02 Architecture](02-architecture.md) — the split that everything else follows from.
