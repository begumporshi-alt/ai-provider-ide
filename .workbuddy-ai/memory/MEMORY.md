# Project memory — AI-Provider Router IDE

**Rules index** — depth in `REFERENCE.md`. **Cap 8,000 B; past it truncates mid-rule.**

## Non-negotiables
- A tool result is not evidence. **A `Write`/`Edit` can report success while the file keeps its old bytes *and* mtime** — `Read` serves the *unwritten* text. Verify by `stat` mtime + **Grep tool**, retrying until it moves. **An `Edit` that inserts must not shrink its anchor block** — read the region back.
- Falsify **one** probe at a time; measure before recording a cause. **A reason is a claim too** — "cannot be tested" needs the same evidence as "is not tested". **Re-snapshot after every accepted change** — a probe reverted from a stale snapshot deletes the fix. **`touch` sources after a probe run** — a preserved-mtime restore leaves the build stale. **A module written against seams is testable before its prerequisites exist** — name them in its header; a driver with no caller compiles green (D39). **A plan's future tense is a claim**: "`x` will implement it" needs an `impl <Trait> for` grep whose hits are not all `#[cfg(test)]` (D40).
- Unset **all six** proxy vars on probe *and* app — else `502`. **A proxy `502` satisfies a "status != 000" readiness loop**.
- `./node_modules/.bin/tsc`, never `npx tsc`. JS tests: managed Node 22 first on PATH. Gate needs `PATH="$HOME/.cargo/bin:$PATH"`. **Shell is bash 3.2 here** — no `mapfile`. Commit msgs via `-F <file>`.
- **One edit per file per batch** — the 2nd lands on a stale snapshot and clobbers the 1st; both report success.
- Absence claims: **Grep tool** (bash `grep` lies) — **skips dot-dirs** (`.github/`, `.workbuddy-ai/` → `cat <dir>/* | grep`). A hit ≠ completeness; count via node.
- **Cargo unifies features per crate** — `default-features = false` is **inert** when another dep takes the crate with defaults (`tauri-utils` → `regex`). Read the *resolved* set: `cargo tree -f "{p} {f}"`. **A measurement's configuration is part of its claim**.
- **The bulk-delete guard is sandbox-only**; clean in `web-test:clean`, *after* `pnpm build`. **A harness that stands in for the wrong transport is not a harness** — the shim intercepted `invoke` while the UI moved to `fetch()`: 106 tests dialled a dead port. **An interceptor cannot test CORS** (it answers before the network stack).

## Where things are
- `ARCHITECTURE.md` is a spec, not the app. `dev-book/` = rules/contracts + drift register; `build-dev-book.mjs` → `book.html`, `check-doc-links` is a gate.
- Playground = **Assistant**; skills are frontend-only, gateway blind to them. **DB path, ports, corpus sizes → `REFERENCE.md`.**
- Identity = **two** strings, either may deny: `AIP-Agent`, `key:<id>`. Use `core.app_keys()`, never `AppKeyProvider`.
- **Clippy and rustfmt are gates**; triage clippy by lint *kind* — count ≠ signal. **Snapshot before `--fix`**: it *moves* code. **A `-D warnings` gate on floating `stable` goes red with no code change** — `rustup update stable` before believing the code.
- **The code sandbox**: `core/js_host.rs` (the actor) + `core/code_adapter.rs` (the manifest half); the rules they cost → `REFERENCE.md`.

## Recall & scope
- Paths differ on **one axis: scope** — gateway `recall_scoped`+`RecallScope` (excludes `Unscoped`) vs Assistant `recall(..., None)`.
- Atoms are born unscoped → gateway recall 0 until a human binds: `capture`'s INSERT omits scope; `assign_scope` is the only way in. Drain must NOT auto-bind.
- Session identity hashes `principal|user|project|agent`; derive from identity, never from place.
- Master switch → per-principal row beats the client's `AIP-Memory` header. `superseded_at` (0014) hides rows from recall/session/injectable, **not** `list`.

## Rules that cost a bug

