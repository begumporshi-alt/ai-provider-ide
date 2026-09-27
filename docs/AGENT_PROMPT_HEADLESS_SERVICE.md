# Agent Prompt: Build Headless Service Mode for AI-Provider Router

**Context:** You are building Phase 1 of a multi-phase project to detach the gateway from the
Tauri WebView process. The full plan lives in `docs/dev-book/10-headless-service.md` and the
tech choice analysis is in `docs/dev-book/11-cross-platform-tech-choice.md`. Read both before
writing any code.

---

## 1. Project Purpose

The AI-Provider Router is a desktop app (Tauri + React + Rust) that acts as a local AI gateway.
It aggregates multiple AI providers (OpenAI, Anthropic, Gemini, etc.) behind a single
OpenAI-compatible HTTP endpoint running on `127.0.0.1:8800`.

**Today:** The gateway HTTP server is Rust, but the router core (model selection, failover, retry,
SSE streaming, context compression) lives in TypeScript inside a hidden WebView window. This means
a renderer crash, user quit, or HMR reload kills the gateway.

**Goal:** Move the router core from TypeScript to Rust so the gateway runs as a standalone
headless service (`aiproviderd`) that survives the UI process. The UI app becomes a pure HTTP
consumer.

---

## 2. What You Are Building (Phase 1 Only)

Phase 1 does NOT port the router core. It only prepares the codebase for that port by:

1. **Splitting the Rust code** into Tauri-independent (`src/core/`) and Tauri-dependent (`src/tauri/`)
   halves.
2. **Creating a standalone binary** (`src/bin/aiproviderd.rs`) that links only `core/` and starts
the HTTP server.
3. **Verifying** that `cargo test`, `cargo clippy`, and `cargo build --bin aiproviderd` pass.
4. **Adding a CI gate** that builds `aiproviderd` on macOS, Windows, and Linux.

This is a structural change with zero behaviour change. If tests fail, it is because imports or
module paths broke — not because logic changed.

---

## 3. Core Features of the Existing System (Do Not Change)

These work today and must continue working after your changes:

| Feature | Evidence |
|---|---|
| HTTP server with 7 routes | `gateway.rs:1755-1761` |
| Master-key + app-key auth | `gateway.rs:67-200` |
| SQLite store with 17 migrations | `store.rs:1009-1013` |
| Keychain vault | `vault.rs` |
| Egress with credential injection | `egress.rs` |
| Model adapters (Anthropic, Gemini, OpenAI, Responses) | `gateway_anthropic.rs`, `gateway_gemini.rs`, `gateway_responses.rs` |
| Gateway bridge (Tauri events to webview) | `gateway_cmds.rs:73-94` |
| 104 Rust tests + 460 TS unit tests + 27 e2e tests | `gateway_tests.rs`, vitest suites |

---

## 4. Technical Constraints (Hard Rules)

1. **No behaviour change.** Phase 1 moves files, splits modules, and adds a binary. It does not
   change logic, algorithms, or HTTP contracts.
2. **All existing tests must pass.** `cargo test` in `apps/desktop/src-tauri/` must return 0.
3. **`cargo clippy --all-targets -- -D warnings` must pass.** This is a gate step.
4. **`cargo fmt --check` must pass.** This is a gate step.
5. **The Tauri app must still build.** `pnpm build` (which runs `tauri build`) must succeed.
6. **The new binary must build on all three platforms.** macOS (`aarch64` + `x86_64`), Windows
   (`x86_64`), Linux (`x86_64`).
7. **Do not add new dependencies without justification.** The existing `Cargo.toml` dependencies
   are sufficient for Phase 1.

---

## 5. Preferred Stack

| Layer | Technology |
|---|---|
| Host / gateway | Rust (Tauri v2, axum, tokio, rusqlite, reqwest, keyring) |
| UI | React 19 + TypeScript 6.0.3 + Vite |
| Build | pnpm 10.12.4 workspace |
| Tests | vitest (TS), `cargo test` (Rust), Playwright (browser) |
| CI | GitHub Actions (`ci.yml`) |

The new service binary uses the **same stack** as the host — no new languages, no new runtimes.

---

## 6. Expected Deliverables

### 6.1 Code changes

