# Project memory — AI-Provider Router IDE

**Rules index, not narrative** — depth lives in `REFERENCE.md`. Injected up to **8,000 chars**; keep it under.

## Non-negotiables
- Verify every edit by reading it back — success messages have lied.
- Prove a spec fails before trusting it passes; falsify **one** probe at a time.
- Measure before recording a cause; a timing property needs an observable proxy.
- Unset all five proxy vars on probe *and* app — else `502 upstream connect failed`; a partial unset gives curl
  `000`, which reads like a crash.
- `./node_modules/.bin/tsc`, never `npx tsc`. JS tests: managed Node 22 first on PATH.
- Gate needs `PATH="$HOME/.cargo/bin:$PATH"` — else `FAILED (1): Rust (cargo missing)` though all else passes.
- **One edit per file per batch** — the second lands on a stale snapshot and clobbers the first; both report success.
- Absence claims: use the **Grep tool** (bash `grep` shim unreliable). A hit ≠ completeness — chase the doc comment.

## Orientation
- Playground = **Assistant** (`screens/Assistant.tsx`). **Skills are frontend-only**: bodies in SQLite `skills`
  (`store.rs:230`), expanded in `Assistant.tsx` (`:583`, `:702`). Gateway is a blind proxy for `system`.
- Live DB `~/Library/Application Support/dev.aiprovider.router/ai-provider-router.db`, `?mode=ro`. Version in
  `schema_version` (not `PRAGMA user_version`). `settings` = `key`/`value_json`.
- Tests: core 231 · vitest 193 · Rust `--lib` 433 · browser 98. Gate `pnpm ci:local`. `build:clean` moves `dist`
  aside — vite `emptyOutDir` trips the bulk-delete guard.
- Ports: gateway **8800** (`settings.gateway`); AI Hub v2 owns **8787**. `DEFAULT_PORT` (`gateway.rs:33`) is stale.
  Bundle: `/Applications/AI-Provider Router.app`.
- Identity is **two** strings, either may deny: `AIP-Agent` label and `key:<id>`. Request paths use
  `core.app_keys()`, never `AppKeyProvider` (memoised).

## Recall & scope
- **The two paths differ on exactly one axis: scope.** Gateway = `recall_scoped` + `RecallScope` (excludes
  `Unscoped`); Assistant = `recall(..., None)`. Live corpus **0 vs 14**. Both want L1/L2/L3; L0 denied on both.
- Every atom is born unscoped, so gateway recall returns 0 until a human binds it — `capture`'s INSERT
  (`memory.rs:290`) omits scope columns; `assign_scope` (`:741`) is the only way in. Drain must NOT auto-bind
  (`drain.test.ts:142`).
- **Session identity — FIXED 2026-09-22.** `session_context.rs` hashes `principal|user|project|agent` (was
  `user|project|agent`). Derive a session from identity, never from place. Detail: REFERENCE.md.
- Operator precedence (master switch → per-principal row) beats the client's `AIP-Memory` header. Denied =
  denied both ways.
- `memories.superseded_at` (0014): excluded from `recall_inner`/`session_atoms`/`stats.injectable`, **not**
  `list`. Superseding a pinned or L3 row is refused.

## Rules that each cost a bug
- **Reinstalling costs one keychain approval.** *Every* request (even unauthenticated) answers `503 master key
  unavailable` until approved — the master-key check precedes auth. `pgrep SecurityAgent` is the tell; **401**
  means healthy. The DMG step of `tauri build` always fails here (hdiutil); the `.app` is complete by then.
- **Never pin a local signing identity in `tauri.conf.json`.** A self-signed cert exists on one machine only,
  and `codesign` fails `no identity found` for everyone else. **CI does not run `tauri build`** (only
  typecheck/test/cargo/Playwright), so it cannot catch this. Default is ad-hoc, which runs locally; override
  with `APPLE_SIGNING_IDENTITY`.
- **Nothing is an image model unless a manifest says so.** Needs `endpoints.generateImage` +
  `modalityRules.image` (or `rawMatch`). Measured 455/455 `text`. An id containing "image" means nothing.
