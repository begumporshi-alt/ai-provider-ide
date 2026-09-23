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
| `ports.ts` shapes | **half realised, and the missing half is the third field (D23).** `UsageTokens` has three fields; `LedgerRow.cached_tokens` is one of them and `BridgeMsg::Usage` is the other two — the bridge variant has no `cached_tokens` at all (`gateway.rs:365-368`). Increment 8 lands the single shape in `core::usage` |
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
Increment 6 lands the part of it that is not: the loop's *policy* is now complete. At the time, what remained
was the adapter call itself — `AdapterInstance` over `manifest-interpreter.ts`'s types — plus `Candidate`,
described here as "Phase 3's type". **Increment 7 discharges both for the image path**, and shows the second
half of that description was wrong: `Candidate`'s three row types already existed in `persist.rs`, and only
its *name* belonged to something else (D21).

#### Increment 7 as built — the adapter seam and the image loop (2026-09-23)

**What landed.** `core/adapter.rs` — `Cancel` (the `AbortSignal` port), `ImageArgs`, `ImageReply`, and the two
traits `AdapterInstance` / `AdapterFactory` — and `engine::execute_image` over them, together with
`engine::Candidate`. This is the first Phase 2 increment to cross the line increments 1–6 held deliberately: it
is `async`, it calls out, and it is the first consumer of `core::limiter`'s cap and of increment 6's
`saturated_outcome`.

**The seam is half the source, and it says so now.** `adapter-instance.ts` declares seven members;
`execution-engine.ts` calls exactly two — `generateImage` (`:174`) and `generateText` (`:91`). Only
`generate_image` is here, and the reason is not effort. `TextArgs` carries `messages`, `tools`, `toolChoice`
and `responseFormat` as `unknown`, plus an `onUsage` callback that is load-bearing: dropping the caller's
callback is how every gateway response came to report `usage: null` (`:93-96`). On this side those `unknown`s
become `serde_json::Value` and the callbacks become owned closures, and `onUsage` would introduce a **second**
usage shape beside the `BridgeMsg::Usage` the crate already has (`gateway.rs:366`). That is the
two-spellings-of-one-state defect this project keeps finding (D19, D21), so the text half waits for the shape
to be decided rather than being invented here and unravelled later. **The first correction in this increment
was to the doc comment**: it read "what the execution engine needs from a provider adapter, and nothing more",
which was true of surplus and false of completeness. It now names which half it is.

**The name had to be freed before the type could land.** `engine::Candidate` is `{provider, key, model}`
(`route-planner.ts:13-17`), and its three row types already existed (`persist.rs:33`, `:176`, `:321`) — so the
shape needed nothing new. The *name* did: `context_scope.rs` already owned it for a recalled memory headed for
the prompt. Two further collisions sat behind it, latent only because they are cross-language —
`CHARS_PER_TOKEN` is **3.5** here and **4** there, `RESERVE_FRACTION` is **0.20** here and **0.25** there,
while `DEFAULT_WINDOW_TOKENS` agrees at 8192 *deliberately* (`context-compress.ts:32-34`). All three are D21.
The TypeScript is this port's reference and cannot move, so the Rust-only names gave way: `MemoryItem`,
`MEMORY_CHARS_PER_TOKEN`, `MEMORY_RESERVE_FRACTION`. `SkipReason::NoCandidates` was **left alone on purpose** —
its string `"no_candidates"` is written into the `aip-memory` response header (`apply_memory_headers:447`), so
renaming the variant would have meant either a wire change or a name contradicting its own value. The rename
is compiler-verified and behaviour-preserving: `cargo test` was **554/0 before and 554/0 after**, no test
touched.

**Four properties the loop has to keep.**

1. **Cancellation is checked before the cap** (`:165` then `:167`). Observable, and pinned by the
   *distinguishing* case rather than the easy one: with a saturated limiter **and** a cancelled request, a port
   that took the slot first would record a `RATE_LIMITED` skip, and this one leaves the chain empty.
2. **The native model id reaches the adapter, never the requested name.** `:176` sends `c.model.nativeId`;
   `args.model` exists only to name a failure. A port that sent the requested name would pass every other test
   in the block.
