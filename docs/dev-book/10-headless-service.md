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

> **Dated — this section is the pre-Phase-1 reconnaissance, and 25f deleted the machinery it
> describes.** The worker window, the 6 s/30 s heartbeat bounds and `app_nap.rs` were all removed on
> 2026-09-24 (Phase 5, increment 25f), so read the lines below as the measurement that justified the
> plan rather than as a description of the tree; §7's Phase 5 is what replaced them. Logged as D44.

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
| **Execution engine** (`execution-engine.ts:228`) | TypeScript — attempt loop, failover, SSE | **Ported** — `core/engine.rs` (increments 1–10) | Done |
| **Route planner** (`route-planner.ts:173`) | TypeScript — candidate ordering | **Ported** — `core/planner.rs` (increment 11b) | Done |
| **Model router** (`model-router.ts:557`) | TypeScript — facade, registry, catalog | **Ported** — `core/router.rs` (increment 13) | Done |
| **Context compression** (`context-compress.ts:271`) | TypeScript — Tier 1 trim, Tier 2 summary | **Ported** — `core/compress.rs` (increment 14a); the wiring is outstanding | **Medium** — the port is done; what is left is calling it, and Tier 2's summarizer must arrive as a seam rather than a closure (D24) |
| **Adapter runtime** (`adapter-runtime.ts:60`, `manifest-interpreter.ts:491`, `code-adapter.ts:615`) | TypeScript — manifest interpreter + QuickJS sandbox | **The one module still unported** | **High** — and the unit of work is not the 60-line dispatch this row used to cite but the **24,820-byte** sandbox beside it. **Spiked 2026-09-24: it is a port, not a reimplementation** — see §2.1.3 |
| **Health tracker** (`health-tracker.ts:78`) | TypeScript — cooldowns, circuit breakers | **Ported** — `HealthTracker` in `core/engine.rs` (increments 1–10) | Done |
| **Concurrency limiter** (`concurrency.ts:91`) | TypeScript — per-provider in-flight caps | **Ported** — `core/limiter.rs` (increment 5) | Done |
| **Usage ledger** (`usage-ledger.ts:114`) | TypeScript — cost attribution | **Ported** — `core/ledger.rs` (increment 12) | Done |
| **Gateway bridge** (`gateway_cmds.rs:73-94`) | Rust — Tauri events to webview | **Deleted** — no webview to talk to | Negative effort |
| **Gateway worker window** (`gateway-worker.ts`, `gateway.html`) | Hidden webview | **Deleted** | Negative effort |
| **App Nap suppression** (`app_nap.rs`) | Native heartbeat to keep JS alive | **Deleted** — no JS to keep alive | Negative effort |
| **Process manager** | None | New: launchd plist, start/stop/lifecycle | Medium |
| **UI → service discovery** | Tauri IPC (`invoke`) | New: HTTP client, health probe | Medium |

**This table was seven rows out of date until 2026-09-24, and the reason is worth stating.** It was written
when the table was a *plan*, and every increment since updated the prose section it belonged to — the
per-increment headings below, and the parked row in [09](09-status.md) — while this table kept saying
"Must be ported to Rust" for six modules that had already landed. A reader planning the remaining work
would have concluded that the execution engine, the planner, the router, the health tracker, the limiter
and the ledger were all still outstanding, when only the **adapter runtime** is.

Two things follow, and the second is the one that matters:

- **The staleness is invisible to the gates.** `build-dev-book` checks structure and links, not whether a
  claim is still true, so nothing could have failed. Only reading the table against the tree catches it.
- **The table's shape hid a gap in the plan.** The adapter runtime is the one module with no phase
  assigned to it — the phases are numbered 1–6 and none of them is "port the manifest interpreter and its
  sandbox". It stayed visible here precisely because this table was the only place that listed *all* the
  modules rather than one increment's worth. So the fix is not only to correct the rows: the missing phase
  has to be decided, and §12's open question (`rquickjs`/`boa` versus a native reimplementation) is what
  decides it. Logged as D25.

**One more thing this table got wrong, and it is why the module looked cheap.** The row cited
`adapter-runtime.ts:60` — the 60-line dispatch — as the unit of work, when the work is
`code-adapter.ts` (**24,820 bytes**, 615 lines) and `manifest-interpreter.ts` (**21,903 bytes**, 491
lines). A module described as "60 lines" needs no phase; a module described as 24.8 KB of QuickJS host
plumbing obviously does. The wrong citation is what made the absent phase look acceptable, so it is
logged separately as D26 rather than folded into D25 — and §2.2's "what must move" list omitted the
same ~1,100 lines for the same reason.

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

### 2.1.3 The adapter-runtime spike, answered (2026-09-24)

**Verdict: it is a port, not a reimplementation — with one caveat that changes where the sandbox runs.**

The question §12 has carried since this plan was written — can `rquickjs` (or `boa`) run the existing
Tier-2 sandbox? — is answered by running the sandbox's own guest contract through `rquickjs` and
checking the values `code-adapter.test.ts` asserts. It was framed as a spike because the answer decides
whether this phase is a port or a rewrite, and the framing held up: the answer is "port", but three
primitives arrive in a shape the TypeScript does not have, and one of them is a containment failure
rather than an inconvenience.

**The harness.** A standalone crate at `.workbuddy-ai/spikes/js-engine/` (`cargo run --release`;
`SPIKE_CRASH=1` for the probes expected to kill the process). It was **723 lines / 13 probes** when
measured on 2026-09-24 and is **988 / 17** after 26p — the counts are given per date because this
sentence had already gone stale once. Every probe
states one claim the TypeScript design depends on, and the money probe copies `GOOD_GUEST`
**verbatim** out of `code-adapter.test.ts:21-37` — not adapted, not reformatted, not re-indented. It
passes:

```
S8  GOOD_GUEST verbatim: all three guest operations ran verbatim:
    listModels=[text-1,img-2], generateText=[Al,pha], generateImage={ok,200,QUJD}
```

Those are the three values the TypeScript test asserts (`code-adapter.test.ts:113`, `:148`, `:154`),
produced by the same guest source, against a Rust host that reproduces `makeHttp`'s deferred-promise
bridge and `callOp`'s job pump. **Same engine, same guest, same answers.**

**What maps one-to-one.** `rquickjs` binds the same QuickJS C engine that
`@jitl/quickjs-singlefile-mjs-release-sync` compiles to WASM, so the language semantics are identical
by construction. Every host primitive the sandbox uses has a direct counterpart:

| `code-adapter.ts` | `rquickjs` | probe |
|---|---|---|
| `newRuntime({ memoryLimitBytes, maxStackSizeBytes, interruptHandler })` | `set_memory_limit`, `set_max_stack_size`, `set_interrupt_handler` | S5, S6 |
| `ctx.newPromise()` + `deferred.resolve/reject` | `Ctx::promise() -> (Promise, resolve, reject)` | S3 |
| `runtime.hasPendingJob()` / `executePendingJobs()` | `Ctx::execute_pending_job()` — **not** `Runtime::*` | S3 |
| `evalCode(source, "adapter.mjs", { type: "module" })` | `Module::declare(...)?.eval()?` — **not** `eval_with_options` | S2, S2b |
| `ctx.getProp(namespace, "default")` | `Module::get("default")` | S2b |

`AdapterInstance: Send + Sync` (`core/adapter.rs`) is satisfiable, but only conditionally: `rquickjs`
declares `Send`/`Sync` for `Runtime` and `Context` **under its `parallel` feature only**
(`runtime/base.rs:187-197`, `context/base.rs:144-149`). Without it both are `!Send` and no
`Arc<dyn AdapterInstance>` can hold one.

**Three traps, each measured rather than reasoned about.**

1. **The module door is not the obvious one.** `EvalOptions::default()` is `global: true` — *script*
   mode — so the natural `ctx.eval(source)` rejects the guest's `export default {` on its first
   character. Clearing `global` does select `JS_EVAL_TYPE_MODULE`, but `eval_with_options` then returns
   the module's *evaluation promise*, which resolves to **`undefined`**: the namespace is unreachable
   from that entry point at all. `Module::declare(...)?.eval()?` plus `get("default")` is the door that
   works — S2 fails to find a `default`, S2b finds one. It also compiles *without running*, which is
   what `compile()` (`code-adapter.ts:202`) exists to do, so one door covers both the compile gate and
   the call path.

2. **The job pump must be the `Ctx` one, and under `parallel` the `Runtime` one deadlocks.**
   `Context::with` holds the runtime's global lock for the whole closure (`context/base.rs:109`), and
   with `parallel` enabled `Runtime::is_job_pending` and `Runtime::execute_pending_job` each take that
   same non-reentrant lock (`runtime/base.rs:162,170`). Calling either inside a context scope hangs the
   thread. This was measured the hard way: the first S3 run wedged with the probe's own diagnostic line
   printed and the `is_job_pending` line never reached. `Ctx::execute_pending_job`
   (`context/ctx.rs:375`) calls `JS_ExecutePendingJob` directly with no lock, so it is the only pump
   available in this shape — **the `parallel` feature, which the seam's bounds require, is exactly what
   makes the obvious pump illegal.** One cost, stated: the `Ctx` variant returns `bool` and folds "a job
   ran" together with "a job threw", so a caller that needs to see a job's exception must inspect the
   promise instead of the return value.

3. **The memory limit fires; QuickJS's out-of-memory *path* is what faults.** This is the finding that
   changes the plan. `MEMORY_LIMIT` is 32 MB (`code-adapter.ts:67`) and the TS suite has **no test for
   it** — it covers lint, wall-clock timeout, http and emit rate limits, path traversal, disposal and
   recovery, but never an over-allocating guest. Measured here, each variant its own run because a crash
   takes the process with it. **Rows S6g–S6j were added 2026-09-25 (26p) and change what rows S6b–S6c
   mean**; the earlier rows are left as measured.

   | Probe | Guest | Result |
   |---|---|---|
   | S6a | allocates ~60 MB, **no limit** | resolves normally — so the limit, not the allocation, is the cause |
   | S6b | allocates ~60 MB, 8 MB limit | **SIGSEGV**, 3 of 3 runs, inside `m.call` |
   | S6c | allocates ~60 MB, **32 MB limit** | **SIGSEGV** — the TS's own value behaves identically |
   | S6d | allocates ~60 MB *after an `await`*, 8 MB limit | rejects cleanly, no crash |
   | S6e | `throw new Error("boom")` at entry | rejects cleanly |
   | S6f | runaway recursion against the 512 KB stack limit | rejects cleanly |
   | S6g | S6f's recursion off the **main** thread, thread C stack varied | `SIGABRT` at 256 KB; contained at 512 KB–2 MB (detail in §19b) |
   | S6h | S6b's guest **+ a signal handler** — the one difference | handler fires: `SIGSEGV`, `si_addr = 0x20`, `si_code = 2`; faulting frame is `build_backtrace` |
   | S6i | S6h's guest **+ `siglongjmp` armed** — the one difference | **survives the fault**; a fresh `Runtime` still evaluates `1+1` afterwards |
   | S6j | calibrate `si_addr`: a deliberate read of `0x1234` | reads back `0x1234` — the instrument is faithful |

   The trap is therefore specific: an out-of-memory raised while the guest executes **directly inside
   the call** — before its first `await` — kills the process with `SIGSEGV`, while the same trap inside
   a job is contained, and neither the stack limit nor an ordinary throw is fatal. A guest whose first
   act is a large allocation takes the app down with it. **A containment limit that aborts the host is
   not a containment limit**, and the contract suite cannot see the difference because it never tests
   one.

   **What the fault actually is — measured 2026-09-25 (S6h, S6i, S6j).** The *site* was recorded on the
   first day; the *cause* was not, and the two support different conclusions. S6h is S6b's guest with a
   signal handler installed — the only difference — and the handler reports **`si_addr = 0x20`,
   `si_code = 2`**, with the faulting frame inside QuickJS's own **`build_backtrace`**, called from
   `JS_CallInternal`'s `exception:` label (`quickjs.c:17439`) — the path that decorates a thrown error
   with `.stack`. Disassembling the faulting offset (`build_backtrace + 0xCCC`) lands on the instruction
   **after** `bl _JS_DefineProperty`, i.e. the `JS_DefinePropertyValue(ctx, error_obj, JS_ATOM_stack, …)`
   that closes `build_backtrace` (`quickjs.c:6792`). So the sequence is: the limit fires, the allocation
   fails, QuickJS raises the error, and then **dereferences a NULL base at `+0x20` while attaching the
   backtrace to it**. That is an unhandled allocation failure inside QuickJS's error path — not the
   guest's allocation, and not a stack overflow. Two independent legs support it: `0x20` cannot be a
   stack address, and the handler ran to completion (a 48-frame `backtrace()` plus
   `backtrace_symbols_fd`) on the stack it was allegedly out of. S6j calibrates the instrument rather
   than assuming it: a deliberate read of `0x1234` reports `si_addr = 0x1234`, so the number is the
   faulting address and not a mis-read field.

**What this decides, and what it leaves open.** The port is real work but it is not a rewrite: the guest
contract, the deferred-promise bridge, the pump, the interrupt handler and the stack limit all map, and
S5 aborted a spinning guest at 300.7 ms and 301.2 ms on two runs against a 300 ms budget. What trap 3
decides is *where* the sandbox runs.

**Corrected 2026-09-25 (increment 26p).** The sentence that stood here read: *"it cannot enforce a heap
ceiling without the power to kill the host."* **S6i falsifies it.** S6i is S6h's guest with `siglongjmp`
armed — again the only difference — and the process **survives**: the faulting frame is abandoned and a
*fresh* `Runtime` is created and evaluates `1+1` afterwards. The two probes differ in exactly one
variable and produce opposite outcomes, so the survival is attributable to the fence and not to the
fault being benign. The heap ceiling **can** be enforced in-process, on the measured fault.

**Reachable is not the same as advisable, and the recommendation does not flip on this alone.** What
S6i establishes is that a fence is *possible*; what it does not establish is that it is *safe*, and the
probe says so in its own output. `siglongjmp` out of a fault runs no destructor, so the faulting
`Runtime`, its heap and any lock it held are abandoned in place. Three questions are open, and each
needs its own probe:

- **The leak is unmeasured.** That the abandoned allocation is lost is certain; its *size*, and whether
  it is bounded across repeated faults, is not. Putting a number on it would cost a hand-declared
  `mach_task_info` ABI — `libc 0.2.189` exports no `task_info` — so it is named here rather than
  asserted.
- **The abandoned runtime's global lock is never released.** Under `parallel`, `Context::with` holds a
  non-reentrant lock for the whole closure (trap 2). If the fault happens inside that scope, the guard's
  `Drop` does not run. The fresh `Runtime` succeeding is evidence the lock is **per-instance rather than
  process-global** — an inference from S6i's result, not a direct measurement — and it means a fenced
  design must *abandon* the runtime, never reuse it.
- **The fault was measured on the main thread and at one site.** S6i ran on the main thread with 8 MB of
  C stack; the actor runs on a 2 MB `std::thread` (S6g). Whether the fence holds there, and whether the
  fault site is identical at 32 MB, is untested.

So the shape of the decision has changed rather than disappeared. It is no longer *"in-process is
impossible, so supervise"* but *"in-process is possible — does the abandoned-frame cost make a
supervisor preferable anyway?"* That is a question about the leak, and it is now a question with a named
probe behind it rather than a premise under it.

**What the spike did not test**, stated so the gaps are not mistaken for coverage: the `log` global
(`code-adapter.ts:166`); `dispose()` and the hot-swap path (`adapter-runtime.ts`); the
`ManifestInterpreter` half of the dispatch, which needs no JS engine at all and was never in question;
and the async-host shape, where the host must `await` a real `reqwest` fetch *between* job pumps. The
probes service `http` synchronously, which is faithful to the TS test's `FakeHttp` but does not exercise
`AsyncContext`/`ctx.spawn`. That last one is the largest remaining unknown, and it is the natural next
probe rather than a port-time surprise.

**Update, 2026-09-24 (increment 18): the engine-free half has landed, and where the sandbox runs is still
open.** The decision this section promotes is **not taken**. What landed is the half of `code-adapter.ts`
that needs no JavaScript engine — `core/sandbox.rs`, the admissible-source rule, the http contract, the emit
budget and the four coercions a guest's answer passes through — which is the split that let `manifest.rs`
land before `interpreter.rs`. None of it decides the process question, and the module note says so in place
rather than leaving a reader to infer it.

**The candidate probe is named here so the next increment does not have to rediscover it.** S6b, S6c and S6d
differ in exactly one respect: whether the out-of-memory is raised **before or after the guest's first
`await`**. Before, the host dies — `SIGSEGV`, 3 of 3 runs, at 8 MB *and* at the TypeScript's own 32 MB. After,
the same trap rejects cleanly. That is a one-variable experiment, and it is the experiment that decides whether
the heap ceiling needs a supervisor process at all or whether the allocating entry segment can be fenced off
in-process. ~~**It has not been run, and nothing here claims the fence works.**~~ Until a probe says otherwise,
§8's subprocess fallback stays the recommended shape for the heap boundary specifically.

**Run 2026-09-25 (increment 26p): the probe said otherwise.** S6h diagnosed the fault and S6i ran the fence;
both are recorded under trap 3 above. The hedge in this paragraph was honest and correctly scoped — and it
**did not survive being quoted.** Three later restatements of this finding dropped it and asserted the
conclusion as a property of the platform, which is how a hypothesis came to read as a fact for two increments.
That is **D54**, and the rule it earns is that a contingency belongs in the conclusion's own sentence rather
than only in the paragraph above it.

**Update, 2026-09-24 (increment 19a): the dependency is in, and the seam's bound is not what this
section implied.** `rquickjs 0.9` is now a dependency of the crate, with `features = ["parallel"]`
and nothing else — see `Cargo.toml` for the measurements. The version is 0.9.0 deliberately rather
than the 0.14.0 Cargo reports as available, because every claim above cites 0.9.0's source by
file:line and an upgrade would void all of them at once.

The correction is to the paragraph above the table, and it is **D30**. `parallel` does give
`Runtime` and `Context` both bounds — that half reproduces. But **no handle that holds a guest
value has them either**, so the feature flag does not by itself make `AdapterInstance: Send + Sync`
satisfiable. Measured with a probe that failed to compile: `Persistent<T>` carries
`rt: *mut JSRuntime` (`persistent.rs:37`), so the wrapper is `!Send`/`!Sync` regardless of `T`; and
`T` reaches `NonNull<JSContext>` (`context/ctx.rs:74`) and `*mut c_void` inside `JSValue`. So `Ctx`,
`Value`, `Object`, `Function` and `Persistent<T>` are all `!Send` and `!Sync` in both directions.

**What that decides.** The adapter cannot hold its `Runtime`, its compiled guest object or its
parked resolvers as fields of the struct implementing the trait — that shape does not compile, and
it fails at the `Arc<dyn AdapterInstance>` coercion rather than at the definition, so it is found
late. The `Send + Sync` handle must instead be a **channel to a thread that owns them**: a thread
creates the `Runtime`/`Context`/`Persistent` values as `!Send` locals (which is legal, since the
closure's body runs on that thread), and the adapter's public surface sends commands to it. That is
the actor shape, and it is now the plan rather than an option. It also answers half of the
"async-host shape" this section names as the largest remaining unknown: the pump and the egress
`await` cannot share one `ctx.with` scope at all, because `Context::with` is synchronous and holds
the global lock — so a single operation is a **sequence of short synchronous scopes separated by
awaits on the actor thread**, with every value that must survive a scope boundary crossing it as a
`Persistent` or as a dumped `serde_json::Value`. The remaining half — how the parked request's
resolve/reject functions are restored into the next scope — is increment 19b's first question.

**Update, 2026-09-24 (increment 19b): the actor lands, and six findings change the code that was written.**

`core/js_host.rs` (~1,100 lines / 14 tests) is the `rquickjs` host as an **actor**: `JsSandbox` is a `Send + Sync` handle that sends commands to a thread owning the `Runtime`, `Context`, and `Persistent` values. The thread is named `js-sandbox`, its stack is `ACTOR_STACK_BYTES = STACK_LIMIT * 4` (2 MB), and its async runtime is a tokio `current_thread` builder. `compile()` uses `Module::declare(...)?` then `.eval()?` then `get("default")` — the door from trap 1. `call()` sets the interrupt deadline, calls the guest method in scope 1, then alternates `resolve_answered` → `pump` → `await egress` in a loop until the promise settles.

**Finding 1: `resolve_answered` must run before `pump`.** Reversing the order makes the verbatim guest timeout, because resolving a parked request queues the guest's continuation as a job, and a pump that ran *before* the resolve leaves that job undrained until the next round — but by then `parked` is empty and the driver reports timeout. Probe A proved this by reversing the order and watching the verbatim test fail with the predicted `Timeout`.

**Finding 2: `Promise::result` on rejection does not carry the reason.** It re-throws the rejected value onto the context and returns `Err(Error::Exception)` (`value/promise.rs:107-113`), so the reason must be read back with `Ctx::catch()`. Treating the `Err` as the reason reports every rejection as the literal string "exception" — the message is what a caller diagnoses from, so this is not cosmetic.

**Finding 3: `is_object` is a raw `JS_TAG_OBJECT` check that a function also satisfies.** Without an `is_function` guard before the object branch, a guest returning `f: () => 1` dumps as `{}` rather than `null`. The test `the_dump_walks_rather_than_stringifies` caught this.

**Finding 4 (the simplification): `armed` is a second spelling of one state.** The interrupt handler checked `armed` before reading `deadline_ms`, but `deadline_ms == u64::MAX` already means "no deadline" and makes the comparison false for every clock reading. A probe removed the `armed` check and the whole module suite — including the spinning-guest abort test — passed identically. The flag, its two `store` calls, and the `AtomicBool` import were all removed.

**Finding 5: `Runtime` has no `memory_limit()` or `max_stack_size()` getters in 0.9.0.** The only observable consequence of the memory limit is the `SIGSEGV` of trap 3, ~~which cannot be tested in-process~~; the stack limit is observable, and `runaway_recursion_is_contained_on_the_actor_thread` asserts it on the actor's own thread — the condition S6f never measured, because S6f ran on the main thread with 8 MB of C stack. **Corrected 2026-09-25 (26p):** the `SIGSEGV` *is* observable in-process, and S6h does exactly that — a `sigaction` handler with `SA_SIGINFO` reads `si_addr` and `si_code` and walks a 48-frame backtrace. What is not observable is the limit *as a number*, which is what this finding is actually about; the phrase was true of the getter and false of the fault.

**Finding 6: `std::thread`'s default stack is not a contract.** `RUST_MIN_STACK` overrides it, and a probe showed that without an explicit `.stack_size` the actor thread gets whatever the environment says. With `RUST_MIN_STACK=262144` the recursion test `SIGABRT`s on `js-sandbox`; with `.stack_size(ACTOR_STACK_BYTES)` the same environment passes. The explicit size is therefore load-bearing, not decorative.

**Two API details that differ from the spike's expectations.** `Ctx` has no `new_string` method in 0.9.0 — `rquickjs::String::from_str(ctx, &str)` is the construction path, and it takes `Ctx` by value. And `dump` needs no `&Ctx` parameter at all: a `Value` carries its own context in 0.9, and clippy's `only_used_in_recursion` caught the vestigial parameter.

**S6g — containment off the main thread.** The spike's S6f measured runaway recursion against a 512 KB JS stack limit and found it contained, but it ran on the **main** thread (8 MB C stack on macOS). The actor runs on a `std::thread` whose default is **2 MB**, so S6f's result does not automatically transfer. Probe S6g (`.workbuddy-ai/spikes/js-engine`, added for this increment) varies the thread stack size with the JS limit fixed at `STACK_LIMIT`:

| thread C stack | 256 KB | 512 KB | 768 KB | 1 MB | 2 MB |
|---|---|---|---|---|---|
| result | `SIGABRT` | contained | contained | contained | contained |

The probe is opt-in (`SPIKE_CRASH=1`) because a size whose C stack runs out first kills the process. `ACTOR_STACK_BYTES` keeps the measured 4× margin and derives the number from `STACK_LIMIT` so the two cannot drift apart.

**Update, 2026-09-24 (increment 20a): `core/code_adapter.rs` lands — the manifest half of the sandbox, and three findings about the seam it had to satisfy.**

`js_host.rs` is the guest's engine and knows nothing about manifests. `code_adapter.rs` is the other half: it reads the two blocks of a `kind: "code"` manifest it needs, builds one `HttpTarget`, and implements all seven `AdapterInstance` members over a `JsSandbox`. Four findings came out of writing it.

**Finding 1: `dispose(&self)` is forced by the seam, and the cost is one mutex.** `AdapterInstance::dispose` takes `&self`, but joining a thread needs *ownership* of its `JoinHandle`, which needs `&mut`. The alternative — wrapping the whole sandbox in a lock — cannot work: `call` is async, so a `std::sync::MutexGuard` across an await is a `Send` error, and a `tokio::sync::Mutex` cannot be locked from a synchronous `dispose`. So `JsSandbox`'s thread slot became `Mutex<Option<JoinHandle<()>>>` and `dispose` takes `&self`, locking only for the join. `Drop` still calls it, and `take` keeps it idempotent.

**Finding 2: a queue on the actor thread has no reader.** The first draft created the `log` line buffer inside `JsHost::compile`. But `JsHost` never leaves the actor thread and is never named from outside it, so the `Arc` it held could never be drained — and the field was dead code, which clippy would have failed. The `Arc` is now created in `spawn`, cloned into the actor, and kept on `JsSandbox`; `drain_log_lines` is copy-and-clear, because `log` is a global the guest may call between two operations. `the_guest_log_reaches_the_caller_and_a_drain_empties_the_queue` asserts the reachability rather than the logging.

**Finding 3: the two adapters disagree about what "rate limited" means, and both are right.** The interpreter's `ping_key` tests `status == 429`; the code adapter's tests `/429/.test(msg)` — a **substring** of the rejection message (`code-adapter.ts:610`). A guest that throws `"upstream said 429"` is reported `429`/`rate_limited` with no HTTP status anywhere. The reference's rule is kept, and the divergence is written down at the one place both can be read side by side. A probe that hard-wires `rate_limited = false` reddens the test, so it is the rule that is measured and not a status that leaked through.

**Finding 4: `manifest::AuthHeader` and `sandbox::AuthHeader` are the same struct twice.** Identical fields, each rendering the same `{{secret}}` rule — into a `BTreeMap` for the interpreter, into an order-preserving `Vec` for the sandbox. They also disagree on a duplicate name. Collapsing them would mean a `Vec` every caller sorts or a map that cannot express order, so the four-line conversion lives in one function and the duplication is recorded instead.

**Two things this increment states rather than fixes.** `generate_text` is **buffered, not streamed**: it runs the operation to completion and then yields the collected lines, so the text is identical but nothing reaches the consumer until the guest's promise settles. True streaming needs the actor to forward chunks mid-operation, which is **increment 20b — landed the same day, below**. And a code provider reports **no usage and no tool calls** — `code-adapter.ts` never calls `args.onUsage` or `args.onToolCall`, so both callbacks on `TextArgs` are dropped and every code-provider request reports zero tokens, which means the spend cap cannot bite for such a provider.

**Thirteen tests, one probe fired.** The base URL is trimmed and the header carries `Bearer {{secret}}` rather than a key; the lint rejects before a runtime is built; a catalogue entry with an empty `id` and a non-string are both dropped while a `name`-only entry survives; the `errorBody` cap is 500 of 900; the emitted lines arrive in order; an empty catalogue is `ok: false`/`status: 0`/`"empty model list"`; `429` is read out of the message; modality comes from the manifest's rules; and a disposed adapter reports `Host` with no flag involved. The argument encoders are pinned separately — an absent `size` leaves the key out rather than nulling it, `maxTokens`/`temperature` are omitted where the four `?? null` keys are always present, and a `limits` block with no cap is `{}` rather than `{"maxOutputTokens": null}`.

**Update, 2026-09-24 (increment 20b): `generate_text` streams — and closing it found three defects that were not the streaming.**

`Chunk::{Line,End}` and the chunk channel on `Command::Call` make the seventh member a real stream: the actor forwards each round's `emit` lines before it does anything else, and the operation's terminal outcome travels the same channel, so the stream ends on a value rather than on an ambiguous closed channel. `End` is an **item** rather than the reply future's `Err` because a consumer holding both would need a `select` whose borrow fights the one that drops the sender — the drop is what closes the channel, so it cannot happen while the future is borrowed.

**Defect 1: the 400-line emit cap was documented and not enforced.** `sandbox::note_emitted_line` was called from nothing but its own tests, and `make_emit` never charged `budget.lines` — so a guest could emit without bound while the previous increment's doc-comment said the cap bit. `make_emit` now calls that function, which also deletes a second spelling of one limit: the message string had been copied verbatim into `js_host.rs`.

**Defect 2: six values always passed together, through four layers, are a parameter object.** `JsHost::drive` carried `#[allow(clippy::too_many_arguments)]`, and adding the chunk channel pushed `send` and `JsHost::call` past the same lint. A `CallSpec` replaces the positional chain, so the allow is gone and there is one spelling of "an operation to run".

**Defect 3: the module note asserted a class the engine derives.** It said a post-first-chunk failure "is `FailureKind::MidStream` by construction". The engine never reads the class off the error — `attempt_disposition(emitted, aborted)` (`engine.rs:448`) answers `Next` until a chunk has been emitted — so a failure *before* the first chunk is a retryable refusal, not a mid-stream break. The note now describes the predicate instead of naming its output.

**Eleven tests, five probes.** The one worth more than it cost is `take` → `clone` in `forward`: the staging buffer is read once per round of the settle loop, so a clone leaves every line behind and the next round re-sends it — a guest that emits, awaits, then emits delivers its first chunk **twice**. The probe reddens exactly `a_chunk_reaches_the_caller_before_the_request_it_precedes_is_answered`, with `Line("first")` arriving where `Line("second")` belongs. The other four: the empty-chunk check moved *after* the charge reddens the 500-empty test with `[End(Err(Limits))]`; the failure check moved before `forward` reddens the cap test at **1 of 401** lines delivered; dropping the charge reddens it at **402 against 401**, which is the pre-20b behaviour in a single number; and `let _ =` → `expect` on the chunk send panics the actor thread. All five were reverted by their inverse edit and verified by hash against the baseline.

**The property is only testable against a request that does not answer.** Every streaming test here needs an egress that parks, because streaming and buffering deliver the same chunks in the same order and differ only in *when* — a fixture that answers immediately cannot tell them apart.

### 2.2 The line count

```
Router-core TypeScript:  5,880 lines across 35 modules
Rust host today:        42,696 lines across 51 files
What must move:         ~2,100 lines (execution, router, planner, compression, health, ledger)
Adapter runtime:        ~1,100 lines (code-adapter 615 + manifest-interpreter 491) — omitted from this list until 2026-09-24
What can be deleted:    ~300 lines (bridge, worker window, App Nap)
Net new Rust:           ~2,500 lines (port + process manager + tests) — computed without the row above
```

**The `Rust host today` row was stale and is corrected (D29).** It read `25,612 lines across 25 modules`
until 2026-09-24, and no definition reproduces that pair: `apps/desktop/src-tauri/src/**/*.rs` is **42,696**
lines across **51** files, `src/core/*.rs` alone is **37,615** across 40, and `src/core/*.rs` with every
`#[cfg(test)]` block excluded is **19,089**. The row is a *planning snapshot* and it was written when the tree
was smaller — increments 1–18 added ~17,000 lines to it — so the honest repair is to re-measure rather than to
defend the old number. The basis is now stated because it was the ambiguity that let the figure rot: **all
lines, including `#[cfg(test)]` blocks, counted by `wc -l` over `src/**/*.rs`.** A count that does not say
whether it includes tests will drift again.

The 5,880 figure includes modules that do NOT need to move: `builtin-templates.ts` (static data),
`redaction.ts` (generator-only), `adapter-generator.ts` (generator-only), `onboarding-orchestrator.ts`
(UI-only), `drift-monitor.ts` (UI-only), `repair-orchestrator.ts` (UI-only). The gateway path touches
only a subset.

**Both arithmetic lines above were derived from a module list that omitted the adapter runtime**, which
is the same omission that left that module without a phase (§2.1.3, D26). "What must move" is short by
about the 1,100 lines now itemised, and "net new Rust" was computed from it. A module absent from the
table was absent from the total.

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
- **CORS:** The UI runs on `tauri://localhost` (or the dev server). The **in-app** gateway is on
  `http://127.0.0.1:8787` (`gateway::DEFAULT_PORT`) — **not** 8800, which is `aiproviderd`'s port and
  is deliberately different, because 8787 collides with AI Hub v2 (§2.1.1). The gateway must add
  `Access-Control-Allow-Origin: tauri://localhost` (or `*` in dev) to its responses, or the UI's
  `fetch()` will be blocked.

### 5.3 New internal routes for the UI

The UI needs some operations that today go through `invoke`:

| Today (`invoke`) | Headless (HTTP) | State |
|---|---|---|
| `gateway_settings_get` | `GET /admin/settings` | **Landed 2026-09-25** |
| `gateway_settings_set` | `POST /admin/settings` | **Landed 2026-09-25** — **a merge, not a replace** |
| `gateway_app_keys` | `GET /admin/keys` | **Landed 2026-09-25** |
| `gateway_app_key_create` | `POST /admin/keys` | **Landed 2026-09-25** — returns the secret once |
| `gateway_app_key_revoke` | `DELETE /admin/keys/:id` | **Landed 2026-09-25** |
| `gateway_spend_status` | `GET /admin/spend` | **Landed 2026-09-25** |
| `gateway_enable` / `gateway_disable` | **Deleted** — service is always on | — |
| `gateway_worker_error` | **Deleted** — no worker window | — |

These routes are authenticated with the same mechanism as the external surface — but **not with the
master key, which the UI never holds.** This paragraph originally said the UI "holds the master key in
memory (it already does, for the one-shot reveal)"; **D51 measured that false.** TypeScript is
key-blind by construction (invariant 2) — it holds `secretRef`, never a secret — and the Gateway screen
says so in the operator's own words: the key is *never rendered in this window*. So every route below
answered **401 to the only client the pure-HTTP decision was written for**, and no test could see it,
because the harness supplied the credential the UI cannot.

**Resolved 2026-09-25 in 26i.** The host mints a local, revocable session credential — an ordinary app
key with the reserved id **`ak-ui`** (`core/ui_session.rs`) — and hands it to the webview through
`ui_session_key`. The webview caches it in a `let` and sends it as `Authorization: Bearer`; it is
**never** in `localStorage`, `sessionStorage` or a cookie, so it vanishes on reload and a fresh one is
minted next call — a secret that survives a reload is one a compromised webview can extract, which is
the whole of invariant 2. It works in **both** processes that can serve the port, because both install
`vault_app_key_provider` against the same keychain and the same database, and **no auth path was
widened** to make it work. It carries no provider credential, so invariant 2 still binds where it was
meant to. It is filtered out of `GET /admin/keys` (`is_ui_session`) so an operator cannot revoke the
UI's own credential and break every screen with no visible cause. See D51.

**Landed 2026-09-25 as increment 26d**, in `core/gateway_admin.rs` — a `#[path]` submodule of
`gateway.rs`, registered by `spawn`, so the in-app gateway and `aiproviderd` serve the identical
surface. Three design points that differ from a literal port of the commands:

1. **The settings write merges.** The IPC path merged in TypeScript (`patchGatewaySettings`)
   because `settings_set` is a whole-row UPSERT and a writer that serialises only the keys it
   knows erases the rest. The merge moved server-side, which makes it atomic instead of a
   read-modify-write across the network. `POST /admin/settings` therefore takes a **patch**, and
   answers with the merged object.
2. **`POST /admin/keys` returns the secret once — and the in-app UI therefore does *not* use it.**
   The IPC command generated the secret host-side, copied it to the clipboard, and returned metadata
   only: `ARCHITECTURE_AUDIT.md` R4 says *"The webview only ever receives `{id, label}`"*, and
   `AUDIT_REPORT.md` H5's fix requires *"a Rust-side native dialog/copy that never enters the webview
   DOM"*. A headless process has no clipboard, so the route **must** be able to return the secret —
   for curl, AI Hub, and any client that has nowhere to copy it to. But that also means the secret
   crosses the webview in the response, so **`gateway_app_key_create` stays on IPC and the app-key
   screen is deliberately excluded from the migration**; the route exists for clients without a host
   clipboard. See the scope correction under §10 decision 2.
3. **A core with no store answers 503, naming the route.** `GatewayCore::store()` is `None` for
   every core built without `with_store`, which is most of the test suite. Refusing loudly beats
   answering an empty list that reads as "nothing is configured".

**Not tested: the happy path of `POST /admin/keys`.** `vault::put` writes to the real OS keychain,
which a CI runner has no access to, so only the validation path (a missing `label` → 400) is
pinned. The rest of the surface has 9 tests covering auth, the 503, the settings merge, the empty
list and the spend shape.

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

### Increment 11 as built — the planner, and the pricing it needed (2026-09-23)

Phase 3 starts with the planner because it is the cheap half, and it is the cheap half because it is pure.
`route-planner.ts` is 173 lines of `buildPlan(input, ctx, now) -> Candidate[]` plus two helpers: no I/O, no
async, no SQLite, no adapter. Its row types are already this crate's (`ProviderRow`, `ApiKeyRow`, `ModelRow`,
`AliasRow`, `HealthTracker`), so the whole of the gap between "the planner is pure" and "the planner can be
ported" was one import — `priceRank`, from `pricing.ts:9`. That is why the increment ships in two commits.

