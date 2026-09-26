# 11 — Cross-platform tech choice: how to run the gateway without a WebView

**Status:** analysis — no implementation yet.

**Question answered:** which technology path lets the gateway survive the UI process on Windows,
macOS, and Linux, while keeping the product a desktop app.

**Date:** 2026-09-23
**Assessed tree:** `7ac97e3`
**Reference project analysed:** `tashfeenahmed/freellmapi` (FreeLLMAPI)

---

## 0. The headline

**FreeLLMAPI solved the same problem by making the server a standalone Node.js process. The user's
project cannot copy that answer without abandoning its security model.**

FreeLLMAPI is TypeScript end-to-end: Express server, React dashboard, Electron-style tray. Every
layer speaks the same language, and the server runs as a background Node.js process that the tray
app merely watches.

This project is different: the security boundary is Rust. The keychain, the credential injection,
and the SQLite store are all Rust-native. Moving the gateway to Node.js would mean either
duplicating that boundary in JavaScript (which breaks the "key-blind by construction" invariant) or
bridging across the Rust→Node boundary on every request (which adds latency and complexity).

So the question is not "which language should the server be in?" — it is "how do we run the
existing TypeScript router core outside a WebView, on all three platforms, without rewriting it?"

There are three answers. This chapter evaluates all three and recommends one.

---

## 1. What FreeLLMAPI does, and what we can borrow

### 1.1 FreeLLMAPI architecture

```
┌─────────────────────────────────────────────┐
│  Desktop tray app (Electron-style)          │
│  ── just a manager ──                       │
│  • Start/stop the server                    │
│  • Show dashboard in a window               │
│  • Tray icon for status                     │
└──────────────┬──────────────────────────────┘
               │
               │ launches as child process
               ▼
┌─────────────────────────────────────────────┐
│  Node.js server (Express + SQLite)          │
│  ── the actual gateway ──                   │
│  • HTTP server on localhost                 │
│  • Router core in TypeScript                │
│  • Provider adapters in TypeScript          │
│  • SQLite with AES-256-GCM                  │
│  • Self-updating model catalog              │
└─────────────────────────────────────────────┘
```

The tray app is **expendable**. Kill it, and the server keeps serving. Reopen it, and it
reconnects. This is exactly the property the user's project needs.

### 1.2 What we can borrow

| FreeLLMAPI pattern | Applicable here? | How |
|---|---|---|
| Server as separate process | Yes | The service binary (`aiproviderd`) |
| Tray app as manager | Yes | The Tauri app becomes a pure consumer |
| Server auto-starts at login | Yes | Platform-specific service registration |
| Dashboard talks HTTP to server | Yes | UI replaces `invoke` with `fetch` |
| SQLite as single data store | Yes | Same database, same path |
| TypeScript router core | **Partially** | Our router core is TS, but our host is Rust |

### 1.3 What we cannot borrow

FreeLLMAPI's server is **pure Node.js**. It handles auth, encryption, and key storage in
JavaScript. This project's security model depends on the Rust host having exclusive access to the
keychain. Moving that to Node.js would:

1. Break the key-blind invariant (`03-contracts.md` §1 — the TypeScript layer must never see a raw
   secret).
2. Require a Node.js keychain library (`keytar` or `node-keychain`), which adds a native dependency
   that is less audited than Rust's `keyring`.
3. Split the security boundary across two languages, making it harder to reason about.

So the server cannot become a Node.js process. The Rust host must remain the server. The question
is how the router core — which is TypeScript — runs without a WebView.

---

## 2. The three paths evaluated

### Path A: Port the router core to Rust

**What it is:** Rewrite `execution-engine.ts`, `model-router.ts`, `route-planner.ts`,
`context-compress.ts`, `adapter-runtime.ts`, and supporting modules in Rust.

**Current state:**
- Rust host: 25,612 lines across 25 modules
- TypeScript router core: 5,880 lines across 35 modules
- Estimated to move: ~2,100 lines (execution, router, planner, compression, health, ledger)

**Cross-platform process management:**
| Platform | Mechanism | Effort |
|---|---|---|
| macOS | launchd LaunchAgent | Low — plist + `launchctl load` |
| Windows | Windows Service (via `windows-service` crate) | Medium — service wrapper + SCM registration |
| Linux | systemd user service | Low — unit file + `systemctl --user` |

All three are well-documented, well-tested patterns. The binary is a single static executable that
needs no runtime.