```
apps/desktop/src-tauri/src/
├── core/               # NEW — Tauri-independent modules
│   ├── gateway.rs      # MOVED from src/
│   ├── store.rs        # MOVED from src/
│   ├── persist.rs      # MOVED from src/
│   ├── vault.rs        # MOVED from src/
│   ├── egress.rs       # MOVED from src/
│   ├── gateway_anthropic.rs   # MOVED from src/
│   ├── gateway_gemini.rs      # MOVED from src/
│   ├── gateway_responses.rs   # MOVED from src/
│   ├── gateway_handlers.rs    # MOVED from src/
│   ├── injection_log.rs       # MOVED from src/
│   └── mod.rs          # NEW — re-exports for core/
├── tauri/              # NEW — Tauri glue
│   ├── commands.rs     # MOVED from src/
│   ├── lib.rs          # MOVED from src/ (was main.rs)
│   ├── gateway_cmds.rs # MOVED from src/
│   ├── app_nap.rs      # MOVED from src/
│   └── mod.rs          # NEW — re-exports for tauri/
├── bin/
│   └── aiproviderd.rs  # NEW — standalone binary
└── main.rs             # MODIFIED — Tauri app entry point (thin wrapper)
```

This is a suggested layout. Adjust if the module graph demands it, but keep the split clear:
`core/` must not import anything from `tauri/`.

### 6.2 The standalone binary (`aiproviderd.rs`)

```rust
// apps/desktop/src-tauri/src/bin/aiproviderd.rs
//
// Standalone gateway service — no Tauri, no WebView.
// Starts the HTTP server on 127.0.0.1:8800 using the same axum router
// that the Tauri app uses today.

fn main() {
    // 1. Open SQLite database (same path as Tauri app)
    // 2. Read master key from keychain
    // 3. Start HTTP server (gateway.rs::serve)
    // 4. Block on tokio runtime
}
```

The binary must compile with `cargo build --bin aiproviderd` and exit 0.

### 6.3 CI changes

Add a step to `.github/workflows/ci.yml`:

```yaml
- name: Build headless service binary
  run: cargo build --bin aiproviderd --release
  working-directory: apps/desktop/src-tauri
```

This step must run on `macos-latest`, `windows-latest`, and `ubuntu-latest` (add to the existing
matrix or create a new job).

### 6.4 Documentation updates

- Update `docs/dev-book/10-headless-service.md` §2.1 to reflect the actual module layout after
  your changes.
- Update `docs/dev-book/09-status.md` with a new row under "Working and verified" once Phase 1
  passes CI.
- Add a drift register entry in `docs/dev-book/07-drift-register.md` if any doc-versus-code
  discrepancies are found.

---

## 7. Where to Start

**Step 1 — Read, do not write.**

Read these files in order:
1. `docs/dev-book/10-headless-service.md` — the plan
2. `docs/dev-book/11-cross-platform-tech-choice.md` — the tech choice
3. `apps/desktop/src-tauri/Cargo.toml` — dependencies and binary targets
4. `apps/desktop/src-tauri/src/lib.rs` — the Tauri app entry point
5. `apps/desktop/src-tauri/src/gateway.rs` — the HTTP server (this is the core module)
6. `apps/desktop/src-tauri/src/main.rs` — the current binary entry point

**Step 2 — Map the dependency graph.**

For each `.rs` file in `src/`, answer:
- Does it import `tauri::` anything? → goes in `tauri/`
- Does it import `crate::commands` or `crate::gateway_cmds`? → goes in `tauri/`
- Does anything in `tauri/` import it? → goes in `core/` (or shared)
- Is it imported by `gateway.rs` or `egress.rs`? → goes in `core/`

Use `grep -n "use tauri" src/*.rs` and `grep -n "use crate::" src/*.rs` to map this.

**Step 3 — Move files and fix imports.**

1. Create `src/core/` and `src/tauri/` directories.
2. Move files according to the dependency map.
3. Add `mod.rs` files in each directory.
4. Update `src/lib.rs` (or `src/main.rs`) to declare the modules with the new paths.
5. Update `Cargo.toml` to add `[[bin]]` for `aiproviderd`.

**Step 4 — Verify.**

Run in this order:
```bash
cd apps/desktop/src-tauri
cargo check
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo build --bin aiproviderd
```

If any step fails, fix it before proceeding. Do not "come back to it."

**Step 5 — Full build.**