**11a — `core/pricing.rs`** (335 lines, 12 tests, `cargo test` 596 → 608). Micro-USD per 1M tokens as an
`i64`, because the ledger column is `cost_estimate_micros INTEGER` and a per-token price is ~1e-7. "Unknown"
is `None` and never `Some(0)`: a provider that publishes no pricing is a different fact from one that
publishes free, and a zero would make it the cheapest carrier in any `cost_spread` ordering — the same defect
class as `NULL ≠ 0` in `usage.rs` and "no cap" as `NULL` in `limiter.rs`. Three findings came from the
falsification harness and none from reading: a dead finiteness filter (the conversion checks the product, so
the gate was a second spelling of a state it already refuses); a test that never reached its own `is_object`
branch; and a `?` chain that is **not** TypeScript's `??` — `to_number(a.get("prompt")?).or_else(||
to_number(a.get("input")?))` returns from the function on the first miss, so a catalog using the
`input`/`output` spelling parsed as *unknown*, which in a cheapest-first ordering silently demotes that
provider to last. Fixed with `find_map` over the four spellings.

**11b — `core/planner.rs`** (~740 lines, 29 tests, `cargo test` 608 → 637). `build_plan`, `resolve_wanted`,
`strip_client_namespace`, `order_keys`, `order_carriers`. `Candidate` moved here from `core::engine`, which
redeems the promise its own doc-comment made in increment 7 — it was parked there "because the planner itself
is not ported yet", and a planner module that did not own its output type would be that promise unredeemed;
the engine imports it, so no call site changed. `ProviderRow`, `ApiKeyRow` and `ModelRow` gained `Clone`,
because the TypeScript's `Candidate` holds *references* — five candidates sharing one provider object — and
the port clones.

**The context is a trait, not a struct of `&dyn Fn` fields, and a borrow decided it.** A struct holding
`&'a dyn Fn(..)` forces every test to keep its closures alive longer than the context built from them: `&|pid|
...` is a temporary, and the borrow checker is right to refuse it. `PlanContext` as a trait lets the fixture
*be* the context, which is also what the TypeScript is — an object literal with methods.

**Three places the port is provably identical but not literally identical**, each pinned:

1. `order_keys` uses `rem_euclid` where JavaScript uses `%` **plus** negative `slice` indices. `-1 % 3` is
   `-1`, and `slice(-1)`/`slice(0, -1)` count from the end, so `start = -1` on three keys means "begin at
   index 2" — exactly `rem_euclid(3)`. It is a total, panic-free spelling of the same rotation, not a
   rounding of it.
2. The TypeScript guards `orderCarriers` with `if (!ctx.pricingFor) return wanted`. With `pricing_for`
   returning `Option<PricingMicros>`, "no lookup supplied" and "a lookup that answers `None` for everything"
   are the *same* ordering: every rank is `None`, every comparison is `Equal`, and a stable sort is the
   identity. The guard is unobservable, so `pricing_for` is a **required** trait method with no default body
   — this crate's rule — and "no pricing" is one of its answers rather than a missing one.
3. The dedup key is a `(provider_id, native_id)` tuple where the TypeScript builds `` `${providerId}
   ${nativeId}` ``. The string collapses two pairs that split differently (`("a b", "c")` and `("a",
   "b c")`); the tuple does not. Reachable only with an id containing a space, but it is the stricter
   reading and costs nothing.

**Two behaviours kept rather than fixed, both now pinned by a test.** `orderCarriers` decides whether to
reorder by `wanted.some(...)`, so *one* carrier asking for `cost_spread` reorders every other carrier on the
list, including providers whose own strategy is something else. And `stripClientNamespace` and the qualified-id
lookup both read `ctx.providers` **regardless of status**, while `buildPlan` then requires `enabled` — so
`a/m1` resolves as qualified against a *disabled* `a`, the bare-id fallback is suppressed by `qualified`, and
the plan comes back empty even though another enabled provider carries a model literally named `a/m1`. That is
the intended "never silently reroute" rule (`:131`) reaching further than its author describes.

**Twenty-two falsifications, all red tests, all restores byte-identical.** They include one test rewritten
mid-harness: the first `the_same_provider_and_model_are_planned_once` used an alias named `m1`, which the
`alias_rows.is_empty()` gate suppresses — so it never reached the dedup and passed for the wrong reason. The
shape that actually duplicates is a qualifier and an alias resolving to the same pair. One assertion is
honestly *not* falsifiable: `the_alias_pass_sorts_a_copy_and_never_the_callers_rows` also asserts the
fixture's own rows come back untouched, which `aliases()` returning `&[AliasRow]` makes unreachable by
mutation. It is kept as a statement of what the signature buys, and the test's falsifiable half is its
ordering assertion.

### Increment 12 — `core/ledger.rs`, the usage ledger (2026-09-24)

The blocker for the model router. `model-router.ts` calls `ledger.append()` in `generateText`,
`generateImage`, `complete`, and `recordNoRoute`; without a Rust ledger, every one of those methods
would be stubbed at its append. `usage-ledger.ts` is 115 lines: an in-memory ring buffer (`Vec` in
TypeScript, `VecDeque` in Rust — `O(1)` pop_front vs `O(n)` splice) plus an optional `LedgerSink` for
persistence.

**`LedgerRow` already exists** as `persist::LedgerRow` (`persist.rs:459`), the wire shape the webview
sends and the SQL INSERT receives. It gained `Clone` and `Debug` in this increment — `Clone` because
`query` returns owned rows (the caller may hold them longer than the next `append`), and `Debug`
because the test spy sink derives it. The port adds only the *buffer* and the *query* surface.

**The sink is a trait, not a struct of callbacks — the same lesson as `PlanContext`.** A struct
holding `&'a dyn Fn(..)` cannot be built from inline closures in tests; a trait lets the fixture be
the sink. The one method returns `Result` so a full disk is observable rather than swallowed.

**`is_none_or` replaces `map_or(true, ...)`** — a clippy lint (`unnecessary_map_or`) that is also
clearer: "if None, true; if Some, apply the predicate" is exactly what the filter needs.

16 tests, `cargo test` 637 → 653. 12/12 falsifications (11 red tests + 1 control that does not
compile). Gate green.

### Increment 13 — the router glue, and the label the chain could not carry (2026-09-24)

Phase 3's last piece. `model-router.ts` is 557 lines, and every one of them now has a Rust
counterpart in `core/router.rs`: `generateText`, `generateImage`, `complete`, `listModels`,
`systemAiAvailable`, `syncConcurrency`, and the private `plan` that builds a `PlanContext` and calls
`build_plan`. Compression is not here — `messages` still pass through verbatim, which is Phase 4's
job and is recorded as such (D20).

`cargo test` 653 → 712: +5 in `engine.rs` (13a), +4 in `pricing.rs`, +50 in the new `router.rs`.

**13a — the attempt label, and the decision the note got half wrong.** Increment 11b parked a
decision: `AttemptOutcome` could not name the provider it tried, because the faithful shape clones
three owned rows per failed attempt where the TypeScript copies a reference. The note proposed
carrying the joined `slug/label` string. That is the cheap option and it is wrong, for a reason the
ledger already states: `fallbackChainJson` is `{provider, key, cls}` as **three separate JSON
fields** — `Activity.tsx` and `Context.tsx` read them separately — so a joined string would have to
be split again, and a label containing the separator would split in the wrong place. The port
therefore adds two fields, not one, via `AttemptLabel { provider_slug, key_label }` and a free
function `labelled(outcome, candidate)`.

The cost the note *did* carry is real and was paid: **`AttemptOutcome` is no longer `Copy`**, so two
call sites now read `(outcome.cls, outcome.retry_after_ms)` before pushing instead of after.
`AllAttemptsFailed::describe()` renders `slug/key:CLS` where a label exists and `CLS:status` where it
does not — the unlabelled shape states that it cannot name the attempt rather than forging a name
for it, and a test asserts exactly that. The drift hook still cannot be ported: it needs the provider
id and the model's native id, and a label deliberately carries neither.

**13b — `core/router.rs`.** 2,644 lines, 1,506 of them the test module; 50 tests.

**The store is a plain struct, and its derives are a measurement.** `RouterStore` carries
`#[derive(Default)]` and nothing else, because `AliasRow` implements neither `Debug` nor `Clone` —
the planner only borrows alias rows, so nothing ever needed to clone one. No trait was invented to
paper over it: the store has no second implementation, and a trait with one implementor is a
comment that costs a vtable.

**Three findings came from failing tests, not from reading.** Each is the kind that compiles and
looks right:

1. **`complete`'s terminal error was `NoRoute`, and `NoRoute` is an HTTP status.** The source throws
   a plain `Error` (`:329`) whose text does not contain the phrase `gatewayStatus` maps to `404`, so
   a Generator failure is a `500`. Reusing `NoRoute` here would have quietly changed the status a
   client sees. Fixed with a distinct `SystemAiUnavailable` variant, and
   `complete_reports_the_sources_message_when_nothing_answers` now asserts `!matches!(.., NoRoute)`
   so the distinction cannot be folded back.
2. **The first fall-through test asserted the wrong loop.** It assumed `complete` retries per *key*;
   the source's `modelOrder` falls through per *model*, so a provider whose first model returns
   nothing is left entirely rather than tried again on its next key. Rewritten as
   `complete_moves_on_to_the_next_provider_when_a_candidate_returns_nothing`, which asserts the
   adapter call log is `["text:key:k1|m1", "text:key:k3|m2"]` — `k2` is never reached.
3. **The image failure path writes no ledger row, and that is the source, not a gap.**
   `generateText` ends in `wrapLedger` (`:172-180`), which catches `AllAttemptsFailed` and appends an
   error row; `generateImage` (`:183-218`) has no wrapper and throws before its `append` is reached.
   So a failed image plan leaves no trace while a failed text plan leaves one. Pinned with a comment
   saying so, because it is exactly the asymmetry a later reader "fixes".

**`RouterError::Text` is boxed, and the engine's allowance was not inherited.** `clippy` raised
`result_large_err` on five returns and `large_enum_variant` on the enum. `execute_text` allows the
first of those (`engine.rs:891`) on a measured argument: its `Ok` arm carries the same 536-byte
`Candidate` the failure does, so its `Result` is ~600 bytes either way and a box would save 16 of
them. That argument is about *that* function. Measured here — `TextFailure` 616, `NoRoute` 72,
`AllAttemptsFailed` 48, against `TextSuccess` 592, `ImageResult` 48, `String` 24, `()` 0 — the error
outgrows the payload by 8× to 77× on four of the five returns, so the lint's premise holds and
suppressing it would be suppressing a true finding. `RouterError` went 616 → 80 bytes. The
arithmetic is asserted by
`the_error_is_boxed_because_it_outgrows_every_payload_but_the_text_one`, which fails if a future
`Ok` type grows past the error and the decision needs re-arguing rather than extending.

**Two source asymmetries are kept and pinned.** `complete` does **not** call `syncConcurrency()`
while `generateText` and `generateImage` do, so a stored cap reaches the Generator only on the next
UI or gateway request. And `complete` writes no `fallbackChainJson` — the column is `NULL`, not
`"[]"`, and the difference is meaningful: `"[]"` means "there were no attempts to record".

**The `E0521` that the engine's note already documents reappeared here.** Handing the seam
`on_usage.as_deref_mut()` off the request field does not compile — the borrow is required to outlive
`generate_text` itself. Two local forwarding closures fix it, exactly as `execute_text` does it. The
binding *outside* the closure, though, is a plain move: clippy's `needless_option_as_deref` is right
that `as_deref_mut()` on a local `Option<&mut dyn FnMut>` is a no-op, and only the reborrow *inside*
each closure is load-bearing.

**Test fixtures leak two adapters on purpose.** `ModelRouter::new` takes `&dyn AdapterFactory`, and
`&Always(adapter.clone())` is a temporary that cannot outlive the call (`E0716`, ~20 sites), so a
`factory()` helper `Box::leak`s one per test. The alternative — an `Arc<dyn AdapterFactory>` field —
was rejected because it would make the router own a seam the source's `AdapterRuntime` outlives.

**Falsification: 12/12** (11 red tests + 1 control that does not compile), each restoring
byte-identical. One mutation initially *missed*, and the miss was informative: mutating
`record_no_route`'s `chain_json(&[])` did not redden
`an_empty_chain_is_written_as_an_empty_array_and_not_as_absent`, because that test is a unit test of
`chain_json` itself and cannot be reached from the call site. The call site's own test is
`a_request_with_no_route_is_recorded_and_never_reaches_the_adapter`; a second mutation was added to
cover `chain_json`'s empty branch directly. A mutation whose expectation names the wrong test is a
green-looking harness measuring nothing.

Gate green: `cargo fmt --check` clean, `clippy --all-targets -- -D warnings` clean,
`cargo test` 712 passed / 0 failed, `cargo check --no-default-features --all-targets` clean.

### Increment 14a — context compression, the pure half (2026-09-24)

Phase 4 opens with the half that needs no engine. `core/compress.rs` is 936 lines — 388 of
implementation against the TypeScript's 271, and 547 of tests — and it carries the whole of
`context-compress.ts`'s decision-making: `prompt_budget`, `estimate_tokens`, `compress_messages`,
`dropped_against`, and `compress_with_summary`.

**What is *not* here is the wiring, and the split is deliberate.** `compress_messages` takes
`&[Value]`, so the TypeScript's "does not mutate the caller's array" test has no counterpart — the
signature makes the mutation unrepresentable, and a test for it could not fail. The gateway still
forwards `messages` verbatim and the assistant still replays every prior turn; nothing calls this
module yet. That is a *wiring* increment, not this one, and the reason it is separate is the next
finding.

`cargo test` 712 → 746: +34 in the new `compress.rs`.