**Pros:**
- Single binary, no runtime dependency
- Native performance, no JS→Rust bridge overhead
- The security boundary stays in one language
- Process management is standard and well-understood on all platforms
- No WebView means no App Nap, no renderer crashes, no HMR teardown

**Cons:**
- 3-4 weeks of focused development (§10 estimate)
- The execution engine has async generators, AbortSignal propagation, and SSE multiplexing — all
  harder in Rust than in TypeScript
- Tier-2 adapters use QuickJS-WASM; porting the sandbox to Rust needs `rquickjs` or equivalent
- Risk of introducing bugs in the rewrite

**Mitigation:** Phase 1 of §10 (extract core library) proves the HTTP server can start without
Tauri. Phase 2 ports the execution engine test-first. A `webview-gateway` feature flag keeps both
paths for one release.

---

### Path B: Embed a JavaScript runtime in Rust

**What it is:** Use `deno_core` or `rquickjs` to run the TypeScript router core inside the Rust
process, without a WebView.

**How it would work:**
```
Rust process (aiproviderd)
├── axum HTTP server
├── keychain vault
├── SQLite store
└── deno_core / rquickjs runtime
    ├── execution-engine.ts  ← loaded as a module
    ├── model-router.ts
    ├── route-planner.ts
    └── ...
```

The JS runtime lives in the same process as the Rust host. The Rust side exposes an API to the JS
side for HTTP egress, keychain access, and SQLite reads.

**Cross-platform:** `deno_core` compiles for all three platforms. `rquickjs` is pure Rust and also
cross-platform.

**Pros:**
- Minimal changes to the router core — it stays TypeScript
- Faster to implement than a full port (1-2 weeks vs 3-4)
- No WebView means no App Nap or renderer crashes
- Single binary if using `rquickjs`; `deno_core` adds ~15MB

**Cons:**
- `deno_core` embedding API is complex, unstable, and poorly documented
- `rquickjs` lacks built-in async/await support (QuickJS itself supports it, but the Rust bindings
  are limited)
- The execution engine uses `fetch()`, `AbortSignal`, and `ReadableStream` — all Web APIs that
  `rquickjs` does not provide natively
- Two languages in one process means two garbage collectors and two error-handling disciplines
- Debugging a panic in the JS runtime is harder than debugging TypeScript in a browser

**Measured feasibility:** A 1-day spike would answer whether `rquickjs` can load the router core
and execute a simple `generateText` call. Until that spike runs, this path is speculative.

---

### Path C: Node.js subprocess

**What it is:** Bundle the router core as a standalone Node.js script, spawn it as a child process
from Rust, and communicate via HTTP or IPC.

**How it would work:**
```
Rust process (aiproviderd)          Node.js process (router-core)
├── axum HTTP server  ───────────►  ├── Express server (or plain HTTP)
├── keychain vault                  │   ├── execution-engine.ts
├── SQLite store                    │   ├── model-router.ts
└── process manager                 │   └── route-planner.ts
                                    └── HTTP on localhost:8801
```

The Rust host proxies requests to the Node.js router, or the Node.js router listens directly and
the Rust host delegates.

**Cross-platform:** Node.js runs on all three platforms. Process management is the challenge:

| Platform | Mechanism | Effort |
|---|---|---|
| macOS | launchd LaunchAgent for Rust binary; Node.js spawned by Rust | Medium |
| Windows | Windows Service for Rust binary; Node.js spawned by Rust | Medium-High |
| Linux | systemd user service for Rust binary; Node.js spawned by Rust | Medium |

The Node.js process is a child of the Rust service. If the Rust service restarts, it must re-spawn
Node.js. If Node.js crashes, Rust must detect it and restart it.

**Pros:**
- Zero changes to the router core
- Node.js has mature async/await, fetch, streams — everything the engine needs
- Quickest path to a working prototype (days, not weeks)

**Cons:**
- Two runtimes in memory: Rust + Node.js (~50MB+ additional RSS)
- Two HTTP hops (client → Rust → Node.js → provider) adds latency
- Bundling Node.js with the app: either require users to install it (bad UX) or ship a bundled
  runtime (increases bundle size by ~40MB)
- The Node.js process is a child — if the Rust parent dies unexpectedly, the child may become a
  zombie or be re-parented to PID 1
- Process management code is platform-specific and error-prone
- The security boundary is split: Rust holds the keychain, but Node.js handles the request logic

**Critical issue:** The router core today calls `fetch()` to providers. In a Node.js subprocess,
`fetch()` works. But the router core also relies on the Tauri event bridge (`gateway-bridge.ts`)
to stream chunks back to Rust. That bridge would need to be replaced with an HTTP/WebSocket
stream — a non-trivial change.