- **`memory_enabled` is in-memory only, off after restart** (`gateway.rs:842`). `Disabled` outranks `WriteOnly`,
  so post-reinstall `aip-memory: write` says `reason=disabled`. Check on the Memory screen, not HTTP.
- Probe headers are **lowercase** — `h.get("Retry-After")` is always `None`. Dump headers before claiming absence.
- **§3.5 concurrency is two semaphores.** `permits` (8+32) *admits*, `dispatch` (8) *routes*; the wait between is
  the queue.
- **Three different 429s — read the body.** `RATE_LIMITED` (upstream + key cooldown) vs "too many failed auth
  attempts" (30s backoff) vs "router at capacity".
- A live capacity probe **cannot** reach the gateway's gate on a real provider (20 concurrent → 4×200, 16×429).
- Never match nodes on label (80-char truncation); pass the identity a thing already has.
- A DB-lifetime-unique id must not come from a per-process counter (`next_id` restarts each launch). Ids carry a
  boot marker.
- **A `#[tauri::command]` arg and a serde field are different boundaries** — only nested payloads hit serde,
  which ignores unknown keys. Every nested payload gets `deny_unknown_fields`. `shim.ts:toRustArgs` renames
  top-level keys only.
- **Every new `#[tauri::command]` needs a `web-test/shim.ts` case the same day** — the shim throws on unknown
  commands, screens swallow it, the screen goes blank.
- **Overlapping reads need a generation counter** — StrictMode double-fires mount effects (vite dev,
  `main.tsx:7`). Only the newest may write.
- A tool failure must never reach the model as `""` — guard at bridge *and* consumer. Clear data on failure; a
  stale value under an error claims *now*.
- Migration = `MIGRATIONS`/`DATA_MIGRATIONS` + bump `schema_version` + count assertion + table-existence list.
  Rewind tests delete `WHERE version >= N`.
- `panic = "abort"` — no poison handling. A debounced save reads state when it **fires**, not when scheduled.
- Parallel Rust tests: no temp dir by `pid+timestamp` (same-ms → `DatabaseBusy`); use a monotonic `AtomicUsize`.
- **Two fixes for one property mask each other.** Test the inner function with adversarial input; select by
  content not index; don't assert collection length.
- **vitest does not typecheck.** `expect(x).toBe(true, "msg")` is invalid — use `expect(x, "msg").toBe(true)`.
  Run the gate, not just vitest.
- **`serde_json` writes keys sorted** (`{"index":0,"type":…}`). Assert JSON/SSE by parsing and comparing
  fields, never by raw substring — a substring test binds to key order and silently tests nothing.
- Bash `grep` on a redirected file returns empty (shim). Use the Grep tool, or `tail` the file.
- A cache needs an **authority**, not just a TTL — check mutation sites can reach it.
- Clamp from numbers/numeric strings only. **Never pre-parse before clamping** — `Number("")` is `0` = *unlimited*
  for the per-provider cap; pass the raw string.
- **`settings_set` is a whole-row UPSERT** (`commands.rs:197`): writing only known keys erases the rest.
  `patchGatewaySettings` merges and is spec'd against the **stored row**.
- **A switch rendered in two places drifts** — Control owns cross-cutting ones; move, don't mirror. (Memory
  master switch stays on Memory by decision.)
- A switch's accessible name must not change with state — `aria-checked` carries it; give state its own element.
- `getByText` matching two elements = a **duplicated fact on screen**, not a bad selector. Scope to the container.
- `__webTest.failNext(cmd, msg, afterMs?)` makes a UI `catch` reachable. **An immediate failure cannot test
  supersession** — defer with `afterMs`, then outlive it before asserting.
- A negative assertion on an auto-dismissing surface **can never fail**.
- **A swallowed write is invisible to every reader.** One `writeTrail` helper, one channel **per trail**; keep
  the swallow. **Four losses, four shapes** — depth: REFERENCE.md §Trail health.
- **The repo is PUBLIC** (2026-09-22). `pnpm key-leak-grep` is a gate step; fixtures synthetic only.
