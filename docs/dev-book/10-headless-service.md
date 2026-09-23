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
├── lib.rs                 # thin crate root: `pub mod core; pub mod tauri; pub use tauri::app::run;`
├── main.rs                # Tauri app binary (unchanged)
├── core/                  # NEW — no dependency on the tauri/ module
│   ├── gateway.rs         # HTTP server, auth, capacity, the Bridge trait
│   ├── store.rs           # SQLite + migrations
│   ├── persist.rs         # store queries + 32 #[tauri::command] handlers
│   ├── egress.rs          # allowlist + reqwest; stream() takes a tauri::ipc::Channel
│   ├── error.rs           # NEW — CommandError, extracted from commands.rs
│   ├── vault.rs  injection_log.rs  capture.rs  context.rs
│   ├── crash_report.rs  memory.rs  orchestrator.rs  skills.rs
│   └── gateway_{anthropic,gemini,responses,handlers,tests}.rs
│       context_scope.rs  model_context.rs  principal.rs  session_context.rs
│       — all `#[path]` submodules of gateway.rs, so they moved with it
├── tauri/
│   ├── app.rs             # was src/lib.rs — setup, tray, RunEvent
│   ├── commands.rs        # 61 tauri:: refs
│   ├── gateway_cmds.rs    # EventBridge, the worker window
│   ├── tools.rs  workbuddy.rs  app_nap.rs  tools_agent_tests.rs
└── bin/
    └── aiproviderd.rs     # NEW — the standalone service
```

**Three things did not go where §7 of the task prompt said they would**, and each was measured rather
than assumed:

1. **`persist.rs` and `egress.rs` are in `core/`, not `tauri/`.** They cannot be anywhere else.
   `gateway.rs` calls `crate::persist::{active_gateway_key_ids, gateway_key_cap, month_spend_micros,
   app_month_spend_micros, spend_cap_micros}` in **non-test** code, so putting `persist` in `tauri/`
   makes `core/` depend on it. Putting `persist` in `core/` while `egress` and `CommandError` stayed
   in `tauri/` fails the same way from the other side: `persist` imports `crate::egress::EgressState`
   and `crate::commands::CommandError`. `{persist, egress, CommandError}` is one cluster, so all
   three moved and `CommandError` was extracted to `core/error.rs`.
2. **`core/` still imports the `tauri` crate.** `persist.rs` carries 32 `#[tauri::command]` handlers
   and `egress::stream` takes a `tauri::ipc::Channel`. `Cargo.toml` makes `tauri` an unconditional
   dependency and `build.rs` runs `tauri_build::build()` for every target, so `cargo build --bin
   aiproviderd` compiles Tauri regardless. The service is therefore Tauri-free in **source**, not in
   **dependency** — which is also why the Linux CI job has to install WebKitGTK. Removing those types
   is Phase 2 work.
3. **One `cfg(test)` edge points backwards.** `gateway_tests.rs` constructs a
   `gateway_cmds::GatewayState`. Harmless — `cargo build --bin aiproviderd` does not compile tests —
   but it means "core never names tauri" is true of the build and false of the test build.

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
calls the execution engine recursively. The `skipCompression` flag (`gateway-bridge.ts:102`)
prevents infinite recursion — the same flag exists in the Rust port.

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
| ** launchd plist gets out of sync with binary path** | Medium | Medium | Version the plist; on app update, check path and rewrite if the bundle moved |
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