```bash
cd /Users/tushershikder/Desktop/Myapps/open ai provider IDE
pnpm build
```

This compiles the Tauri app. It must succeed.

**Step 6 — Commit and push.**

Follow the project's commit style: `feat(core): extract Tauri-independent gateway library`.

---

## 8. Integration and Testing Requirements

### 8.1 What must pass

| Check | Command | Gate? |
|---|---|---|
| Rust tests | `cargo test` | Yes |
| Rust lints | `cargo clippy --all-targets -- -D warnings` | Yes |
| Rust format | `cargo fmt --check` | Yes |
| TypeScript typecheck | `pnpm typecheck` | Yes (indirect — no TS changes expected) |
| Tauri build | `pnpm build` | Yes |
| Headless binary build | `cargo build --bin aiproviderd --release --no-default-features` | Yes (new for Phase 1) |
| Headless targets check | `cargo check --no-default-features --all-targets` | Yes (added 2026-09-23, closing D17) |
| Doc links | `pnpm check-doc-links` | Yes |
| Dev book | `pnpm docs:book` | Yes |

### 8.2 What must NOT change

- The HTTP API surface (7 routes, same responses)
- The SQLite schema (no migrations added or removed)
- The keychain access pattern
- The Tauri IPC command surface (`commands.rs` handlers)
- The WebView worker window (`gateway-worker.ts`, `gateway.html`)

### 8.3 How to prove it works

1. **The Tauri app starts and serves requests:**
   ```bash
   pnpm dev          # start the app
   curl http://127.0.0.1:8800/v1/models \
     -H "Authorization: Bearer $(security find-generic-password -s masterkey -w)"
   ```
   Must return 200 with a JSON models list.

2. **The standalone binary starts and serves requests:**
   ```bash
   cd apps/desktop/src-tauri
   cargo run --bin aiproviderd
   # In another terminal:
   curl http://127.0.0.1:8800/health
   ```
   Must return 200 with `{"status":"ok"}`.

3. **Both cannot run simultaneously** (port conflict is expected and correct).

---

## 9. Common Pitfalls

1. **Circular imports.** `core/` must not import `tauri/`. If `gateway.rs` imports `commands.rs`,
   that is a dependency that must be inverted (extract the shared type into `core/`).

2. **Tauri-specific types leaking into core.** `AppHandle`, `Window`, `Event`, `InvokeError` —
   all belong in `tauri/`. The core HTTP server takes closures for key providers and bridge
dispatch, not Tauri handles.

3. **The `tauri::generate_context!()` macro.** This is in `lib.rs` and is Tauri-specific. Do not
   move it to `core/`.

4. **Feature flags for platform-specific code.** The macOS App Nap suppression (`app_nap.rs`) is
   behind `#[cfg(target_os = "macos")]`. Keep those gates intact when moving files.

5. **The `[[bin]]` section in Cargo.toml.** Adding a new binary requires either:
   ```toml
   [[bin]]
   name = "aiproviderd"
   path = "src/bin/aiproviderd.rs"
   ```
   or renaming the existing binary and adding the new one. The existing Tauri app binary is
   `src/main.rs` (implicitly named after the package). Be careful not to break it.

---

## 10. Success Criteria

Phase 1 is complete when:

- [ ] `cargo test` passes with 0 failures
- [ ] `cargo clippy --all-targets -- -D warnings` passes
- [ ] `cargo fmt --check` passes
- [ ] `cargo build --bin aiproviderd` produces a runnable binary
- [ ] `pnpm build` produces a working Tauri app
- [ ] CI builds `aiproviderd` on macOS, Windows, and Linux
- [ ] `docs/dev-book/10-headless-service.md` is updated with the actual module layout
- [ ] `docs/dev-book/09-status.md` has a new row for "Headless service — Phase 1 complete"
- [ ] All changes are committed and pushed to `origin/main`

---

## 11. Communication Rules

- **Before you start:** Confirm you have read chapters 10 and 11 and the dependency map.
- **Before each commit:** Run the gate steps (`cargo test`, `clippy`, `fmt`).
- **When you hit a blocker:** Stop, describe the exact error, the file, and the line, and ask for
  help. Do not guess-and-continue.
- **When you finish:** Report the test counts, the binary size of `aiproviderd`, and any
  deviations from the expected module layout.