**The three safety properties are the point, not the byte count.** Tier 1 is hard truncation of the
oldest *complete turns*, and truncation is only safe because of three things: the `system` prefix
survives (it carries the client's instructions and, on the gateway, the injected memory block);
the newest turn survives even when it alone exceeds the budget (dropping it would answer a question
the user did not ask); and a turn boundary only ever falls on a `user` message, so an assistant
`tool_calls` turn and the `tool` results answering it always move together. The third is checked at
**every** budget from 0 to just past the whole conversation rather than at one hand-picked value,
because a bug that fires at one size is exactly what a single case misses — and the falsification run
confirms that this exhaustive loop is the *only* test that catches a turn boundary moved onto `tool`.

**Two estimators, kept apart on purpose; one fact, shared on purpose.** `gateway::context_scope`
already estimates tokens for the memory-injection budget, and the two are close enough that merging
them is the obvious tidy-up. They are not the same estimate — 3.5 chars/token against 4, a 0.20
reserve against 0.25, and string-only content against multimodal parts — and the *direction of the
error* differs: the memory estimator over-estimates deliberately (fewer chars per token means more
tokens means it under-injects, which is safe), while the compressor is not under that pressure. The
collision that settles it is `MEMORY_FRACTION`, which is *also* 0.25 while meaning "share of the
remaining window memory may take" — a value collision with a different meaning, which is exactly the
D21 pattern. So both ratios, both reserves and the content shape stay separate, with a test asserting
they differ, and the one genuinely shared fact — the per-message overhead of 4 — was extracted to
`context_scope::MESSAGE_OVERHEAD_TOKENS` and is now referenced by both.

**`String::length` counts UTF-16 code units, and the difference is not academic here.** The port uses
`encode_utf16().count()`. Byte length would over-estimate every non-ASCII conversation — Bengali is
three bytes per character — and drop history that fits; scalar values would under-count astral
characters by half. The test pins all three readings with inputs where they differ by 4×, including
four Bengali characters, which is the case that matters for a user in Dhaka.

**`new Set(final.messages)` is object identity, and Rust has no identity to compare.** The port's one
structural divergence: `dropped_against` spends one unit of allowance per kept copy rather than
testing membership, which gives the same answer as identity for distinct messages and a *correct*
answer for duplicates — with `[A, A, B]` reduced to `[A, B]`, exactly one `A` went. The doc-comment
claims only a partially-kept duplicate can tell the three readings apart, and the falsification run
**proved that claim the hard way**: a mutation replacing the allowance with a membership test reddens
the unit test and leaves the budget-driven duplicate test green, because in that test no copy of the
dropped message survives. The first harness expectation was wrong; the code was right.

**The fallback window is an alias, not a literal.** `DEFAULT_CONTEXT_WINDOW = DEFAULT_WINDOW_TOKENS`
because both answer one question — what window do we assume when nobody told us — and the TypeScript
says so in as many words. The test pinning it **cannot fail while the alias holds**, and that is
recorded rather than hidden: it is a guard on the shape, catching the day someone writes `8192` back
in. A test whose name overstates its coverage is the same defect as one whose name is simply wrong.

**Tier 2 degrades, and the degrade path is the contract.** A summarizer that fails and one that
returns only whitespace are the *same* outcome — Tier 1's answer, already a correct solution to the
same problem, merely one that keeps less — because an added feature must not turn a working request
into a failed one. The summary lands in the system prefix so the re-fit cannot trim it away; the
re-fit may drop further turns, and those go without a second summary, since recursing would put an
unbounded number of model calls on the request path. The dropped set is reported against the
**original** conversation rather than the intermediate one, so "what was removed" does not change
meaning depending on whether a summary happened to be produced.

**The re-entrancy blocker is real, and it is measured in both directions.** `Assistant.tsx`'s live
Tier 2 summarizer closes over the `router` singleton and calls `router.generateText` from inside
`router.generateText`. In Rust, `generate_text(&mut self, …)` cannot take a callback that re-enters
the same `&mut self`. Measured rather than guessed: a minimal reproduction is rejected with
**`E0501`** — `cannot borrow *self as mutable more than once at a time` — and *not* with the `E0499`
that was the first guess; the sequenced counterpart (summarize, then route) compiles and runs. So the
guard `skipCompression` exists to provide is not needed in this shape at all, and what Tier 2's
wiring needs instead is for the summarizer to be handed to the router as a *seam* — a
`&dyn Fn`-style boundary the router calls and does not own — rather than as a closure over the router
itself. This supersedes Phase 4's original note and §12's open question; see D24.

**Falsification: 21/21**, every mutation restoring byte-identical. Two initially *missed*, and both
misses were worth more than the passes:

1. **A harness bug.** M14 expected two tests to redden; the second cannot distinguish the counting
   rule from membership at all, for the reason above. The expectation was corrected to the single
   test that can.
2. **A real coverage gap.** `the_oldest_turn_goes_first_and_the_loop_stops_as_soon_as_it_fits` used
   **two** turns, and with two turns the bound `turns.len() - 1` ends the loop after one iteration
   whether or not the running total was decremented — so the second half of the test's own name was
   unverified, and deleting `total -= turn_tokens[start]` left it green. Rewritten with a third turn,
   which is what gives the loop somewhere left to go. The test now fails on that mutation.

Gate green: `cargo fmt --check` clean, `clippy --all-targets -- -D warnings` clean,
`cargo test` 746 passed / 0 failed, `cargo check --no-default-features --all-targets` clean.

### Phase 3 — Port the model router and route planner (2-3 days)

**Goal:** rewrite `model-router.ts` and `route-planner.ts` in Rust.

**`Candidate` is already in Rust.** `engine::Candidate` landed with increment 7, because the image loop needs
it, and its three row types are `persist.rs`'s unchanged. What Phase 3 adds is the *planner* that produces a
plan of them, not the type — and `context_scope::MemoryItem` is a different thing under a name that no longer
collides (D21).

**The planner is done (increment 11b).** `core/planner.rs` holds `build_plan`, `resolve_wanted`,
`strip_client_namespace`, `order_keys`, `order_carriers`. The ledger is done (increment 12), and the
router glue is done (increment 13): `core/router.rs` carries `generateText`, `generateImage`,
`complete`, `listModels`, `systemAiAvailable`, `syncConcurrency`, and the `plan` helper that builds a
`PlanContext` and calls `build_plan`. **Phase 3 is complete.** Compression is Phase 4's, and its pure
half has since landed — see increment 14a above. `messages` still reach the engine verbatim: the
module exists and nothing calls it yet.

These are less risky than the execution engine — they are synchronous, stateful logic without async
streams. The main challenge is the registry and catalog data structures, which today live in JS
memory and are hydrated from SQLite.

In Rust they become structs loaded from `store.rs` on startup and kept in an `Arc<RwLock<_>>`.

### Phase 4 — Port context compression (2-3 days)

**Goal:** rewrite `context-compress.ts` in Rust, then wire it in.

**Status — the port is done, the wiring is not.** Increment 14a landed `core/compress.rs`: Tier 1,
Tier 2, the estimator and the budget rule, 34 tests. What remains is the increment that calls it —
the gateway's read path and the assistant's turn loop both go through `router.generate_text`, so the
call belongs there once, and the two cannot drift.

**Tier 2's recursion problem has a different shape in Rust than in TypeScript, and the difference was
measured.** The TypeScript needs `skipCompression` because the summarizer closes over the same
`router` singleton it is running inside. In Rust, `generate_text(&mut self, …)` cannot accept a
callback that re-enters the same `&mut self`: a minimal reproduction is rejected with **`E0501`**,
and the sequenced counterpart compiles and runs. So the guard is not what the wiring needs — what it
needs is for the summarizer to arrive as a **seam** the router calls and does not own, rather than as
a closure over the router. The original note here claimed the flag "does not exist in Rust yet" and
that Phase 4 "must introduce the compression and the guard together"; the first half was true when
written and the second half is the wrong prescription. See D24.

**The earlier claim that `src-tauri` had no compression path at all was corrected while landing
increment 14a.** `context_scope.rs` estimates tokens, sizes a budget and drops what will not fit —
but it compresses *recalled memory* into a system message and never touches the conversation. What
was missing was a second input to an existing path, not a missing module. See D20.

### Phase 4b — Port the adapter runtime, and the module D26 left unphased

**Numbered 4b rather than 5 deliberately.** Renumbering would desync
[11](11-cross-platform-tech-choice.md), whose Phase 5 is the same "delete the bridge" step and whose
numbering this plan shares — so the adapter runtime is inserted where it belongs in the *order*
without moving a number that two documents depend on.

**Goal:** port the adapter layer — the two implementors of the `adapter.rs` seam.

This module has never had a phase, and **D26 is why**: the port table described the work as
`adapter-runtime.ts:60` — "60 lines" — when it is `code-adapter.ts` (615 lines / 24,820 bytes) plus
`manifest-interpreter.ts` (492 lines / 21,903 bytes). A module described as 60 lines needs no phase.

**The two implementors are not equally load-bearing, and that was measured on 2026-09-24 rather than
assumed.** `adapter-runtime.ts:52-58` branches on `manifest.kind === "code"`: a code manifest runs in
the QuickJS sandbox, anything else through the `ManifestInterpreter`. Against the installed database:

| implementor | live manifests | what it serves |
|---|---|---|
| `ManifestInterpreter` (`kind: "declarative"`) | **3 of 3** | every installed provider, and every builtin template |
| `CodeAdapterInstance` (`kind: "code"`) | **0 of 3** | reachable only as Tier 2 |

Tier 2 is reachable but human-gated: `Onboarding.tsx:240-242` offers it "only when the declarative
grammar cannot express this provider. It is an explicit human action, never an automatic fallback."
So the interpreter is the critical path and the sandbox is the exception path — which is why the
sandbox's `SIGSEGV` finding (§2.1.3) is a recorded residual risk rather than a blocker, and why
`adapter.rs:29-30` is right that "a subprocess-backed adapter is simply another implementor, so
in-process or out-of-process is not a question this trait has to answer."

**Increment 15 landed 2026-09-24 — the I/O-free half.** Three modules, 66 tests:

| module | ports | what it holds |
|---|---|---|
| `core/jsonpath.rs` | `jsonpath.ts` (77 lines) | `parse_path` / `select_all` / `select_one` — the subset has no `..`, no filters and no expressions, so a selector cannot carry code |
| `core/template.rs` | `template.ts` (41 lines) | the `{{x}}` required / `{{x?}}` omit-when-absent grammar — the §2.6 frozen rule |
| `core/manifest.rs` | the I/O-free half of `manifest-interpreter.ts` | header rendering and the `{{secret}}` sentinel, streaming tool-call reassembly, `read_cached_tokens`, `join_url`, `ManifestHttpError` |

Three states were **not** redefined, because the crate already has them: the sentinel is
`egress::SENTINEL`, `"response" | "mid-stream"` is `engine::FailureKind`, and a real tool call is
`adapter::ToolCall`. The TypeScript has one class in one file; Rust splits the same state across a
seam, and a seam is only worth having if both sides agree on the vocabulary.

**A dependency decision the interpreter forced, recorded rather than taken quietly.** `modality.ts`
is **deferred**, and the blocker is a dependency: a modality rule's `modelIdPattern` is a regular
expression, and this crate has no `regex` in its **runtime** graph. `Cargo.lock` lists
`regex 1.13.1`, which is exactly the trap — it arrives only through `tauri-build`'s **build** graph,
and `cargo tree -e normal -i regex --no-default-features` prints *nothing to print*. Adding it would
be a genuinely new runtime dependency of `aiproviderd`, which this port's own rule
(`adapter.rs:51-52`) forbids. See §10 decision 5.

**Corrected 2026-09-24, and the correction is the measurement rather than the conclusion (D28).** That
command carried `--no-default-features`, which is **not** how `aiproviderd` ships — so it answered a
question about the Tauri-free binary while the claim was about production. Under the default feature
set `cargo tree -e normal -i regex` lists three parents, `tauri-utils` and `urlpattern` among them.
`regex` was already in the runtime graph; the cost was zero. Decision 5 was argued from this paragraph
and is resolved against it above.

**Increment 16 landed 2026-09-24 — the I/O half, and the module is now whole.** Rust **812 → 870**,
**58 tests** across four files:

| module | lines | tests | what it holds |
|---|---|---|---|
| `core/http_port.rs` | 184 | 2 | the host seam — `HttpRequest` / `HttpMethod` / `HttpResponse<'a>` / `HttpError` / `trait HttpPort` |
| `core/manifest_view.rs` | 551 | 6 | the typed read model of a stored manifest — `ManifestView` and its sub-shapes |
| `core/interpreter.rs` | 2,258 | 44 | `ManifestInterpreter` — `list_models`, `ping_key`, `run_image`, and the streaming `run_text` loop |
| `core/manifest.rs` | — | +6 | `parse_retry_after` / `retry_after_from`, which increment 15's note claimed were already there |

**`HttpPort` is its own module for the same one-way-edge reason `adapter.rs` is.** `egress.rs`
implements it and `interpreter.rs` consumes it; putting the trait on either side would make the other
depend on the whole of it. **That sentence read "will implement" until increment 25a, and the future
tense turned out to be load-bearing: there was no production implementor at all, so it described an
intention rather than the tree (D40).** The implementation now lives in `core/egress_port.rs` rather
than in `egress.rs` itself, which keeps the trait at arm's length for the same one-way-edge reason
the module was split for in the first place. `stream: bool` on the request replaces `ipc-client.ts:41`'s sniffing — the
host should not have to infer a request's shape from its URL — and there is deliberately no timeout
field and no third method: the seam carries what the caller decided, not what the host might like to
do about it.

**The response shape is not the TypeScript's, and the asymmetry is the point.** The TS returns one
object carrying both `text()` and `lines`; `HttpResponse` fills `body` for a unary request *and for a
streaming request that failed*, and `lines` only for a streaming request that succeeded. The single
case where the request's choice (`stream: true`) differs from the caller's need is a `>= 400` on the
stream path (`manifest-interpreter.ts:304`), where the body is the only thing there is to read.

**The `finally` was the whole design problem.** `generateText` ends in a `finally` (`:421-437`) that
fires on *every* exit — reporting the reassembled tool calls and then the usage. Rust has no
`finally`, and `Drop` cannot stand in: the callbacks are `&'a mut dyn FnMut`, so a consumer that drops
the stream mid-flight would leave `Drop` with nothing callable, and the borrow would not outlive the
value regardless. What the port has instead is `TextStream::flush()` — idempotent, guarded by
cancellation, called at every exit the loop can reach, and called **before** a mid-stream error is
handed over, which is what makes the report arrive ahead of the failure.

**The read model is not the grammar, and the two want opposite strictness.**
`adapter-spec/src/manifest.ts` is 193 lines of zod that validates, applies defaults (`kind`,
`pagination.style`) and enforces `superRefine` rules — it is the gate an AI-generated manifest passes.
The interpreter reads a manifest that has *already* passed that gate, and must therefore **ignore
unknown fields** — the exact opposite of this repo's `deny_unknown_fields` rule for boundary payloads.
A stored manifest is a superset; a payload is a contract. `manifest_view.rs` parses both builtin
templates character for character in its tests, which is the guard against read-model drift.

**Increment 15's own scope note was wrong, and it is recorded rather than quietly patched.**
`parse_retry_after` / `retry_after_from` (`manifest-interpreter.ts:191-204`) are pure functions the
class calls, and they were never ported — although that note said every pure function the class calls
was present. They landed here with six tests, and the note was rewritten to *enumerate* what the
module holds rather than summarise it. **The date branch of `Retry-After` is a recorded absence:** the
source's second branch is `Date.parse(v)`, which accepts a superset of RFC 9110 and for which this
crate has no parser, so an unreadable value returns `None` and the caller falls back to
`engine.rs:1168`'s cooldown floor. A wrong date would set a cooldown nobody chose; asking for nothing
is the safe direction.

**Ten falsification probes, every one a red test, and two of them found more than they confirmed.**

1. **A test named for the dialect default did not test it.** Deleting the dialect default from
   `wants_usage` left **all 42 interpreter tests green**. The fixture sets `requestUsage: true`, which
   satisfies the *first* branch of the nullish chain, so the rule the test is named for was never
   reached. This is D18's defect class — a test whose claim is broader than its check — and it
   surfaced only because the probe was run *against the test* rather than trusted. The test now
   removes the key and **asserts the removal**, so a fixture that stopped carrying the flag would fail
   loudly instead of testing nothing, and a companion test pins the conjunction's second conjunct
   (`openai-chat-v1` **and** a `usage` selector to read). Re-run: removing either conjunct now fails
   exactly the test that names it.
2. **`flush()` carries two properties, and only one of them was named.** Removing the flush from the
   `Fail` arm failed the ordering test *and* pushed a second test's item count from 2 to 3 — because
   `flush` sets `finished`, so it is also the **termination** for every path that calls it. That is
   faithful (the source's `throw` unwinds its generator, so the `finally` runs and nothing after the
   failing line is read) but it was an *unnamed dependency*: the item-count assertion was pinning
   termination without saying so. A sibling test now names it
   (`a_mid_stream_error_ends_the_stream_so_a_later_line_is_never_read`), the `flush` doc-comment
   states both properties, and re-running the same probe now fails three tests, each naming one. The
   transport-break arm is **not** symmetric: there the flush's only job is the ordering, because the
   inner stream is already exhausted.

**A counting rule this increment needed.** `cargo test` reports **870** in the lib while a
`#[test]`-attribute count gives 732. The difference is exactly the `#[tokio::test(flavor =
"multi_thread")]` sites — **136** of them — which a `#\[(tokio::)?test\]` pattern silently misses.
`674 + 136 + 58 = 868` before the two tests added while falsifying. Count attributes by their full
form, or count what cargo prints.

**Increment 17 landed 2026-09-24 — `modality.rs`, and §10 decision 5 is taken.** Rust **870 → 900**,
**30 tests** in one file:

| module | lines | bytes | tests | what it holds |
|---|---|---|---|---|
| `core/modality.rs` | 655 | 30,043 | 30 | `rules_from_manifest`, `matches_modality_rule`, `tag_modality` and the `rawMatch` matcher — the port of `modality.ts` |

**Decision 5 was decided by measurement, and the measurement overturned the premise twice.** The plan
priced the option as "a genuinely new **runtime** dependency of `aiproviderd`" and quoted `cargo tree
-e normal -i regex --no-default-features` printing *nothing to print*. That command is accurate and
answers the wrong question, because the flag is not how `aiproviderd` ships. Under the default feature
set `regex` has three parents — `tauri-utils`, `urlpattern`, and the new direct edge — so it was in the
runtime graph all along. Settled the only way that settles it: `cargo tree --edges normal` resolves
**307** crates with the dependency and **307** without it, and the set difference is **empty**. The
cost is zero, and the increment-15 paragraph that recorded the old figure now carries the correction.

**The features are not the dependent's to choose, and two of my own claims died on that.** I wrote
`regex = { default-features = false, features = ["std"] }` and recorded that `perf` and `unicode` were
therefore off. Both were false: Cargo unifies features per crate across the whole graph, `tauri-utils`
takes `regex` with defaults on, and the resolved set is the full default one — `perf`, `perf-literal`,
`aho-corasick` and all. `Cargo.toml` now declares a plain `regex = "1"` with the reasoning beside it,
which is also the safer form: under the old spelling a future `tauri-utils` change would have silently
produced a build in which `^dall-e-.*$` stops compiling.

**And the assumption under both of them was wrong in a way only a test could show.** `unicode` off is
not available as a design. It does make `\d`/`\w`/`\s` ASCII, matching JavaScript — but it also makes
`.` byte-oriented, and the `Regex` type then refuses the pattern outright:
`RegexBuilder::new("^dall-e-.*$").unicode(false).build()` fails with *pattern can match invalid
UTF-8*. So the trade is refused, deliberately: **a class divergence on input that cannot occur beats a
hard failure on input that does.** What is left is measured and pinned in both directions — for ASCII
input every construct agrees with JavaScript, `.` being the one reachable exception because it matches
`\r` where JavaScript's excludes it; for non-ASCII input `\d` and `\w` part company, `\b` following
them. Recorded rather than papered over with a pattern rewriter, which would trade a known difference
for an unknown defect.

**The source's own test is named the opposite of what it asserts**, and that is **D27** rather than a
quiet fix: `modality.test.ts:19-20` is called *"does not throw on an invalid regex — an unparseable
rule simply never matches"* and then asserts `.toThrow()`. The assertion is right and the **name** is
wrong, so a porter who reads the name implements the silent behaviour that demotes every model of a
provider to `text`. The port takes the assertion.

**Eight falsification probes, each reverted by its inverse edit, each red on the tests that name the
property.** OR → AND reddens `either_matcher_may_match` and `a_rule_with_neither_matcher_never_matches`.
Letting a `text`-keyed rule populate `image` reddens `a_text_keyed_rule_is_ignored`. Removing array
membership reddens `raw_match_matches_array_membership` **and leaves the `[0]`-indexing tests green**,
which is what shows those two test indexing rather than membership. An uncompilable pattern turned
into a non-match reddens the four error-path tests; an unreadable `modalityRules` block read as an
absence reddens its own; an unresolvable `rawMatch` path treated as an error reddens its own.

Two probes were worth more than they cost. **Anchoring** — wrapping every pattern in `^(?:…)$`, which
is the natural Rust assumption — reddens **five** tests, so `RegExp.test`'s unanchored semantics is
load-bearing well beyond the test named for it. And **switching to `unicode(false)`** reddens exactly
the two divergence tests, reproducing the measurement above as a test failure, while
`the_builtin_template_rule_matches_the_models_it_exists_for` stays **green** — the only pattern any
shipped manifest carries has no `.` and no classes, which is the boundedness argument in a single
observation.

**Nothing remains in this phase.**

**What has landed.** Increments 15–17 make the interpreter whole (`jsonpath.rs`, `template.rs`,
`manifest.rs`, `http_port.rs`, `manifest_view.rs`, `interpreter.rs`, and `modality.rs`, which also
took §10 decision 5). Increment 18 lands the engine-free half of the sandbox (`sandbox.rs`); 19a adds
the engine and measures the seam's bound, which is D30; 19b lands the actor (`js_host.rs`); 20a the
manifest half (`code_adapter.rs`); 20b the last member 20a had deliberately **buffered** — true
streaming for `generateText`; and **21 closes the phase** with the registry that chooses between the
two implementors (`adapter_runtime.rs`). Six of the seven `AdapterInstance` members came with 20a and
the seventh with 20b, so the only thing left after those was the branch, and it is the branch that
makes the sandbox reachable from the router at all.

**Increment 21 — the adapter runtime, and the last module of the phase.** `AdapterRuntime` is the
port of `adapter-runtime.ts`, and the honest description of that file is a **registry**, not the
factory the plan named: `register`, `unregister`, `for_provider` and `dispose` over one
`RwLock<HashMap<String, Arc<dyn AdapterInstance>>>`, with a private `build` that reads `kind`. The
registry half is not bookkeeping — a `kind: "code"` adapter owns a thread and a QuickJS context
(D30), and `JsSandbox::spawn` compiles the guest source and blocks until the actor reports ready, so
a `for_provider` that constructed instead of looking up would spawn a thread and compile a module per
request. Fourteen tests; Rust **982 → 996**.

**The one divergence, and why it is not a preference.** The reference disposes the superseded adapter
before it builds the replacement:

```text
const superseded = this.byProvider.get(providerId);
if (superseded) void superseded.dispose?.();            // :30 — void-ed, so it does not wait
this.byProvider.set(providerId, this.build(manifest));  // :31 — throws before the set runs
```

Because `build` is evaluated as the argument to `set`, a manifest that fails to build throws *before*
`set` runs — so the map keeps the old adapter, now disposed, and every later `forProvider` returns it
and fails with `"adapter disposed"`. The provider is dead until something re-registers it. The `void`
also means the teardown races the construction rather than preceding it, so the ordering is an
artifact of a discarded promise rather than a stated policy. On this side `dispose` is synchronous
and **joins the actor thread**, so porting the order would pay a join on a path that then fails *and*
reproduce the dead-adapter state. The port builds first, swaps, then disposes; a failed `register`
leaves the previous adapter serving and says so in its `Err`. Recorded as **D32**, pinned by
`a_manifest_that_fails_to_build_leaves_the_previous_adapter_serving`, and the probe that restores the
reference's order reddens exactly that test.

**`appUrl` is the increment's one hidden dependency.** The reference's declarative branch passes
`vars: { appUrl: this.vars.appUrl ?? "https://aiprovider.router" }` (`:57`), which reads like a
courtesy default and is not: the OpenRouter template's `generateText` carries
`"HTTP-Referer": "{{appUrl}}"` (`manifest_view.rs:302`), and an **unbound** host variable renders as
the empty string rather than being omitted (`manifest.rs:294` — the `?? ""` rule, which is the
opposite of the request template's). A runtime that supplied no vars would therefore send an empty
`HTTP-Referer` on every OpenRouter request. The test asserts on the header the egress was handed, not
on the field, and the probe that empties the context's map reddens it with `left: Some("")`.

**A false pass, caught by a probe rather than by review.** The first version of
`a_superseded_sandbox_is_disposed` observed disposal through `generateImage`. The fixture guest
implements `listModels` and nothing else, so that call failed with `AttemptError::Transport` because
the method was missing — the *same* error a disposed sandbox produces — and the assertion could never
fail. The probe that removed the `superseded.dispose()` call left it green, which is what exposed it.
It now probes `listModels`, the operation the guest answers, and asserts the replacement works beside
the superseded adapter failing. The general form is the one this register keeps rediscovering: **an
assertion whose expected failure has more than one cause is not an assertion.**

**What is deliberately not here.** No store read: `register` takes a parsed manifest, and who reads
`manifests.body_json` and calls it is the activation path's business. Nothing in production calls
`AdapterRuntime` yet, which is the same position `code_adapter.rs` has been in since 20a — this phase
makes the sandbox *reachable*, and Phase 5 is what reaches it.

### Phase 5 — Delete the bridge (1 day)

**Goal:** remove `gateway_cmds.rs` bridge code, `gateway-worker.ts`, `gateway.html`, and `app_nap.rs`.

This is the satisfying phase. The gateway routes directly into the Rust router core. No hidden
webview. No Tauri events. No heartbeat.

**Reconnaissance changed the size of this phase, and it is larger than "delete".** At reconnaissance a Grep
for `normalize_gateway_request`, `detect_client`, `parse_assistant_stream`, `to_wire_tool_calls`,
`registry_to_openai` and `MAX_TOOL_ITERATIONS` over `src-tauri/src` returned **no matches**, and
`tauri/tools.rs` held no OpenAI tool schemas at all. **All six now resolve** — the sentence is dated because
the tense was not (D36). So the bridge was not a thin adapter over a Rust core that already existed — it was
the *only* place the client-facing request pipeline lived. Deleting it without porting that pipeline would
have removed behaviour, not indirection. The phase therefore splits into five increments, and only the last
one is the deletion:

| Increment | Work |
|---|---|
| **22 — landed** | Port `gateway-normalizer.ts` (728 lines) and `gateway-client-detector.ts` (19 lines) to `core/gateway_normalizer.rs` |
| **23 — landed** | Port `parseAssistantStream`, `toWireToolCalls` and the tool registry's OpenAI schemas |
| **24a — landed** | Move the tool host from `tauri/tools.rs` into `core/tools.rs`, where the bridge can reach it |
| **24b-i — landed** | `core/bridge_policy.rs` — the bridge's decisions with no I/O: status, tool ownership, the held-prose gate, the turn outcome, call collection, the retry hint |
| **24c — landed** | `Bridge::ready` — the seam that decides *whose* question readiness is, so a Rust bridge is not measured against a webview's liveness rule (D35). It is a prerequisite of 24b-ii, not a follow-up: installing a Rust bridge without it ships a five-second stall plus a 503 on every request |
| **24b-ii-a — landed** | `SharedRouterState` — the state every request must see one copy of: the circuit breaker, the key cursors, the ledger and the limiter. A prerequisite of 24b-ii, not a follow-up: `execute_text`'s `&mut HealthTracker` and `ModelRouter`'s `&mut self` made "two requests at once" unrepresentable, so the driver could only have been written serialising or with per-request state (D38) |
| **24b-ii-b — landed** | `core/router_bridge.rs` — the driver: a Rust-native `Bridge` running the tool loop against `ModelRouter` and `AdapterRuntime`, writing to `ReplyHandle`. **Landed against seams, not wired**: three paths it must walk are still Tauri-shaped or Tauri-gated, so nothing installs it yet (D39) |
| **25a — landed** | `core/egress_port.rs` — `impl HttpPort for EgressPort`, the production implementor the plan's own future tense had assumed existed (D40). Un-gates `egress::stream` off `tauri::ipc::Channel` onto an `mpsc` sink, so `egress.rs` now carries **no** `cfg(feature = "app")` at all |
| **25b — landed** | Hydration readers — split `providers_list` / `api_keys_list` / `models_cache_list` / `aliases_list` into un-gated `&Store` functions plus thin `#[tauri::command]` wrappers, so a headless launch can build the `RouterStore` (D39, gap 1). It also gave `RouterSettings` its first production source, a prerequisite none of D39's three gaps had named |
| **25c — landed** | The manifest activation path — read `manifests.body_json` and call `AdapterRuntime::register`, which no production code did before this increment (D40). `core/activation.rs` is `register`'s **first production caller**. It iterates manifest rows rather than providers, because the reference's `PROVIDER_PROFILES[slug]` branch has no Rust port — harmless on this install, a divergence elsewhere (**D41**) |
| **25d — landed** | A store-backed `LedgerSink` over `persist::ledger_insert` (D39, gap 3). Not required to *serve*: a router with no sink attached keeps the ledger in memory and raises no error, so this is durability rather than reachability. `core::ledger::StoreLedgerSink` is the **first production `LedgerSink`**, and `persist::ledger_insert` is `pub` and un-gated, so the headless service writes ledger rows with no command in the path |
| **25e — landed** | Install `RouterBridge` — hydrate (`RouterStore::from_store`, 25b), register the adapters (`activation::activate`, 25c), build the `EgressPort` (25a) and the store-backed ledger sink (`StoreLedgerSink`, 25d), and swap `HeadlessBridge` for `RouterBridge` in `bin/aiproviderd.rs`. The binary answers `ready() == true`. **The "serves completions" half of this row was not true when it was written** — the first end-to-end run, during 25f verification, found the egress allowlist empty and every provider call refused (**D45**) |
| **25f — landed** | Delete `EventBridge`, the worker, `gateway.html` and `app_nap.rs`, switch `build_core` — **and retire the webview-liveness subsystem, which this row had not named (D35)**. Safe only once 25a–25e stand a Rust path behind it. Landed in the two passes the row's own risk implies: the deletions first, then the wiring |

**Increment 22 — the request normalizer.** `core/gateway_normalizer.rs` is a pure module: no I/O, no
clock, no network, which is what lets it be pinned before anything calls it. 53 tests, Rust
**996 → 1049**. Five divergences from the reference, each stated in the module's header with its
reason — the tool-name map is returned out of band as a field rather than attached to the body as a
non-enumerable property (a `serde_json::Value` has nowhere to hide one, and a key in the object would
be serialized and sent upstream); a non-string `name`/`arguments` contributes nothing to a generated
id where the reference coerces it; length arithmetic counts Unicode scalars rather than UTF-16 code
units; object key order is not preserved; and the reference's duplicated guard in
`promoteInputToMessages` is not reproduced.

**The hash helpers are pinned against the reference's own output rather than against a reading of it.**
`simple_hash` is the reference's signed-32-bit `|0` accumulator and `generateToolCallId` /
`normalizeTo9CharId` are its base-36 renderings, so the port was checked by *running* the original in
Node and asserting the same strings: `generateToolCallId(0, "read", "{}")` is `call_tcdq4k`,
`normalizeTo9CharId("call_abc123")` is `000d4riwf`. A hand-rolled `parse_glm_version` replaces the
reference's `/glm-?(\d+)(?:[.p](\d+))?/`, and its grammar is pinned by a test that includes the inputs
where it does **not** match.

**Two findings, and they are different in kind.**

The first is **D33 — a write with no reader.** `remapClaudeToolNamesInRequest` records every rename in
`_toolNameMap` on three paths, and the module also builds a global `CLAUDE_REVERSE_MAP` by inverting the
rename table — and **neither is ever read**. The only consumer of `_toolNameMap` in the whole repository
is the test for the writer (`gateway-normalizer.test.ts:380`). So the response-path restore the plan
prescribes in present tense (`gateway-flexibility-plan.md:113` and `:311`) was never implemented, and a
Claude Code client that sends `bash` receives `Bash` back. This is D31's signature one layer out: a cap
whose only caller is its own test is not enforced, and a map whose only reader is its own test is not a
feature. The port carries the per-request map as a field on the returned value, so Phase 5c's response
path has a consumer to read, and deliberately does **not** port the global reverse map — it would rewrite
any TitleCase name, including one the client never sent, where the per-request map records only what
*this* request renamed.

The second is an **asymmetry preserved rather than corrected.** The reference drops
`max_tokens`/`max_completion_tokens` when `max_output_tokens` is already set, but leaves
`reasoning_effort` in place when `reasoning` is already set, because there the `delete` sits *inside*
the guard (`gateway-normalizer.ts:596-602`). The stray alias is ignored by the upstream, and correcting
it here would be a silent behaviour change in a port, so a test pins the reference's behaviour instead
and the module header records why.

**Seven falsifications, all red** (baseline `94875ae1…`): the WorkBuddy-first client order, the 32-bit
`|0` truncation in `simple_hash`, the GLM 5.1 boundary, the reasoning alias, the insertion point of a
repaired tool result, the open-schema rule, and the 9-character id padding. One of them exposed a
**coverage gap rather than a defect**: no test distinguished *where* a repaired tool result is inserted —
the one existing test has a single message, so "after the declaring turn" and "at the end" are the same
index — and the rule had therefore been unpinned. `inserts_a_missing_tool_result_directly_after_its_assistant_turn`
now separates the two, which is what makes the probe able to redden.

**Increment 23 — the stream parser, the tool wire and the tool registry.** Three modules, 41 tests, Rust
**1049 → 1090**, and the count was measured rather than projected: the plan said 42, the tree says
18 + 12 + 11. All three are pure — no I/O, no clock, no network — which is the same reason increment 22
could be pinned before anything calls it.

`core/assistant_stream.rs` ports `assistant-stream.ts` (171 lines). **The one structural subtlety is a
split the port keeps rather than smooths.** The seven marker families are matched as **literal,
case-sensitive** substrings, exactly as `String.indexOf` does, while the `function=` and `parameter=` tags
inside a block are matched by a **case-insensitive regex** that tolerates an optional pipe and arbitrary
spacing. So `<|tool_call_start>` one character short is prose, while `<FUNCTION = Bash>` is a tag. Two
functions carry the split — `literal_index_of` and `match_marker_at` — and the tests pin opposite sides of
it, so collapsing the two would redden one of them.

Two more rules are ported rather than approximated. `\s` is **JavaScript's**, not Unicode's: the two
disagree on `U+FEFF`, which JS counts as whitespace and `char::is_whitespace` does not, so `is_js_space`
is hand-written and the test asserts the disagreement itself rather than only the membership. And the
streaming hold-back has a **floor of 2** and a **ceiling of `len - 1`** — a lone `<` in prose survives, a
half-typed marker is held back, and a *complete* token is never eaten because by the time the hold-back
runs such a token has already been consumed as a marker.

`core/tool_wire.rs` ports `tools/wire.ts` (82 lines) and exists because of one defect. An absent tool-call
id used to become the empty string on the assistant turn and the tool *name* on the result turn, so the
two could never match and every continuation died with a provider `400` — which is what "the router stops
after a tool call" was. The fix is structural: `to_wire_tool_calls` returns the wire entries **and** the
ids it chose, so both halves are derived from one decision and are index-aligned by construction. That
alignment is the property to preserve, and `the_ids_and_the_entries_are_index_aligned` pins it. The module
reuses `gateway_normalizer::to_base36` rather than inventing a second spelling of the same conversion,
which is the only reason `to_base36` became `pub(crate)`.

`core/tool_registry.rs` ports `tools/registry.ts` (168 lines): eight tools with OpenAI JSON schemas, built
once behind a `OnceLock`. A `const` is impossible for a `Value`-carrying registry, so the alternative would
have been a `static` that cannot be built — worth stating because the obvious wrong answer is the one that
looks simplest. `registry_to_openai` returns **`None`** for an empty registry rather than an empty array:
some providers reject an empty `tools` list with a `400`, so "omit the key" and "send nothing" are
different requests.

**One finding, and it is D34.** The `MARKERS` array order was documented — in the port's own doc comment —
as load-bearing: "the order is the tie-break". A tie requires two families to match at one offset, which
requires one start token to be a prefix of another, and **no start token is** — 0 prefix pairs over all 7,
measured. The strict `at < s` comparison is therefore a tie-break for a tie that cannot occur, and `at <= s`
behaves identically. The *reachable* half of the same loop — the **earliest** match wins, not the last — is
real and was already pinned by `handles_several_blocks_in_one_response`, so the defect is narrow and
precise: a documented rule about a state that cannot be entered. It is D33's signature one step further
out — a mechanism whose only evidence is prose — except that here the prose is the port's own, which is
what made it checkable at all.

**The correction is a guard, not a rewording.** `the_marker_order_is_not_load_bearing` asserts the
prefix-freeness of the seven start tokens, so the day a family is added that *can* tie, the test goes red
and the tie-break becomes live again — at which point the comment is wrong and must be rewritten. A comment
saying "this is not load-bearing" is unverifiable; a test saying so is falsifiable, and the probe that adds
a prefix-pair family (`<|tool_call`) reddens it with a message naming the two tokens.

**Eleven falsifications, all red** (baselines `faaf88e8…` for the parser, `99489982…` for the wire,
`ebdb1df3…` for the registry; tree byte-identical after restoration): the hold-back floor, the tag
case-fold, the closing-tag strip, the `U+FEFF` membership, id synthesis, the `arguments` default, the name
fallback, `None`-on-empty, `additionalProperties`, the cross-module `MUTATING_TOOLS` guard, and the new
prefix-freeness tripwire. The tenth is worth naming because it crosses a module boundary: adding `read_file`
to `gateway::MUTATING_TOOLS` reddens the registry's own test, which proves the test reads the gateway's
constant rather than a copy of it.

**Increment 24a — the tool host moves into `core/`, and it was never coupled at all.** Phase 5c needs
`core/router_bridge.rs` to execute tools, and `core/` may not name `crate::tauri::*`. The open question was
whether that meant rewriting the sandbox. It did not, and the measurement is the increment's first result:
`tauri/tools.rs` is 1,464 lines, its implementation is 828 (the test modules begin at `:829`), and **before
that point the only `tauri::` mentions are four `#[tauri::command]` attributes** — `:126`, `:144`, `:157`,
`:805`. No `AppHandle`, no `State`. The test region mentions neither either, the out-of-line
`tools_agent_tests.rs` (236 lines) is glue-free too, and its one outward reach — `default_workspace_root` —
was already in `core/gateway.rs`. So the host was glue-free logic wearing four attribute macros, and the work
was a `git mv`, four deletions, and four thin wrappers in `tauri/tools_cmds.rs`.

**Two consequences, and the second is the one worth measuring.** The obvious one is that the bridge can now
reach the host. The measurable one is that the tool tests changed sides of a line nobody was watching:
`lib.rs:12-13` gates `pub mod tauri` behind `#[cfg(feature = "app")]`, so **51 tool tests were never compiled
in the headless configuration at all** — and they are the tests for the sandbox the headless service is
supposed to enforce. After the move, `cargo test --no-default-features` reports **1030 passed / 0 failed**,
all 51 included. Before the move the same run would have reported 979 — by subtraction rather than a second
measurement, since the move changed nothing else. That difference is coverage the split silently did not have.

**No behaviour change, and the count is the proof:** 1090 passed / 0 failed on default features, exactly the
increment-23 number. The wrappers add no logic, and must not — if one ever grows a line, that line belongs in
`core::tools`, or the app and the service start enforcing two slightly different sandboxes.

**Phase 5d is bigger than its row, and the gap is measured (D35).** The row names four files. What those files
implement is a liveness subsystem that exists *only* because the worker is a webview the OS can suspend:
`HEARTBEAT_STALE_MS` = 6 s and `HEARTBEAT_STALE_HIDDEN_MS` = 30 s (`core/gateway.rs:44`, `:65`),
`beat_is_fresh()` (`:1140`), `FIRST_MSG_TIMEOUT` = 30 s (`:1299`), the `gateway_heartbeat` command
(`tauri/gateway_cmds.rs:889`), `ensure_bridge_window` (`:105`) with its worker-warmup window, the
background-mode bounds, the re-warm on the request path, and the three `r1_*` tests. `app_nap.rs` exists for
that reason and no other.

**The hazard is concrete, and worse than a bare 503.** The webview beats every 2 s
(`gateway-bridge.ts:130`); `beat_is_fresh()` goes false 6 s after the last beat. The gate itself is
`if !core.is_available() && !await_core(core).await` (`core/gateway.rs:1418`), and `is_available()` is
`is_running() && beat_is_fresh()` (`:1124`). So a request arriving on a stale beat is first **stalled for
`CORE_RECOVERY_GRACE` = 5 s**, polled every 150 ms (`:1369-1370`), and only then answered `503`. Deleting the
worker without retiring the gate therefore costs every client five seconds *and* a 503, permanently — nothing
will ever beat again. And `RouterBridge` cannot simply take the beat over: `ReplyHandle` deliberately does not
hold the core — the reference cycle increment 12 designed out — so the beat has no source until one is chosen.

**So 24b-ii has a prerequisite the plan did not have.** The beat's source must be decided before the driver
is written. There are two shapes, and the second is the one to take:

- **The core stops asking.** When a Rust bridge is installed, `beat_is_fresh()` short-circuits true.
  Rejected. A Rust bridge *is* always awake, so "is it awake?" is not answered — it is **bypassed by a flag**,
  and that flag is a second spelling of state the core already holds (which bridge is installed). This project
  has already paid twice for two spellings of one state (`NULL` vs `0`); a bypass is the same defect with a
  different subject.
- **A seam on the `Bridge` trait.** Sync, defaulted, so no async-in-trait machinery is needed:

  ```rust
  fn ready(&self) -> bool { true }   // a bridge in this process is always awake
  fn warm(&self) {}                  // ask the bridge to recover, if it can
  ```

  `EventBridge` overrides both with the heartbeat and the re-composite. The other **three** impls —
  `NoopBridge` (`core/gateway.rs:465`), `SynthBridge` (`core/gateway_tests.rs:97`) and `MinimalBridge`
  (`:3186`) — are test doubles and inherit the defaults untouched. `await_core` stays in the core, calling
  `bridge.ready()` / `bridge.warm()` in place of `beat_is_fresh()` / `request_warm()`.

  **Why this one:** it is the shape that makes Phase 5d *safe by construction*. With `EventBridge` deleted the
  defaults make `await_core` return true on its first poll, so the loop and the 503 branch become visibly
  unreachable rather than silently wrong — the compiler and the tests show what is dead instead of leaving a
  gate that fires on a condition nobody sets. The cost is one trait method pair and two overrides, paid once.

Either way it is a decision, and D35 records that it is currently unnamed.

**Increment 24b-i — the bridge's decisions, separated from the I/O that carries them out.** Phase 5c splits
in two because the driver is large and its *decisions* are not. `core/bridge_policy.rs` is the decisions: 699
lines, **34 tests**, Rust **1090 → 1124**, and the headless run **1030 → 1064** — every new test reachable
without the `app` feature, which is the whole reason policy belongs in `core/`. The reference is
`gateway-bridge.ts` (421 lines). What is in it: `BridgeKind` and its `parse`/`runs_tool_loop`;
`CLIENT_ATTRIBUTABLE_STATUS` with `gateway_status` and `gateway_status_for_attempts`; `ToolOwnership` with
`decide_tool_ownership` and `tool_choice_for`; `ProseGate`; `TurnOutcome` with `decide_turn`;
`push_tool_call`; `MAX_TOOL_ITERATIONS`; `retry_after_hint`.

**Two scope corrections, both from measuring instead of assuming.** `min_retry_after_ms` and `attempt_budget`
were on the reconnaissance list for this increment; both are already ported into `core/engine.rs` (`:298`,
`:326`), so the only new work on the wait is `retry_after_hint`, which turns the engine's `0` into an absent
field. And the pre-turn liveness probe is **not** ported at all — it exists because a webview can be
suspended, and a Rust bridge cannot (D35). What the reference parses twice, `ProseGate` takes once: it
receives text that has already been through `assistant_stream::visible_text`.

**Six rules, each one a defect class rather than a style preference.** An id-less tool call is **always
kept** — the reference's `if (!collected.some((c) => c.id && c.id === call.id))` leans on the `c.id &&`, and
comparing the ids directly makes `None == None` true so a turn that asked for three writes runs one. The tool
toggle is read **only** when the client brought no tools, which is what stops a setting overriding a client
that declared its own. The upstream status **outranks** the message heuristic, so a chain ending in `400` is
reported `400` even when the message says "no route" — the status is evidence and the message is not. The
**last** attempt decides, not the first. `discard` is not `release`: a new turn drops the previous preamble
where a finished turn hands it over. And an unnamed wait is an **absent field, not a zero**, because
`retry_after_ms: 0` reads to a client as "retry now" — the wrong advice immediately after an overload.

**`/no route|not found/i` is hand-rolled, and the ASCII folding is argued rather than assumed.** There is no
`regex` in the runtime graph — the constraint `sandbox.rs:44` records for its header names. JavaScript's `/i`
folds Unicode, so ASCII folding needs an equivalence proof: neither needle contains `s`, `k` or `i`, the only
letters with non-ASCII case-fold partners (`ſ`/U+017F, `K`/U+212A, `İ`/U+0130), so no non-ASCII character can
match either literal. `no_non_ascii_character_can_stand_in_for_a_letter_here` pins the argument with the
lookalikes themselves.

**Nine falsifications, all red, tree restored byte-exact** (`74d4a4ed…`, 31,004 bytes): the id-less keep, the
toggle order, the status-over-message precedence, last-versus-first, `discard`, the unnamed-wait omission, the
empty-chunk guard, mercury-over-collected, and the gateway-only tool steering. **D36 was opened and fixed in
the same increment** — the Phase 5 reconnaissance sentence above is present tense and asserts a Grep returns
no matches for six names that all now resolve.

**Increment 24c — readiness is the bridge's question, not the core's.** D35's fix, and it is a prerequisite of
24b-ii rather than a follow-up: installing a Rust bridge without it ships a five-second stall plus a 503 on
every request. Rust **1124 → 1128**, headless **1064 → 1068**, and **behaviour on the webview path is
unchanged** — 1124 / 0 both before and after the refactor, so the four new tests are the only additions.

The shape: `Beat { age, hidden }` is the core's liveness view as a `Copy` snapshot, and `Beat::is_fresh()` is
now the single place the two bounds are applied. `Bridge::ready(&self, beat: Beat) -> bool` has **no default
body**. `GatewayCore` gains `beat()` and `bridge_ready()`; `is_available()` becomes
`is_running() && bridge_ready()`; `beat_is_fresh()` stays, because it is the UI's `worker_awake` — a statement
about the *webview*, not about the bridge. `await_core` polls `bridge_ready()`, so an in-process bridge succeeds
on the first poll and the loop never sleeps. `EventBridge::ready` delegates to `webview_ready`;
`HeadlessBridge::ready` answers `false`, which is honest (it discards every dispatch) and preserves the binary's
fast 503 instead of turning it into a thirty-second hang.

**Two departures from what D35 first proposed, both measured rather than preferred.** *No default body:* the two
answers are opposites, and a default of `true` would let a *future* webview-backed bridge silently inherit
"always ready" — the hazard itself. With no default, the compiler's `E0046` immediately surfaced a **sixth**
implementor (`core/context_scope.rs:1336`) that a Grep for `impl Bridge for` had missed, because it spells the
path in full. *No `warm()`:* the re-warm hook and its rate limiter are core-owned state, and `request_warm` is
already a no-op with no hook installed, so a bridge-side copy would be a second spelling of state the core
already holds.

**`webview_ready` is a coverage device, not tidiness.** `EventBridge` is the only implementation that serves
production traffic and the only one no test can construct — it needs an `AppHandle`. Spelling `beat.is_fresh()`
at each site would leave that line unreachable, and reverting it to `true` would reintroduce D35 with every test
still green. One shared function moves the decision where the tests can reach it: the three doubles exercise it,
so the R1 heartbeat tests guard it.

**Seven falsifications, all red, both files restored byte-exact.** `await_core`'s timeout branch stays uncovered
on purpose — it costs `CORE_RECOVERY_GRACE` (5 s) of wall clock and the crate has no `tokio` `test-util` to fake
it; it was uncovered before this change too. **D37 was opened and fixed here:** two doc comments named "Phase 2"
as the phase that replaces `HeadlessBridge`, when Phase 2 is the execution engine and the bridge is Phase 5c —
two scope-wrong claims in two consecutive increments.

### Phase 6 — Process manager and UI changes (2-3 days)

**Goal:** launchd plist, service binary bundling, UI HTTP client.

1. ~~Write the plist template and the install logic.~~ **Landed 2026-09-25 as increment 26a** —
   `core/service.rs` (plist, install, uninstall, status over an injectable `launchctl`) plus
   `tauri/service_cmds.rs` and its shim cases. **Not called from anywhere in production, by
   design:** with `RunAtLoad` set, the agent and the app both bind the same port, so installing
   it is a bind conflict until step 3 lands. See the 26a note in §11.
2. Bundle `aiproviderd` into the `.app`. **Half-done already, and not by this plan:** `tauri build`
   copies every `[[bin]]` next to the main binary, so the service is in `Contents/MacOS/` with
   `bundle.externalBin` unset and nothing in this repository naming it (no script, no `resources`).
   **`externalBin` is not the fix and is not needed** — it wants a `<path>-<target-triple>` source that
   nothing produces, and it targets the same destination the `[[bin]]` handling already fills. §2.1.1's
   "no sidecar config is needed" was checked and confirmed on 2026-09-25; step 2's "what is missing is
   declaring it" was the wrong half of the sentence.
   **What this step actually decides is which build gets bundled, and the reason is the dependency
   invariant, not size.** Measured 2026-09-25, same session, same profile, one variable: the
   default-features binary **links `WebKit.framework`** (12 dylibs; 34 `wry`/`webkit`/`gtk` nodes in
   `cargo tree`) and the `--no-default-features` one **does not** (8 dylibs; 0 nodes) — but the
   Tauri-free binary is only **16,896 B smaller** (8,586,864 vs 8,603,760), because WebKit is a system
   framework linked *dynamically* and so contributes no file size at all. A size argument would be
   nearly vacuous, and the figure this step used to carry was wrong by 22× (D56).
   **So: bundle the Tauri-free build — and note that `tauri build` cannot produce it.** It builds the
   default-features target, so the copy it places today is the WebKit-linking one (verified: the
   bundled binary links WebKit). Producing the Tauri-free one and substituting it into the bundle is a
   build step, and that is the real remaining work here.
3. ~~Add the UI control for the service.~~ **Landed 2026-09-25 as increment 26b** — a "Login-item
   service" card on Control → Gateway with status, Install/Remove, and a port-conflict warning.
   See the 26b note in §11.
4. Change the UI from `invoke` to `fetch()` for gateway operations. **In progress (2026-09-25).**
   §10 decision 2 is settled: **pure HTTP**. The migration covers gateway request routes (already
   HTTP), the §5.3 admin routes, and the CRUD route groups. ~~Admin routes (settings, keys,
   spend)~~ **landed 26d**; ~~provider CRUD~~ **landed 26e**; ~~remaining CRUD (api-keys,
   manifests, models-cache, aliases, ledger)~~ **landed 26f**. See the decision entry in §10.
5. ~~Add CORS headers to the gateway for `tauri://localhost`.~~ **Landed 26c.** A
   prerequisite for step 4, now unblocked by the pure-HTTP decision.
6. Update `09-status.md` and the drift register. **Done for 26a–26f.**

---

## 8. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Execution engine port introduces bugs** | High | Critical | Port tests first; keep JS implementation behind a feature flag; run both in parallel for one release |
| **Adapter runtime (QuickJS-WASM) is hard to port** | **Resolved 2026-09-24** | High | **Spiked and answered: it is a port.** `rquickjs` runs `GOOD_GUEST` verbatim to the same three values the TS suite asserts, and every host primitive maps (§2.1.3). The residual risk is narrower and named: an OOM raised during the synchronous part of the call **`SIGSEGV`s the host** — measured 2026-09-25 to be a **NULL dereference at `+0x20` inside QuickJS's own `build_backtrace`**, not the guest's allocation. **Corrected 2026-09-25:** this cell used to conclude *"the 32 MB heap limit is not containment … so that ceiling needs a supervisor or a subprocess"*, and **S6i falsifies that** — `siglongjmp` out of the fault leaves a working process, so the ceiling **is** enforceable in-process. What is unmeasured is the cost of the abandoned frame: the leak's size, and a `Runtime` left holding its global lock. See §2.1.3 and D54 |
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
   - ~~Port: single binary, simpler deployment, but `rquickjs` is immature.~~
   - ~~Subprocess: keep JS adapters in a worker, but add IPC overhead.~~
   - ~~*Recommendation:* evaluate `rquickjs` in a spike (1 day). If it passes the contract suite, port.
   If not, subprocess.~~
   - **Answered 2026-09-24 by the spike in §2.1.3.** The spike was run and the contract suite passes
   verbatim, so **port**. Note the premise: "`rquickjs` is immature" was never tested, and it is now
   contradicted for every primitive this sandbox actually uses. One sub-decision survives — what to do
   about the heap ceiling. ~~the 32 MB heap ceiling cannot be enforced in-process without the power to
   kill the host, so either the whole adapter runtime runs under a supervisor or that one limit does.~~
   **Corrected 2026-09-25 (26p): the ceiling *can* be enforced in-process** — S6i fences the fault and
   the process keeps working. The question is now whether the abandoned-frame cost (an unmeasured leak,
   plus a `Runtime` abandoned while holding its global lock) makes a supervisor preferable *anyway*. It
   is open, and it is a question about the leak rather than about feasibility. See D54.

2. **Do we keep the Tauri app as a pure HTTP client, or keep a subset of IPC for performance?**
   — **RESOLVED 2026-09-25: pure HTTP.**
   - ~~Pure HTTP: simpler, consistent, no special cases.~~
   - ~~Hybrid HTTP+IPC: keep IPC for hot paths (settings read), HTTP for gateway operations.~~
   - ~~*Recommendation:* pure HTTP. The latency difference is not perceptible, and hybrid creates two
   contracts to maintain.~~
   - **Decision: pure HTTP.** Six reasons, each grounded in this project's own documented hazards:
     1. **Two contracts is this project's documented failure mode.** MEMORY.md: "A switch in two
        places drifts." Hybrid creates exactly this — every operation has two transports, and this
        project has been bitten by the pattern repeatedly (Control switch drift, `settings_set`
        UPSERT vs `patchGatewaySettings` merge, the four `COOLDOWN_FLOOR_MS` literals across two
        languages).
     2. **The latency is imperceptible.** ~1-2ms HTTP vs ~0.1ms IPC — "Measurable but not
        perceptible for UI operations" (§5.2). Settings reads can be cached client-side after the
        first fetch.
     3. **The gateway already serves external clients over HTTP.** Curl, AI Hub, and WorkBuddy
        already use the HTTP surface for completions, streaming, models, and images. The UI going
        through HTTP makes it "just another client" — the same code path, the same tests, the same
        proven transport.
     4. **The data ownership model requires it.** §6.1 says the service owns the database. If the
        UI keeps writing to SQLite via IPC, it races with the service. Pure HTTP makes the service
        the sole writer.
     5. **The transition is seamless.** Under pure HTTP, the UI code is identical whether the
        backend is the in-process gateway or the headless service — same
        `fetch("http://127.0.0.1:<port>/...")`, with the port read from `gateway_status` rather than
        hardcoded (the in-app gateway defaults to **8787**, `aiproviderd` to **8800**; see §5.2). Under
        hybrid, you need conditional logic ("is the
        service running? use HTTP; otherwise use IPC") — a switch in two places that drifts.
     6. **CORS is the only new cost, and it's trivial.** One middleware adding
        `Access-Control-Allow-Origin: tauri://localhost` (or `*` in dev). Already prescribed as
        step 5.
   - **What stays as Tauri APIs (not custom `invoke`):** window/tray management, file dialogs,
     system notifications, and master-key retrieval from the keychain (needed once at startup to
     authenticate HTTP requests). "Pure HTTP" means "no custom `invoke` commands for data access,"
     not "no Tauri at all."
   - **Authentication model:** the UI becomes an authenticated client of the gateway — but **not by
     sending the master key**, which it never holds (D51). 26i resolved this with a host-minted,
     revocable session credential (`ak-ui`): the host caches it in a `let` and sends it as
     `Authorization: Bearer`, and the master key is read from the keychain **host-side** and never
     crosses into the webview. See §5.3 and `core/ui_session.rs`. This is consistent with how
     external clients work — they present a credential; they simply present a different one.
   - **Migration scope, corrected 2026-09-25 by measurement — as first written this was
     over-scoped.** It said "no custom `invoke` commands for data access remain." The production
     UI calls **107** distinct commands, and roughly a third are not gateway data at all:
     `skills_*` is **documented frontend-only** ("skills are frontend-only, gateway blind to them"
     — MEMORY.md), and ~34 more are *about the app* rather than the gateway (crash reports,
     diagnostics bundle, onboarding state, history, config import/export, agent step trails, drift
     events, router model context). A headless service has no UI crash reports to serve.
   - **Corrected scope: HTTP serves the gateway and the data the service owns (~75 commands)** —
     `gateway_*`/`egress_*`, config CRUD, the memory/context layer, ledger, settings, vault,
     service management, tool toggles. **IPC stays for app-owned UI state (~34)** — skills, crash
     viewer, diagnostics, onboarding, history, config export, agent trails, drift, workbuddy.
     **This is not the hybrid the decision rejected.** That one kept IPC for *performance* (hot
     paths), producing two spellings of the same fact. This keeps IPC for *ownership* — each side
     serves its own data, so there is still one authority per fact.
   - **Second scope correction, 2026-09-25 (26n): the app-key group stays on IPC, and not for
     ownership — for a security reason.** `gateway_app_keys`, `gateway_app_key_create`,
     `gateway_app_key_revoke`, `gateway_app_key_delete` and `gateway_app_key_cap_set` are *gateway
     data* by the ownership test, so the bullet above says they migrate. They must not:
     `POST /admin/keys` returns the secret in the response body, and R4/H5 require that an app-key
     secret **never enters the webview** — `ARCHITECTURE_AUDIT.md` R4: *"The webview only ever
     receives `{id, label}`"*; `AUDIT_REPORT.md` H5's fix: reveal via *"a Rust-side native dialog/copy
     that never enters the webview DOM"*. Migrating that screen would trade a documented security
     property for transport uniformity. **The route still exists** — a headless client has no host
     clipboard to copy into — but the in-app UI does not call it. This is a **third admissible reason
     for IPC**, alongside ownership and app-state: *a route whose response carries a secret the
     webview must not hold.*
   - **Measured 2026-09-25 after 26l and 26n:** 73 `invoke` commands remained, against 39 `fetchAdmin`
     call sites over 30 `/admin/*` templates. The "~34" above is close to the measured **~39**
     app-owned; the gateway-data remainder was **~10** — three whose routes already existed
     (`manifest_upsert_active`; `settings_get`/`settings_set` for non-`gateway` rows — migrated in
     26n) and seven that needed one (`manifest_stage`, `manifests_history`, `gateway_spend_cap_set`,
     `gateway_memory_enabled`, `gateway_set_memory_enabled`, `gateway_prune_live_context`,
     `ledger_append`).
   - **All seven were migrated in 26o, so the gateway-data remainder is now zero.** Every one of the
     seven listed above has a route; the list is kept rather than deleted because it is the record of
     what the increment closed. Measured after 26o by a different method — which is why the numbers
     differ from the line above rather than superseding it: **65** `invoke` commands and **39**
     `/admin/*` templates, counted from `invoke("name")` first-argument literals and `/admin/…`
     string literals with template holes normalised. What remains on IPC is app-state,
     secret-bearing, or host-resource — see §13 for the enumeration.
   - `gateway_enable/disable` and `gateway_worker_error` are deleted (service is always on).
   - **Revisit if:** a real performance bottleneck appears that HTTP cannot serve — unlikely on
     localhost, but the hybrid door stays open if measured.

3. **Do we ship the service as a separate downloadable, or bundle it inside the `.app`?**
   - Separate: smaller app bundle, but two downloads to manage.
   - Bundled: one `.app`, one update channel, but larger.
   - *Recommendation:* bundled. The binary is small (~5MB), and one artefact is simpler for users.

4. **What is the minimum viable port?**
   - Full port: everything in Rust, no JS in the gateway path.
   - Hybrid: keep the router core in JS, but run it in a separate process via `deno` or `node`.
   - *Recommendation:* full port. A hybrid still has a JS process that can crash, and the whole
   point is to eliminate the webview as a failure mode.

5. **Does the adapter layer get a regex engine, or does `modelIdPattern` wait?** — **RESOLVED
   2026-09-24: add `regex`. The cost is zero crates, and the option's stated price was wrong.**
   - **Add `regex` as a direct dependency.** ~~Cost: a genuinely new **runtime** dependency of
     `aiproviderd`.~~ Measured 2026-09-24: `regex` was **already** in the runtime graph, pulled in by
     `tauri-utils` (through `tauri`) and by `urlpattern`, which `tauri-utils` also takes. `cargo tree
     --edges normal` resolves **307** crates with the dependency and **307** without it, set
     difference empty — so the true cost is **zero**. The quoted figure came from `cargo tree -e
     normal -i regex --no-default-features`, and that flag *is* the defect: `--no-default-features`
     is not how `aiproviderd` ships, so the command answered "what does the Tauri-free binary link"
     while the decision was about production. See **D28**.
   - **The syntax gap is real, and the port handles it loudly.** Rust's `regex` has no backreferences
     and no lookaround, so a pattern the JavaScript accepts can fail to compile here. The port
     returns an error rather than a non-match, because the reference throws and nothing catches it —
     the alternative silently demotes every model of that provider to `text`.
   - **`unicode` stays on, and that was the increment's actual finding.** The first design turned it
     off, which does make `\d`/`\w`/`\s` ASCII and so match JavaScript. Measured: it also makes `.`
     byte-oriented, and `RegexBuilder::new("^dall-e-.*$").unicode(false).build()` fails with *pattern
     can match invalid UTF-8* — rejecting the most ordinary pattern a manifest can carry. The trade
     was refused and the divergence is pinned by two tests, in the direction it actually goes. The
     resolved feature set is the full default one regardless, because Cargo unifies features per
     crate and `tauri-utils` takes `regex` with defaults on; `Cargo.toml` therefore declares a plain
     `regex = "1"`, and stating the requirement is what keeps a future `tauri-utils` change from
     silently moving it.
   - **Defer `modality.rs`.** Rejected: `tagModality` would have no Rust counterpart and every model
     would read as `text` — and the cost this option was avoiding turned out not to exist.
   - **Outcome:** `core/modality.rs` landed in **increment 17** with 30 tests. The Phase 4b account
     above carries the details.

---

## 11. Effort estimate

| Phase | Days | Cumulative |
|---|---|---|
| 1 — Extract core library | 1-2 | 2 |
| 2 — Port execution engine | 3-5 | 7 |
| 3 — Port router + planner | 2-3 | 10 |
| 4 — Port context compression | 2-3 | 13 |
| **4b — Port the adapter runtime** | **3-4** | **17** |
| 5 — Delete bridge | 1 | 18 |
| 6 — Process manager + UI | 2-3 | 21 |
| **Buffer (testing, edge cases)** | 3 | **24** |

**Total: 4-5 weeks of focused development.**

**The 4b row is new on 2026-09-24, and its absence is the estimate's own defect.** Every other line
here was derived from the port table's module list, and that list omitted the adapter runtime — the
same omission D26 records, where the module was described as "60 lines" and therefore needed neither
a phase nor a line in this table. The two figures that were wrong as a result are corrected in §2.2;
this row is the third. An estimate that omits the highest-risk module is not optimistic, it is
incomplete, and the distinction is why the row is added rather than folded into Phase 2's range.

~~This is an all-at-once change, not an incremental one. The bridge is the boundary, and the router
core is on one side of it. You cannot move it piecemeal — half the engine in Rust and half in JS
would need a second bridge between them.~~

**This paragraph was false when it was written and the work since has proved it false.** It was
measured wrong the only way that counts: **fourteen increments have moved it piecemeal.** Increments
1–10 ported the execution engine into `core/engine.rs`, 11b the planner, 12 the ledger, 13 the router
glue and 14a the pure half of compression — each a self-contained Rust module, each with its own
tests, none of them needing a second bridge, because a *ported module with no caller* is not a half of
anything. What the paragraph got right is narrower than it claimed: the **switchover** is
all-at-once — the day the gateway stops dispatching through the bridge, both halves must exist. That
is a statement about the last step, not about the whole change, and it is why Phase 5 exists. The
distinction matters because the paragraph as written argues against the strategy that actually
worked, and a reader could have taken it as a reason not to start.

**Increment 24b-ii-a — the state a concurrent bridge has to share.** 24b-ii was the plan's next step, and
reconnaissance found it could not be taken as written (D38). The row says the driver runs the tool loop
"against `ModelRouter` and `AdapterRuntime`" — and `ModelRouter` cannot serve two requests at once. Three
measurements, each a line of code rather than a reading of it: `execute_text` and `execute_image` take
`health: &mut HealthTracker` and hold it for the whole request (`engine.rs:894`, `:614`);
`generate_text` and `generate_image` take `&mut self` (`router.rs:551`, `:760`); and the three pieces that
must be process-wide — the circuit breaker, the key cursors, the ledger — are private fields of a router
that would have to be rebuilt per request.

**Both shapes the driver could have been written in are defects, and neither is loud.** A
`Mutex<ModelRouter>` serialises every model call in the process, which makes §3.5's two semaphores and
their 40 permits decorative — the tests stay green because none of them measures throughput. One router
per request is worse, because it is silent in a way a lock is not: each request would cool its own copy of
a key, write to its own ledger, and start on key zero, so the round-robin that spreads load across a
provider's keys would stop existing, and **no existing test would notice, because every one of them builds
a single router**.

**The shape is `ProviderLimiter`'s, applied to the rest of the state.** That type already solved this exact
problem — `#[derive(Clone)]` over an `Arc`, "shared between the router (which changes the cap at runtime)
and the engine (which consults it per candidate), so it is `Send + Sync` and interiorly mutable" — so the
port is a precedent rather than an invention. `HealthTracker` gains a `Mutex` *inside* it and its methods
become `&self`, which is what lets the engine's parameter become `&HealthTracker`; the lock is taken per
**record**, never across an `await`, because every method on the type is synchronous. `SharedRouterState`
then bundles the four pieces behind one `Arc`-backed handle, and `ModelRouter::with_shared` builds a
request-scoped router from it.

**One type rather than four `with_*` calls, and the reason is the one `ReplyHandle` already records.** A
wiring step somebody can skip produces a failure that is silent and looks like something else; four setters
would leave a caller able to share the breaker and the limiter while quietly giving each request its own
cursors — which is not a smaller version of sharing, it is a different behaviour. `ModelRouter::ledger_mut`
is **deleted** rather than ported: a `&mut UsageLedger` escaping the lock is the exact thing the sharing
exists to prevent, and it had no callers.

**Six tests, and the pair is what makes them a claim.**
`two_routers_from_one_shared_state_share_the_*` assert the sharing;
`two_routers_without_shared_state_keep_their_own_breaker` asserts that `new()` gives each router its own —
without it, the sharing tests would pass for a reason that has nothing to do with sharing. The first test
is deliberately **end to end**: it drives `generate_text` to a `429` on one router and asserts the cooldown
reaches the next, because the mechanism-level tests would all stay green if `generate_text` handed the
engine a tracker of its own. That is not hypothetical — P5 below is exactly that mutation, and it reddens
**one** test: the end-to-end one.

**No behaviour change, and the count is the proof: 1128 / 0 before and 1133 / 0 after** the five
mechanism-level tests, so every pre-existing test still passes untouched. Rust **1128 → 1134**, headless
**1068 → 1074** — every new test reachable without the `app` feature. The diff is 440 insertions against 164
deletions across two files, and the deletions are almost all mechanical: 31 `&mut health` argument sites,
27 `let mut health` bindings and 14 `t.keys[…]` reads in `engine.rs`, plus 19 `rows(router.ledger())` calls
in `router.rs` that gain a `&` because `ledger()` now hands out a guard.

**Six falsification probes, all red, both files byte-exact** (`1b5ac27f…`, `fd01c1f7…`): `with_shared`
ignoring its argument, the cursor never advancing, `new()` handing out one process-wide instance, `Clone`
rebuilding the limiter instead of sharing it, `generate_text` passing a private tracker, and
`record_result` writing to a copy of the map. **The first probe's tally is the interesting one** — 5
expected red, 5 red, 0 expected-green failures — because it shows the control and the sharing tests measure
different things rather than the same thing twice.

**A red gate that was the build, not the code.** The first full `cargo test` after this increment returned
**1119 passed / 15 failed**, every failure in the key-health family, and the first one examined asserted that
`record_result` had inserted a key and found `0` — probe P6's mutation exactly. So the first reading was a
revert that had not landed. It had. The source was byte-correct (`md5` identical before and after the fix) and
the **artifact** was stale: the harness restores a mutation by writing the saved bytes back, and a restore that
preserves timestamps restores the *old* mtime too, so cargo's mtime-based freshness check saw a source older
than a binary compiled from the mutated text and declined to relink. `touch`ing the two files gave **1134 / 0**,
and **1074 / 0** without the `app` feature. The tell is that `--lib` alone and `--test-threads=1` fail
*identically* — a parallelism artifact goes green single-threaded, a stale build cannot. **`touch` the sources
after a probe run, and read a red gate as "which binary am I running?" before "what did I break?"** Every gate
was then re-run against the fresh build, because a stale cache discredits the earlier results too.

**Increment 24b-ii-b — the driver, and the three gaps it lands against.** `core/router_bridge.rs` is the
port of `gateway-bridge.ts` (421 lines), and 24b-i had already taken the *decisions* out of it: what is
left is the I/O that carries them out — the tool loop, the spawned task, and the writes to `ReplyHandle`.

**`BridgeHost` is where the operator's toggles come from, and it is a trait for a measured reason rather
than a stylistic one.** The reference reads `get_tools_enabled` over an `invoke` on every request. A Rust
bridge could keep its own `AtomicBool` — and that copy would be the second spelling of state the core
already holds: the operator flips the switch, the core updates, and the bridge keeps serving the old
answer with nothing to report it. Holding `GatewayCore` instead is not available either, because the core
owns the bridge (`Arc<dyn Bridge>`) and the bridge would own the core — the reference cycle `ReplyHandle`
exists to avoid. So the bridge **asks**, through a narrow four-method handle (`settings`, `tools_enabled`,
`tools_mutation_enabled`, `workspace_root`), and the wiring is free to point it at the core's own
accessors without the bridge ever naming the core. That also settles the second half of the question:
`tools_enabled` is asked per request rather than captured, so there is no second copy to drift.

**One rule, one spelling, for the third time.** `gateway_tool_refusal` moved from a method on
`GatewayCore` to a free function, because two callers need the same answer and only one of them has a
core: the webview path reaches it through the core's `is_tools_mutation_enabled`, the Rust path through
the host's `tools_mutation_enabled`. Two spellings of a refusal message is how the two paths come to
disagree about which tools are refused. It is the same split `webview_ready` made in 24c, for the same
reason.

**`RouterBridge` is one `ModelRouter` per request over one `SharedRouterState`**, which is only
expressible because 24b-ii-a landed first. `dispatch` is synchronous by contract and the loop is not, so
the spawn is the whole of it; `cancel` **removes** the registry entry as well as raising the flag, because
a request can only be cancelled once and leaving the entry would grow the map for the life of the process.
`ready` returns `true` for any beat, and that is the deliberate opposite of `webview_ready`: a webview can
be suspended by the OS, so its readiness is a question about a heartbeat, and nothing suspends a task in
this process.

**26 tests, and the load-bearing ones are the two modes of the tool loop.** The suite runs against a real
`ModelRouter` and a real `RouterStore`, not a mock of either — the only double is the adapter.
`gateway_mode_holds_the_prose_and_releases_it_once_at_the_end` scripts two chunks and asserts **one**
delta; `passing_mode_streams_the_prose_as_it_arrives` asserts two. The pair is what makes the held-prose
gate a claim rather than a description of one. `a_pass_through_turn_hands_the_clients_calls_back_and_runs_nothing`
proves the call was handed over rather than executed by counting `generate_text` calls: running it costs a
second turn, a second turn is not scripted, so the request would end in a transport error instead of
`Done`.

**Two falsification probes, one at a time, both red.** The gate made to never hold reddens **two** tests —
the held-prose one (`left: 2, right: 1`) and, unexpectedly, the mid-stream one (`left: 1, right: 0`, the
held preamble released on a turn that failed) — which is a second property confirmed live that the
mutation was not aimed at. `decide_turn` made to run the client's calls reddens both pass-through tests,
with `the client's calls came back` as the panic. `bridge_policy.rs` is byte-identical to `HEAD`
afterwards, so neither probe left residue.

**No behaviour change: 1134 / 0 before and 1160 / 0 after**, headless **1074 → 1100** — every one of the
26 reachable without the `app` feature, which is a property of the seams the module was written against
rather than a coincidence.

**D39 — and the honest consequence is that nothing installs this yet.** The row names one deliverable, and
reconnaissance found three prerequisites it does not have, all measured:

1. **Hydration.** `RouterStore::hydrate` has **no production caller** — its only callers are `router.rs`'s
   own tests. The four readers that would feed it (`providers_list`, `api_keys_list`, `models_cache_list`,
   `aliases_list`) are `#[cfg(feature = "app")]` and take `State<'_, Arc<Store>>`.
2. **Streaming egress.** `egress::stream` is `app`-gated because it hands events to a
   `tauri::ipc::Channel` — and `generate_text` **always streams** (`router.rs:717`), so without it there is
   no text path at all, not a degraded one.
3. **The ledger row.** `persist::ledger_insert` already takes a plain `&Connection` and is nonetheless
   `app`-gated, and no production `LedgerSink` implementation exists — so even a served request would write
   nothing.

So **the headless binary cannot serve a text request end-to-end today**, and the module says so in its own
header rather than in a comment somebody has to find. That is why the driver was written **against seams**
— `Arc<RouterStore>`, `Arc<dyn AdapterFactory>`, `Arc<dyn BridgeHost>` — which is what lets it be tested
now, with the doubles the crate already has, and what fixes the interface the three gaps must satisfy.
Writing the port first and the prerequisites second is the reconnaissance lesson applied: where the port
needs I/O it cannot set up, compile a *probe* rather than the real thing — and here the seams are exactly
what makes that possible.

**Increment 25a — the edge the plan assumed was already there.** Phase 5d was the next step and the
reconnaissance that preceded it found it was not takeable, for a reason larger than D39's three gaps.
D39 recorded that the *driver's prerequisites* were missing. Measuring the *dependencies* found the same
shape one level up: **the Rust provider path has never been connected in production, in either build**
(D40). `impl HttpPort` occurred seven times and every one was inside a `#[cfg(test)]` module, so the
adapter seam had no production implementor; `AdapterRuntime`, `ModelRouter::new`, `RouterStore::hydrate`
and `RouterBridge` likewise had none. The plan's own `:1791` said "`egress.rs` will implement it" — a
future tense that had never become past.

So 25a is the edge. `core/egress_port.rs` implements `HttpPort` for `EgressPort`:

- **Unary** (`stream: false`) maps straight onto `egress::request`, which was already feature-agnostic.
- **Streaming** (`stream: true`) spawns `egress::stream` and consumes its events through an `mpsc`
  channel as the pull stream the trait promises. The two sides want opposite shapes and neither is
  wrong: `HttpResponse::lines` is a `BoxStream` the interpreter polls, and `egress::stream` is a push
  producer. The channel is the adapter between them, and it carries cancellation in the direction the
  egress already understands — dropping the receiver fails the next `send`, which is how a push
  producer learns a consumer has gone away (§3.5). A watcher task aborts the driver when the `Cancel`
  flag is raised, because a *silent* upstream produces no `send` to fail.

**Two design points that are the contract rather than style.** *Headers are out of band*: `HttpResponse`
carries `status` and `headers` beside the stream, so the first event is awaited before the response is
built — a status that stayed `0` until the first poll would be a lie the interpreter cannot detect,
because it reads the status before it touches the stream. *The `>= 400` case is the documented
asymmetry*, not a special case: `http_port.rs:25-31` says `body` is filled for a unary request **and for
a streaming request that failed**, with `lines` present only for one that succeeded. The egress already
sends exactly the shape that needs — `Headers`, then one `Error` carrying the provider's words — so the
module reads that second event into `body` and returns `lines: None`.

**The un-gating is what makes the headless build real.** `egress::stream`'s last parameter was a
`tauri::ipc::Channel`, which was the *only* reason the function was `app`-gated; the body never touched
Tauri. It is now an `UnboundedSender<StreamEvent>`, whose `send` returns a `Result` exactly as
`Channel::send` does, so every `is_err()` and `let _ =` in the body is unchanged. **`egress.rs` now
carries no `cfg(feature = "app")` at all.** `tauri/commands.rs:80` keeps its `Channel` and forwards
through one task, so the webview path is untouched.

**Five tests, and they are the first in the crate to drive the egress over a real socket.** `egress.rs`'s
three test modules are pure — allowlist, secret injection, host scanning — and nothing had ever performed
an HTTP request in a test, so `request`, `stream` and `fetch_image` were exercised only in production, by
a webview. The new tests stand up a loopback axum server (which `check_url` permits unconditionally, the
same affordance a local Ollama provider relies on) and assert on what the server *saw*, so "the line
arrived" and "the line is correct" are two claims rather than one. **Two falsification probes, one at a
time, both red, file byte-exact:** flipping the `>= 400` arm to return `lines: Some(empty)` reddens the
500 test alone; disabling the cancellation watcher reddens the cancel test alone, at 5.13 s, which is the
timeout rather than a spurious failure. Rust **1160 → 1165**; headless **1100 → 1105**, so every new test
is reachable with no Tauri in the graph. The headless build compiles with no errors and no warnings,
which is the measurement that says the un-gating is complete rather than partial.

**Increment 25b — the readers a launch needs, and the settings nobody read.** D39's first gap was
hydration: `RouterStore::hydrate` had no production caller, because the four readers that would feed it
were `#[tauri::command]`s taking `State<'_, Arc<Store>>` — a shape a headless launch cannot produce. The
body never needed the `State`: it locks `store.conn` and runs a query. So each became a pair — an
un-gated `pub fn x_rows(store: &Store) -> Result<Vec<Row>, CommandError>` holding the query, and a
one-line `#[tauri::command]` wrapper keeping the wire name the webview calls. The pattern is not new in
that file: `gateway_keys_list`, `active_gateway_key_ids`, `gateway_key_cap` and `month_spend_micros` were
already un-gated and `&Store`-shaped, and `gateway_keys_list` has no command at all. `list_models` — the
query `models_cache_rows` delegates to — lost the `app` gate it had never needed.

`RouterStore::from_store(store: &Store)` is `hydrate`'s **first production caller**, and it is the
sentence `router.rs`'s own module note already made: "tests build one with `hydrate`, which is also what
a launch does". It reads the four tables under four separate locks rather than one transaction, which is
deliberate: those were four commands and therefore four round-trips, a launch reads a database nothing
else is writing to yet, and closing the window would mean a `&mut Connection`-shaped reader that
`persist` does not have.

**The sixth gap, and the one this increment did not go looking for.** `RouterSettings` had no production
source either. The three settings live in the `settings` row `key='router'` as camelCase JSON that the
webview writes (`store.ts:655`) and applies with `Object.assign` inside a `try`/`catch` that keeps the
defaults (`:390-397`); the only reader in Rust was the generic `settings_get` command, which is
`app`-gated and hands back a `String`. That matters beyond tidiness because `BridgeHost::settings` exists
precisely so the bridge never holds a second copy of the operator's toggles — and it had nothing to point
at. Closed by `persist::setting_value(store, key)`, the core-side parsed sibling of `settings_get`, which
`spend_cap_micros` now reads through instead of duplicating the query, plus `RouterSettings::from_store` /
`from_value`.

**`per_provider_concurrency` is copied through un-clamped, and that is the contract.** The field is a
`serde_json::Value` so that a stored `-1`, `"4"` or `""` stays representable and `clamp_concurrency`'s
corruption branch stays reachable; clamping at the reader would move the check and leave that branch
unreachable from the only path that can produce a corrupt value. `from_value` also treats a `systemAi`
with no model as no pick at all — a pick that cannot be routed to would put an unusable entry in the
model order.

**Seven tests, and two falsification probes, one at a time, file byte-exact after each revert.** Rust
**1165 → 1172**; headless **1105 → 1112**, so every new test is reachable with no Tauri in the graph. The
probes were chosen for the two claims a compiler cannot check:

| probe | change | red |
|---|---|---|
| a malformed settings row | `setting_value` returns `Some(null)` instead of `None` | `setting_value_parses_and_treats_an_unreadable_row_as_absent` **alone** |
| an un-clamped concurrency | `from_value` coerces through `as_u64` | `router_settings_from_value_hands_the_concurrency_on_unclamped` **alone** |

That the *other* tests stayed green is the useful half of the measurement. The malformed probe left
`router_settings_from_store_falls_back_to_the_defaults` green, because `from_value(&null)` yields the
defaults too — so only the persist test guards the malformed-is-absent contract. The coercion probe left
`router_settings_from_store_maps_the_stored_object` green, because `6` is a valid `u64` — so only the
corruption test guards the un-clamped contract, and a reader that coerced would pass the happy path. A
round-trip test alone would have missed both.

**Increment 25c — the activation path, and the branch the reference tries first.** With 25b landed a
launch can build the store, but it still could not serve, because `AdapterRuntime` had **no production
constructor at all** (D40). The module said so itself: "Who reads `manifests.body_json` and calls it is
the activation path's business, and nothing in production calls it yet." `core/activation.rs` is that
business, and `activate(&runtime, &store)` is the first production caller of both `AdapterRuntime::new`
and `register`. `persist::manifests_active_rows` is the un-gated `&Store` reader underneath it, split
from the `manifests_active` command exactly as 25b split the four row readers.

**The one decision is skip, not abort.** The reference wraps the register in a `try`/`catch` whose body
is a comment — *"corrupt manifest: leave unregistered; Phase 5 drift/repair surfaces it"*
(`store.ts:377-379`). A launch that refused to start because one provider of three had a bad manifest
would trade a degraded service for no service, so `activate` returns both what it registered and what
it skipped, with the reason and the **version** for each — the version because the table holds every
one, and "provider X" alone names three candidates. **The store read is the only failure that
propagates**: a database this process cannot read is not a degraded launch, it is no launch.

**The skip relies on a boundary that already existed.** `AdapterRuntime::register` builds before it
swaps (D32), so a manifest that fails to build leaves the previous adapter serving. That is what makes
re-activation safe, and `reactivating_a_provider_that_now_fails_leaves_the_previous_adapter_serving`
pins it: the operator activates a broken v2, activation reports it skipped, and the v1 adapter is still
in `registered()` — a bad activation is not an outage.

**The divergence, and it is measured rather than assumed (D41).** The reference's loop runs over
*providers* and tries `PROVIDER_PROFILES[slug]` before it looks at a manifest row; there is no Rust
`PROVIDER_PROFILES`, so this iterates *manifest rows*. Against the installed database the two agree —
**2** providers, both `type='manifest'`, both carrying an active row, and no builtin provider
installed. They would not agree on a machine that had an OpenRouter provider with no manifest row.

**Six tests, two probes, one at a time, file byte-exact after each revert.** Rust **1172 → 1178**;
headless **1112 → 1118**, so every new test is reachable with no Tauri in the graph. Dropping
`WHERE is_active = 1` reddens `activation_reads_only_the_active_version` and `reactivating_...`
**alone**, and that four of six stay green is the finding: the filter is only observable through a
fixture that carries a superseded version, so a suite of nothing but well-formed active rows would
have passed with no filter at all. Making activation abort on the first failure reddens exactly the
three tests that exercise a failure, and none of the three that do not.

**Increment 25d — the ledger sink, and the error that reaches a client.** D39's three gaps are now all closed. 25a took `egress::stream` off `tauri::ipc::Channel`; 25b un-gated `persist`'s row readers and gave `RouterStore::hydrate` its first production caller; 25d does the third, and it is the one whose absence was invisible — a router with no sink attached keeps the ledger in memory and raises no error, so nothing about a served request announces that nothing was written.

`persist::ledger_insert` was `#[cfg(feature = "app")]` for no reason of its own. It takes a plain `&rusqlite::Connection` and touches no Tauri type; the gate was inherited from its caller, the `ledger_append` command. It is now `pub` and un-gated, and the command is a one-line delegate — the same shape `providers_rows` and `manifests_active_rows` took in 25b and 25c.

`StoreLedgerSink` is the first production `LedgerSink`. `trait LedgerSink` (`ledger.rs:50`) had no implementor outside `#[cfg(test)]`; `UsageLedger::with_sink` (`:82`) was therefore reachable only from tests, and `SharedRouterState` built its ledger with no sink at all. The sink holds an `Arc<Store>` — not a `&Store`, because the ledger outlives any borrow once it is installed in `'static` shared state — and writes on the store's own connection.

The error is sanitised because this one reaches a client. `UsageLedger::append` returns the sink's error; the router turns it into `RouterError::Ledger`; `router_bridge.rs:602` answers that with **502**. So the sink goes through `ui_db_error` exactly as a `#[tauri::command]` does: `e.to_string()` here would put SQL text and an absolute database path on the wire.

The write is synchronous, under the ledger's own lock, and that is the reference's shape too. `append` is `&mut self`, reached through `SharedRouterState::ledger()`'s `MutexGuard`, so concurrent requests serialise their INSERTs — one local write, no deadlock, because the lock order is always `ledger → conn` and nothing in `persist` reaches back for the ledger.

Four tests, two probes. Rust **1178 → 1182**; headless **1118 → 1122**, so all four run with no Tauri in the graph. Swallowing the database error reddens `the_store_sink_sanitises_a_database_failure` and `a_row_that_violates_a_check_constraint_is_an_error_not_a_silent_drop` **alone** — the two happy-path tests stay green, which is the point: an error-free sink and a sink that hides its errors are indistinguishable on the happy path. Passing the raw rusqlite error through instead of `ui_db_error` reddens **only** the sanitisation test, so "returns an error" and "returns a *safe* error" are separately enforced.

A correction 25d found while writing the register. 25c's note in `adapter_runtime.rs` called `core::activation` "the first production caller of both `register` and this type's constructor". A grep says otherwise: `AdapterRuntime::new` occurs only in `#[cfg(test)]` code (`activation.rs:149`, `adapter_runtime.rs:347`). 25c closed `register`; the constructor's first production caller is 25e. The note and D40 now say so, and D40's tally stays at **two of five** — a method's caller is not a constructor's.

**Increment 25e — the install, and the chain that connects every link.** D40 named five constructors with no production caller: `HttpPort` (25a), `RouterStore::hydrate` (25b), `AdapterRuntime`, `ModelRouter::new`, and `RouterBridge`. 25e installs the last three in `bin/aiproviderd.rs`: `AdapterRuntime::new(egress_port)` at `:148`, `RouterBridge::new(...)` as the bridge the `GatewayCore` owns, and `ModelRouter::new` is reached through `RouterBridge::router()` at `router_bridge.rs:172`. **The chain `ModelRouter → AdapterRuntime → HttpPort → egress` is now connected in production**, and D40 is closed.

The binary builds the full stack in sequence: `AllowList` → `EgressState` → `EgressPort` → `AdapterRuntime` → `activation::activate` (logging registered and skipped providers) → `RouterStore::from_store` → `UsageLedger::with_sink(StoreLedgerSink)` → `SharedRouterState::with_ledger` → `HeadlessHost` (the `BridgeHost` impl that reads `RouterSettings` from the store, defaults tools to on and mutation to off, and has no workspace root) → `RouterBridge::new` → `GatewayCore::new(bridge, ...)`.

Three tests on the binary: the original `HeadlessBridge` readiness test (kept as a test double), and two `HeadlessHost` tests — defaults on an empty store, and reading a `router` settings row back. One probe: hardcoding `settings()` to `RouterSettings::default()` reddens the read-back test alone.

D40: **Fixed in 25a–25e** — all five constructors now have production callers. The note in `adapter_runtime.rs` is updated; the tally in the register is updated.

**Increment 25f — the deletion, and the subsystem the row had not named.** The last row of Phase 5,
and the one the whole phase exists to make safe: with 25a–25e standing a Rust path behind the
gateway, the webview can be removed without removing the only working text path. D35 had already
measured that the row was larger than it read — the four files are the *visible* half of a liveness
subsystem that exists only because the worker is a webview the OS can suspend — so the increment ran
as **two passes: the deletions that need no compilation change, then the wiring.**

**Pass one, the files.** `gateway.html`, `gateway-worker.ts`, `gateway-bridge.ts` (421 lines) and
its 420-line test, `app_nap.rs` — whose entire reason to exist is that a hidden webview's JS stops
beating — `capabilities/gateway.json`, and two scripts (`idle-lapse-test.sh`,
`verify-heartbeat-fix.sh`) that reproduce the idle lapse the deleted code was built to survive.
`pub mod app_nap;` goes with them.

**Pass two, the subsystem.** Deleting the files leaves the machinery that *measured* the webview
still in the core, and it is the machinery, not the files, that would have turned every request into
a 503 six seconds after the app stopped beating. `core/gateway.rs` loses `HEARTBEAT_STALE_MS` (6 s)
and `HEARTBEAT_STALE_HIDDEN_MS` (30 s), `Beat` and `Beat::is_fresh`, `webview_ready`,
`Bridge::ready`, `WARM_MIN_INTERVAL` / `WarmFn` / `await_core`, `CORE_RECOVERY_GRACE` /
`CORE_RECOVERY_POLL`, the `last_heartbeat` / `hidden` / `worker_error` / `warm` / `last_warm`
fields with their accessors, and the whole `core_recovery_tests` module (`gateway.rs:446-625`, 180
lines, seven tests). `tauri/gateway_cmds.rs` loses `EventBridge`, `ensure_bridge_window`,
`warm_bridge_window`, `hide_worker_after_warmup`, `GATEWAY_WINDOW`, the watchdog with its
`WATCHDOG_STARTED` guard, and the eight `gateway_*` reply commands (`gateway_heartbeat`,
`gateway_worker_error`, `gateway_chunk`, `gateway_result`, `gateway_done`, `gateway_error`,
`gateway_tool_calls`, `gateway_usage`), which leave `commands.rs`'s handler list with them. 23 files,
**−1,841 lines against +506**.

**The one design decision: `Bridge::ready` was deleted rather than kept.** 24c introduced it as a
seam so a Rust bridge would not be measured against a webview's liveness rule (D35), and with
`EventBridge` gone **every** remaining implementor would answer `true` — `RouterBridge`, the
headless bridge, and the three doubles. The seam's whole content was the *difference* between the
two answers, and the difference left with the webview. Keeping it with a constant answer would have
left `try_slot`'s "core unavailable" branch reachable only from a test double, which is the defect
class this register keeps recording (D31, D33, D34): **a branch that cannot fire in production.** So
`try_slot` (`gateway.rs:1280`) now has exactly one refusal — `!core.is_running()`, which is terminal
— and the second gate, the wait, and the 503 behind them are gone.

**`HostSettings` is what replaced the liveness subsystem, and it is deliberately not a heartbeat.**
`BridgeHost::settings` needs three answers (tools on, mutation on, workspace root) and `RouterBridge`
must not hold a second copy: the operator flips a switch, the core updates, and the bridge serves the
old answer with nothing to report it. The core owns the bridge (`Arc<dyn Bridge>`), so the bridge
cannot own the core — the cycle `ReplyHandle` exists to avoid — so the three live behind
`Arc<AtomicBool>` / `Arc<Mutex<Option<PathBuf>>>` the core writes through and the host reads through,
and `with_host_settings` *drops* the default it replaces rather than keeping it, so there is one live
copy from the moment it returns. **`Weak<GatewayCore>` was considered first and rejected:** it breaks
the cycle too, but it makes "the core is not wired yet" a state the host has to answer for, and every
answer it could give is a default the operator never chose — the `NULL` vs `0` defect with a
different subject. Sharing the fields removes the state instead of defaulting it.

**The webview's answers leave the wire, and the screen stops deriving them.** `GatewayStatus` goes
from eight fields to four (`running`, `port`, `has_key`, `endpoint_url`); `workerError`, `background`
and the asleep/serving distinction are facts about a renderer that no longer exists. Control.tsx
loses both `Gateway state` rows, the `worker-boot` finding and `Finding.detail` — whose only producer
was that finding, so the field became dead and `noUnusedLocals` would have flagged it — and
Gateway.tsx loses the "Serving in the background right now" paragraph, which was the *second*
spelling of the background-mode preference already rendered directly above it: one screen carrying
two sources of truth for one fact. `gateway-status.spec.ts` goes from four worker tests to two.

**The cross-language guard was retargeted rather than deleted.** `agentLoop.test.ts`'s "the tool-step
ceiling has one source" read `gateway-bridge.ts` to compare its `MAX_TOOL_ITERATIONS` against the
Assistant's `DEFAULT_MAX_ITERATIONS`. The reference file is gone but the property is not, so it now
reads `core/bridge_policy.rs`'s `const MAX_TOOL_ITERATIONS: usize`. **Probe A confirmed it is not
vacuous** — mutating `8` to `9` reddens it alone (`expected 8, got 9`), and the revert is byte-exact.

**The probe that did not falsify, and the test it corrected.** The gate's end-to-end test asserts a
stopped gateway is refused with `503` and `retry-after: 1` without waiting. Inserting a five-second
sleep before `try_slot`'s refusal should have reddened it; it **passed in 0.02 s**. The reason is a
property of the request path rather than of the gate: **all six call sites of `try_slot`**
(`gateway_handlers.rs:72`, `:282`, `:384`; `gateway_anthropic.rs:351`; `gateway_gemini.rs:208`;
`gateway_responses.rs:256`) are preceded by `check_gateway_key` (`gateway.rs:1389`), which refuses a
stopped gateway at `:1394` *before* `try_slot` runs. The test was therefore asserting the **auth**
gate's answer while its comment claimed it guarded the slot gate — an over-claim of exactly the kind
this register exists to catch. Fixed by keeping the end-to-end test, with its comment now recording
the measurement, and adding a **direct** `try_slot(&s.core)` test, which is reachable because
`gateway_tests.rs` is `#[path]`-included as a child module of `gateway`.

**Two gates caught what the others could not.** `cargo test` was green at 1171 / 0 and `cargo check
--all-targets` clean while `cargo clippy -- -D warnings` was **red**: deleting the webview's doc
block left it *floating* before `ReplyHandle`, and clippy attaches a detached doc comment to the next
item (`empty_line_after_doc_comments`). rustfmt tolerates it and the compiler does not care — only
the lint gate saw it, which is the argument for running all three. The block is now a `//` note with
the reason in place.

**Measured: Rust lib 1182 → 1172, `aiproviderd` 3 → 2; headless lib 1122 → 1112.** Thirteen test
attributes go and two arrive. Twelve leave the lib target — the whole `core_recovery_tests` module
(seven, including 24c's four `Bridge::ready` tests), the three `r1_*` background-mode tests,
`a_sleeping_worker_is_still_running` and
`the_rust_bridge_is_ready_for_any_beat_because_nothing_suspends_it` — and one leaves the binary
(`the_headless_bridge_reports_itself_unable_to_serve`). The two arrivals are the split gate pair.
That the lib delta is **ten** and not eleven is the arithmetic that says the removed binary test
never counted in the lib target, and it was checked against a `git worktree` at `4d33cfc` rather
than inferred: the attribute count and the suite count disagreed by one, and the disagreement was
the evidence that one of the thirteen belonged to a different target.

**25f verification — the first end-to-end run, and the bug it found.** 25f's own numbers were all
green, and D40 was closed on the claim that every constructor had a production caller. That claim
asks whether the chain is **assembled**; it does not ask whether the chain **conducts**. So the
increment was finished by running the service against a real provider: `cargo build --bin
aiproviderd --release --no-default-features`, then the binary on its persisted port 8800 with the
keychain master key.

**The first completion failed, and the failure message pointed the wrong way.**

```
POST /v1/chat/completions   {"model":"agnes-2.5-flash", …}
→ 502  {"error":{"message":"all attempts failed for agnes-2.5-flash
              [agnes/key-01:NETWORK -> agnes/Key-02:NETWORK]"}}
```

Everything *upstream* of the egress had worked: auth passed, the request was normalized, the router
planned two attempts and tried both keys round-robin, and the memory layer was consulted
(`aip-memory: injected=0;reason=disabled`). The message blamed the provider — and the provider was
demonstrably reachable, because the app's gateway had served `agnes-2.5-flash` successfully minutes
earlier (ledger row 1528). The refusal was local.

**The cause is one line.** `bin/aiproviderd.rs` built `AllowList::default()`. `AllowList` is
`#[derive(Default)]` over a `HashSet` (`egress.rs:57-58`), so the default is **empty**, and
`check_url` (`:148`) refuses every non-local host that is not in it — the module's own tests assert
exactly that (`:631`). The app populates the list from provider CRUD
(`persist::recompute_allow`, called at `persist.rs:137` and `:166`); the service called it
**nowhere**. Every outbound call was therefore `HostDenied`, which the attempt layer reports as
`NETWORK` — a 502 that blames the upstream for a local policy refusal. Fixed by calling
`persist::recompute_allow(&egress_state, &store)` at boot, before the adapter runtime is built.

**Re-verified, and the response body is not the evidence — the row is.** After the fix the same
request returned **200** with `{"content":"\n\npong"}` and
`usage {prompt_tokens: 1721, completion_tokens: 19}`, and a **durable `ledger` row** was re-read
from the store: id **1532**, `source=gateway`, `provider_id=8234f8af…`, `status=ok`,
`tokens_in=1721`, `tokens_out=19`, `key_id=2f4b37eb…`, `latency_ms=10448`. A 200 alone would prove
the bridge answered; only the row proves the store-backed sink was reached, which is the half 25d
existed for.

**The full matrix, measured on the running service:**

| Probe | Result |
|---|---|
| `GET /health` | 200 `{"status":"ok"}` |
| `GET /v1/models` (master key) | 200 — **467** models, **2** providers |
| `POST /v1/chat/completions` | 200, `"pong"`, 1721 in / 19 out |
| ledger row after the completion | id 1532, `status=ok`, both token counts, `key_id` set |
| bad key | **401** `invalid_api_key` |
| no `Authorization` header | **429** `too many failed auth attempts — backing off` |

**One observed behaviour that is *not* a defect, recorded so it is not re-diagnosed.** The first two
completion attempts answered `503 master key unavailable` at **1.505 s** each, and the third
succeeded. That is `MASTER_KEY_WAIT` (`gateway.rs:143`) — an explicit 1500 ms bound on the keychain
read, which exists because an ACL mismatch after a reinstall makes the Security framework raise a
prompt and block *indefinitely*, and unbounded that wedges the whole HTTP surface rather than failing
one request. The failure is not cached: `MasterKeyCache::get` returns `Unavailable` at the deadline
*without* storing it (`:238-239`) while the abandoned thread keeps loading, so the next request
answers `Ready`. The contract is the `retry-after: 5` on the 503. **The operational consequence
belongs to Phase 6:** a supervisor that health-checks an *authenticated* route will see 503s for the
first seconds after every install or upgrade, and must retry rather than declare the service dead.
`/health` is unauthenticated precisely so it is not subject to this.

**Why no test could have found it.** Every constructor had a production caller — D40's claim was
true. `AllowList::default()` being empty is *intended*, and its tests depend on it. And the app
populates the list on a path (`persist`'s CRUD commands) that the service does not use. The defect
is in the **composition** of two correct pieces, which is the class D40 named and could not test.
The lesson is the increment's: **"every link has a production caller" is a structural claim, and only
a request can make a behavioural one.** Logged as **D45**.

**The latency characterisation, measured 2026-09-24.** The same question as the run above — does the
service actually serve? — asked in numbers. Method: an isolated store (`AIP_DATA_DIR`) whose provider
`base_url` **and** active manifest endpoint both point at a local stub on `127.0.0.1:8799` (`check_url`
permits localhost unconditionally), ledger cleared, service on 8801. The same request then goes two
ways against the same stub — through the gateway, and straight at it — so the difference is the
gateway's own cost rather than the upstream's.

**Overhead: ~11 ms.** Median 11.2 ms on one run and 10.4 ms on another (n = 15 each); the spread
across runs is 10.4–12.0 ms. Where it goes: `/health` (no auth) **0.2 ms** → `/v1/models` (auth +
store) **1.8 ms** → `/v1/chat/completions` (auth + router + ledger + dispatch) **11.6 ms**. The
router's own ledger corroborates it — 32 rows land in the 0–99 ms bucket, matching the harness phase
exactly. The whole thing is reproducible: `scripts/measure-gateway-latency.mjs` builds the isolated
store, starts the stub, and refuses to print numbers if the stub received nothing.

**Two measurement caveats, both of which changed the answer.** The first pass at the decomposition was
taken with `curl`, which reported `/v1/models` at **6.1 ms** against node's **1.8 ms** for the same
request; node reuses its connection where `curl` opens a fresh one per invocation, so `curl`'s figure
carries connection setup. The node numbers are the ones above. Separately, `curl`'s
`%{time_starttransfer}` counts response **headers** (0.5 ms) while node's first `res.on("data")` counts
the first **body** byte (1,209 ms) — same request, two "TTFB"s, both correct. **The configuration is
part of the claim**, and this pair is the same lesson as the `cargo tree` feature unification.

Put against the real ledger (**n = 1,053** successful gateway requests, p50 **4,588 ms**, p90 15,356 ms,
p99 39,395 ms, p50 prompt **22,084 tokens**), the overhead is **0.25 %** of the real-world p50: **the
gateway is not the bottleneck and the upstream is.** Concurrency is shed rather than queued —
`perProviderConcurrency: 4` binds before `MAX_CONCURRENT`, so 24 simultaneous requests returned 4–5×200
and 19–20×429 `RATE_LIMITED` in 30 ms of wall time.

**Streaming was the one real latency weakness — and it is now an operator setting rather than a
defect.** Response headers return in **0.5 ms**, but the first *content* chunk arrived only once the
upstream had finished: measured **1,209 ms** against an upstream that streamed over 1,200 ms, and
1,814 ms against 1,800 ms. The whole answer arrived as a single delta frame, then a finish frame, then
`[DONE]`. The cause is `ProseGate` (`bridge_policy.rs:236`), which sets
`hold = (ownership == ToolOwnership::Gateway)`, combined with a `HeadlessHost::tools_enabled()` that
returned `true` unconditionally: a client declaring no tools was therefore `Gateway`-owned, so every
delta was held until the turn resolved (`router_bridge.rs:390`). The holding is deliberate — a turn
that goes on to call a tool must not leak its preamble — but hardcoding the toggle meant a service
could never reach the corner where the gate *does not* hold, and an interactive client paid the **full
generation time before the first token** where a relaying gateway shows text at ~0.5 s.

`RouterSettings` now carries **`gatewayToolsEnabled`** and `HeadlessHost` reads it instead of answering
`true` (`core/router.rs`, `bin/aiproviderd.rs`). An absent key means `true`, so no existing install
changes behaviour. With it `false`, ownership is `None`, `hold` is false, and deltas reach the client as
the upstream emits them. Pinned by `tools_off_streams_the_prose_as_it_arrives` — the third corner of the
gate, which `passing_mode_streams_the_prose_as_it_arrives` (`Client`) and
`gateway_mode_holds_the_prose_and_releases_it_once_at_the_end` (`Gateway`) had left open — and
**falsified before it was trusted**: forcing `ProseGate::new` to hold unconditionally reddens it and the
`Client` case while correctly leaving the `Gateway` case green.

**And then confirmed live, end to end.** The same request against the same stub, the only difference
being the setting: with gateway tools **on** the first content byte arrived at **1,211.5 ms** of a
1,211.6 ms total, and with them **off** at **3.7 ms** of a 1,213.8 ms total. The total is unchanged —
the upstream still takes the same time — but time-to-first-token falls by a factor of ~327. That is the
difference between a client rendering nothing for the whole generation and rendering text immediately,
and it is the one latency number a user actually feels.

**The cost is real, which is why this is a setting and not a fix.** Gateway-owned tools are what let the
gateway run its own tool loop, so turning them off trades that capability for streaming. The desktop app
is untouched: it answers from `HostSettings`, a live toggle the UI flips, and unifying the two means
making that toggle write this key — a UI change, not a host one.

**25g verification — the measurement becomes an assertion.** Everything above is a *measurement*, and no
gate could tell whether the next change broke it. 25g closes that by booting the real service against a stub
upstream **inside `cargo test`**, so the 1-frame/6-frame difference is asserted rather than observed once.

**The harness is the real stack with exactly two substitutions.** The test module in `bin/aiproviderd.rs`
builds a `Store` in a temp dir, seeds one provider (`p1`, slug `stub`), one key, one model and one active
manifest whose `base_url` points at an in-process `axum` stub on `127.0.0.1:0`, then assembles the chain
production assembles — `AllowList`, `EgressState`, `AdapterRuntime`, `ModelRouter`, `RouterBridge`,
`GatewayCore` — and calls `gateway::spawn(core, 0)`. Both substitutions exist because **CI has no OS
keychain**: the master key is a closure (`GatewayCore::new(bridge, Arc::new(|| Some("test-gw-key".into())))`),
and the provider key arrives through a new seam.

**The seam, and why it is not a way to skip a check.** `EgressState` gains
`secrets: SecretProvider` — `Arc<dyn Fn(&str) -> Result<Option<String>, vault::VaultError> + Send + Sync>` —
and a second constructor, `with_secret_provider(allow, store, secrets)`. `new` keeps its signature and
delegates with `Arc::new(vault::get)`, so its six existing callers do not have to name the keychain to keep
the behaviour they already had. It follows `KeyProvider`'s precedent, and that type's own note is the whole
argument: the request path is the one place a provider key is used, so without a seam it cannot be exercised
end to end without an OS keychain — which is to say it cannot be exercised in CI at all. Production really
does use the keychain, and the installed one shows it plainly: **three** account families under the service
`ai-provider-router`, with `masterkey`, the three `key:<api_keys.id>` rows the request path reads, and no
`gwkey:<id>` because no per-app key has been created. **What the seam cannot do is skip a check**:
`check_secret_host` runs before this lookup and `inject_secret` runs after it, and neither consults the value.
What moves is where the bytes come from, not whether the request is allowed. Falsified before it was trusted —
reverting `build` to call `vault::get` reddens `an_injected_provider_is_what_resolves_a_secret_ref`, and it
reddens on the **recording** assertion (`left: [], right: ["key:k1"]`) rather than on either `matches!` or
`is_ok`, which is the false pass the test was written against.

**The assertion: one frame or six, on the same running gateway.**

| `gatewayToolsEnabled` | frames the client receives | concatenated text |
|---|---|---|
| **`true`** (the default, and absence) | **1** | `Hello world!` |
| **`false`** | **6** | `Hello world!` |

`the_gateway_relays_upstream_deltas_only_when_gateway_tools_are_off` asserts that the stub was reached, then
the one-frame shape, then flips the store row and re-requests **without restarting anything**, then the
six-frame shape and the identical concatenation. That the second request sees the flip is what pins the
per-request read of `RouterSettings::from_store` rather than a value captured at boot — which is the property
the setting depends on and the one no unit test could reach. Falsified before it was trusted: reverting
`HeadlessHost::tools_enabled` to a hardcoded `true` reddens it at the second assertion with
`got 1 frame(s)`, so the table above is **measured** rather than inferred.

**D46 becomes a test, and its two assertions are not redundant.**
`a_manifest_host_outside_the_allowlist_is_refused_as_network_without_reaching_upstream` rewrites the manifest's
host to `https://not-allowlisted.example/v1`, re-activates, and asserts **both** the 502 carrying `NETWORK`
**and** that the stub's request counter did not move. A 502 alone is also what an unreachable upstream
produces; *"the stub was not touched"* is what separates a local refusal from a network failure — which is
precisely the distinction D45's first diagnosis got wrong.

**The refusal test had to be sent non-streaming, and that is itself a finding.** Its first version streamed
and failed with `left: 200, right: 502`: a streaming client is already holding a `200` and its headers by the
time the router gives up, so the refusal arrives as an SSE frame instead of as a status. Both are correct —
they are two surfaces for one refusal — but only the non-streaming one can assert a status. This is the shape
in which the symptom was first seen, and it is recorded in the test rather than in a comment elsewhere.

**Three findings the round produced, none of which any gate could have.**

1. **The ambient-proxy trap.** Six variables are set on this machine (`http_proxy`, `https_proxy` and their
   uppercase forms, plus `ALL_PROXY`/`all_proxy`) with `NO_PROXY` unset, and `reqwest` reads them at
   **client-build** time (`async_impl/client.rs:418-420` pushes `ProxyMatcher::system()`) with no per-request
   override — `Proxy::no_proxy` is per-`Proxy`, and `ClientBuilder::no_proxy` clears all of them. So a test
   that builds a client in an ambient environment can be routed through a proxy it never asked for, which is
   how a `502` and a curl `000` both appeared. The test module removes all six behind a `std::sync::Once`;
   `scripts/measure-gateway-latency.mjs` deletes the same six before spawning the service. **This was a real,
   undocumented production behaviour and not the cause of the failure it was first blamed for** — the tests
   failed identically once the proxies were cleared, and only a probe placed the actual cause.

2. **A manifest with no `stream` block hides as `NETWORK`.** See **D47**: the guard decides how the response
   is *read*, not what is *asked for*, so the request still goes upstream with `"stream": true`, the answer is
   SSE, and the unary parser reports it as a transport failure. Found because the fixture manifest omitted the
   block; fixed by declaring it, since the reference's own templates do.

3. **A streaming client cannot observe a status code.** Stated above as the reason the refusal test is
   non-streaming, and worth separating because it constrains what any future end-to-end assertion about
   refusals can be written against.

**Measured:** `cargo test` lib **1174 → 1175**, binary **3 → 5**. The two new binary tests are the ones above;
the lib test is the seam's.

**25h — D46, closed at the boot path.** The divergence 25g pinned as a *test* is now closed as a *defect*,
and by the register's own second candidate rather than a new idea: **assert at activation that the host the
adapter will dial is one the egress will permit**, so it fails loudly at launch instead of per request.

**The divergence, restated because the fix is shaped by it.** The allowlist is derived from
`providers.base_url` (`persist::recompute_allow`, called on provider CRUD and at boot) while the adapter dials
`manifest.provider.baseUrl` (`manifest::join_url`). The generator writes both, so they agree on any install
nobody has edited; editing one and not the other is what a custom-base-URL or proxy feature would do. When
they disagree every attempt is refused by `check_url` and reported as `NETWORK` — measured 2026-09-24, **56 of
56** requests answered `502 … [agnes/key-01:NETWORK -> agnes/Key-02:NETWORK]` while the stub's counter never
moved. The refusal was local policy wearing the upstream's name.

**`egress::host_is_permitted` is the one predicate, and that is the load-bearing choice.** It is
`is_local(host) || allow.contains(host)`; `check_url` refuses on it and `activation::check_destination` skips on
it. Two spellings of "is this host allowed" is precisely how a boot-time assertion comes to disagree with the
enforcement it is asserting about — the class of defect this register keeps finding.

**Why the host is `provider.baseUrl`'s and nothing else.** Because `join_url` **unconditionally prefixes** the
base: `join_url(base, path)` is `base + path` for every path, including one that looks absolute. So the host of
every URL a manifest can dial is the host of its `provider.baseUrl`, and checking that one host is *sufficient*
rather than a sample. An image URL returned *by* a provider is a different destination and is still checked by
`check_url` at fetch time; the assertion does not claim to cover it, and says so.

**The check declines when there is no host to judge.** A manifest with no `provider.baseUrl` returns `Ok` from
`check_destination` and is handed to `register`, which names the real problem a moment later. Without that, a
malformed manifest would be reported as an allowlist problem and send the operator to the wrong screen — a fix
that *lowers* diagnosability while looking like it raises it.

**Reachability is unchanged, and that is the safety argument.** A provider whose host is not allowlisted could
not be dialled before either — `check_url` refused it every time. So the fix changes **when and how the problem
is said**, not what works. That is what makes it safe to land without a migration or a compatibility note.

**Three falsification probes, one at a time, each reddening exactly its own test.** Removing the
`check_destination` call reddens `a_manifest_whose_host_is_not_allowlisted_is_skipped_by_name` **alone**, and on
the `registered.is_empty()` assertion rather than on the reason text — so the test is not merely checking a
string. Dropping the `is_local` branch from the predicate reddens
`a_localhost_manifest_needs_no_allowlist_entry` alone, which is what pins the local branch: without it every
fresh install would stop serving Ollama. And making the check claim a host it never saw reddens
`a_manifest_with_no_base_url_is_left_to_register_to_refuse` alone. Each probe reverted and the tree re-gated.

**What 25h does not close, stated rather than implied.** A provider edited *after* launch does not re-activate —
`persist` recomputes the allowlist on provider CRUD, and nothing re-runs activation — so a mismatch created at
runtime still reaches `check_url` and is still reported as `NETWORK`. Closing *that* needs the refusal to carry
its own class, which would add a token to the cross-language `ErrorClass` contract: `ALL_CLASSES` is walked
against the TypeScript union spelled out verbatim, so a Rust-only class is a deliberate divergence rather than
a local edit. **Candidate 1 was rejected on measurement:** deriving the allowlist from the manifest would let a
manifest widen it, and constraining the adapter's destinations to hosts the operator registered is the one
property the allowlist exists to hold.

**Measured:** `cargo test` lib **1175 → 1178**, binary **5 → 5** — the D46 test was rewritten rather than added,
because the old one asserted the behaviour the fix removes.

**25i — the egress refusal gets its own class, and `EGRESS_DENIED` enters the contract.** 25h closed D46 at the
boot path and named the half it left open: a provider edited *after* launch does not re-activate, so a mismatch
created at runtime still reaches `check_url` and is still reported as `NETWORK`. Closing that is not a change of
policy — the refusal already happened — it is a change of **what the refusal is called**, which is why this is a
taxonomy increment rather than an egress one.

**The misattribution has a direction, and that is what makes it worth a class.** Folded into `NETWORK`, a local
policy refusal tells the operator the *provider* is unreachable when the provider was never asked, and sends them
to the wrong system — the wrong turn D45's first diagnosis took, and the one D46's 56-of-56 run measured. So
`AttemptError::Blocked { reason }` and `ErrorClass::EGRESS_DENIED` are added, and the interpreter's **one**
mapping asks the *kind* rather than reading the message: `HttpError` became a struct with `message` +
`kind: HttpErrorKind::{Transport, Denied}`, and `attempt_error_from` is `if e.is_denied() { Blocked { reason } }
else { Transport }`.

**The reason travels with the error and is logged where the attempt is recorded.** `AttemptOutcome`
deliberately has no message field — its own note records why the chain carries two names and not a candidate — so
the egress's words would otherwise be dropped at exactly the boundary where they stop being recoverable.
`attempt_outcome` logs them before building the outcome, which is the last point at which they are still in hand.
The client-facing token stays a single word.

**Why the message could not decide it, and the test that says so.** The previous spelling of
`a_port_failure_is_a_transport_failure` passed `HttpError::new("host not allowlisted")` — a *transport*-kind
error whose message reads like a refusal. Under message-sniffing that input classifies as a policy refusal; the
rewritten test keeps it as the discriminating **middle** case and asserts it is still `Transport`, so a revert to
text-matching reddens on the assertion that names it. Two probes, one at a time: reverting the mapping to
always-`Transport` reddens the denied case **alone**, and making it match on `message.contains("not allowlisted")`
reddens the middle case **alone**. The two halves are load-bearing separately, which is what a single assertion
could not have shown.

**`EGRESS_DENIED` is a deliberate cross-language divergence, and the union test records it as one.** `ALL_CLASSES`
is walked against the TypeScript union spelled out verbatim (`errors.ts:5-14`), so a Rust-only member makes that
test fail — which it did, and the failure was the point rather than an obstacle. Rather than loosening the
assertion, it was split into two directional claims ("the port has not lost a class the TypeScript can send", "it
has gained exactly the recorded ones") plus a uniqueness claim the old set-equality got for free, and the extra
token is named in `RUST_ONLY_SPELLINGS`. A second divergence now has to be added there **by name**, in a diff a
reviewer reads, instead of being absorbed by an assertion someone widened. `EGRESS_DENIED` is not drift, not
retryable with the next key — every key of a provider shares its host, so the next key fails identically — and
not recorded against the key; all three are asserted, and the key-health arm is an explicit no-op so the omission
is visible rather than implied.

**A fourth route to the same misattribution, found by writing the class.** `egress::stream` calls `build` — which
is where `check_url` refuses — **before** its send loop, so a denied host on the *streaming* path emitted no
event at all: the sender dropped, `streaming`'s first `recv()` returned `None`, and the consumer reported
`"the egress ended before reporting response headers"` from the arm whose own comment claimed to be the
unreachable residue. Nothing was dialled, so nothing could have ended — the report was certainly false, and it was
the third message in this family to name the wrong party. The fix is that `egress::stream` sends its
classification *before* returning;
`a_streaming_refusal_is_reported_as_a_refusal_not_as_headers_that_never_came` pins it, and removing the send
reddens it with that exact sentence as the failure text. Recorded as **D48**.

**Measured:** `cargo test` lib **1178 → 1181**, binary **5 → 5** — three tests added, one per file: the class
mapping (`engine.rs`), the two-kind contract (`http_port.rs`), and the streaming refusal (`egress_port.rs`). The
interpreter test was rewritten rather than added. Gates: `fmt` clean, `clippy --all-targets -D warnings` clean,
`--no-default-features --all-targets` clean, lib **1181/0**, binary **5/0**.

**25j — the builtin profiles, and D41's second facet.** D41 was recorded as *"a builtin provider with no manifest
row would go unregistered"*. Porting the branch turned up a second facet that needs no failure to reach, and showed
the first to be narrower than the entry claimed.

**The reference's loop, and what the port was missing.** `store.ts:367-381` runs **over providers**, and for each
one tries `PROVIDER_PROFILES[p.slug]` **first**, registering `withBaseUrl(profile(), p.baseUrl)` and `continue`ing —
only falling back to that provider's active manifest row. `core::activation` iterated *manifest rows*, so a provider
with no row was never visited at all, and a provider with one was always served the row.

**Facet 1 — the no-row case is reachable, not hypothetical.** `addProvider` writes the provider row
(`store.ts:495`) **before** the manifest row (`:497-502`), and its `catch` rolls back in-memory state only:
`adapters.unregister` and `refreshFromHost`. Nothing deletes the provider row. So a failure between the two writes
leaves a provider that serves nothing, permanently — and `Providers.tsx:298` creating a builtin provider is the
ordinary way to get there.

**Facet 2, which D41 does not mention — a builtin provider *with* a row was served the stale one.** The row is
written once, at creation, with `version: 1`, and nothing re-seeds it on upgrade: no migration and no boot path
rewrites a `builtin-template` row. The reference ignores that row for a builtin slug and serves the *current*
profile. So every template change between releases is served by the reference and not by the port, for every builtin
provider, from the second release onwards. **Facet 1 needs a failure; facet 2 needs only time.**

**`core/builtin_templates.rs` is the port** — `openai_compat`, `anthropic_compat`, and
`provider_profile(slug, base_url)`. The base URL is a **parameter**, which is `withBaseUrl` composed rather than
applied: the profile supplies the dialect and its quirks, the provider row supplies the destination. Two
consequences worth stating. The profile path dials `providers.base_url` — the column `recompute_allow` derives the
allowlist from — so a builtin provider **cannot trip D46**, the divergence 25h closed. And the reference's pinned
default URLs are deliberately **not** duplicated in Rust: nothing here consumes them, and a copy would be a second
answer to "where does OpenRouter live".

**The slug is the key, not `type`.** `store.ts:368` is `PROVIDER_PROFILES[p.slug]`. Keying on `type` would have
diverged in the other direction, and invisibly, for the same reason this one was — no builtin provider is installed
on the only database anyone has measured.

**An omitted key is not a null one.** `opencode` passes `{ imageEndpoint: false }`, so `headers: extra?.textHeaders`
is `undefined` and `JSON.stringify` drops it. A port that always emitted `headers` would generate a manifest the
reference never would; `a_profile_without_overrides_omits_the_optional_keys_entirely` pins it, and the
transcription tests pin both templates field by field against `builtin-templates.ts`.

**Activation now iterates providers.** `Skipped.version` became `Option<i64>` — `None` for *no row involved* rather
than a `0` sentinel, because two spellings of one state is the defect this register keeps finding. Both log
consumers were updated.

**One additive divergence, taken deliberately.** A provider with neither a profile nor a row is **reported**, naming
the slug and the write order. The reference's loop falls off the end silently, and that silence is what made D41
invisible: the symptom arrives later, from `adapter_runtime`, as `no active manifest for provider …` on every
request, with no mention of the launch that could have named it.

**Four probes, one at a time.** Removing the profile branch reddens the 5 profile tests **alone**. Making
`provider_profile` ignore its `base_url` argument reddens 8 across both modules. Removing the no-row report reddens
its own test **alone**. Inverting precedence reddens the 2 tests that are about precedence — and the 2 further
failures there were artefacts of the probe's own simplified row path rather than of precedence, which is recorded
rather than claimed.

**Measured:** `cargo test` lib **1181 → 1197**, binary **5 → 5** — 9 tests in the new module, 7 in activation.
Gates: `fmt` clean, `clippy --all-targets -D warnings` clean, `--no-default-features --all-targets` clean, lib
**1197/0**, binary **5/0**.

**25k — one authority for "which manifest serves this provider".**

**The stated rationale was false, and the work is the residual.** The recommendation that opened 25k was
"seed builtin providers at boot, or the port will drift again on the next template change". That drift was
already closed: 25j made activation read the *profile*, not the row, so serving no longer diverged. What
*did* diverge was the second consumer of the same question: `workbuddy::tool_support` still read the row,
so a builtin provider was **served** by its current profile and **reported on** from its snapshot row — two
answers to one question, produced by one increment (**D49**).

**`activation::serving_manifest` is the one function.** It takes a slug, a base URL, and an optional
`(body_json, version)` — the stored row — and returns the manifest that serves the provider, with the
version it came from (`None` for a profile, `Some` for a row). Both `register_provider` and `tool_support`
read it. The function is the authority; the two callers are the consumers.

**`tool_support` now outer-joins `manifests`.** The join is load-bearing, not cosmetic: a builtin provider
may have no row and still be served by its profile, and an inner join would answer "unknown" — which the
caller reads as `false` — for a provider that is serving and forwarding tools right now.

**`manifest_forwards_tools` now takes `&Value`.** It used to take `&str` and parse, which assumed the
caller had a JSON string. After `serving_manifest` returns a `Value`, re-serializing and re-parsing would
be a second parse for no reason, and it would make the "not JSON" case unrepresentable — which is fine,
because that case is now `serving_manifest`'s `Err` arm, not the predicate's.

**Four tests, four claims.** `a_builtin_provider_reports_tool_support_from_its_profile_not_its_row` — the
row has no `tools` field, so `true` can only have come from the profile. `a_builtin_provider_with_no_manifest_row_still_reports_tool_support` — the outer join is load-bearing. `a_provider_without_a_profile_still_answers_from_its_row_in_both_directions` — the fix is not "builtins are always true". `a_row_that_is_not_json_is_unknown_rather_than_either_answer` — a corrupt row yields `None`, not a panic or a false claim.

**Three probes, one at a time.** Removing the profile branch from `serving_manifest` reddens the two builtin
tests and the five existing D41 tests **alone**. Changing the outer join to an inner one reddens the no-row
test **alone**. Making `manifest_forwards_tools` always `true` reddens the negative-direction test and the
existing predicate test **alone**.

**Measured:** `cargo test` lib **1197 → 1201**, binary **5 → 5** — 4 new tests in `workbuddy.rs`. Gates:
`fmt` clean, `clippy --all-targets -D warnings` clean, `--no-default-features --all-targets` clean, lib
**1201/0**, binary **5/0**.

---

### Increment 26a — the LaunchAgent, and the port it has not taken over yet

**Phase 6 step 1, and the first increment of the phase.** Phases 1–5 made the gateway a Rust service that
needs no webview; what none of them did is let it outlive the app *process*. `Cmd+Q` still takes the gateway
with it, because the only thing that ever started it was the app. `core/service.rs` is the other half: a
launchd `LaunchAgent` launchd owns, so the gateway comes up at login and stays up whether or not a window is
open.

**The binary is copied out of the bundle, and that is the risk register's own remedy.** A plist points
`ProgramArguments` at an absolute path, and the obvious one —
`/Applications/AI-Provider Router.app/Contents/MacOS/aiproviderd` — moves every time the bundle is versioned
or atomically swapped. `KeepAlive` **throttles** on repeated failed execs and can leave the job disabled, so a
path briefly missing during an update is not self-healing. Install therefore copies the bundled binary to
`{data_dir}/bin/aiproviderd` and points the plist there.

`tauri build` does put `aiproviderd` in `Contents/MacOS/` — measured on the bundle in
`target/release/bundle/macos`, **4,454,336 B** alongside the 11,074,960 B app binary (both dated
2026-09-24). **It is the default-features build**, and that half is confirmed by linkage rather than by
size: `otool -L` on the bundled copy lists **12 dylibs including `WebKit.framework`**, matching a fresh
default-features release build exactly. So the binary an installed agent would exec is not the binary
§2.1.1's dependency split is about.
**The size half of this paragraph was wrong, and 26r corrected it (D56).** It read "the Tauri-free
release binary measures **4,073,968 B**, 380 KB smaller" — wrong by **22×** in magnitude, and computed
from a build that no longer exists: the current release binaries are ~8.6 MB, and the true delta is
**16,896 B** (8,586,864 Tauri-free vs 8,603,760 default-features), because WebKit is linked
*dynamically* and costs no file size. The direction happened to be right and the reason was not.
Nothing in 26a depends on which build gets bundled, and 26a does not close it — but a later increment
that cares about what the service links has to say which one it is, and **26r did: the Tauri-free one,
for the linkage, not for the 16.5 KB.**

**The seam is one `&impl Fn`.** `install`, `uninstall` and `status` take the runner as an argument, so every
branch is reachable from a test with no launchd and no root. This is `HttpPort`'s and `BridgeHost`'s shape,
for the same reason: the alternative is a module whose only coverage is the machine it happens to run on.

**The `bootout` before `bootstrap` is not tidiness.** `bootstrap` of an already-loaded label fails, so a
re-install — the shape an update takes, and the only way a new binary reaches a running agent — would
otherwise be a no-op reporting success while launchd keeps exec'ing the old path.

**No `cfg` gate, deliberately.** A `#[cfg(target_os = "macos")]` module is a module no non-macOS build ever
compiles, which is the shape D17 recorded as a blind spot. Only `read_uid` and `run_launchctl` name the
outside world, and on a machine without `/bin/launchctl` they fail with a message rather than at compile
time — so all 15 tests run on all three CI platforms.

**Three commands, and the shim cases the same day.** `service_install`, `service_uninstall`,
`service_status` in `tauri/service_cmds.rs`, with `web-test/shim.ts` cases: status answers the honest
`{plistPresent: false, loaded: false, pid: null}`, and install/uninstall throw naming the missing launchd.
A shim that reported `loaded: true` would show a running service with no process behind it.

**What 26a does not close, stated rather than implied — and this one is a live hazard, not a note.** With
`RunAtLoad` and `KeepAlive` both set, the agent starts the gateway at install time and at every login, and
the desktop app *also* starts a gateway when it runs. Both bind the same persisted port, so **until the UI
stops starting its own (Phase 6 step 3), installing the agent and launching the app is a bind conflict, not a
handover.** Nothing detects or resolves it, and nothing calls `install` in production yet — it is a
capability with a command in front of it and the operator starts it. Uninstall likewise cannot guarantee the
job stopped: a `bootout` that fails while the job is running leaves the process up until logout.

**Three falsification probes, one at a time.** Dropping `RunAtLoad` from the plist reddens
`the_plist_asks_to_be_started_at_load_and_kept_alive` **alone**; swapping `bootout` after `bootstrap` reddens
`install_bootouts_before_it_bootstraps` **alone**; pointing `parse_pid` at a prefix that never matches reddens
`status_reports_the_pid_of_a_running_job` **alone**, leaving the "loaded but not up" and "launchd does not
have it" tests green — which is what separates the three status states from one another.

**Measured:** `cargo test` lib **1201 → 1216**, binary **5 → 5** — 15 new tests in `core/service.rs`. Gates:
`fmt` clean, `clippy --all-targets -D warnings` clean, `--no-default-features --all-targets` clean.

**The live run, and the one thing it could not reach (2026-09-25).** A temporary integration probe
(`tests/launchd_live.rs`, deleted after the run — **26q later reintroduced a file at this path as a
persistent, `#[ignore]`d harness; see the 26q note below**) drove the **real** `service::install` against the real
`launchctl`: real `~/Library/LaunchAgents`, real copy of the binary, real `bootstrap`, then `GET /health`,
then `uninstall`. What it established, measured:

- The plist this module generates is **accepted by `plutil -lint`** — `OK`, 779 bytes — and points at
  `/Users/tushershikder/Library/Application Support/dev.aiprovider.router/bin/aiproviderd`.
- `fs::copy` preserves the executable bit, so no `chmod` is needed: the installed binary is `-rwxr-xr-x`.
  **This is true of the real bundle and it is exactly why the `install` defect stayed invisible for three
  increments (26q):** `fs::copy` preserves *whatever* mode the source carries, and the unit suite's fixture
  wrote its source at `0644`, so all 15 tests exercised a path the bundle never takes. The measurement was
  correct and its scope was the bundle — the fixture never shared the property.
- The failure path reports usefully — `launchctl bootstrap gui/501 … failed (5): Bootstrap failed: 5:
  Input/output error` — naming the domain and launchctl's own message, not a paraphrase.

**And the one thing it did not reach:** `bootstrap` returned **error 5 (EIO)**, from a shell with no launchd
user session. Measured: `launchctl list` returns **0 lines** in that context, while `launchctl print gui/501`
shows the domain alive (`type = login`, `creator = loginwindow[171]`, 410 services). Both the modern
`bootstrap gui/501` and the legacy `launchctl load -w` fail identically, and so does `bootstrap user/501` —
so this is the *calling process's session*, not the domain, the plist or the verb. Ruled out along the way:
the sandbox (it fails with the sandbox off too), a malformed plist (`plutil` says otherwise), and the
`com.apple.provenance` xattr on the plist and the binary (stripping both changed nothing).

**What that means, and what it does not.** It does **not** indicate a defect in `core/service.rs`: mutating
`gui/<uid>` requires a process with an Aqua session, and the Tauri app is one by construction — this is the
ordinary reason a CLI cannot install a LaunchAgent. It **does** mean the end-to-end claim for 26a is
**unverified**, and it must stay that way until something with a session calls `install`. That is 26b's UI
control, and this paragraph is the debt it has to pay. The state was left clean: no plist, no copied binary,
no job in `gui/501`.

---

### Increment 26b — the UI control, and the session that verifies it

**Phase 6 step 3, and the increment that pays 26a's debt.** 26a built the launchd agent but could not
verify it: a shell with no Aqua session cannot mutate `gui/<uid>`, and every attempt returned error 5.
26b is the UI control that calls `install` from a process that *does* have a session — the Tauri app
itself.

**Three commands, one screen.** `service_status`, `service_install`, `service_uninstall` in
`tauri/service_cmds.rs`, with wrappers in `store.ts` (`serviceStatus`, `serviceInstall`,
`serviceUninstall`). The Control screen's Gateway tab gains a "Login-item service" card: a status line
(Not installed / Installed, not running / Running (pid N)), Install/Remove buttons, and a warning when
the app gateway is running and the service is installed but not up — because both bind the same port.

**The shim got a `serviceStatus` helper.** `__webTest.serviceStatus` arranges the state, and
`service_status` reads it — the same pattern `gatewayStatus` uses. Four web-tests:
- not installed → "Not installed" + Install button
- installed, not running → "Installed, not running" + Remove button
- running (pid 12345) → "Running (pid 12345)" + Remove button
- app gateway running + service installed but not up → the port-conflict warning

**The port-conflict warning is honest, not cautious.** With `RunAtLoad` set, installing the agent starts
the gateway immediately, and if the app gateway is already running, both bind the same port. The warning
tells the operator to stop the app gateway first. Nothing auto-stops it — that would be a side effect the
operator did not ask for.

**Measured:** `cargo test` lib **1216** (unchanged — no Rust changes), binary **5** (unchanged). TS
typecheck clean. Web-tests **104 → 106** (4 new in `service-status.spec.ts`). Playwright pass: all 4 in
~19 s. vitest **181** passed. fmt, clippy, `--no-default-features --all-targets`, check-doc-links,
docs:book, key-leak-grep all clean.

---

## Increment 26k — the shim serves `/admin/*` (and the browser suite runs as a gate again)

**The gap 26i left.** 26i moved a group of `store.ts` functions from `invoke` to `fetchAdmin`, which
dials `http://127.0.0.1:<port>/admin/*`. The browser harness stood in for the **IPC** host only, so
every migrated call left the page for a port nothing listens on. `web-test/shim.ts` now intercepts
`fetch` for loopback URLs whose path is `/admin/*` and dispatches to the **same in-memory store** the
`invoke` cases use.

**This is a second entry point, not a second implementation — which is the point.** Each route is a
thin adapter: parse path/query/body, call the `dispatch` case the `invoke` path already calls, reshape
the reply into what `core/gateway_admin.rs` answers. One store, two entry points — the shape the Rust
half has, where routes delegate to `persist::*` / `memory::*` / `context::*` cores. All 29 path
templates are served, not just the ones with a caller today.

**Three things the interception does, and one it cannot.**
- **It authenticates first.** `ui_session_key` now mints on first ask the way `ui_session::ensure`
  does, and the route refuses with 401 before parsing anything — the rule 26g moved a query parse to
  satisfy, since an axum extractor runs before the handler body and would answer a caller it had not
  authenticated. `__webTest.uiSessionKey` arranges the refusal.
- **It is arrangeable.** `failNext` accepts `METHOD path` alongside a command name, so "this read
  failed" survives the migration; `__webTest.adminCalls()` records what the UI sent, the HTTP
  counterpart of `store.requests()`.
- **It cannot model CORS.** The interceptor answers before the network stack runs, so the browser
  never performs the preflight or the origin check `cors_headers` exists to satisfy. **A CORS
  regression cannot redden this harness** — stated here rather than implied.

**The bug it found, and it is a live one.** `persistAliases` sent `{ rows }` — the IPC command's
shape — while `aliases_replace_h` takes `Json<Vec<AliasRow>>`, a bare array, which is what
`admin_aliases_replace_*` posts and what `POST /admin/memory/batch` already uses. The pair had never
been walked: 26f's test posts the array, 26j's fake accepts anything. Because `persistAliases` is in
the **boot** path, the app came up with "App data could not be opened" — no screen rendered at all.
Fixed on the client: the HTTP route is the surviving contract, so the IPC spelling is the one that
goes.

**Two more consequences of the transport change, both real, both fixed at the right layer.**
- **The pin checkbox lagged a round-trip.** `doPin` awaited the write and then re-read, so the control
  only moved after the host answered — invisible when that was one IPC hop, visible over HTTP, and a
  checkbox that lags the click reads as a write that did not land. `Memory.tsx` now updates
  optimistically and lets the re-read reconcile; the host is still the authority, and a failure reads
  the truth back.
- **`memory-recall.spec.ts` waited on the wrong element.** It waited for `div.whitespace-pre-wrap`,
  which also matches the user's own echoed message, so it read the egress log before the request had
  been made. It now waits on the request it is about to assert on. The assertions are unchanged; only
  the wait was wrong.

**Measured.** Browser suite **106 passed / 0 failed** in 1.5 m — the first time it has run green since
26b, and the first time it has run as a gate at all. Before: red from test 18 onward, each failure
costing the full 120 s timeout. `web-test:types` clean, `pnpm typecheck` clean, vitest **181/181**,
`key-leak-grep` clean. No Rust changed.

**Falsified.** With the interception removed (`globalThis.fetch = nativeFetch`), `smoke.spec.ts` goes
**13/14** — the memory screen renders "No memories yet" again. Probe reverted; `shim.ts` is back at
its committed size.

---

## Increment 26l — the app starts its own listener, and the boot survives it being off

**The gap 26k left, and 26k is what found it.** 26k made the harness serve `/admin/*` so the suite
could see the pure-HTTP migration, and the first thing it saw was that the migration had made
`bootstrap()` depend on a listener a fresh install does not have. `persisted_gateway_port` only
auto-restores once the gateway has been enabled at least once, and *"the user has never chosen"* read
as the same `None` as *"the user turned it off"*. So on a first run nothing was bound, and because
every screen now reads over `fetch()` the app was not degraded but **unusable**: measured 2026-09-25,
onboarding's first write (`createPendingProvider`) answered `{"ok":false,"err":"TypeError: Failed to
fetch"}`, so a new user could not add a provider at all — and `bootstrap()` reported the app's own
database as corrupt.

**Three states, because two facts had collapsed into one.** `GatewayStartup`:

- `Default` — no `gateway` row; the user has never chosen. Start on `DEFAULT_PORT`.
- `Off` — the user said so. Stay down.
- `On(port)` — bring it back on the port the user chose.

`persisted_gateway_port` deliberately keeps the stricter reading: it answers *which port*, and
`aiproviderd` has its own default, so `enabled` with no `port` is `None` there and `On(DEFAULT_PORT)`
here. The two now share `gateway_settings_row` — one query, two policies, which is the only reason
they cannot drift.

**A listener with no master key is worse than no listener.** `check_gateway_key` tests the master key
*before* it ever looks at an app key, so an auto-started listener with no key refuses everything with
401 — including the UI's own session credential. It would look healthy and serve nothing. So the
auto-start generates the first master key when the state is `MasterKeyLookup::Absent`, and **never** on
`Unavailable`: the second means the keychain did not answer, and generating there would rotate a key
that already exists.

**The boot degrades, and names the state.** `bootstrap()` now guards all six reads in one `try` —
providers, api-keys, models-cache, manifests, aliases and the `router` row — and degrades on
`isUnreachable(e)`, which is `e instanceof TypeError`. That single distinction is the whole design: the
browser rejects a `fetch()` to a closed port with a `TypeError`, while every other failure on the path
(an HTTP status, or an `invoke` the host rejected) arrives as a plain `Error`. So *the gateway is not
running* is survivable and *the store could not be opened* still fails the boot, which is what keeps a
corrupt database reported as one. A degraded boot leaves `bootstrapped` false, so the shell's notice
points at a recovery that works: `Shell.tsx` renders *Gateway not running — start it in Control to load
your data*, and `Control.tsx` retries `bootstrap()` after the switch starts the listener rather than
making the user relaunch.

**The StrictMode bug underneath it.** The degradation worked and the notice still did not appear. The
cause, once probed, was React StrictMode's double mount: `App` calls `bootstrap()` twice before either
resolves, the second call returned early, its `then` fired first, and `App` marked itself ready with the
reads still in flight — so the shell rendered while `bootDegraded` was still `null`. Fixed by sharing
one in-flight promise, with `bootstrapped` set only at the very end of a successful path. **A guard that
is correct and a guard that has run are different facts**, and only the second one reaches the screen.

**The keyed settings route, and the port it fixed.** `GET/POST /admin/settings/{key}`. `settings` is one
generic table holding rows that are not the same kind of thing: `gateway` is the listener plus the tool
switches, while `router` is read **per request** by the headless host (`RouterSettings::from_store`) and
carries `failoverEnabled`, `systemAi` and `perProviderConcurrency` — service data by any reading.
`/admin/settings` owns only `gateway`, so the UI's `settings_get`/`settings_set` on `router` had no HTTP
route at all, which was the last thing standing between the TypeScript migration and *all data access is
over `fetch()`*. The route **merges** into the row, for the reason 26h found: a whole-row UPSERT of a row
the caller only partly knows erases the rest of it. `read_gateway_settings` is deleted and
`read_settings_object` is now the single implementation of *absent and corrupt both mean `{}`*, which
until 26l existed twice.

`gatewayBaseUrl()` had a second defect of the same shape and it was quieter: its fallback said **8800**,
a port this app has never bound, while `DEFAULT_PORT` is **8787**. It now reads `gateway_status` first —
the live port is the authority, and the row is only written once the operator toggles the switch — and
falls back to `8787`.

**Migrated in this increment:** `manifest_activate` ×2, `manifests_active`, `gateway_spend_status`,
`memory_principal_list` / `memory_principal_set`, `gateway_prune_memories`, `persistRouterSettings`.
**Kept on IPC, on purpose:** `readGatewaySettings` / `patchGatewaySettings` — the `gateway` row is the
listener's own config, and the disable path writes *after* `gateway_disable`, so it must not depend on
the surface it has just stopped.

**The harness capability, built before the test that needed it.** `__webTestAdminSurfaceAbsent` makes
`isAdminTarget` return false, so the request falls through to the real network stack and fails the way a
first launch fails. Returning false is the honest model — refusing would have tested the harness. Until
this existed the shim answered every `/admin/*` call unconditionally, so a boot path that had acquired a
network dependency looked healthy in **all 106 tests**: a regression that made the app unbootable on a
fresh install was invisible to the suite that exists to catch it.

**Measured.** Rust lib **1278 / 0** — 26l adds **8** (three keyed-settings, five startup-policy); the
row's documented **1216** had already aged by 54 across 26c–26i, which is D50's pattern repeating inside
the window D50 was closed in. Headless `--no-default-features` **1214 / 0**; binary **5 / 0**. Browser
**108 passed / 0 failed** in 3.8 m (was 106; the two new are `gateway-off.spec.ts`). vitest **181/181**,
`pnpm typecheck` clean, `web-test:types` clean, fmt and clippy clean, `key-leak-grep` OK,
`check-doc-links` 52 files / 127 links.

**Falsified, both probes reverted.** (a) Making the keyed write ignore its path segment reddened
`admin_keyed_settings_merge_into_their_own_row_only` with `port: 8800` bleeding in from the `gateway`
row — the row separation is the property, and the test asserts on the row re-read from the host, not on
the response body. (b) `if false && row.get("enabled")…` reddened `gateway_startup_honours_an_explicit_off`
with `On(8787)` against `Off`.

**A tool hazard, recorded because it nearly cost a landed edit.** Bash `grep -c "A\|B"` returned a false
`0` twice over code that was present. The host-side Grep tool is the authority for an absence claim; a
shell `grep` with alternation is not.

---

## Increment 26m — three claims the code had already outgrown

**A documentation increment, and it is D52.** 26l's measurement surfaced three statements in this
document that the code had already left behind. None of them is a file 26l edited, which is exactly why
they survived.

- **§5.3: "The UI holds the master key in memory (it already does, for the one-shot reveal)."** Already
  known false — D51 measured it, and 26i *replaced the premise* with the `ak-ui` host-minted session
  credential. The paragraph asserting the old premise survived the fix, so this document described the
  defect and its solution in the same chapter. It now states the `ak-ui` model and **quotes the sentence
  it replaces** rather than silently overwriting it.
- **§5.2 and §10 decision 2: "the gateway is on `http://127.0.0.1:8800`."** `gateway.rs:38` is
  `DEFAULT_PORT = 8787`, and §2.1.1 of this same document explains the split — `aiproviderd` binds 8800
  *deliberately*, because 8787 collides with AI Hub v2. Two places described a single-port world that
  never shipped, and a reader of §5.2 alone would dial a closed port. §5.2 now names 8787; §10.2 reads
  the port from `gateway_status` instead of hardcoding one.
- **§13: "~12 `invoke` calls remain."** Measured with a node script over `apps/desktop/src`: **73**
  distinct `invoke` commands and **39** `fetchAdmin` call sites over **30** `/admin/*` templates — against
  §10's own corrected target of ~75 HTTP / ~34 IPC. Off by 6×. The line now carries the measured numbers
  and the ~13 split: 5 whose routes already exist, 8 that need one.

**Why this is its own increment rather than a line inside 26l.** All three claims were correct when
written and aged — D50's class exactly, and D50 was closed at 1216 earlier in the *same session* and went
stale again before it ended. **A prose claim cannot be kept current by fixing it once**, so the fix is to
write down what it now is *and* how it was measured.

**Measured:** no code changed, so no test count moves. Doc gates re-run clean: `check-doc-links` 52 files
/ 127 links, book rebuilt.

---

## Increment 26n — the gateway-data commands whose routes already existed

**The first half of the migration's remainder, and one scope correction that shrank it.** 26l measured
73 `invoke` commands against 39 `fetchAdmin` call sites. Three already had a route and needed only the
client moved:

- **`manifest_upsert_active`** — two call sites in `Onboarding.tsx`, now `POST /admin/manifests`. The
  body is the row itself: `manifest_upsert_active_h` takes `Json<persist::ManifestRow>`, and
  `ManifestRow` is `rename_all = "camelCase"` — the shape the wizard was already building.
- **`settings_get` / `settings_set` for non-`gateway` rows** — `Assistant.tsx` (`assistant`) and
  `Gateway.tsx` (`background`), now the keyed route 26l added. Two shape changes came with it and both
  are improvements: the keyed route answers an **object** where the IPC command answered a JSON
  *string* (so the `JSON.parse` is gone rather than kept as a no-op), and it **merges** where
  `settings_set` was a whole-row UPSERT.
- **The `gateway` row stays on IPC**, unchanged from 26l — it is the listener's own config, and the
  disable path writes *after* `gateway_disable`.

**The scope correction: the app-key group is excluded, and for a security reason.** The plan's
corrected scope calls the app-key commands gateway data, and by the ownership test they are, so they
should migrate. They must not. `POST /admin/keys` returns the secret in the response body (§5.3 design
point 2, because a headless client has no host clipboard), and R4/H5 require that an app-key secret
**never enters the webview** — `ARCHITECTURE_AUDIT.md` R4: *"The webview only ever receives
`{id, label}`"*; `AUDIT_REPORT.md` H5's fix: reveal via *"a Rust-side native dialog/copy that never
enters the webview DOM"*. Migrating that screen would trade a documented security property for
transport uniformity, so **the route exists for clients without a clipboard and the in-app UI does not
call it.** That makes a **third admissible reason for IPC**, alongside ownership and app-state: *a
route whose response carries a secret the webview must not hold.*

**The fourth instance of the claim 26m fixed.** 26m swept three places that said the UI holds the
master key. It missed one — §10 decision 2's own *Authentication model* bullet still read "the UI
becomes an authenticated client of the gateway, sending the master key with each request … held in UI
memory for the session". **A fix's sweep must cover every place the falsified claim appears, not the
places the fix touched**: the lesson the register already records for deletions (D44), arriving here
*inside the fix for that very class*. It now names `ak-ui` and points at §5.3.

**Measured.** No Rust changed. Browser suite **108 passed / 0 failed** (2.9 m), vitest **181/181**,
`pnpm typecheck` clean. After: **72 `invoke` commands and 43 `fetchAdmin` call sites** (was 73 / 39).

**Falsified, one probe.** Pointing the manifest write at `/admin/manifests__probe` reddened
`ui.spec.ts:55` (the zero-config wizard) — which is what proves the suite exercises the new transport
rather than merely tolerating it. Probe reverted.

**One more thing the migration fixed on the way.** `gateway-client.fake.ts` answered `[]` to every
unmatched `GET`, and `Object.assign(x, [])` is a silent no-op — so a settings read through the fake
would have looked like a passing spec while returning nothing. It now answers `{}` for
`/admin/settings`, which is the shape the real route has.

**26o — the gateway-data remainder, closed.** The seven commands §13 listed as gateway data still
needing a route all have one now: `POST /admin/manifests/stage`, `GET /admin/manifests/{id}/history`,
`POST /admin/spend/cap`, `POST /admin/context/prune`, `POST /admin/ledger`, and
`GET`/`POST /admin/memory/enabled`. **Six of the seven are database state. The seventh is not, and
that is the increment's one real decision.**

**The memory master switch is process state, and it is still right to route it.** It is an
`AtomicBool` on `GatewayCore`, read by the request path on every request — so its authority is
*whichever process serves the listener*. `invoke` reached the **app's own** core instead. In the
default install those are the same core, because the app starts and serves its own listener (26l), so
this route changes nothing observable today; the claim that it fixes a live bug would have been
**false**, and it was checked before it was written (`gateway_status` reports `state.core.port()`, and
`gatewayBaseUrl()` reads it, so the UI always dials the app's own listener). It is here because the
headless deployment is the case the port exists for, and there the two cores differ. It is
deliberately **not** the `MemoryMode` in `context_scope.rs`, which is per-client and parsed from the
`AIP-Memory` header: that decides what a given client gets, this decides whether the layer runs at
all, and a client's explicit mode can only narrow it.

**Two store functions were extracted rather than duplicated.** `manifest_stage` and
`manifests_history` held their SQL inline in their `#[tauri::command]` bodies, so a route calling
`persist::*` did not exist to call. Both are now un-gated `pub fn`s — `manifest_stage_row`,
`list_manifest_history` — for the reason D39 gave and `ledger_insert` already paid for: they take a
plain `&Store` and touch no Tauri type, so the `app` gate was inherited from their caller rather than
earned. `ledger_append` gained `ledger_append_row` for the same reason. **A route that re-issued the
SQL would be a second implementation free to drift from the first**, and the headless build is the
one that would have drifted silently.

**The harness could not model the switch, and that was a defect in the harness.** `web-test/shim.ts`
answered `gateway_memory_enabled` with a literal `false` and `gateway_set_memory_enabled` with its own
argument, storing nothing — so a POST followed by a GET disagreed with itself and no spec could have
caught a route that failed to write. Both are now backed by a `memoryEnabled` variable defaulting to
`false`, which is what the stub returned, so specs that only read it are unaffected. This is the
harness counterpart of the rule the 26k note already carries: **a harness that answers unconditionally
cannot see a dependency.**

**`{id}` on both manifest sub-routes means the provider id.** The activate route already had this
shape (`manifest_activate_row(store, provider_id, version)`, called from
`/admin/manifests/${providerId}/activate`), so the new history route reuses the same parameter name
rather than a descriptive one: two parameter names at one path position is a router conflict waiting
to happen, and the sibling's name was already on the wire. Recorded here because a reader of
`{id}/history` would reasonably assume a manifest id.

**The fifth instance of the master-key premise, and the first in source.** `gateway_admin.rs`'s module
header still said *"The UI holds the master key in memory for the session"* — the premise §10
decision 2 retired, which 26m fixed in three places and 26n in a fourth. This one is in the **file
D51's own Location cell names**, closed as Fixed in 26i without the sentence being edited: **a
closure does not sweep its own citation.** Register entry **D53**; the header now states the `ak-ui`
model and cites the history.

**A second harness, a second defect of the same family — and this one was found by a red spec.**
`web-test/shim.ts` answered the memory switch unconditionally; `src/lib/gateway-client.fake.ts`, the
**vitest** transport, did something subtler. Its `defaultResponse` returns `{ ok: true }` for any
`POST` that a spec has not seeded — right for most writes, and *silently wrong* for the two 26o added:
`store.ts` destructures `{ version }` out of `POST /admin/manifests/stage` and reads `.enabled` off
`POST /admin/memory/enabled`, so the fallback yielded `undefined` rather than an error. The visible
symptom was `store.trail-writes.test.ts` failing with `expected undefined to be 2` — **in a spec about
`approveRepair`'s trail bookkeeping, which is not the property that broke.** Both routes now have no
default at all: they are listed in a `NON_OK_WRITES` table and a call to either throws unless the spec
seeds it with `seedAdmin`. The rule is the one the shim's own header already carries, applied to
*shapes* rather than to *answers*: **a fabricated response is a claim about the wire, and a wrong
claim is worse than a loud failure.** Two dead `case`s in the same spec's `invoke` mock were removed
with it — `manifest_stage` and `manifest_activate` no longer go through IPC, and a stub for a command
nothing issues reads as coverage.

**Gates, measured 2026-09-25 after 26o.** App lib **1284/0** and binary **5/0**
(`cargo test`); headless **1220/0** (`cargo test --no-default-features`); `cargo check
--no-default-features --all-targets` clean; clippy clean under `--all-targets -- -D warnings` on
**rustc 1.98.1**; `cargo fmt --check` clean; vitest **181/181**; `pnpm typecheck` clean;
`web-test:types` clean; browser suite **108/108**; `key-leak-grep` OK; `check-doc-links` 52 files /
127 links. **Two of those runs are not reproducible with the obvious command**, and both are
environment rather than code: (1) the headless suite **hung** at 1220 tests on the two
`ui_session` keychain specs when run at full parallelism, and passed in 4.12 s in isolation — it is
keychain contention, and `-- --test-threads=4` completes in 9.84 s; (2) the browser suite's first two
attempts failed before any test ran, and **neither failure was the suite's**. The first was
`Timed out waiting 30000ms from config.webServer`, caused by the four `http_proxy`/`https_proxy`
variables pointing at `127.0.0.1:53585`: Playwright's readiness probe for the mock provider went
through the proxy, got a `502`, and never saw the server as up. The second was
`SAFE_DELETE_BULK_CONFIRM_REQUIRED` — the sandbox's bulk-delete guard refusing Playwright's cleanup of
a 4,102-file `test-results`. **The suite is green with all six proxy variables unset and
`web-test:clean` run first**; both traps are recorded here because the next run will meet them, and
because a `502` from a proxy satisfies a `status != 000` readiness loop — the check passes and the
server is not there.

**Falsified with one probe, not assumed.** `gatewayMemoryEnabled`'s path was pointed at
`/admin/memory/PROBE-WRONG-PATH`; `web-test/memory.spec.ts:128` — *"the master switch is live,
proving the screen's host load succeeded"* — went red at line 134, its assertion about the screen's
load, because the shim answers an unrouted `/admin/*` path with `404 unknown_route`. Reverted, the
same spec passed in 16.8 s. So the browser suite exercises the new transport rather than tolerating
it: a route that is not wired is a failure, not a silent `undefined`.

### Increment 26q — the install's success claim, and the fixture that hid it

**The standing item was "whether `service::install` actually gets a job running."** §12 says it is
unverified, and 26a's note already explains why: the one live attempt returned `Bootstrap failed: 5:
Input/output error` from a shell with no launchd user session. **26q rebuilt that attempt from
scratch before reading the 26a note, and reproduced it exactly** — `launchctl list` → 0 lines;
`bootstrap gui/501`, `bootstrap user/501` and the legacy `load -S Aqua -w` all exit 5; while
`launchctl print gui/501` and `print gui/501/com.apple.Finder` both answer. Running the identical
probe **outside the sandbox** changes nothing, so the sandbox is not the variable. That is a
confirmation of 26a rather than a new finding, and it cost an hour that reading §26a first would have
saved. The conclusion is unchanged: **only a process with an Aqua session can close this, and the app
is one.** 26b built that caller; nobody has run it and recorded the result.

**What 26q could close, it closed — and the defect is not in launchd.** `install` reported success on
the strength of exactly one fact: `bootstrap` exited 0. **`bootstrap` registers a job; it does not
exec the program** — acceptance and execution are different facts, and only the second one is a
gateway that is up. The reachable case: `fs::copy` preserves the source's mode, the module note
relies on the bundled binary already being executable, and **nothing checked**. Install a `0644`
source and launchd loads a job whose every spawn fails with `EACCES`, which `KeepAlive` restarts until
launchd throttles the job — while `install` returns `Ok(())` and the operator is told it worked.
`verify_executable` now refuses, **before any launchd state is touched**, because a refused re-install
must leave a previously loaded job alone rather than trade a working gateway for a broken one.

**And the reason no test caught it is the interesting part.** `service.rs`'s `source()` fixture writes
the stand-in binary with `std::fs::write`, which produces mode `0644`, under a comment reading *"a
source binary to install from, with the one property that matters: it exists."* **The property that
mattered was that it is executable.** So the fixture stood in for a bundle launchd could never exec,
every install test installed a job that could never start, and `install` returned `Ok(())` for all of
them — **the defect was live inside the suite that was supposed to catch it.** A fixture asserts an
invariant; this one asserted the wrong one, and the wrong invariant is written down as a comment,
which is what made it invisible. Fixed: `source()` is `0755`, `non_executable_source()` carries the
hostile mode, and the module's own previously untested claim that "permissions come along" now has an
assertion. Register **D55**.

**Two probes, one at a time, both reverted.** `install_refuses_a_binary_launchd_could_never_exec` goes
red with the `verify_executable` call commented out — `panicked … not an install: ()`, the `()` being
the `Ok(())` that *was* the defect. And the new plist test goes red when `escape_xml` stops escaping
`<` and `>`, printing the malformed `<string>…c<d>e…</string>` that caused it.

**The plist is now judged by a parser rather than by the renderer.** Every pre-existing assertion
about `render_plist` is substring containment against the string `render_plist` produced, which
proves only that the renderer agrees with itself. `the_rendered_plist_survives_a_real_plist_parser`
pipes it through `plutil -lint` — Apple's own parser, the same one 26a's live run used — on a path
carrying `&`, `<` and `>`. It is `#[cfg(target_os = "macos")]` and prints a `SKIP` line rather than
passing quietly when `plutil` is absent. This is the one artefact launchd actually consumes, and it is
now validated by something that is not us.

**The live check is a command now, not a paragraph.** `tests/launchd_live.rs`, `#[ignore]`d — CI has
no Aqua session, and a gate step that is red for environmental reasons is how a suite teaches people
to ignore it:

```text
cd apps/desktop/src-tauri
cargo test --test launchd_live -- --ignored --nocapture
```

Run it from **Terminal.app**, which launchd starts inside the GUI session. It installs into a scratch
directory so it cannot clobber a real agent, polls `status` for a pid instead of trusting `bootstrap`'s
exit code, asserts the payload's own marker file exists (so the pid is *ours* and not some other
process launchd happened to have), and uninstalls what it installed. **Its output distinguishes the
two meanings of a pass**: `SKIP` means the environment, no `SKIP` means the verification. What was
verified here is the harness — it compiles, runs, and takes the `SKIP` path carrying `launchctl`'s own
message. **The verification itself is still open**; §12 now names the command.

**Measured.** App lib **1284 → 1286**, headless **1220 → 1222**, binary **5 → 5** — two new unit tests
in `core/service.rs`, both reachable without the app feature, plus one `#[ignore]`d integration
target. Gates: `cargo fmt --check` clean; `clippy --all-targets -- -D warnings` clean; `cargo check
--no-default-features --all-targets` clean; lib **1286/0**; headless **1222/0**.

### Increment 26r — Phase 6 step 2, and the size argument that was the wrong argument

**Step 2 asked a question with two candidate answers and a false premise.** It read: the service ships
undeclared, "what is missing is declaring it, and deciding whether the copy is the default-features
build (measured 4,454,336 B, links Tauri) or the Tauri-free one (4,073,968 B)". Three claims, and
reconnaissance falsified two of them.

**`externalBin` is not missing, it is unnecessary.** The binary is already in `Contents/MacOS/` with
`bundle.externalBin` unset, no `resources` entry and no script naming it — so the bundler's `[[bin]]`
handling is what places it, which is §2.1.1's claim, now checked rather than assumed. Declaring
`externalBin` would want a `<path>-<target-triple>` source that nothing produces, and would target the
same destination the `[[bin]]` handling already fills. §2.1.1 said "no sidecar config is needed" and
step 2 said "what is missing is declaring it". **§2.1.1 was right.**

**The size argument was wrong by 22×, and it was the wrong argument to make.** Re-measured 2026-09-25,
same session, same profile, one variable — the feature set:

| Measurement | default features | `--no-default-features` |
|---|---|---|
| release binary | **8,603,760 B** | **8,586,864 B** |
| `otool -L` dylibs | 12, **includes `WebKit.framework`** | 8, no WebKit |
| `cargo tree` nodes matching `webkit`/`wry`/`gtk` | **34** | **0** |

The Tauri-free binary is **16,896 B smaller** — not the 380 KB the docs claimed. **WebKit is a system
framework linked *dynamically*, so it costs no file size at all**; the whole delta is Tauri's own Rust
code. That is why the old figure was plausible when written and wrong now: it was measured before
Phases 2–5 moved the engine into `aiproviderd`, when Tauri's Rust code was a large fraction of a much
smaller binary. **The direction was right and the reason was not, and a reason is what a decision
needs** — "16.5 KB" cannot carry a decision that "does not link WebKit" carries easily.

**The finding that matters most: the evidence for the dependency invariant could not fail.** The status
row cited `cargo tree --no-default-features --edges all | grep -ci 'webkit|wry|gtk'` → **0**. In BSD
BRE the `|` is **literal**, so that pattern searches for the string `webkit|wry|gtk` and returns 0 on
*any* input. Run against the default-features tree — which holds **34** real matches — it printed **0**
as well. The conclusion was true and the instrument was null, which is D54's lesson with a different
mechanism: not a hedge that lost its condition, but a command that **cannot report the failure it
exists to detect**.

**So step 2's decision, taken:** bundle the **Tauri-free** build, for the linkage — and note that
`tauri build` **cannot produce it**, because it builds the default-features target, so the copy it
places today is the WebKit-linking one (verified: the bundled binary links WebKit). Producing the
Tauri-free binary and substituting it into the bundle is a **build step**. That, not a config key, is
what remains in step 2.

**Measured.** No test counts change — this increment is measurement and documentation, and it adds no
code. Gates: `cargo fmt --check`, `clippy --all-targets -- -D warnings`,
`cargo check --no-default-features --all-targets`, `check-doc-links` and `docs:book`, all green.

### Increment 26s — Phase 6 step 2's build step, and the gate that can actually fail

**26r closed step 2's *decision* and left its *build step* open**: bundle the Tauri-free `aiproviderd`,
for the linkage, not for the 16.5 KB — and `tauri build` cannot produce it, because it builds the
default-features target. That step is what this increment lands.

**The build step is a script, not a config key, because there is no config key.** `tauri build` runs
one `cargo build` per target; there is no `tauri.conf.json` field that says "build the `[[bin]]`
target without the `app` feature". So the substitution is a *post-bundle* step: build the Tauri-free
`aiproviderd` with `--no-default-features`, verify its linkage, copy it into `Contents/MacOS/`, and
re-verify. `scripts/substitute-tauri-free-aiproviderd.sh` is that step; `pnpm build:headless` is its
one-command entry point.

**The gate is a different instrument than the one D56 retired.** The status row's evidence
(`cargo tree … | grep -ci 'webkit|wry|gtk'` → 0) was BSD BRE: the pattern is the literal string
`webkit|wry|gtk`, so it returns 0 on *any* input, including a tree with 34 real WebKit matches. The
replacement is `otool -L` on the binary — a check that reads the *actual dylib list* — plus `grep -icE`
(ERE, so the alternation is real). `scripts/check-bundled-aiproviderd-links.sh` runs it.

**The instrument is proven fail-capable, which D56's rule requires for any absence claim.** Pointed
at the default-features binary (which links WebKit) it exits **2** and names the offending
`/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit` line; pointed at the Tauri-free
binary it exits **0**. An instrument that cannot report the failure it exists to detect is worse
than no instrument, because a green exit reads as a passing check.

**Run 2026-09-25.** `pnpm build:headless` succeeded: Tauri-free build → WebKit link count **0**;
default-features build → WebKit link count **1** (the contrast); post-substitution bundle → WebKit
link count **0**. The gate then passed against the substituted bundle, and was *re-run* against the
default-features binary placed back in the bundle (falsification), which exited 2 as expected. The
bundle now ships the Tauri-free binary.

**What this does not close.** The two binaries are *functionally* different only in their
dependencies: Tauri-free `aiproviderd` does not start a webview or a Tauri event loop, so it
cannot *be* the desktop app. The substitution is one-way — `tauri build` always overwrites the
bundled `aiproviderd` with the default-features one — so any future `tauri build` run **must** be
followed by `pnpm build:headless`, or the bundle regresses to WebKit-linked. That coupling is
stated here and is the reason the gate (not the substitution) is the durable guard: a missing
substitution is caught by the gate's exit 2, not by the silent absence of a WebKit-free binary.

**What 26s leaves open, and it is a step 4 question.** `gateway_startup`'s two-process race (26l)
was still unmeasured *when 26s landed*: with `RunAtLoad` set the agent and the app both bind the
same persisted port, and nothing can test it without both processes up. **26t closed the decision
half of it** — the probe-and-delegate policy, so the app stops starting its own gateway when the
agent owns the port. The end-to-end measurement (both processes up) is the `launchd_live` harness,
still blocked on a real Aqua session.

**Gates:** `cargo fmt --check`, `clippy --all-targets -- -D warnings`,
`cargo check --no-default-features --all-targets` clean; `check-doc-links` 52 files/127 links;
`docs:book` 212 ids; `key-leak-grep` OK. No test counts change — this increment adds two shell
scripts and one `package.json` entry, and lands no Rust or TypeScript.

### Increment 26t — Phase 6 step 4: the app stops starting its own gateway when the agent owns the port

**The race, now designed for.** 26s left step 4 open because it is the one that touches the
app. The collision is fully measured: the launchd agent (`aiproviderd`, `RunAtLoad`) and the
desktop app both read `persisted_gateway_port` and bind it at launch. Whichever binds second
silently loses — the app's `spawn` fails at `TcpListener::bind` with `Address in use` and logs
`auto-start FAILED`, ending up with no listener; or the agent exits 1 and `KeepAlive` throttles
it. Neither process knows the other is there. 26l sharpened it by making the app *start* its
listener on a fresh install rather than only restore one, so on a user who has the agent
installed the next launch is a guaranteed race.

**The policy — ask the socket, not the job.** A `launchctl` read of "the service is installed"
is a different fact: a loaded job between restarts has no pid, and a `KeepAlive` backoff may not
have re-spawned yet. Two listeners cannot share a port, so the question that matters is the
socket's — *is someone accepting right now?* The fix is to probe the port before binding, and
only bind when it is free.

**What 26t lands.** Three functions in `core/gateway.rs`, split out of `app.rs` the way
`hide_on_close_from` was, so the policy is reachable without a Tauri app and without a real
socket:

- `probe_port(port, wait)` — a `TcpStream::connect_timeout` to loopback. `Ok(())` means
  something is accepting; `Err` (refused, wedged, timeout) means free. The connect is the whole
  detection: a free loopback port answers `ECONNREFUSED` in microseconds, a serving one accepts.
  The socket is dropped on return, because a probe that leaves an accepted connection open is
  exactly the squatting it exists to catch.
- `app_bind_decision(probe) -> bool` — `true` (delegate) when the probe is `Ok`, `false` (bind)
  when it is `Err`. **The asymmetry is the point: only a confirmed "in use" is a reason not to
  bind.** A broken probe must never leave the app with no listener — a dead agent and a dead app
  is the worse of the two states, and the safe side of a wedged probe is "bind it".
- `app_listener_action(probe, port) -> Option<u16>` — `Some(port)` when taken (delegate), `None`
  when free (bind). The seam `app.rs` calls.

`GatewayCore::set_port` is new: `spawn` writes the bound port, and the delegate path writes the
agent's port, so `gateway_status` (the UI's discovery surface) reports the port that is actually
serving rather than the boot default. `app.rs`'s auto-start now probes, and on a taken port
records the port on the core, sets `running`, and returns without binding.

**The falsifying probe.** A function that answered `Ok` unconditionally would delegate on every
launch and the app would never start its own gateway — a silent regression, green tests and all.
`step4_probe_port_free_reports_err` pins it: probing a free port must `Err`. `step4_set_port_...`
pins the discovery half. The decision itself is pinned by the two `app_bind_decision` /
`app_listener_action` probes, one per arm.

**Gates:** `cargo fmt --check`, `clippy --lib --bins --no-default-features` clean,
`cargo build --features app --lib` clean (the `app.rs` edit); `cargo test --lib` **1291** passed
(+5: the step-4 probes), 0 failed. `check-doc-links`, `docs:book`, `key-leak-grep` — run with the
commit.

**What 26t does not close.** The two-process race is *designed* but not yet *measured end-to-end*:
that needs both the agent and the app up, which is the `launchd_live` harness territory (Task #4,
blocked on a real Aqua session). What 26t proves is the *decision* — that a taken port is read as
"delegate" and a free port as "bind" — at the seam that does not need either process.

### Increment 26v — the `launchd_live` harness now runs a real `aiproviderd` and pins the 26t delegation end-to-end

**The genuine remaining code task from 26t, landed.** 26t's five falsifying probes pinned
`app_bind_decision` / `app_listener_action` / `probe_port` at the seam — the unit level. The
end-to-end measurement, the one that puts the real agent up and asserts the app's decision reads
`Some(port)` against a live listener, was the open item 26u's §13 note named. This is it.

**What landed:**

- `service.rs` — `Paths` gained two fields:
  - `environment: BTreeMap<String, String>` — launchd's `EnvironmentVariables` dict, emitted by
    `render_plist` when non-empty (stable order, so re-installs don't produce a diff that looks like
    a change). Empty in the production install; the harness uses one `AIP_DATA_DIR` entry so the
    agent points at a scratch store.
  - `data_dir: PathBuf` — the directory `paths(home, data_dir)` was built from. Not consumed by
    `render_plist` (launchd reads only `EnvironmentVariables`), exposed so callers can reconstruct
    the env var value without re-deriving it from `binary`'s parent.
  - Three new unit tests in `mod tests`: `an_empty_environment_means_no_environment_variables_dict`,
    `a_non_empty_environment_emits_the_dict_with_each_key_escaped`,
    `the_environment_dict_sits_between_program_arguments_and_run_at_load`.

- `launchd_live.rs` — new `#[ignore]`d test
  `agent_serves_health_and_app_delegates`:
  1. Looks for `target/debug/aiproviderd`; if missing, prints `SKIP: aiproviderd not built` and
     returns (a statement about the build, not a pass — the test cannot pin a listener that was
     never execed).
  2. Creates a scratch `Paths` with `AIP_DATA_DIR` pointing at `paths.data_dir`.
  3. Calls `service::install`, which copies the real `aiproviderd` binary into the scratch tree,
     writes the plist with the `EnvironmentVariables` dict, and bootstraps the job.
  4. Polls `service::status` for the agent's pid within `SPAWN_BUDGET` (20 s).
  5. Calls `probe_port(8800, 3 s)` — the `SERVICE_DEFAULT_PORT`, which a fresh scratch store
     (no `gateway` setting row) falls back to.
  6. Calls `app_listener_action(&probe, 8800)` and asserts the result is `Some(8800)` — the 26t
     delegation pinned against a live listener, not a synthetic seam.
  7. Uninstalls what it installed; always reports whether cleanup worked.

- The file's header now documents **three** tests (previously two): the shell-script stand-in
  (which proves `service::install` runs a payload), the real-binary test (which proves the gateway
  runs behind it), and the stated limits (the real plist location at login is not tested; a logout
  would be needed for that).

**Why the `EnvironmentVariables` dict is the right mechanism** — launchd's `bootstrap` has no
`-e` flag; `EnvironmentVariables` in the plist is the only way to set env vars on the agent's
process. A wrapper script (`/bin/sh -c 'export AIP_DATA_DIR=…; exec …'`) would work but adds a
second executable that `verify_executable` cannot check, and the dict is the native shape. The
production install path leaves the dict empty, so the production plist is byte-identical to the
26t version.

**What it does not cover, stated:** `KeepAlive` behaviour when the binary is inside an updated
`.app` bundle that moves the installed path (the risk register's own open question, §12). The
scratch install here points at a stable path under `data_dir/bin/`, which is the shape
`service::install` uses in production; the only thing not tested is the login-time scan of
`~/Library/LaunchAgents`, which requires a logout and is the human step §12 names.

**Gates:** `cargo test --no-default-features` — 1230 lib tests passed (was 1225, +3 new
`EnvironmentVariables` tests), 5 aiproviderd bin tests passed, 2 launchd_live tests ignored (as
designed). `cargo clippy --no-default-features --tests` clean. `cargo fmt --check` clean.

**Human step still open:** the test requires an Aqua session. From Terminal.app:

```bash
cd apps/desktop/src-tauri
cargo build --no-default-features --bin aiproviderd
cargo test --test launchd_live -- --ignored --nocapture
```

A green run with no `SKIP` line and `action = Some(8800)` in the output is the verification.
A `SKIP: aiproviderd not built` line means the build step was skipped; a `SKIP: no Aqua session`
line means Terminal.app was not in a GUI session. Read the output, not the exit code.


**No code landed in this increment — a measurement.** The "65 `invoke` / 39 `/admin` templates / 7
still on `invoke`" figures from 26o had been propagated through 26p–26t as if they were current,
and the live tree had moved under them. Re-measured on the tree 26t committed:

- `invoke` commands in `apps/desktop/src`: **~17** total (7 in `store.ts`, 10 across the screens),
  every one in the must-stay-on-IPC category §13 lists (listener control + discovery, workspace root,
  the two secret groups, `agent_run_*`, `service_uninstall`, `skills_*`, `tools_check_root`,
  `settings_set gateway`). **No command whose data the gateway owns is left on `invoke`.**
- `/admin/*` templates used by the UI: **23**, all served. The two that look absent
  (`/admin/settings/background`, `/admin/settings/router`) are served by the generic
  `/admin/settings/{key}` route (`gateway.rs:2127`).
- **Task #8 (manifest extraction) done**: `manifest_stage_row`/`manifests_history` live in
  `persist.rs`; `gateway_admin.rs`'s `manifest_stage_h` calls `persist::manifest_stage_row` (shared
  SQL); `gateway_tests.rs:5017` pins the route. No second SQL implementation.
- The vitest/Playwright suite is **181/181**, not "108/108" — it grew after 26l.

**The class is the register's own, one level down.** D56 retired a command that could not fail; D57
retired an instrument that had not been pointed at the artefact. This is *a "cannot be rechecked"
total re-used without re-measurement* — 26o's closing sentence said exactly that about the 65/39
figures ("A total without its method cannot be rechecked"), and the next five increments quoted the
same figure without running the grep. D59 records it. The corrected inventory in §13 is the method a
reader can re-run in one line each.

**Gates:** no Rust or TypeScript change; `check-doc-links`, `docs:book`, `key-leak-grep` — run with
the commit. The 181/181 suite is the current green line.

## 12. What we know we do not know

- ~~Whether `rquickjs` (or `boa`) can run the existing Tier-2 adapter sandbox. The contract suite is
the test; until it is run, this is an open question.~~ **Answered 2026-09-24: yes, it can.** `rquickjs`
runs `GOOD_GUEST` verbatim to the values `code-adapter.test.ts` asserts. The contract suite *was* the
test and it passed — but it does not test the memory limit, and that is precisely where the port's one
real containment failure lives. See §2.1.3.
- ~~Whether the summarization call in context compression (Tier 2) works correctly when the engine
  calls itself recursively.~~ **Answered 2026-09-24, and the question was mis-framed.** Rust does not
  permit the recursive shape at all — a callback that re-enters the same `&mut self` is `E0501` — so
  there is no recursion to get wrong. The real question is how the summarizer reaches the router, and
  the answer is as a seam the router calls rather than a closure it runs inside. See increment 14a
  and D24.
- Whether launchd's `KeepAlive` behaves correctly when the binary is inside an `.app` bundle that
is updated (the path changes). This needs a real update cycle to verify.
- **Whether `service::install` actually gets a job running.** **Unverified, and it now has a command
  instead of a paragraph.** Reproduced independently by 26q on 2026-09-25: `bootstrap gui/501`,
  `bootstrap user/501` and the legacy `load -S Aqua -w` all exit `5: Input/output error` from a shell
  with **no launchd user session** (`launchctl list` → 0 lines), while `launchctl print gui/501` shows
  the domain alive — and running the identical probe **outside the sandbox** changes nothing, so the
  sandbox is not the variable. A CLI is not a process that may mutate `gui/<uid>`; the Tauri app is,
  which is what 26b's UI control provides. **Run this from Terminal.app and read the output, not the
  exit code:**

  ```text
  cd apps/desktop/src-tauri
  cargo test --test launchd_live -- --ignored --nocapture
  ```

  `SKIP` in the output means the environment rather than the code, and a green run carrying `SKIP` is
  **not** a verification. What 26q did close is the half that needed no session: `install` no longer
  reports success for a binary launchd could never exec (`verify_executable`). Full measurements in
  the 26a and 26q notes above
- **What `gateway_startup` should do when `aiproviderd` is the process serving.** Opened 2026-09-25 by
  26l; **answered as a decision by 26t.** The probe-and-delegate policy is landed: `probe_port`
  asks the socket, `app_listener_action` maps the result to `Some(port)` (delegate) or `None` (bind),
  and `app.rs`'s auto-start records the agent's port on the core rather than binding a second
  listener. What 26t does *not* close is the end-to-end measurement — it needs both the agent and
  the app up, which is the `launchd_live` harness territory.

---

## 13. Where this plan lives

This is a plan, not a specification. When implementation starts, each phase gets its own design
document in `docs/` and its own branch. This chapter is updated as decisions are made and
assumptions are tested.

**Next action:** ~~settle §10 decision 2 — pure HTTP or hybrid HTTP+IPC~~ — **settled 2026-09-25:
pure HTTP**, and its scope **corrected by measurement** (107 commands, narrowed to the ~75 the
service owns — see the decision entry); ~~add CORS~~ **landed 26c**; ~~add the §5.3 admin routes~~
**landed 26d**; ~~provider CRUD~~ **landed 26e**, which also added the allowlist seam the routes
need. ~~Remaining CRUD routes — api-keys, manifests (+ activate), models cache,
aliases, ledger read~~ **landed 26f** (committed `449d4ec`, pushed); ~~the memory/context routes~~
**landed 26g** — 17 memory + 3 context-graph routes. The History screen's two commands
(`history_sessions`, `history_timeline`) are **not** ported: 26e measured them as app-owned UI
state, not service data. ~~the tool toggles~~ **landed 26h** — `GET/POST /admin/tools` and
`PUT /admin/tools/workspace-root`; the toggle writes **both** authorities (the in-memory flag and
`gatewayToolsEnabled` in the `router` row) because writing only one would be a toggle that lies.
~~the TypeScript migration~~ **landed 26i** — D51 resolved with a host-mediated session credential
(`ak-ui`). **The sentence that followed read "~12 `invoke` calls remain", and 26l measured it wrong on
both readings: 73 `invoke` commands remained, against 39 `fetchAdmin` call sites over 30 `/admin/*`
templates.** **26n** then migrated the three whose routes already existed — `manifest_upsert_active`
(`POST /admin/manifests`) and `settings_get` / `settings_set` for non-`gateway` rows (26l's keyed
route). **26o closed the seven this line had listed as gateway data still needing a route**: each now
has one — `manifest_stage` (`POST /admin/manifests/stage`), `manifests_history`
(`GET /admin/manifests/{id}/history`), `gateway_spend_cap_set` (`POST /admin/spend/cap`),
`gateway_prune_live_context` (`POST /admin/context/prune`), `ledger_append` (`POST /admin/ledger`),
and the memory master switch (`GET`/`POST /admin/memory/enabled`). What remains on `invoke` is
app-state, secret-bearing, or host-resource, and **no command whose data the gateway owns is left**:
listener control and discovery (`gateway_status` — which *must* stay IPC, since it is how the UI
learns where to send HTTP — plus `gateway_enable`/`gateway_disable`), the workspace root
(`gateway_project_key`), in-memory telemetry (`gateway_injection_stats`), the host log file
(`gateway_log_tail`), the `router_model_context_*` pair, and the two secret groups — `gateway_key_*`
(master) and `gateway_app_key_*` (R4/H5, because `POST /admin/keys` returns the secret in its body).

**The measured state after 26o, with its method** — because the figures above were measured another
way and do not reconcile with this count: `apps/desktop/src` holds **65** distinct `invoke` commands
and names **39** distinct `/admin/*` path templates. Counted by extracting `invoke("name")`
first-argument literals and `/admin/…` string literals from `apps/desktop/src`, normalising template
holes to `{x}`, query strings kept. This increment removed **7** commands and added **6** templates
(the memory switch is one path serving both verbs). **A total without its method cannot be
rechecked** — which is why 26l's "30 templates" and 26n's "43 call sites" were left as written and
this figure stands beside them rather than replacing them. ~~the browser
harness~~ **landed 26k** — `web-test/shim.ts` intercepts `fetch` to `127.0.0.1:<port>/admin/*` and
dispatches to the same in-memory store the `invoke` cases use, so the suite runs as a gate again:
**106/106**, from red at test 18. It found one live bug on the way (`persistAliases` sent `{ rows }`
where the route wants a bare array) and cannot model CORS — see the 26k note. ~~the boot that could
not reach the listener~~ **landed 26l** — the app now **starts** its own gateway by default rather
than only restoring it, because *"never chosen"* is not *"turned off"* (`GatewayStartup::Default`),
and it generates the first master key when there is none; `bootstrap()` degrades on an unreachable
surface instead of reporting the database as corrupt; the keyed `GET/POST /admin/settings/{key}`
route closes the last gap the TypeScript migration had; and `gatewayBaseUrl()`'s fallback stopped
naming 8800. Browser suite **108/108**.
Steps 1 and 3 are landed (26a and 26b); **26r took step 2's decision and 26s closed its build step** —
bundle the **Tauri-free** build, because it does not link WebKit (the size difference is 16.5 KB and is
not the reason). `tauri build` cannot produce that binary — it builds the default-features target — so
`scripts/substitute-tauri-free-aiproviderd.sh` (`pnpm build:headless`) is the post-bundle step: build the
Tauri-free `aiproviderd` with `--no-default-features`, verify its linkage with `otool -L`, and copy it
into `Contents/MacOS/`. The substitution is **one-way**: any future `tauri build` overwrites the bundled
binary with the WebKit-linked one, so the durable guard is the gate `scripts/check-bundled-aiproviderd-links.sh`
(ERE `grep -icE 'WebKit|wry|gtk'` against `otool -L`), which is the instrument D56 required — one that
reports *presence*, not the BRE command that returned 0 on any input. `bundle.externalBin` is **not**
needed: the bundler already places the `[[bin]]` target, which is how the service reached `Contents/MacOS/`
(D56).
With `RunAtLoad` set, the agent and the app both bind the same persisted port, so the agent is only
usable once the app stops starting its own gateway — which is what step 4 does. **26t landed step 4's
decision half**: `probe_port` asks the socket, and on a taken port the app records the agent's port on
the core and returns without binding a second listener — the two-process race is no longer a silent
collision but a designed delegation. The end-to-end measurement (both processes up) still lives in the
`launchd_live` harness. The other decisions in §10 still stand.

**The 26u re-measurement — the open-item list under-reported the tree, and this entry corrects it.**
The "65 `invoke` / 39 `/admin` templates / 7 still on `invoke`" figures (from 26o) have been
propagated through 26p–26t without being re-measured, and the live tree has moved. Measured 2026-09-25
on the same tree 26t committed:

- **`invoke` commands remaining: ~17**, not 65 — and every one is in the *must-stay-on-IPC* category
  §13 itself listed (listener control + discovery, `gateway_enable`/`disable`, the workspace root,
  the two secret groups, `agent_run_*`, `service_uninstall`, `skills_*`, `tools_check_root`,
  `settings_set gateway`). **No command whose data the gateway owns is left on `invoke`.**
- **`/admin/*` templates used by the UI: 23**, all served by Rust routes — the two that look absent
  (`/admin/settings/background`, `/admin/settings/router`) are served by the generic
  `/admin/settings/{key}` route registered in `gateway.rs:2127`. Every `fetchAdmin` call site in
  `store.ts`/screens has a matching `axum` route.
- **Task #8 is done** — `manifest_stage_row`/`manifests_history` are extracted into `persist.rs`,
  the `POST /admin/manifests/stage` handler calls `persist::manifest_stage_row` (shared SQL), and
  `gateway_tests.rs:5017` pins its version-increment behaviour. No second SQL implementation.
- The browser/vitest suite is **181/181**, not "108/108" — it has grown since 26l.

The class is the register's own: a "cannot be rechecked" total was re-used as if it were current. D59
records it. The corrected inventory above is the method a reader can re-run: `grep -c "invoke("
apps/desktop/src/store.ts` (~8), `grep -rhoE '"/admin/…"' apps/desktop/src/…` (23), and the Rust route
registrations in `gateway.rs:2125-2142`.

(This line read "answer the four decisions in §10, then begin Phase 1" until 2026-09-24, by which
point Phase 1 and twelve increments had landed; it then read "decide the sub-question the
adapter-runtime spike left open — in-process with a supervised heap ceiling, or out-of-process — and
then give that module a phase in §7" until 2026-09-25, by which point Phase 4b had given that module
its phase and the spike's residual was recorded in the risk register instead; and 26p then *answered*
that residual — S6i fences the fault in-process — narrowing it from feasibility to the abandoned-frame
cost, which is D54; 26r took step 2's decision while leaving its build step open, and 26s then closed
that build step — `scripts/substitute-tauri-free-aiproviderd.sh` plus the `otool -L` gate — and 26t
then landed step 4's decision half: `probe_port` asks the socket, and on a taken port the app records
the agent's port on the core rather than binding a second listener, so the two-process race is a
designed delegation, not a silent collision. **26v extended the `launchd_live` harness to close the
loop end-to-end**: `agent_serves_health_and_app_delegates` installs a **real `aiproviderd`** binary
(Tauri-free, `--no-default-features`) as the agent payload, points it at a scratch store via
`AIP_DATA_DIR` (a new `EnvironmentVariables` dict in `render_plist`, empty in the production install
so the production plist is unchanged), and asserts that after the agent is up, `probe_port` +
`app_listener_action` reads `Some(port)` — the 26t delegation, pinned against a live listener rather
than a synthetic seam. The test is `#[ignore]`d and requires an Aqua session, so it runs from
Terminal.app with `cargo test --test launchd_live -- --ignored --nocapture` after `cargo build
--no-default-features --bin aiproviderd`. The only remaining open item is that human step: run the
ignored test from a GUI session and confirm the agent's pid + `/health` + the delegation assert hold.
It is rewritten here rather than silently overwritten because a stale "next action" is the cheapest way for a
plan to stop describing its own project.)
