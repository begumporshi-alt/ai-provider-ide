# 10 — Headless service mode

**Status:** Phase 1 landed 2026-09-23 — the code is split and `aiproviderd` builds and serves. Phases
2–6 are still plan only. **Phase 1 does not serve completions**, and is not meant to: see §2.1.1.

**Question answered:** what it takes to detach the gateway from the webview process so it survives UI
quit, crash, and reload.

**Date:** 2026-09-23
**Assessed tree:** `fb38d1e` (clean, `main` == `origin/main`, CI green)
**Phase 1 landed on:** the commit immediately after `f7fdf2c`
**Method:** every claim below carries a `file:line` or the command that produced it.

---

## 0. The headline

**The gateway is already a Rust HTTP server. What makes it dependent on the UI is the router core,
which lives in a webview.**

Moving the router core from TypeScript to Rust is the work. Everything else — process management,
launchd registration, the UI falling back to HTTP — is wiring around that change.

---

## 1. The problem, restated with measurements

### 1.1 What already works (R1 background mode)

Closing the main window hides it instead of quitting (`lib.rs:277-284`). The gateway worker window
stays alive. The heartbeat bound relaxes from 6s to 30s (`gateway.rs:65`). App Nap is fought with
a native heartbeat (`app_nap.rs`).

**What R1 does NOT fix:**

| Failure mode | Why it happens | Evidence |
|---|---|---|
| Renderer crash | WebView process dies; bridge goes dead | `gateway_tests.rs:852-864` tests the 503 path |
| User quits app | `Cmd+Q` / Dock quit kills the process | Background mode only intercepts the close button |
| App Nap (deep) | macOS suspends hidden JS timers beyond the 30s bound | `gateway.rs:46-64` — 38 lapses measured over 11h |
| HMR reload | Vite hot-reload tears down the worker window | `gateway-worker.ts:7-8` documents the risk |

### 1.2 The shared-fate diagram

```
Today:  one OS process
        ├─ main window      (React UI, user-visible)
        ├─ gateway worker   (hidden webview, router core in JS)
        └─ Rust host        (HTTP server, bridges into the webview)

Target: two OS processes
        ├─ UI app           (React UI, talks HTTP to the service)
        └─ aiproviderd      (Rust HTTP server + router core, no webview)
```

The shared fate is the process boundary. R1 moves the close-button case from "quit" to "hide".
Headless mode moves the process boundary so the gateway is no longer inside the UI process at all.

---

## 2. What stays, what moves, what is new

### 2.1 The component map

| Component | Today | In headless mode | Effort |
|---|---|---|---|
| **HTTP server** (`gateway.rs`) | Rust — axum on 127.0.0.1 | Same code, same port, same routes | None |
| **Auth layer** (`gateway.rs:67-200`) | Rust — master-key + app-key check | Same code | None |
| **Keychain vault** (`vault.rs`) | Rust — `keyring` crate | Same code | None |
| **SQLite store** (`store.rs`, `persist.rs`) | Rust — `rusqlite` | Same code, same DB path | None |
| **Egress** (`egress.rs`) | Rust — reqwest with credential injection | Same code | None |
| **Model adapters** (`gateway_anthropic.rs`, `gateway_gemini.rs`, `gateway_responses.rs`) | Rust, but dispatch through bridge | Call providers directly, no bridge | Medium — remove bridge indirection |
| **Execution engine** (`execution-engine.ts:228`) | TypeScript — attempt loop, failover, SSE | Must be ported to Rust | **High** — 228 lines, but the logic is load-bearing |
| **Route planner** (`route-planner.ts:173`) | TypeScript — candidate ordering | Must be ported to Rust | **High** — 173 lines, heuristic-heavy |
| **Model router** (`model-router.ts:557`) | TypeScript — facade, registry, catalog | Must be ported to Rust | **High** — 557 lines, the public API |
| **Context compression** (`context-compress.ts:271`) | TypeScript — Tier 1 trim, Tier 2 summary | Must be ported to Rust | **High** — 271 lines, summarizer needs an AI call |
| **Adapter runtime** (`adapter-runtime.ts:60`) | TypeScript — manifest interpreter + sandbox | Must be ported to Rust | **High** — 60 lines, but pulls in QuickJS-WASM |
| **Health tracker** (`health-tracker.ts:78`) | TypeScript — cooldowns, circuit breakers | Must be ported to Rust | Medium |
| **Concurrency limiter** (`concurrency.ts:91`) | TypeScript — per-provider in-flight caps | Must be ported to Rust | Low |
| **Usage ledger** (`usage-ledger.ts:114`) | TypeScript — cost attribution | Must be ported to Rust | Medium — already mirrored in `persist.rs` |
| **Gateway bridge** (`gateway_cmds.rs:73-94`) | Rust — Tauri events to webview | **Deleted** — no webview to talk to | Negative effort |
| **Gateway worker window** (`gateway-worker.ts`, `gateway.html`) | Hidden webview | **Deleted** | Negative effort |
| **App Nap suppression** (`app_nap.rs`) | Native heartbeat to keep JS alive | **Deleted** — no JS to keep alive | Negative effort |
| **Process manager** | None | New: launchd plist, start/stop/lifecycle | Medium |
| **UI → service discovery** | Tauri IPC (`invoke`) | New: HTTP client, health probe | Medium |

### 2.1.1 The module split as built (Phase 1, 2026-09-23)

`apps/desktop/src-tauri/src/` now has three parts. The rule is **module-level, not crate-level**:
`core/` may not name `crate::tauri::*`.

```
src/
├── lib.rs                 # thin crate root: `pub mod core;` + `#[cfg(feature = "app")] pub mod tauri;`
├── main.rs                # Tauri app binary (unchanged)
├── core/                  # no dependency on the tauri/ module; every `tauri` mention is gated
│   ├── gateway.rs         # HTTP server, auth, capacity, the Bridge trait
│   ├── store.rs           # SQLite + migrations
│   ├── persist.rs         # store queries + 28 #[tauri::command] handlers, all 28 gated
│   ├── egress.rs          # allowlist + reqwest; stream() takes a tauri::ipc::Channel (gated)
│   ├── error.rs           # NEW — CommandError, its store conversions, and the DB-error redaction
│   ├── vault.rs  injection_log.rs  capture.rs  context.rs
│   ├── crash_report.rs  memory.rs  orchestrator.rs  skills.rs
│   └── gateway_{anthropic,gemini,responses,handlers,tests}.rs
│       context_scope.rs  model_context.rs  principal.rs  session_context.rs
│       — all `#[path]` submodules of gateway.rs, so they moved with it
├── tauri/
│   ├── app.rs             # was src/lib.rs — setup, tray, RunEvent
│   ├── commands.rs        # 106 lines mention `tauri::`; 57 are `#[tauri::command]` attributes
│   ├── gateway_cmds.rs    # EventBridge, the worker window
│   ├── tools.rs  workbuddy.rs  app_nap.rs  tools_agent_tests.rs
└── bin/
    └── aiproviderd.rs     # NEW — the standalone service