3. **A saturation skip is recorded, not merely skipped** — `RATE_LIMITED`/`429` from `saturated_outcome`,
   though the provider was never contacted.
4. **The permit comes back on both the served and the failed path.** The TypeScript's `finally` (`:189-191`) is
   `Permit`'s `Drop` here; a port that released only on success would leak one slot per failure until the
   provider stopped being admitted at all.

**Two properties it inherits from the TypeScript, one of them a live defect — D22.**

- **Live.** `generateImage` returns `{ok: false, status, errorBody}` for `>= 400`
  (`manifest-interpreter.ts:461`) and never calls `retryAfterFrom`, though `res.headers` is in scope on that
  line — while `listModels` (`:246`) and `generateText` (`:304`) both pass it. `ImageAttemptResult` (`:57-60`)
  has **no field** for it, so the wait cannot travel even in principle. `executeImage` therefore records an
  outcome with no `retry_after_ms` (`:184`), `recordResult` falls through to the 1000 ms floor, and a
  `429 Retry-After: 30` on the image path is retried after one second. That is the exact failure the text
  path's own fix describes at `:126-128` — "a key that asked for a minute is retried a second later — straight
  back into the window it was told to wait out" — one path away. It reaches the client too: no image attempt
  can name a wait, so `minRetryAfterMs()` is **0** for an image-only chain and the client is told nothing.
- **Latent.** `catch {}` (`:186`) names `NETWORK`/`0` and keeps nothing the error carried, where `:117-121`
  classifies a thrown `ManifestHttpError` by its status. The two agree only because a status-bearing refusal is
  **returned** rather than thrown, so that arm is never reached with a status — the same shape as D19, where a
  rule's two spellings agree only because of a constant at a producer.

**The port keeps the image path's behaviour in both cases**, which is what makes Rust and TypeScript
comparable, and pins each with a test that cites D22. The fix belongs in `manifest-interpreter.ts:461` plus the
`ImageAttemptResult` shape, and would correct both implementations at once; fixing it in Rust alone would
create a silent behavioural difference between the two, which is the defect class this book keeps recording.

**Twelve falsifications, all fired, every restore byte-identical.** The cancel check moved after the cap; the
requested name sent instead of the native id; the adapter error classified instead of called `Network`; a
refusal treated as a success; the refusal recording a named wait; the refusal's status recorded as `200`; a
named zero budget becoming the default; a saturation skip not recorded; the permit leaked on the failure path;
a failing factory recorded as rate-limited; an empty chain rendered as `[]`; and `Cancel::clone` copying the
flag instead of sharing it.

**What this narrows.** Increment 6 recorded the remaining work as "the adapter call itself — `AdapterInstance`
over `manifest-interpreter.ts`'s types — plus `Candidate`, which is Phase 3's type". Both halves of that
sentence are now discharged for the **image** path, and neither is for the text path. What remains is the
streaming half: a `Stream` adapter for `chunks: AsyncIterable<string>`, which is blocked on the same `TextArgs`
shape as above and nothing else. One gap is *unblocked but deliberately not closed*: `AttemptOutcome` still
cannot name the provider it tried, because in Rust the faithful shape clones three owned rows per failed
attempt where the TypeScript copies a reference — the cheap alternative is to carry the `slug/label` string
`describe` actually reads, and that is a decision rather than a port step.

#### Increment 8 as built — the usage shape (2026-09-23)

**The increment is the blocker, not a step toward it.** Increment 7's own note ends by saying the streaming half
is blocked on the `TextArgs`/`usage` shape. Increment 8 settles that shape and nothing else: one new module of
144 lines, against increment 7's 2,327 insertions across eleven files. The ratio is the point — the expensive part
of the text half is the *streaming* shape, and this removes the other blocker so the next increment has one open
question instead of two.

**What landed.** `core/usage.rs` holds `UsageTokens` — `prompt_tokens: u64`, `completion_tokens: u64`,
`cached_tokens: Option<u64>` — the Rust port of `ports.ts:106-117`, plus the two accessors that name where each
field goes: `counts()` for the pair a client sees, `cached_for_ledger()` for the `Option<i64>` the column takes.
Six tests; `cargo test` **569 → 575/0**, the predicted count exactly.