---

## 3. Comparison matrix

| Criterion | Path A: Port to Rust | Path B: Embed JS runtime | Path C: Node.js subprocess |
|---|---|---|---|
| **Time to implement** | 3-4 weeks | 1-2 weeks | 3-5 days |
| **Router core changes** | Full rewrite | Minimal | Moderate (bridge replacement) |
| **Binary size** | +0MB (single binary) | +15MB (deno_core) or +2MB (rquickjs) | +40MB (bundled Node.js) |
| **Memory at idle** | Low (~20MB) | Medium (~40MB) | High (~70MB) |
| **Cross-platform ease** | High (Rust compiles everywhere) | Medium (runtime dependency) | Medium (runtime + process mgmt) |
| **Security boundary** | Strong (single language) | Weak (two GCs, two error models) | Weak (split across processes) |
| **Performance** | Best (no bridge) | Good (in-process) | Poor (two HTTP hops) |
| **Debuggability** | Good (Rust tools) | Poor (JS-in-Rust stack traces) | Good (separate Node.js process) |
| **Reliability** | Best (no JS runtime to fail) | Medium (runtime can panic) | Medium (child process mgmt) |
| **App Nap / renderer crash** | Eliminated | Eliminated | Eliminated |
| **Long-term maintainability** | Best | Poor (runtime API churn) | Poor (two runtimes to update) |

---

## 4. The recommendation

### 4.1 Primary recommendation: Path A (port to Rust)

**Rationale:**

1. **The security model demands it.** The key-blind invariant (`02-architecture.md` §1) is only
   enforceable because the TypeScript layer cannot touch credentials. Path B and Path C both put
   the router core — which handles request bodies, headers, and provider URLs — in a JavaScript
   runtime that could, in principle, be tricked into exfiltrating data. Rust's type system and
   memory safety make that class of bug impossible by construction.

2. **The existing investment is Rust-heavy.** The host is 25,612 lines of Rust. The router core is
   5,880 lines of TypeScript, but only ~2,100 lines are in the hot path. The adapters are already
   in Rust (`gateway_anthropic.rs`, `gateway_gemini.rs`, etc.). Porting is less work than it
   appears because the boundary is already half-crossed.

3. **Cross-platform is free with Rust.** A single `cargo build` produces binaries for macOS,
   Windows, and Linux. No runtime to bundle, no process management hell, no "works on my machine."

4. **The other paths have fatal flaws.** Path B's `deno_core` is immature and heavy. Path C's
   Node.js subprocess adds 40MB, two HTTP hops, and splits the security boundary. Both are
   short-term wins that create long-term debt.

### 4.2 The phased approach (revised for cross-platform)

The original §10 plan is correct, but the process management phase needs to be cross-platform from
day one.

**Phase 1 — Extract core library (1-2 weeks)**
- Split `src/` into `src/core/` (Tauri-independent) and `src/tauri/` (Tauri glue)
- Add `src/bin/aiproviderd.rs` as a standalone binary
- Verify: `cargo test`, `cargo clippy`, `cargo build --bin aiproviderd` on all three platforms
- **Cross-platform gate:** CI builds the binary on `macos-latest`, `windows-latest`, and
  `ubuntu-latest`.

**Phase 2 — Port execution engine (3-5 weeks)**
- Rewrite `execution-engine.ts` in Rust, test-first
- Replace `SynthBridge` in tests with the real Rust engine
- **Cross-platform gate:** Tests pass on all three platforms (they are platform-agnostic, but
  verifying this is cheap)

**Phase 3 — Port router + planner (2-3 weeks)**
- Port `model-router.ts` and `route-planner.ts`
- Keep the `webview-gateway` feature flag active

**Phase 4 — Port context compression (2-3 weeks)**
- Port `context-compress.ts`
- The summarizer makes recursive calls — verify no deadlock

**Phase 5 — Delete the bridge (1 week)**
- Remove `gateway_cmds.rs` bridge, `gateway-worker.ts`, `gateway.html`, `app_nap.rs`
- Gateway routes directly into Rust router core

**Phase 6 — Cross-platform service installer (2-3 weeks)**
- **macOS:** `launchd` LaunchAgent plist
- **Windows:** Windows Service via `windows-service` crate (or `sc` CLI for registration)
- **Linux:** `systemd` user service unit file
- **Tauri app changes:** Service discovery (`GET /health`), install/uninstall/start/stop UI, status indicator. The app and the service contend for one port on every platform, so the UI owns the handover — starting the service stops the app's own listener first (26y)
- **CI gate:** Build and package on all three platforms