```

**Four things did not go where §7 of the task prompt said they would**, and each was measured rather
than assumed:

1. **`persist.rs` and `egress.rs` are in `core/`, not `tauri/`.** They cannot be anywhere else.
   `gateway.rs` calls `crate::persist::{active_gateway_key_ids, gateway_key_cap, month_spend_micros,
   app_month_spend_micros, spend_cap_micros}` in **non-test** code, so putting `persist` in `tauri/`
   makes `core/` depend on it. Putting `persist` in `core/` while `egress` and `CommandError` stayed
   in `tauri/` fails the same way from the other side: `persist` imports `crate::egress::EgressState`
   and `crate::commands::CommandError`. `{persist, egress, CommandError}` is one cluster, so all
   three moved and `CommandError` was extracted to `core/error.rs`.
2. **`core/` still imported the `tauri` crate — closed the same day by the `app` feature.** As
   built, `persist.rs` carried **28** `#[tauri::command]` handlers (this chapter said 32; that number
   counted four doc-comment mentions — the same mistake as the "104 tests" of §9.1) and
   `egress::stream` took a `tauri::ipc::Channel`. `Cargo.toml` made `tauri` an unconditional
   dependency and `build.rs` ran `tauri_build::build()` for every target, so `cargo build --bin
   aiproviderd` compiled Tauri regardless — Tauri-free in **source**, not in **dependency**, which is
   also why the Linux CI job had to install WebKitGTK.
   Now: `default = ["app"]`, `tauri`/`tauri-plugin-opener` are `optional`, every `tauri` mention in
   `core/` carries `#[cfg(feature = "app")]` (the 28 attributes, `use tauri::State`, the `Channel`,
   and the app-only helpers those wrappers reach), and `build.rs` reads `CARGO_FEATURE_APP` before
   calling `tauri_build::build()`. Measured: `cargo tree --no-default-features --edges all | grep -ci
   'webkit|wry|gtk'` → **0**, and the runtime `tauri` crate is absent from the graph;
   `cargo check --bin aiproviderd --no-default-features` is **warning-free**; `cargo test` still
   **489 passed / 0 failed**; clippy `--all-targets -- -D warnings` and `fmt --check` clean. The Linux
   job now builds with `--no-default-features` and installs no GTK/WebKit. `tauri-build` is the one
   exception — Cargo has no optional build-dependencies, so it still compiles, but it pulls no
   GTK/WebKit and is not called.
3. **One test-only file points backwards — eight times, in five functions.** `core/gateway_tests.rs`
   names `crate::tauri::gateway_cmds::{GatewayState, run_gateway_tool, set_gateway_workspace_root}`
   in **8 references**: `tool_test_state` (2),
   `a_bad_workspace_root_is_refused_before_anything_stores_it` (3), and one each in
   `a_bound_listener_is_stale_only_when_serving_was_never_asked_for`,
   `a_refused_gateway_tool_call_is_gated_logged_and_recorded` and
   `a_successful_gateway_tool_call_runs_logs_the_outcome_and_records`. It is declared
   `#[cfg(test)] #[path = "gateway_tests.rs"] mod tests;` (`core/gateway.rs:1806-1808`), so it
   compiles only under `cfg(test)` and never reaches `cargo build --bin aiproviderd` — "core never
   names tauri" is therefore true of the build and false of the test build. All five functions carry
   `#[cfg(feature = "app")]`, so the feature-less test build does not see them either.
   Two earlier notes were wrong for the same reason — counting the *file*, then counting a
   doc-comment mention as a reference: first "one `cfg(test)` edge", then "nine times".
4. **The service binary is copied into the macOS app bundle, undeclared.** Adding the second `[[bin]]`
   makes `tauri build` place `aiproviderd` in `Contents/MacOS/` beside the app binary — a separate
   physical copy (distinct inode), with `bundle.externalBin` unset and nothing in `build.rs` naming
   it. Measured 2026-09-23 on a `--bundles app` build: the bundle is **15 MB** and holds
   `Contents/MacOS/{ai-provider-router, aiproviderd}`, where the pre-change bundle installed at
   `/Applications` held only `ai-provider-router`. Two consequences for Phase 6: **useful** — the
   service already ships with the app, so no sidecar config is needed; and an **obligation** — a
   Developer ID release must sign *every* Mach-O in the bundle with the same identity and hardened
   runtime, and `aiproviderd` is currently only linker-signed (`adhoc`). That obligation is now partly mechanical: `verify-release-signature.sh` gained an explicit per-Mach-O check on 2026-09-23, so a nested binary that is not Developer ID signed is named **by file** instead of being left to notarization to reject. Not a regression by itself:
   `codesign --verify --deep --strict` reports "code has no resources but signature indicates they
   must be present" for the **new** bundle, the **pre-change installed** bundle, and the app binary
   **alone** — it is a property of Tauri's ad-hoc dev bundle, not of the second binary. (`aiproviderd`
   on its own verifies: "valid on disk … satisfies its Designated Requirement".)

**One new route: `GET /health`.** The plan (§4.2) and the task prompt (§8.3) both assume it exists; it
did not. It is the single unauthenticated route and returns `{"status":"ok"}` — nothing else, no
version, no key state. It answers before any key is produced because a client that does not yet hold
one must still be able to find the service. Every other route, including the 404 and 405 refusals,
still authenticates first.

**What the binary proves, stated exactly.** `aiproviderd` opens the same SQLite file, reads the master
key from the keychain, binds `127.0.0.1:8800` (persisted setting first, then 8800 — **not**
`DEFAULT_PORT`, which is 8787 and collides with AI Hub v2), and answers `/health` with 200. It
installs `HeadlessBridge`, which discards every dispatch, because the router core is still TypeScript
in a webview. `is_available()` is `is_running() && beat_is_fresh()`, and no heartbeat ever arrives, so
**every completion route answers 503 — by design**. Verified locally 2026-09-23:
`curl http://127.0.0.1:8800/health` → `200 {"status":"ok"}`; `POST /v1/chat/completions` → `503`.

### 2.1.2 Phase 1 acceptance, audited (2026-09-23)

The task prompt's §10 is a nine-item checklist. Two sibling claims in the same file had already proved false
(D12, D14), so the checklist was audited rather than assumed. **Eight of the nine hold as written; one cannot**,
because the command it names does not do what it says.

| # | Criterion, as the prompt words it | Verdict |
|---|---|---|
| 1 | `cargo test` passes with 0 failures | **met** — 489 passed / 0 failed |
| 2 | `cargo clippy --all-targets -- -D warnings` passes | **met** — exit 0 |
| 3 | `cargo fmt --check` passes | **met** — exit 0 |
| 4 | `cargo build --bin aiproviderd` produces a runnable binary | **met** — `aiproviderd 1.0.0`; and now also under `--no-default-features`, which compiles no Tauri |
| 5 | `pnpm build` produces a working Tauri app | **not met as written** — `pnpm build` is `build:clean && tsc && vite build`, frontend only; it never invokes the bundler. Satisfied only by substituting the real command: `tauri build --bundles app` → exit 0, 2m37s. Recorded as **D14**, and now a CI step, so the substitution is enforced rather than remembered |
| 6 | CI builds `aiproviderd` on macOS, Windows, and Linux | **met** — run #92, all three legs green. Note the job built with **default features** until this pass (**D15**) |
| 7 | `10-headless-service.md` updated with the actual module layout | **met** — §2.1.1 |
| 8 | `09-status.md` has a new row for the phase | **met** |
| 9 | All changes committed and pushed to `origin/main` | **met** |

The prompt is left unedited. It is a dated input, and ticking its boxes would misrepresent what was asked
versus what was found — the same reasoning as **D13**.

**§8.2's five "must NOT change" constraints were checked by diff against `ef539c1`, not asserted:**

| Constraint | Measurement |
|---|---|
| HTTP API surface | **8** `.route(...)` registrations at both revisions, identical (`gateway.rs:1938-1945`) |
| SQLite schema | no `*.sql` file touched |
| Keychain access pattern | no `vault*` file touched |
| Tauri IPC command surface | **85** handlers — 57 in `tauri/commands.rs` + 28 in `core/persist.rs` — identical name sets, none added, none removed |
| WebView worker window | no `*.ts` / `*.html` / `*.json` touched |