**Why the third field decided it, rather than the first two.** `UsageTokens` has three fields and the crate's only
usage type has two. A Grep for `UsageTokens`, `struct Usage` and `TokenUsage` over `src-tauri/src` matches **no
file**, so `BridgeMsg::Usage` (`gateway.rs:365-368`) is what a porter would reach for — and it has nowhere to put
`cached_tokens`, the field migration 0015 and the entire prompt-cache measurement exist to capture. That is D23.
The subtlety worth keeping is that the crate is *not* losing the measurement today, and the reason is what makes
the gap look like nothing: **the ledger is not written through the bridge.** The webview's router reads
`exec.usage()?.cached_tokens` in process (`model-router.ts:435`, `:519`) and writes the row itself, while the
two-field `gateway_usage` forward (`gateway-bridge.ts:299-305`) feeds only the response body. So the same
asymmetry costs a **client** a field it cannot derive, and would cost a **porter** the measurement. The
client-facing half was already recorded (`09-status.md:179`); D23 records the port-planning half, which was not.

**The absence/zero distinction is carried by the type, not by a comment.** `cached_tokens: Option<u64>` is what
makes "the provider reported no cache block" unrepresentable as `Some(0)`, and `cached_for_ledger` keeps `None` as
`None` so the column receives SQL `NULL` rather than a forged zero. The cast is `as` rather than
`i64::try_from(..).ok()`, and the tidier-looking alternative is worse: it would turn an out-of-range count into
`None`, which is indistinguishable from "reported nothing" — a wrong number is recoverable, a wrong state is not.

**One property has no runtime test, and the tests say so.** No assertion can see a field that does not exist yet.
What can is an exhaustive struct literal: a fourth field breaks every construction in the module, which forces a
decision about which boundary carries it. `every_field_reaches_one_of_the_two_boundaries` keeps that literal
exhaustive and says in its own doc comment that the assertions are the readable half and the literal is the
load-bearing one. The falsification run is where that stops being a claim: the mutation making the third field
non-optional is rejected by the *compiler* rather than by a test, and the rejection is the guard firing.

**Six falsifications.** Five fail a named test — forging absence into zero, swapping the two counts, doubling the
prompt count, discarding every cache count as unreported, and a constructor that ignores its third argument — and
the sixth is the compile-time one above. Every restore verified byte-identical to the baseline hash.

**What this narrows.** The `TextArgs` shape is decided: `on_usage` carries `core::usage::UsageTokens`. What
remains is the streaming shape itself, and one question this increment made visible rather than answered — the
text loop must outlive the call that starts it, so `execute_image`'s `&mut HealthTracker` borrow is not available
to it, and how the loop owns its mutable state is a design decision rather than a translation.

#### Increment 9 as built — the text half of the adapter seam (2026-09-23)

**The seam is now whole for both members the engine calls.** `adapter-instance.ts` declares seven;
`execution-engine.ts` calls two — `generateImage` (`:174`) and `generateText` (`:91`). Increment 7 landed the
image half, this lands the text half, so `AdapterInstance` is complete with respect to its only consumer. The
other five (`capabilities`, `tagModality`, `listModels`, `pingKey`, `dispose`) stay absent, and their absence is
now stated once in the module doc instead of being re-derived at each reading.

**What landed.** Three shapes in `core/adapter.rs`: `ToolCall` (`ports.ts:50-57`), `TextArgs<'a>`
(`manifest-interpreter.ts:70-91`) and `AdapterInstance::generate_text`. Eight tests against one new double.
`cargo test` **575 → 583/0**: the seven the seam was scoped for, plus one the double's own first draft earned
(below). That arithmetic is how a trait addition is proven real rather than assumed.