**Total: 11-17 weeks.** The wide range depends on how the execution engine port goes — it is the
riskiest phase.

### 4.3 Risk: Tier-2 adapters (QuickJS-WASM)

The router core's `adapter-runtime.ts` loads Tier-2 adapters into a QuickJS-WASM sandbox. Porting
this to Rust requires either:

1. **`rquickjs`** — a Rust binding to QuickJS. A 1-day spike is needed to verify it can run the
   existing adapter code.
2. **WASM runtime in Rust** — `wasmtime` or `wasmer`. The existing sandbox compiles to WASM, so
   this is theoretically possible.
3. **Drop Tier-2 support temporarily** — Tier-0 (builtin templates) and Tier-1 (manifest
   interpreter) cover most providers. Tier-2 is the escape hatch for edge cases.

**Recommendation:** Spike `rquickjs` in Phase 1. If it fails, document Tier-2 as a known limitation
of the headless mode and keep the WebView path behind the feature flag for Tier-2 users.

---

## 5. What to do now

### Decision 1: Do we commit to Path A?

**Yes.** The other paths compromise the security model or create unsustainable operational
complexity. Path A is the only one that makes the gateway a true service without sacrificing the
architecture's core invariant.

### Decision 2: Do we drop Tier-2 adapters if `rquickjs` fails?

**Yes, temporarily.** The plan documents Tier-2 as a limitation and keeps the WebView path behind a
feature flag. When `rquickjs` matures or a better alternative appears, Tier-2 can be restored.

### Decision 3: Do we ship headless mode as the default?

**No, not immediately.** The `webview-gateway` feature flag keeps the current architecture as the
default for one release. Headless mode is opt-in via a build flag. This gives users a release
cycle to report issues before it becomes the only path.

### Decision 4: Do we support Windows Services or just background processes?

**Background processes on Windows, Services optional.** A Windows Service requires admin rights to
install, which is a barrier. A background process (no console window, started by the Tauri app) is
simpler and sufficient for v1. A Service can be added later for enterprise deployments.

---

## 6. What FreeLLMAPI got right that we should copy

1. **The server is the product; the tray app is just a viewer.** This is the mental model shift.
   The user's project currently treats the Tauri app as the product and the gateway as a feature.
   Headless mode reverses that.

2. **The dashboard talks HTTP to the server, never directly to the database.** This keeps the data
   layer behind one API. The user's project already does this via Tauri IPC; moving to HTTP is a
   small change.

3. **Single SQLite file, single source of truth.** FreeLLMAPI encrypts the whole database;
   the user's project encrypts only the keychain entries. Both approaches are valid, but the
   "single file" principle is the same.

4. **The server auto-starts and auto-restarts.** This is the user experience that matters. A user
   should never have to think about whether the gateway is running.

---

## 7. What the user's project does better

1. **The security boundary is stronger.** FreeLLMAPI handles credentials in Node.js; the user's
   project handles them in Rust with OS keychain integration. This is not paranoia — it is the
   difference between "we try not to leak keys" and "keys are physically impossible to leak from
   the TypeScript layer."

2. **The adapter system is more sophisticated.** FreeLLMAPI has provider adapters; the user's
   project has a three-tier adapter system (builtin → manifest → sandboxed code) with drift
   detection and repair. Porting this to Rust is work, but the result is a more capable system.

3. **The gateway is already HTTP-native.** FreeLLMAPI's dashboard talks to the server over HTTP;
   the user's UI talks over Tauri IPC. But the gateway itself already speaks OpenAI-compatible
   HTTP. The UI just needs to become another HTTP client.

---

## 8. Next action

Begin **Phase 1** of §10: extract the core library.

The first commit should:
1. Create `src/core/` and `src/tauri/` directories
2. Move `gateway.rs`, `store.rs`, `persist.rs`, `vault.rs`, `egress.rs`, and adapter modules into
   `src/core/`
3. Keep `commands.rs`, `lib.rs`, and `gateway_cmds.rs` in `src/tauri/`
4. Add `src/bin/aiproviderd.rs` that imports `core` and starts the HTTP server
5. Verify `cargo test` and `cargo clippy` still pass
6. Update `09-status.md` and the drift register

This commit changes no behaviour. It only changes file paths. If it breaks anything, the blast
radius is the import graph, not the logic.