**One instrument error was caught in the act, and it points the other way.** A first pass counted routes with a
regex requiring `/v1/…` or `/health`. It returned **7**, which made the docs' "8 routes" look like a fifth false
count. The regex was the defect: the eighth route is `/v1beta/models/{*tail}`, which the pattern could not
match. Counting `.route(` call sites gives 8, agreeing with the docs. **Here the docs were right and the
instrument was wrong** — the opposite of the four earlier cases, and the reason a count is only as good as the
pattern that produced it. A near-miss worth keeping: the previous four corrections make a fifth one *plausible*,
and plausibility is not evidence.

### 2.2 The line count

```
Router-core TypeScript:  5,880 lines across 35 modules
Rust host today:        25,612 lines across 25 modules
What must move:         ~2,100 lines (execution, router, planner, compression, health, ledger)
What can be deleted:    ~300 lines (bridge, worker window, App Nap)
Net new Rust:           ~2,500 lines (port + process manager + tests)
```

The 5,880 figure includes modules that do NOT need to move: `builtin-templates.ts` (static data),
`redaction.ts` (generator-only), `adapter-generator.ts` (generator-only), `onboarding-orchestrator.ts`
(UI-only), `drift-monitor.ts` (UI-only), `repair-orchestrator.ts` (UI-only). The gateway path touches
only a subset.

### 2.3 What does NOT need to move

The UI and the generator stay in TypeScript. They become HTTP clients of the service instead of
Tauri IPC callers. The only modules they need are:

- `ports.ts` — the interface types (imported by both sides)
- `domain.ts` — shared types
- `config.ts` — settings shape

These become a **shared contract package** — TypeScript types that describe the HTTP API, consumed
by both the service (Rust implements them) and the UI (TypeScript calls them).

---

## 3. The target architecture

### 3.1 Process boundaries

```
┌─────────────────────────────────────┐     ┌─────────────────────────────────────┐
│  UI App (Tauri)                     │     │  aiproviderd (Rust binary)          │
│  ─────────────                      │     │  ─────────────────────────            │
│  Main window                        │     │  axum HTTP server (port 8800)       │
│  React + TypeScript                 │     │  Auth (master key, app keys)        │
│  └─ Settings, onboarding, screens   │     │  Router core (Rust)                 │
│                                     │     │  ├─ Route planner                   │
│  HTTP client (new)                  │     │  ├─ Execution engine                │
│  └─ GET  /health                    │◄────┼──┤  ├─ Model adapters                │
│  └─ POST /v1/chat/completions       │◄────┼──┤  ├─ Health tracker                │
│  └─ POST /v1/images/generations     │◄────┼──┤  ├─ Concurrency limiter           │
│  └─ GET  /v1/models                 │◄────┼──┤  └─ Context compression           │
│  └─ ...                             │◄────┼──┘                                   │
│                                     │     │  SQLite (same DB file)              │
│  No gateway logic — pure consumer   │     │  Keychain (same OS vault)           │
└─────────────────────────────────────┘     └─────────────────────────────────────┘
```

### 3.2 The UI app's new responsibility

Today the UI owns the gateway settings (port, background mode, etc.) and pushes them to Rust via
`invoke`. In headless mode the service owns its own settings. The UI is a **viewer and editor**, not
an owner.

| Setting | Today | Headless |
|---|---|---|
| Port | UI sets, Rust reads from SQLite | Service sets, UI reads from service |
| Background mode | UI toggle → Rust stores | **Deleted** — service is always background |
| Gateway enabled | UI toggle → Rust starts/stops HTTP | Service always on; UI toggles are client-side only |
| Per-app keys | UI creates, Rust stores | Same — but created via HTTP, not IPC |
| App budgets | UI sets, Rust enforces | Same — but set via HTTP, not IPC |

### 3.3 The service binary

A new crate binary: `apps/desktop/src-tauri/src/bin/aiproviderd.rs`.

It is **not** a Tauri app. It is a standard Rust binary that:
1. Opens the SQLite database (`store.rs` already supports this)
2. Reads the master key from the keychain (`vault.rs`)
3. Starts the axum HTTP server (`gateway.rs`)
4. Registers with launchd (see §4)

The binary reuses the `ai_provider_router_lib` crate for everything except Tauri-specific code.
This means splitting the current lib into:
- **Core** (HTTP, SQLite, keychain, adapters, store) — usable by both Tauri and the service
- **Tauri glue** (commands, events, window management) — Tauri-only

---

## 4. Process management strategy (macOS)

### 4.1 launchd LaunchAgent

The service registers as a user LaunchAgent, which means:
- It starts at user login
- It restarts if it crashes (`KeepAlive`)
- It runs as the user, not root
- It appears in Activity Monitor as `aiproviderd`

The plist template:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>dev.aiprovider.routerd</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/AI-Provider Router.app/Contents/MacOS/aiproviderd</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>~/Library/Logs/aiproviderd/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>~/Library/Logs/aiproviderd/stderr.log</string>
</dict>
</plist>
```

### 4.2 The UI app as a controller, not an owner

The UI app does not start the service directly (that would create a parent-child relationship, and
the UI's death would take the service with it). Instead:

1. **On first launch:** the UI app checks if the plist is installed. If not, it writes it and tells
the user to log out and back in (or runs `launchctl load`).
2. **On every launch:** the UI app checks `GET /health` on port 8800. If the service is up, it
connects. If not, it shows a "Service not running" state with a manual start button.
3. **The service outlives the UI:** quitting the app leaves the service running. Reopening the app
reconnects.

### 4.3 Why not a Tauri sidecar

Tauri has a sidecar feature for bundling external binaries. A sidecar is launched by the Tauri app
and killed when the app quits. That is the opposite of what we want — the service must survive the
UI's death.

So the service is **not** a sidecar. It is an independent binary that happens to be shipped in the
same `.app` bundle.

---

## 5. The HTTP contract changes

### 5.1 What stays the same

The external-facing HTTP surface (7 routes, `gateway.rs:1755-1761`) does not change. External
clients — curl, AI Hub, other apps — see the same API.

### 5.2 What the UI app loses

Today the UI uses Tauri IPC (`invoke`) for everything. In headless mode it becomes an HTTP client.
This means:

- **Latency:** HTTP localhost is ~1-2ms, vs ~0.1ms for IPC. Measurable but not perceptible for UI
  operations.
- **No shared memory:** Large payloads (image generations, long chat histories) cross the HTTP
  boundary as JSON instead of being passed by reference.
- **CORS:** The UI runs on `tauri://localhost` (or the dev server). The gateway is on
  `http://127.0.0.1:8800`. The gateway must add `Access-Control-Allow-Origin: tauri://localhost`
  (or `*` in dev) to its responses, or the UI's `fetch()` will be blocked.

### 5.3 New internal routes for the UI

The UI needs some operations that today go through `invoke`:

| Today (`invoke`) | Headless (HTTP) |
|---|---|
| `gateway_settings_get` | `GET /admin/settings` |
| `gateway_settings_set` | `POST /admin/settings` |
| `gateway_app_keys` | `GET /admin/keys` |
| `gateway_app_key_create` | `POST /admin/keys` |
| `gateway_app_key_revoke` | `DELETE /admin/keys/:id` |
| `gateway_spend_status` | `GET /admin/spend` |
| `gateway_enable` / `gateway_disable` | **Deleted** — service is always on |
| `gateway_worker_error` | **Deleted** — no worker window |

These routes are authenticated with the same master-key mechanism as the external surface. The UI
holds the master key in memory (it already does, for the one-shot reveal).