**The one design decision, and it was a decision rather than a translation: pull, not push.** `generate_text`
returns `BoxFuture<Result<BoxStream<'a, Result<String, AttemptError>>, AttemptError>>`. The crate's *other* text
path is push-based — `ReplyHandle` plus an `mpsc` channel (`gateway.rs:566-640`) — so the port had a precedent
available and did not take it. The reason is cancellation: a pull stream is driven by the engine, so the engine
decides when to stop asking, which makes cancellation an engine-owned check rather than a flag every adapter must
remember to honour. The TypeScript is a pull generator for the same reason (`adapter-instance.ts:21`).

**Two phases, and the split is the whole design.** Awaiting the returned future is the *response* phase — a
refusal is `Err`, before a byte reaches the caller. Polling the stream is the *mid-stream* phase — a break is
`Err` as an **item**, because by then the consumer already holds text and re-running the attempt would show it the
text twice. Those are exactly `FailureKind::Response` and `FailureKind::MidStream`, and the engine's
classification turns on which one it saw: mid-stream → `ParseError` whatever the status; response → the status
decides. `the_two_phases_stay_separable_when_the_status_is_identical` gives both a `429` and asserts the two
classes differ, because a seam that collapsed the kinds would make the distinction unrecoverable downstream — and
`RateLimited` cools a key where `ParseError` does not.

**`TextArgs` keeps its callbacks because the TypeScript puts them there, and the lifetime is the price.**
`on_tool_call` and `on_usage` are `Option<&'a mut (dyn FnMut(..) + Send)>`, which is what makes `TextArgs<'a>`
parameterised rather than split into a sibling argument. The faithful shape was worth it: one struct carrying the
same ten fields as its source is checkable against that source, where two structs require the reader to re-derive
why the split is where it is. The cost is stated rather than hidden — **`TextArgs` has no derives**, because
`dyn FnMut` is neither `Debug`, `Clone` nor `Eq`.

**Neither trait method has a default body, and the compiler enforced that here.** Adding `generate_text` broke
exactly one implementor outside the new code — the image double at `engine.rs:1539` — with `E0046: not all trait
items implemented, missing: generate_text`. That is the method-shaped analogue of `core/usage.rs`'s exhaustive
struct literal: adding a member is a compile error at every implementor, which forces a decision about what that
implementor *means* by it. The decision was written down — the double is the image half's, so it fails loudly on
the response phase rather than answering an empty stream that reads like a model saying nothing — instead of being
defaulted away. A default body would have made the same addition silent, which is the whole reason there is none.

**One friction the seam owns, found by the compiler rather than by review.** `Result::unwrap_err` requires the
*Ok* type to be `Debug`, and a `BoxStream` is not — so `Result<BoxStream<..>, AttemptError>` cannot use
`unwrap_err`, and every consumer, `execute_text` included, must `match`. The test was rewritten to match
explicitly, which is also the stronger assertion: it names the phase rather than trusting that whatever came back
was the error arm.

**The double was wrong first, and no compiler could have caught it.** The first draft fired both callbacks while
the *future* resolved — the source's **non-stream** branch (`manifest-interpreter.ts:312-329`) — behind a
`TextArgs` whose `stream` field said `true`. The stream branch fires them in the loop's `finally` (`:424`,
`:430`), after the last chunk. That is not cosmetic infidelity: a consumer that read usage without draining would
have gone green against this double and failed against every real adapter, and that consumer is `execute_text` —
the very next thing to be written. The double now *takes* the callbacks and fires them when the inner stream
reports exhaustion, exactly once, in the source's order (tool calls before usage), and
`the_callbacks_fire_when_the_stream_ends_and_not_when_the_future_resolves` asserts the **moment** rather than the
value: the log is empty once the future resolves and holds both entries after the drain. The lesson is an old one
in a new shape — a test double is an adapter implementation, so it owes the same contract, and a field it is
handed is not decoration.

**Eight falsifications.** Six fail a named test — flattening a response-phase refusal into an empty stream,
hoisting a mid-stream break into the response phase, making the classifier read only the status, flattening an
unreported cache block to a reported zero, dropping a tool call's `arguments` on the way to its callback, and
firing the callbacks while the future resolves — and two are rejected by the *compiler*: an implementor missing
the new member, and the usage callback reverted to a two-field payload. Every restore verified byte-identical to
the baseline hash. The last one is increment 8's guard re-tested at a new boundary: `on_usage` carrying
`UsageTokens` rather than a bare pair is load-bearing, and reverting it is unrepresentable rather than merely
untested.