**Auth / install** — **Reinstalling costs one keychain approval**; until granted *every* request answers `503 master key unavailable` (precedes auth); **401** = healthy. **Never pin a signing identity in `tauri.conf.json`** — CI cannot catch it; build to verify. **`memory_enabled` is in-memory only**, `Disabled` outranks `WriteOnly`; check the Memory screen, not HTTP.

**Gateway** — Nothing is an image model unless a manifest says so (`endpoints.generateImage` + `modalityRules.image`). §3.5 = **two semaphores**: `permits` *admits*, `dispatch` *routes*. **Three different 429s — read the body**; a live capacity probe cannot reach the gate. Probe headers are **lowercase** (`h.get("Retry-After")` → `None`) — dump before claiming absence; client-facing `Retry-After` = the **shortest** wait. A DB-lifetime-unique id needs a boot marker — `next_id` restarts per launch. **Caps are independent, not narrowed** — an app cap under a global still breaches the global; two 402 codes.

**Tauri boundary** — A `#[tauri::command]` arg, a serde field and the Rust→webview `BridgeRequest` are **different boundaries**, and **a field on one side is not wiring**; only nested payloads hit serde → give every nested payload `deny_unknown_fields`. `shim.ts:toRustArgs` snake_cases top-level keys, and **every new command needs a `web-test/shim.ts` case the same day** → `REFERENCE.md`. A tool failure must never reach the model as `""` — guard at bridge *and* consumer.

**Data & migrations** — Migration = SQL/`DATA_MIGRATIONS` + bump `schema_version` + count assertion + table list; rewind tests delete `WHERE version >= N`. **Adding a column proves nothing about the writer** — trace TS router → `store.ts` → command → INSERT. **`ledger.key_id` is the *provider* credential (`api_keys.id`), not the gateway app key.** **`NULL` ≠ `0`** — "no cap" is `NULL`; two spellings of one state is the defect. `panic = "abort"` — no poison handling; a debounced save reads state when it **fires**. **`settings_set` is a whole-row UPSERT** (`commands.rs:197`) — known keys only erases the rest; `patchGatewaySettings` merges. Clamp from numbers/numeric strings only; **never pre-parse** (`Number("")` = `0` = *unlimited*). A cache needs an **authority**, not just a TTL.

**Tests & specs** — **vitest does not typecheck**: `expect(x,"msg").toBe(true)`, not `toBe(true,"msg")`; run the gate. `serde_json` sorts keys — assert by parsing, never substring. **Two fixes for one property mask each other** — select by content, not index. Parallel Rust tests: no `pid+timestamp` temp dir (same-ms → `DatabaseBusy`); use `AtomicUsize`. `__webTest.failNext(cmd,msg,afterMs?)`: an immediate failure can't test supersession; a negative assertion on an auto-dismissing surface **can never fail**. **A spec must not prove a round-trip by an input's value** — assert on the row re-read from the host. **An implicit default depends on the install** — `tsconfig.json` pins `"types":["node"]`. **A drift guard is not a behaviour guard** — an equality test over two representations stays green when the *wrong* one is used; **a cap is enforced where its function is *called*, not described**.

**Concurrency** — **A `&mut` parameter on shared state is a concurrency ceiling**: the borrow checker makes "two at once" unrepresentable — share via `Arc`+interior mutability (the `ProviderLimiter` shape). **A mechanism test passes while the request path passes a private copy** — pin the property end-to-end.

**UI** — Overlapping reads need a **generation counter** (StrictMode double-fires mounts). **Seed a draft field only when absent** (`prev[k.id] ?? …`) — re-seeding on refresh wipes the typing; the save then sends `0`. **A switch in two places drifts** — Control owns cross-cutting ones; move, don't mirror; accessible name must not change with state. `getByText` matching two elements = a **duplicated fact on screen**; a readiness wait must match only the awaited view. **A swallowed write is invisible to every reader** — one `writeTrail` helper, one channel **per trail**. **The repo is PUBLIC** — `pnpm key-leak-grep` is a gate step; fixtures synthetic.