---

## 6. Data ownership and the SQLite database

### 6.1 Single database, two accessors

Both the service and the UI app open the same SQLite file. SQLite handles concurrency via file
locking, so this is safe as long as both use WAL mode (which `store.rs` already does).

| Data | Owner | Access pattern |
|---|---|---|
| `api_keys` (provider credentials) | Service (read) | Service reads for egress; UI never touches |
| `gateway_keys` (app keys) | Service (CRUD) | Service enforces; UI reads for display |
| `ledger` (spend records) | Service (write) | Service writes on every request; UI reads for display |
| `settings` | Service (write), UI (read/write) | Both read; UI writes user preferences, service writes gateway config |
| `memory_*` tables | Service (write) | Service writes captures; UI reads for recall |

### 6.2 The migration problem

Today migrations run inside the Tauri app on first launch. In headless mode they run inside the
service on first start. The UI app must not run migrations — it would race with the service.

The service becomes the **schema owner**. The UI app checks `PRAGMA schema_version` on connect and
refuses to start if the service's version is newer than the UI expects.

---

## 7. The phased implementation

### Phase 1 — Extract the core library (1-2 days)

**Goal:** split the Rust code into "Tauri-dependent" and "Tauri-independent" halves, without
changing behaviour.

1. Create `src/core/` for Tauri-independent code: `gateway.rs`, `store.rs`, `persist.rs`,
   `vault.rs`, `egress.rs`, all `gateway_*.rs` adapters.
2. Create `src/tauri/` for Tauri glue: `commands.rs`, `lib.rs` (app setup), `gateway_cmds.rs`
   (bridge, worker window).
3. Verify: `cargo test` still passes, `cargo clippy` still clean.
4. Add a new binary target: `src/bin/aiproviderd.rs` that links only `core/` and starts the HTTP
   server.

**What this proves:** the HTTP server can start without Tauri.

### Phase 2 — Port the execution engine (3-5 days)

**Goal:** rewrite `execution-engine.ts` in Rust.

This is the highest-risk module. It has:
- Async generator functions (`async function* stream()`)
- AbortSignal propagation
- Retry logic with Retry-After headers
- Circuit breakers and cooldowns
- SSE chunk parsing and multiplexing

The Rust equivalent uses `tokio::sync::mpsc` for streaming, `tokio::time::timeout` for cancellation,
and `async-stream` for the generator pattern.

**Test strategy:** port the tests first. `gateway_tests.rs` already has synthetic bridge tests.
Replace the synthetic bridge with the real Rust engine and verify the same assertions pass.

#### Phase 2 as scoped, and increment 1 as built (2026-09-23)

Measured before writing code, not estimated. `execution-engine.ts` is **229 lines**, but its real
dependency set is **885 lines** across six modules this plan never names — so the honest size of
"port the execution engine" is **1,114 lines of TypeScript**:

| module | lines | why the engine needs it |
|---|---|---|
| `execution-engine.ts` | 229 | the attempt loop itself |
| `manifest-interpreter.ts` | 492 | `ManifestHttpError`; the adapter layer |
| `ports.ts` | 152 | `ToolCall`, `UsageTokens` — the callback shapes |
| `concurrency.ts` | 92 | `ProviderLimiter` (audit R3, skip-don't-wait) |
| `health-tracker.ts` | 79 | `COOLDOWN_FLOOR_MS`, `HealthTracker` |
| `errors.ts` | 39 | `classify`, `ErrorClass` |
| `adapter-instance.ts` | 31 | `AdapterInstance` — a type only |

**Phase 2 is independently landable.** Of the six, only `Candidate` comes from `route-planner.ts`,
and it is imported as a **type**, not a value — so the engine does not depend on Phase 3's logic.
The ordering above holds.

**The test surface is 14 engine-relevant cases across five files**, concentrated in
`packages/router-core/test/acceptance.test.ts` (4 — 401→second-key-serves, failover-disabled,
anthropic dialect, abort mid-stream), `retry-after.test.ts` (2 pure cases), and
`concurrency.test.ts` (1 — the slot is released when an attempt fails).

**One contract already spans both halves of the port.** `AllAttemptsFailedError.minRetryAfterMs()`
in TypeScript and `BridgeMsg::Error::retry_after_ms` in Rust state the same rule — *shortest*, not
longest — and `gateway::cooldown_secs` already consumes it. They agree today. That is exactly why
the ported tests are worth having: they are what keeps them agreeing.

**The 1-second floor is spelled at four code sites across two languages, and only one is named:**

| site | spelling |
|---|---|
| `health-tracker.ts:27` | `COOLDOWN_FLOOR_MS = 1000` — the only named one; used by the tracker *and* `minRetryAfterMs` |
| `gateway.rs:1720` (`cooldown_secs`) | `.max(1)` |
| `gateway_handlers.rs:236` | `unwrap_or_else` falling back to the string `"1"` |
| `gateway.rs:1911` (`ensure_retry_after`) | `HeaderValue::from_static("1")` |

The coupling is documented only in prose — `gateway.rs:1903-1905` says its `1` "matches the core's
own key-cooldown floor (`health-tracker.ts`: `cooldownUntil = now + max(retryAfterMs ?? 0, 1000)`)".
Four literals and a comment is the drift surface; collapsing them onto one named constant per side
is port work, not cleanup. `cooldown_secs` had **no test at all** before this increment.

**Increment 1 landed.** `core/engine.rs` — the pure core, with no I/O, no async and no store:
`COOLDOWN_FLOOR_MS`, `ErrorClass`, `BodyHint`, `classify`, `is_retryable_with_next_key`,
`ErrorClass::is_drift`, `AttemptOutcome`, `min_retry_after_ms`. Nine tests, three ported from
`retry-after.test.ts` (shortest-wins fold, every-named-wait-counts, the sub-second floor).

**Increment 2 landed — the enforcement half.** `HealthTracker`, `KeyHealth` and
`AUTH_BREAKER_THRESHOLD`: the module that *cools* a key, beside the one that *reports* the wait.
`COOLDOWN_FLOOR_MS` now backs both, so the floor the tracker enforces and the floor the client is
told cannot drift — which is the entire reason the TypeScript exports it (`health-tracker.ts:23-25`).
Thirteen more tests. `cargo test` **511 passed / 0 failed** (489 when Phase 2 began); clippy
`--all-targets -- -D warnings` and `cargo fmt --check` clean; `cargo check --no-default-features`
warning-free and the service build still succeeds.

**One invariant spans both increments, and it is now a test.**
`the_enforced_floor_and_the_reported_floor_agree` walks every wait a provider could name — 1, 400,
999, 1000, 1001, 30 000, 60 000 ms — and asserts that the cooldown `record_result` enforces equals the
value `min_retry_after_ms` reports. `Some(0)` is the single deliberate exception, pinned separately:
the tracker still cools for the floor while the report returns 0, meaning *omit the header* and let the
middleware's floor apply. Both end up telling the client to wait; only the reporting path defers.

**Three behaviours of the ported tracker are load-bearing and non-obvious, so each has a test.**
The key status check is a **deny-list** (only `disabled`/`invalid` refuse, so an unrecognised status is
*tried*) while the provider check is an **allow-list** (only `enabled` passes) — opposite polarities, so
"fixing" either to match the other fails a test. The breaker counts **consecutive** failures, so one
`Ok` closes it *and* resets the count. And the model-side drift classes (`NotFound`,
`BadRequestSchema`, `ParseError`) leave key health alone, as do `ServerError`, `Network` and `Timeout`.

**The TypeScript's `else if (!isRetryableWithNextKey(cls)) return;` in `recordResult` is a no-op.**
The classes it names would fall through to the same "do nothing" anyway, and `SERVER_ERROR`, `NETWORK`
and `TIMEOUT` are not named by it at all yet still reach it. The Rust port keeps the behaviour and
replaces the branch with an exhaustive match arm, so the cases that change nothing are visible rather
than implied by an absent branch.

**`ApiKeyRow.cooldown_until` has no writer.** `is_key_usable` honours the record's own cooldown, and
that check is unreachable today: every `updateKey` call site passes `status`, `lastTestedAt`, or both —
four sites in source, measured 2026-09-23 — and nothing assigns the field directly. Its unit is
therefore pinned only by the TypeScript comparing it against `Date.now()`, which is milliseconds, so
the Rust test asserts ms and says why. This is the `NULL` ≠ `0` family: a persisted field that two
layers map and no layer writes.

**Eight falsifications across the two increments prove the tests bite rather than describe.**
Increment 1: folding `min`→`max` fails the shortest-wait test, dropping the floor fails the floor test,
adding `Timeout` to the retryable set fails the set test. Increment 2: dropping the floor from the
enforced cooldown fails the cross-module invariant, `>=`→`>` on the breaker threshold fails the
threshold test, inverting the key deny-list fails the status test, inverting the provider allow-list
fails its test, and making `record_result` a no-op fails the map-growth test. The file was restored
byte-identically after each run (`cmp -s`).

**Deliberately not here yet.** `AttemptOutcome` carries no `Candidate` — that type is Phase 3's —
so a failed chain cannot name what it tried, and `AllAttemptsFailedError` has no Rust home. That is
a recorded gap, not an oversight. Also unbuilt: the attempt loop itself, which needs
`route_planner`'s `Candidate`, and the streaming half, which needs a `Stream` adapter for
`chunks: AsyncIterable<string>`.

#### Increment 3 as built — the reply seam (2026-09-23)

The engine is pure; a bridge is not. Before a Rust router can answer a single request it needs a way
*back* to the request that is waiting, and outside the Tauri event system that way back did not
exist. So this is a prerequisite for both remaining halves rather than a detour from them.

**The cycle, stated exactly.** `GatewayCore` owns `Arc<dyn Bridge>` (`gateway.rs:584`) and the reply
path is `GatewayCore::reply(id, msg)`, so a bridge that wants to answer must reach the core that
owns it. `SynthBridge` — the test bridge, and the only working example of a replying bridge in the
tree — did precisely that, with `core: Mutex<Option<Arc<GatewayCore>>>` filled in by a hand-written
`attach()` after construction. Two defects, and only the first is obvious:

1. **A strong cycle.** core → bridge → core. Neither ever drops. Invisible in a test process; in a
   service it is the entire core — store, semaphores, injection log — held alive forever by a bridge
   nothing can reach.
2. **The wiring was a step nothing required.** `Bridge` documented a hand-off surface and never
   mentioned `attach`. A bridge that forgot it compiled, passed every test that did not dispatch, and
   then failed *silently*: `dispatch` panicked inside a detached `std::thread` (`.unwrap()` on
   `None`), which nothing joins, so the request waited out `FIRST_MSG_TIMEOUT` and answered a
   generic 503.

**The seam.** `ReplyHandle` — `Clone`, holding `Arc<Mutex<HashMap<u64, UnboundedSender<BridgeMsg>>>>`
and nothing else. `Bridge::dispatch` takes one: `fn dispatch(&self, req: BridgeRequest, replies:
ReplyHandle)`. `GatewayCore::dispatch(req)` is the single entry point that supplies it, and
`GatewayCore::reply` delegates to the same handle — so the map has one owner, and the two doors onto
it cannot drift apart.

**A parameter, not a stored handle — and that is the whole design.** A handle installed on the bridge
at construction is the same defect in a different shape: still a step, still forgettable. A parameter
cannot be forgotten, because the call does not compile without it. The consequence is stronger than
"the cycle is absent" — **it is unrepresentable.** `GatewayCore::dispatch(&self)` has no `Arc<Self>`
to put into the handle, and `new_with_key_wait` builds the handle *before* the `Arc` exists. The
construction order forbids the back-reference, so no later edit can reintroduce it by accident.

**Blast radius, measured.** Six dispatch sites across four files (`gateway_handlers.rs` ×3,
`gateway_responses.rs`, `gateway_anthropic.rs`, `gateway_gemini.rs`), four `Bridge` impls, one field.
`SynthBridge` lost its back-pointer and its `attach()`, and seven call sites went with them.

**Three new tests, each pinning a different half of the claim.**

- `a_bridge_answers_through_the_handle_it_was_handed_and_nothing_else` — a bridge with no core field
  answers a real HTTP request end to end. This is deliberately the shape the headless bridge will
  take, so the test states the contract as much as it checks the wiring.
- `the_bridge_holds_no_reference_that_keeps_the_core_alive` — asserted with a `Weak`, because that is
  the only way to state "it really was dropped" rather than "we believe nothing holds it". No server
  is started, deliberately: a spawned listener holds the core too, and the assertion would then be
  measuring task teardown timing instead of the reference graph. It also pins that a reply after the
  core is gone is a plain `false`, not a panic.
- `the_bridge_and_the_core_answer_into_the_same_place` — a terminal reply through the bridge's handle
  retires the registration `try_slot` made, asserted through the *other* door
  (`GatewayCore::reply`). Were they two maps, the core would go on offering to serve a finished
  request and the entry would never be freed.

`cargo test` **514 passed / 0 failed** (511 before); clippy `--all-targets -- -D warnings` and
`cargo fmt --check` clean; the headless build and the Tauri build both unaffected.

**Four falsifications, one of which is the measurement that gives this increment its point.** Handing
the bridge a *fresh* handle instead of the core's — the two-maps defect — fails the same-place test
immediately, and fails the end-to-end test after exactly **30.01 s**: `FIRST_MSG_TIMEOUT` observed
rather than quoted. That 30 seconds of a client waiting for a generic 503 is what a forgotten
`attach()` produced. Also falsified: making `reply` report success for an unregistered id (fails the
after-drop assertion), and giving the core a second owner (fails the `Weak` assertion, which proves
that check is not vacuous). Restored byte-identically after each run (`cmp -s`).

**One thing this increment found and did not fix.** `cargo check --no-default-features --all-targets`
fails with **33 errors**: `persist.rs:2349` calls `list_drift_events`, which is defined behind
`#[cfg(feature = "app")]` at `persist.rs:825`. Both mirrors build `--no-default-features` *without*
`--all-targets`, so the lib's test code is never compiled in that configuration and the failure stays
invisible. `core/`'s shipping code is Tauri-free — which is what the Phase 1 claim was about, and it
holds — but `core/`'s tests are not. Pre-existing rather than introduced here: `persist.rs` is
untouched by this increment (`git diff --name-only`), and `cargo check --no-default-features` without
`--all-targets` still passes. Recorded as **D17**, Open.

#### Increment 4 as built — the attempt budget and the terminal error (2026-09-23)

**`AllAttemptsFailedError` now has a home, and its arithmetic has exactly one implementation.** The
TypeScript spells the shortest-wait fold **twice** — as `minRetryAfterMs()` on the error
(`execution-engine.ts:220-227`) and as the engine's own reporting loop — and the two are the same
rule: drop a `0`/absent wait, floor at `COOLDOWN_FLOOR_MS`, take the minimum, return `0` when nothing
was named. Increment 1 had already ported that fold as `min_retry_after_ms`; the error's method now
**delegates** to it instead of carrying a second copy, and `the_error_reports_the_same_wait_as_the_free_fold`
walks seven chains to keep them one arithmetic. The realistic drift is a re-implementation that forgets
the floor — that is the falsification used, and it fails on the chain naming 400 ms (400 against 1000).

**The attempt budget, and the `??` that is not `||`.** `attempt_budget(plan_len, max_attempts:
Option<usize>)` ports `Math.min(args.plan.length, args.maxAttempts ?? MAX_ATTEMPTS_DEFAULT)`. The
`Option` is the point: `None` is "the caller named none" and takes the default of **6**, while
`Some(0)` is **zero** — no attempts, an empty chain, and a message that says `empty plan`. A port using
`||`, or one that pre-parsed an empty string into `0` and then treated `0` as falsy, would silently turn
"try nothing" into "try six". Same family as the clamp bug where `Number("")` comes out *unlimited*: an
absent value and a zero value are different facts, and a falsy test erases the difference. Falsified by
adding `.filter(|&n| n > 0)`.

**The wire spellings are now a checked contract rather than a convention.** `ErrorClass::as_str()`
returns the `errors.ts:5-14` strings verbatim, and `ALL_CLASSES` plus
`every_class_has_the_spelling_the_typescript_uses` compare the Rust list against the TypeScript union
spelled out in the test. The reason is concrete: `{:?}` yields `RateLimited` where every other surface —
the TypeScript, the audit notes, this book — says `RATE_LIMITED`, and a message rendering the Rust form
is a second vocabulary for one concept. Comparing sorted vectors covers a missing, an extra and a
duplicated spelling in one assertion, which is why there is no separate length or uniqueness test.

**Five more tests; `cargo test` 514 → 519 / 0.** Five falsifications, restores byte-identical.

**What the loop port must still preserve — read, not yet ported.** Three properties of `executeText` a
faithful Rust `Stream` has to reproduce, none of them touched by this increment:

- **The terminal failure is thrown on *drain*, not on call.** `throw new AllAttemptsFailedError(...)`
  sits at `execution-engine.ts:141-143`, *inside* the async generator, after the loop. `executeText`
  itself returns a `TextExecution` successfully; a caller that never drains `chunks` never learns the
  plan failed. The Rust equivalent is a `Stream` whose last item is a terminal `Err` — a port returning
  `Result<Stream, E>` would report the failure at the wrong moment.
- **An aborted signal ends the stream silently** (`:80` and `:133` are plain `return`s). So "ended with
  no output and no error" is a legal terminal state, and a port that turned it into an error would turn
  a cancellation into a failure.
- **`if (!served)` at `:141` cannot be false.** `served` is assigned only inside `if (!emitted)`, and
  every path that sets `emitted` either returns at `:107` or rethrows at `:115`. This is an *inspection*
  of those four paths, not a measurement — stated as one so it can be checked rather than trusted. It is
  the same class of no-op guard as `recordResult`'s `else if`: harmless in TypeScript, and a hazard to
  port literally, because a reader would infer a state that cannot exist.

#### Increment 5 as built — the per-provider limiter (2026-09-23)

`core/limiter.rs`, a new file, 22 tests. `cargo test` 519 → **541 / 0**.

**The gap it closes was not a porting gap.** Before this increment, `per_provider_concurrency`
appeared **nowhere** in the Rust tree — a Grep over `apps/desktop/src-tauri` returns nothing. Audit
finding R3 is implemented in TypeScript only, so the Rust gateway has the one global semaphore and no
per-provider cap at all. That is precisely the starvation `concurrency.ts`'s own header describes: a
global bound cannot see providers, so one slow or rate-limited provider can hold every permit. This
increment is therefore the first one that **adds** a behaviour to the Rust side rather than relocating
one, and the plan's "no behaviour change" constraint does not apply to it in the usual direction —
there was nothing here to preserve.

**It is a separate file, not another section of `engine.rs`.** `engine.rs` is the port's *pure* half —
a taxonomy, two arithmetic folds, and no state. `ProviderLimiter` is the only piece of the six
dependency modules that is **shared mutable state across threads**, and the hazard that comes with it
(the check-then-act race below) is a different hazard from the ones in `engine.rs`. Grouping by kind
rather than by "which TypeScript file it came from" is what makes the race visible to the next reader.
`engine.rs`'s header now points at it.

**Three places the port deliberately differs.**

- **The release is RAII, and still idempotent.** TypeScript returns `(() => void) | null`; a call site
  that forgets to call it holds the slot for the lifetime of the process and nothing reports it.
  `acquire` returns a `Permit` that releases on `Drop`, so the forgettable step is gone.
  `Permit::release` remains callable and idempotent, so the double-release case is still representable
  and still tested, and `Drop` calls that same method.
- **The check and the increment are one critical section.** `concurrency.ts:75-76` is
  `if (!this.hasCapacity(id)) return null;` then `this.inFlight.set(...)`. That is atomic there
  because JavaScript runs one thread. Here it is a race, and a literal translation admits more than the
  cap. `has_capacity` is consequently **advisory only** and must not be used to gate an acquire; its
  doc-comment says so, because rewriting `acquire` as `if !self.has_capacity(p) { return None }` is
  exactly how the race would come back.
- **The cap is `usize`.** In TypeScript `-1` satisfies `maxPerProvider <= 0` and so behaves as
  *unlimited* while displaying as a bound — the hazard `clampConcurrency` exists to catch. The type
  removes it. `clamp_concurrency` still rejects a stored negative, because a stored value is untrusted
  input from the settings blob (`model-router.ts:85` hydrates it with no validation), not a number this
  program produced.

**The finiteness check is load-bearing, not defensive.** `"Infinity"` parses to `f64::INFINITY` and
`"NaN"` to `f64::NAN`, and `f64::min` **ignores a `NaN` operand** — so without the check both would
clamp to `MAX_PER_PROVIDER`, turning a corrupted string into the largest cap the program allows. The
test `a_string_that_parses_to_a_non_finite_number_falls_back_rather_than_to_the_maximum` pins it, and
deleting the check fires it.

**One documented divergence.** JavaScript's `Number("0x10")` is `16` and `Number("0o7")` is `7`;
`str::parse::<f64>()` rejects both, so they fall back to the default here. Neither is a concurrency cap
a person types, and matching `Number()`'s coercion table would mean accepting spellings nobody
intended — but a port that differs silently is worse than one that differs loudly, so it is tested
(`a_hex_string_is_rejected_where_javascript_would_coerce_it`).

**Six falsifications, all fired, restores byte-identical.** Splitting the check from the increment into
two locks fails `the_cap_holds_under_concurrent_acquires` in **5 of 5 runs** — the test is exact rather
than statistical, because no permit is released until all 64 threads have finished deciding, so the
number of simultaneous holders is precisely the cap for a correct implementation and can only exceed it
for a racy one. Removing the `released` guard fails `an_explicit_release_followed_by_drop_counts_once`.
Clamping a negative to zero instead of falling back fails `rejects_a_negative_rather_than_letting_it_mean_unlimited`.
Flooring zero to one fails `keeps_zero_because_it_means_unlimited`. Removing `impl Drop` fails
`dropping_a_permit_returns_the_slot`. Removing the finiteness check fails the non-finite test.

**The four tests that failed on the first run were the port announcing itself.** They were written as
`assert!(lim.acquire("p1").is_some())`, which binds the `Option` and drops the `Permit` at the end of
the statement — so the slot came back immediately and the cap was never under pressure. That is the
RAII difference made concrete: in TypeScript an ignored `acquire` return value holds the slot forever,
and here it releases at once. The worst case for a careless caller is therefore that the cap is not
enforced for one attempt — **fail-open, not fail-closed** — and `Option` being `#[must_use]` makes the
careless call site a compiler warning too. `a_permit_that_is_never_bound_cannot_leak_capacity` pins it.

**A finding about the TypeScript suite: its idempotence test does not test idempotence.** Recorded as
[D18](07-drift-register.md). Deleting the `released` flag from `concurrency.ts:77-80` leaves
`release is idempotent — a double release cannot leak capacity` **passing** — measured 2026-09-23, 1
passed and 272 skipped. With a cap of 1 the count is already 0 and the entry already deleted after the
first release, so the second and third calls take the "delete at zero" branch again and change nothing.
The property only bites with **two** permits held, where a double release drops the count from 2 to 0
while the other permit is still in flight and the limiter then admits two more. The Rust port keeps the
weak test for fidelity, marks it as weak in place, and carries the property in
`an_explicit_release_followed_by_drop_counts_once` — which is the one the falsification fires.

**Preserved, for the loop port.** A skipped candidate is reported with class `RATE_LIMITED` and status
`429` (`execution-engine.ts:85`, `:169`) even though the provider was never contacted and may be
perfectly healthy — it is saturated by our own in-flight count. The port keeps that, because the class
drives the client-facing `Retry-After` and a saturated provider genuinely does want a wait. It does
mean the reported chain cannot distinguish "we never tried" from "the provider said 429", which is a
fidelity gap rather than a bug, and Phase 3 inherits it.

**Still not ported, and still blocked on Phase 3.** The attempt loop and the streaming half. The
limiter's *consumer* is the loop (`:83-87`, `:167-171`), so this increment ports the decision and not
its use; nothing in the shipping gateway consults the limiter yet.

#### Increment 6 as built — the per-attempt policy (2026-09-23)

**The increment was redirected by a gap-check, then scoped by measuring `Candidate`.** The plan's Phase 2
dependency table names six modules; five are landed and the sixth is `manifest-interpreter.ts` (491 lines).
Measured before writing any code:

| what | measurement |
|---|---|
| `manifest-interpreter.ts` in Rust | **Nothing.** A Grep for `manifestVersion`, `requestTemplate` and `modalityRules` over the Rust tree matches no file. The only manifest awareness is `manifest_forwards_tools` (`tauri/workbuddy.rs:145-152`), a shallow single-purpose probe reading `endpoints.generateText.requestTemplate.tools` — and it lives in `tauri/`, not `core/` |
| `Candidate`, the engine's other import | `{provider, key, model}` (`route-planner.ts:13-17`) — Phase 3's type, assembled from three `domain.ts` types |
| `ports.ts` shapes | already realised: `UsageTokens.cached_tokens` is `LedgerRow.cached_tokens` plus `BridgeMsg::Usage` |
| `adapter-instance.ts` | a trait written over `manifest-interpreter.ts`'s types, so it cannot land alone |

So the adapter layer is genuinely blocked, and `Candidate` would be a scope expansion into Phase 3. What is
**not** blocked is everything `executeText` decides *between* attempts — which is the last piece of the
engine that needs no adapter layer. That is increment 6.

**The rule the TypeScript spells twice.** `executeText` classifies a caught error in two places, and the two
expressions are not the same rule:

| site | expression |
|---|---|
| `:113` — already emitted | only `classify(status) === "OK"` forces `PARSE_ERROR` |
| `:118` — not yet emitted | the failure kind `mid-stream` **or** `classify(status) === "OK"` forces `PARSE_ERROR` |

Executed against the real `classify` — not transcribed; the control imports `errors.ts` and evaluates both
expressions verbatim — the two disagree:

| kind | status | `:113` | `:118` |
|---|---|---|---|
| mid-stream | 200 | `PARSE_ERROR` | `PARSE_ERROR` |
| mid-stream | 429 | `RATE_LIMITED` | `PARSE_ERROR` |
| mid-stream | 503 | `SERVER_ERROR` | `PARSE_ERROR` |

They agree on the one input a producer emits, and *only* because `manifest-interpreter.ts:360` hardcodes the
status: `new ManifestHttpError(200, …, "mid-stream")` is the sole mid-stream construction site, and the other
two pass a real status. **Latent, not live** — recorded as D19. The port states the rule once, takes the
`:118` spelling because it does not depend on a constant chosen at a throw site, and
`the_two_spellings_agree_only_because_the_midstream_producer_reports_two_hundred` pins the choice.

**What landed** (`core/engine.rs`, +204 lines): `FailureKind`, `AttemptError`, `classify_attempt_error`,
`AttemptDisposition`, `attempt_disposition`, `attempt_outcome`, `records_key_health`, `saturated_outcome`,
`CandidateGate` and `candidate_gate`. Thirteen tests; `cargo test` 541 → **554 / 0**.

**Four invariants the port had to state, each with a test.**

1. **A `2xx` that threw is `PARSE_ERROR`, not `OK`.** A provider that answers `200` and then throws has a
   body we could not read; calling it `OK` would make the loop treat a broken stream as a served request.
2. **`emitted` is checked before `aborted`.** Once a byte has reached the consumer the request can neither be
   retried nor quietly abandoned — the caller holds partial output, so a cancelled stream that had already
   produced text *rethrows* rather than stopping.
3. **The rethrown path drops its retry hint.** The mid-stream path rethrows, so a wait it will never honour
   would be noise in the chain; the TypeScript says so by omission (`:114` pushes no `retryAfterMs`) while
   both other paths carry it.
4. **The R3 skip is recorded in the chain and deliberately not in key health.** `RATE_LIMITED` is exactly the
   class `record_result` cools a key on, so omitting the skip is a decision rather than a no-op —
   `a_saturated_provider_is_reported_as_rate_limited_429_and_is_not_a_key_problem` asserts the contrast that
   proves it. This is the limiter's first written contract: increment 5 ported the decision and had no
   consumer to define its use.

**A fifth invariant is a dependency between two functions, so it is asserted rather than assumed.** The
mid-stream path records the outcome in the chain but never in key health. That is safe only while every
mid-stream failure is a drift class, which `record_result` ignores — so
`a_rethrown_failure_is_always_a_drift_class_so_skipping_health_cannot_lose_a_cooldown` walks all ten statuses,
classifies each as a mid-stream failure, records it, and asserts the key is still usable; then does the
opposite with `RATE_LIMITED`, to show the rule is not vacuous.

**Seven falsifications, all fired, every restore byte-identical.** Rule 2 removed; rule 3 removed; the
disposition order swapped; the rethrown path keeping its hint; `records_key_health` no longer exempting
`Rethrow`; the saturated status changed to `500`; the gate order swapped. Each failed exactly the test naming
its mechanism (exit 101), and `cmp` confirmed the restore.

**What this narrows.** The previous subsection records the attempt loop as "still blocked on Phase 3".
Increment 6 lands the part of it that is not: the loop's *policy* is now complete, and what remains is the
adapter call itself — `AdapterInstance` over `manifest-interpreter.ts`'s types — plus `Candidate`, which is
Phase 3's type. The streaming half is unchanged.

### Phase 3 — Port the model router and route planner (2-3 days)

**Goal:** rewrite `model-router.ts` and `route-planner.ts` in Rust.

These are less risky than the execution engine — they are synchronous, stateful logic without async
streams. The main challenge is the registry and catalog data structures, which today live in JS
memory and are hydrated from SQLite.

In Rust they become structs loaded from `store.rs` on startup and kept in an `Arc<RwLock<_>>`.

### Phase 4 — Port context compression (2-3 days)

**Goal:** rewrite `context-compress.ts` in Rust.

Tier 1 (trimming turns) is pure logic — port directly.

Tier 2 (summarization) is harder: it makes an AI call. In Rust this means the compression module
calls the execution engine recursively. The `skipCompression` flag (`model-router.ts:108`, the option
on the request; the branch that honours it is `:134`, and the caller that sets it is
`Assistant.tsx:100`) prevents infinite recursion. **It does not exist in Rust yet.** There is no
compression path in `src-tauri` at all — measured 2026-09-23, a Grep for `compress` and `summari[sz]`
over the tree matches one unrelated doc comment, and `trim`, `compact`, `drop_turn` and
`reduce_context` match only string `.trim()` calls. Phase 4 must introduce the compression and the
guard together, and the guard is the part that is easy to leave out because its absence is invisible
until the first summary recurses. See D20.

### Phase 5 — Delete the bridge (1 day)

**Goal:** remove `gateway_cmds.rs` bridge code, `gateway-worker.ts`, `gateway.html`, and `app_nap.rs`.

This is the satisfying phase. The gateway routes directly into the Rust router core. No hidden
webview. No Tauri events. No heartbeat.

### Phase 6 — Process manager and UI changes (2-3 days)

**Goal:** launchd plist, service binary bundling, UI HTTP client.

1. Write the plist template and the install logic.
2. Bundle `aiproviderd` into the `.app` (Tauri's `bundle.externalBin` or manual copy).
3. Change the UI from `invoke` to `fetch()` for gateway operations.
4. Add CORS headers to the gateway for `tauri://localhost`.
5. Update `09-status.md` and the drift register.

---

## 8. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Execution engine port introduces bugs** | High | Critical | Port tests first; keep JS implementation behind a feature flag; run both in parallel for one release |
| **Adapter runtime (QuickJS-WASM) is hard to port** | Medium | High | Evaluate `rquickjs` or `boa` crates; fallback: keep Tier-2 adapters in a sandboxed subprocess |
| **SQLite concurrent access deadlocks** | Low | High | WAL mode is already on; add connection pooling; test with `cargo test` under `tokio::task::spawn` |
| ** launchd plist gets out of sync with binary path** | Medium | Medium | The template above points `ProgramArguments` at an absolute path **inside** the bundle (`/Applications/AI-Provider Router.app/Contents/MacOS/aiproviderd`), so anything that moves the bundle — a versioned install path, an atomic directory swap — leaves the job pointing at a path that no longer exists. Remedies, in order of preference: (1) put the binary at a fixed path **outside** the bundle, or behind a stable symlink, and point the plist there; (2) have the updater run `launchctl bootout` before the swap and `launchctl bootstrap` after it. "Check the path and rewrite the plist if the bundle moved" is the weakest of the three, because it only helps once the app is running again. Note that `KeepAlive` **throttles**, and can leave the job disabled after repeated failed execs, so a path that is briefly missing during a swap is not self-healing |
| **UI → service discovery fails on first install** | Medium | Medium | Graceful degradation: UI shows "service not running" with manual start instructions |
| **CORS misconfiguration blocks UI in dev** | High | Low | Dev mode allows `*`; production allows `tauri://localhost` only |
| **Bundle size increases** | High | Low | Service binary is ~5MB stripped; acceptable |
| **Migration rollback is hard** | Low | High | Keep the Tauri bridge code behind a `webview-gateway` feature flag for one release |

---

## 9. Test strategy

### 9.1 What must be re-tested

Every gateway test in `gateway_tests.rs` (**113** tests, re-measured 2026-09-23 — this plan said 104,
inherited from the task prompt; the crate total is **489**) must pass against the Rust-native engine.
The synthetic bridge (`SynthBridge`) is replaced with the real router core.

### 9.2 New tests needed

| Test | Why |
|---|---|
| Service starts without Tauri | `aiproviderd --version` exits 0 |
| Service survives UI process death | Start service, kill UI, `curl /health` still 200 |
| Service restarts on crash | `kill -9` the service, launchd restarts it within 5s |
| UI reconnects after service restart | Kill service, wait for restart, UI auto-reconnects |
| Concurrent SQLite access | 10 parallel requests, no `DatabaseBusy` |
| CORS preflight | `OPTIONS` request from `tauri://localhost` returns 204 |

### 9.3 The feature-flag safety net

For one release, keep both code paths:

```rust
// In gateway.rs
#[cfg(feature = "webview-gateway")]
fn route_request(req: Request) -> Response {
    // Today: dispatch to bridge
}

#[cfg(not(feature = "webview-gateway"))]
fn route_request(req: Request) -> Response {
    // New: direct Rust router core
}
```

The Tauri app builds with `--features webview-gateway` (default). The service binary builds without
it. This lets the team roll back by reverting one line in `Cargo.toml`.

---

## 10. Decisions needed

1. **Do we port the adapter runtime (QuickJS-WASM) to Rust, or sandbox it in a subprocess?**
   - Port: single binary, simpler deployment, but `rquickjs` is immature.
   - Subprocess: keep JS adapters in a worker, but add IPC overhead.
   - *Recommendation:* evaluate `rquickjs` in a spike (1 day). If it passes the contract suite, port.
   If not, subprocess.

2. **Do we keep the Tauri app as a pure HTTP client, or keep a subset of IPC for performance?**
   - Pure HTTP: simpler, consistent, no special cases.
   - Hybrid HTTP+IPC: keep IPC for hot paths (settings read), HTTP for gateway operations.
   - *Recommendation:* pure HTTP. The latency difference is not perceptible, and hybrid creates two
   contracts to maintain.

3. **Do we ship the service as a separate downloadable, or bundle it inside the `.app`?**
   - Separate: smaller app bundle, but two downloads to manage.
   - Bundled: one `.app`, one update channel, but larger.
   - *Recommendation:* bundled. The binary is small (~5MB), and one artefact is simpler for users.

4. **What is the minimum viable port?**
   - Full port: everything in Rust, no JS in the gateway path.
   - Hybrid: keep the router core in JS, but run it in a separate process via `deno` or `node`.
   - *Recommendation:* full port. A hybrid still has a JS process that can crash, and the whole
   point is to eliminate the webview as a failure mode.

---

## 11. Effort estimate

| Phase | Days | Cumulative |
|---|---|---|
| 1 — Extract core library | 1-2 | 2 |
| 2 — Port execution engine | 3-5 | 7 |
| 3 — Port router + planner | 2-3 | 10 |
| 4 — Port context compression | 2-3 | 13 |
| 5 — Delete bridge | 1 | 14 |
| 6 — Process manager + UI | 2-3 | 17 |
| **Buffer (testing, edge cases)** | 3 | **20** |

**Total: 3-4 weeks of focused development.**

This is an all-at-once change, not an incremental one. The bridge is the boundary, and the router
core is on one side of it. You cannot move it piecemeal — half the engine in Rust and half in JS
would need a second bridge between them.

---

## 12. What we know we do not know

- Whether `rquickjs` (or `boa`) can run the existing Tier-2 adapter sandbox. The contract suite is
the test; until it is run, this is an open question.
- Whether the summarization call in context compression (Tier 2) works correctly when the engine
calls itself recursively. The `skipCompression` flag is designed for this, but recursive async
calls in Rust are harder to reason about than in JS.
- Whether launchd's `KeepAlive` behaves correctly when the binary is inside an `.app` bundle that
is updated (the path changes). This needs a real update cycle to verify.

---

## 13. Where this plan lives

This is a plan, not a specification. When implementation starts, each phase gets its own design
document in `docs/` and its own branch. This chapter is updated as decisions are made and
assumptions are tested.

**Next action:** answer the four decisions in §10, then begin Phase 1 (extract core library).