**What this narrows.** The seam is complete; what remains of Phase 2 is the loop over it — `engine::execute_text`.
One question is now visible and *not* answered: the text loop must outlive the call that starts it, so
`execute_image`'s `&mut HealthTracker` borrow (`:559`) is not available to it. Three shapes are open — lend the
state to the returned stream (`execute_text<'a>(health: &'a mut HealthTracker, ..) -> BoxStream<'a, ..>`, which
means the caller cannot touch health while draining), own it behind interior mutability, or invert the direction
and take a sink. The TypeScript answers none of this, because a generator borrows its enclosing scope for free —
which is exactly the affordance Rust does not have. That makes it a design decision with three named options
rather than a translation.

### Increment 10 as built — the text loop over the seam (2026-09-23)

**What landed:** `engine::execute_text` and its three shapes — `ExecuteTextArgs<'a>`, `TextSuccess` and
`TextFailure`. This is the last piece of Phase 2: the seam had both members the engine calls, and this is the
loop over them. `cargo test` **583 → 596**.

**The sink is the increment's one real shape decision, and it is a deviation from the source.** `executeText`
returns `TextExecution { chunks: AsyncGenerator }` — a *pull* stream the caller iterates. This takes
`on_chunk: &mut dyn FnMut(&str)` and runs to completion. Two reasons, both structural:

1. The source's generator is not a plain generator. `yield chunk` sits inside an `await`-driven retry loop, so a
   pull port would have to express "await the factory, then await `generate_text`, then poll its stream, then
   decide whether to retry" as a hand-written state machine — and there is no `async-stream` dependency, which
   this port may not add.
2. A pull port cannot report plan exhaustion honestly. The source *throws* `AllAttemptsFailedError` from inside
   the generator (`:141-143`), and a `BoxStream<Item = Result<String, AttemptError>>` has no room for it. The
   alternatives are widening the item type or leaving the caller to infer exhaustion from an empty stream — and
   the second is how a failed request becomes a `200` with no body.

The cost is stated rather than hidden: **a caller can no longer stop early by not draining.** It cancels
instead, which the loop honours at `:80` and `:133` — an explicit signal replacing an implicit one.

**Failures carry what the source leaves readable.** `TextFailure` has three variants, each with `attempts` and
`usage`, because `executeText` returns the `TextExecution` object *before* `chunks` is iterated, so
`model-router.ts`'s `catch` reads `exec.served()`, `exec.fallbackChain()` and `exec.usage()` on the failing
path (`:488`, `:517-519`). `Cancelled` is its own variant rather than an empty `Ok` because the source
`return`s from the generator instead of throwing, and the caller writes a different ledger row for each
(`:451`) — `Ok` with no candidate would be two spellings of one state.

**Two borrow-checker findings, and the first was mine and it was wrong.** `execute_text` initially did not
compile, and the obvious diagnosis was that `TextArgs` needed **two** lifetimes — payloads for the request,
callbacks for the attempt — with `'b: 'a` so a stream that is `+ 'a` can hold `&'b mut` callbacks. Built it;
it changed nothing. A 60-line reproduction isolated it instead:

- Removing `on_tool_call` from the struct literal made **every** error vanish (`on_usage` never was the
  problem — it is already wrapped in a local closure, because the engine must record usage as well as forward it).
- Three lifetimes (`'b` for tool calls, `'c` for usage) reproduced the same four errors.
- A single `'a` compiled the moment the tool-call callback was routed through a **local closure**.

So the seam did not need changing and the call site did. `TextArgs<'a>` is unchanged from increment 9; the fix
is `forward_tool` in `execute_text`, and the rule is recorded in both places: **the value handed to the seam
must borrow a local, not a field of the caller's own argument struct.** A `&mut dyn FnMut` taken off a field
carries that field's declared lifetime and rustc resolves the seam's lifetime to *it* rather than to a shorter
subregion, which forces the borrow to outlive the whole retry loop — `E0499`, twice, plus `E0597` and `E0373`.
The second finding is smaller and older: `match adapter.generate_text(..).await` was the block's tail
expression, so the `Result<BoxStream<…>, _>` temporary's destructor ran *after* `record_usage` and
`forward_tool` were dropped. Binding it to `let refusal` first drops it at the end of the statement instead.

**`TextArgs`' payloads are now borrowed.** Increment 9 landed `messages`, `tools`, `tool_choice` and
`response_format` as owned `Value`s, which is what the TypeScript's `unknown[]` looks like written down. The
loop is their first consumer and builds one `TextArgs` per *attempt*, so owned payloads meant a deep copy of the
whole conversation per attempt — where the source passes one array by reference and copies nothing. `messages`
grows with the conversation, so it is the wrong thing to copy for a shape's convenience.

**Two `#[allow]`s, each with a measurement rather than an assertion.** Clippy reads `TextFailure` as a large
enum (`large_enum_variant`) and `execute_text` as returning a large error (`result_large_err`). Measured:
`Candidate` **536** bytes, `TextSuccess` **592**, `TextFailure` **616**. Both arms carry that payload by value,
so the `Result` is ~600 bytes either way and boxing the error would save 16 of 616 while adding a heap
allocation to every failure — including the mid-stream one, where the caller already holds text. The image path
is the control: its `Err` is 48 bytes, clippy never mentions it, and its `Result` is *still* 608, because the
size comes from `ImageSuccess.candidate`. Same 536-byte payload, same ~600-byte result, no lint. The arithmetic
is asserted by `the_text_results_size_comes_from_the_payload_not_from_the_error`, which fails if a future field
makes the error dominate. `gateway.rs:1402` allows the same lint for the same shape of reason.

**One open contract question, recorded rather than fixed.** The engine `break`s out of the stream on a
mid-stream error and drops it. In the source, `for await` calls `return()` on the inner generator when the loop
body throws, so its `finally` — where `onToolCall` and `onUsage` fire (`manifest-interpreter.ts:424`, `:430`) —
still runs. A Rust adapter that fires those callbacks only when its stream is polled to `None` will not fire
them on the break path, so `usage` stays `None` for a broken stream that did report one. Nothing exercises it
yet because no adapter is ported; it is a contract the first adapter must be written against, and the two
candidate answers are a `Drop` impl on the stream or the engine draining to `None` before it reports the break
— the latter would change what "mid-stream" means, so it is a decision and not a port step.

**Thirteen tests, thirteen falsifications.** Chunks reach the sink in order; the native model id reaches the
adapter rather than the caller's name; a response-phase refusal advances and keeps its status; a mid-stream
break is `MidStream`, names who served, and is **not** retried; the same `429` is a refusal or a break
depending on which phase threw; a saturated provider is skipped, recorded `RATE_LIMITED`/`429` and consumes no
slot; `Some(0)` is a budget of zero; cancellation returns `Cancelled` and not `AllAttemptsFailed`; exhaustion
reports every attempt in order and names the caller's model; the permit comes back on all four exit paths;
usage reaches both the result and the caller's callback, with `cached_tokens` intact; a tool call passes
through byte-for-byte on a turn that produced no text. Every mutation produced a red test, including the one
that pads `TextFailure` by 512 bytes to check the size test is not merely decorative, and every restore was
verified byte-identical.

**What remains of Phase 2:** nothing in `core`. What is still open overall is unchanged from increment 9 —
`AttemptOutcome` cannot name the provider it tried, and it is now confirmed load-bearing by
`model-router.ts:537-539`, which reads `a.candidate.provider.id/slug` off each attempt.

### Phase 3 — Port the model router and route planner (2-3 days)

**Goal:** rewrite `model-router.ts` and `route-planner.ts` in Rust.

**`Candidate` is already in Rust.** `engine::Candidate` landed with increment 7, because the image loop needs
it, and its three row types are `persist.rs`'s unchanged. What Phase 3 adds is the *planner* that produces a
plan of them, not the type — and `context_scope::MemoryItem` is a different thing under a name that no longer
collides (D21).

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
