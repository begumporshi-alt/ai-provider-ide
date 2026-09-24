# Project memory — AI-Provider Router IDE

**Rules index** — depth in `REFERENCE.md`. **Cap 8,000 B; past it truncates mid-rule.**

## Non-negotiables
- A tool result is not evidence. **A `Write`/`Edit` can report success while the file keeps its old bytes *and* mtime** — `Read` serves the *unwritten* text. Verify by `stat` mtime + **Grep tool**, retrying until it moves.
- Falsify **one** probe at a time; measure before recording a cause. **A reason is a claim too** — "cannot be tested" needs the same evidence as "is not tested". **Re-snapshot after every accepted change** — a probe reverted from a stale snapshot deletes the fix.
- Unset **all six** proxy vars on probe *and* app — else `502`; partial → curl `000` (reads as a crash). **A proxy `502` satisfies a "status != 000" readiness loop** — it exits instantly; later probes measure it.
- `./node_modules/.bin/tsc`, never `npx tsc`. JS tests: managed Node 22 first on PATH. Gate needs `PATH="$HOME/.cargo/bin:$PATH"`. **Shell is bash 3.2 here** — no `mapfile`. Commit msgs via `-F <file>` — backticks in a quoted `-m` are substitution and vanish.
- **One edit per file per batch** — the 2nd lands on a stale snapshot and clobbers the 1st; both report success.
- Absence claims: **Grep tool** (bash `grep` shim lies) — **skips dot-dirs** (`.github/`, `.workbuddy-ai/` → `cat <dir>/* | grep`). A hit ≠ completeness; count via node, not `find | grep -c` (→ `0`). **`cargo fmt --check` colours even redirected** — counting `^[-+]` → **0** = "no changes"; pass `-- --color=never`.
- **The bulk-delete guard is sandbox-only.** A Playwright `webServer` timeout is a guard symptom **or a proxy `502`** (vite removes `node_modules/.vite/deps`; the guard refuses; only the 60s timeout surfaces). Clean in `web-test:clean`, *after* `pnpm build`. `DEBUG=pw:webserver` separates `ECONNREFUSED` from a non-2xx. **`npm`'s prune hits it too** — test with `-L`, not `-e`.

## Where things are
- `ARCHITECTURE.md` is a *spec*, not the app. `dev-book/` = rules/contracts + drift register. `pnpm docs:book` → `book.html`; `check-doc-links` is a gate step. Counts/gates: `dev-book/09-status.md`, `05-workflow.md`.
- Playground = **Assistant** (`screens/Assistant.tsx`); skills are frontend-only (SQLite `skills`, `store.rs:230`), gateway blind to them.
- DB `~/Library/Application Support/dev.aiprovider.router/ai-provider-router.db` (`?mode=ro`); version in `schema_version`, not `PRAGMA user_version`.
- Ports: gateway **8800**; AI Hub v2 **8787**; `DEFAULT_PORT` stale.
- Identity = **two** strings, either may deny: `AIP-Agent`, `key:<id>`. Use `core.app_keys()`, never `AppKeyProvider`.
- **Clippy and rustfmt are gates** (`--all-targets -- -D warnings`; `cargo fmt --check`); triage clippy by lint *kind* — count ≠ signal (64 → 2 real). **Snapshot before `--fix`**: it *moves* code. **A `-D warnings` gate on floating `stable` goes red with no code change** — `rustup update stable` before believing the code.

## Recall & scope
- Paths differ on **one axis: scope** — gateway `recall_scoped`+`RecallScope` (excludes `Unscoped`) vs Assistant `recall(..., None)`. Corpus **0 vs 14**; L0 denied both.
- Atoms are born unscoped → gateway recall 0 until a human binds: `capture` INSERT (`memory.rs:290`) omits scope; `assign_scope` (`:741`) is the only way in. Drain must NOT auto-bind.
- Session identity **fixed 2026-09-22**: hashes `principal|user|project|agent`; derive from identity, never from place.
- Master switch → per-principal row beats the client's `AIP-Memory` header. `superseded_at` (0014) hides rows from recall/session/injectable, **not** `list`.

## Rules that cost a bug

**Auth / install** — **Reinstalling costs one keychain approval**; until granted *every* request answers `503 master key unavailable` (precedes auth); **401** = healthy. **Never pin a signing identity in `tauri.conf.json`** — CI cannot catch it (no `tauri build`); build to verify. **`memory_enabled` is in-memory only**, off after restart, `Disabled` outranks `WriteOnly` — check the Memory screen, not HTTP.

**Gateway** — Nothing is an image model unless a manifest says so (`endpoints.generateImage` + `modalityRules.image`); 455/455 `text`. §3.5 = **two semaphores**: `permits` (8+32) *admits*, `dispatch` (8) *routes*. **Three different 429s — read the body**; a live capacity probe cannot reach the gate. Probe headers are **lowercase** (`h.get("Retry-After")` → `None`) — dump before claiming absence; client-facing `Retry-After` = the **shortest** wait. Never match nodes on label (80-char truncation). A DB-lifetime-unique id needs a boot marker — `next_id` restarts each launch. **Caps are independent, not narrowed** — an app cap under a global still breaches the global; two 402 codes.

**Tauri boundary** — A `#[tauri::command]` arg, a serde field and the Rust→webview `BridgeRequest` are **different boundaries**, and **a field on one side is not wiring**; only nested payloads hit serde (ignores unknown keys) → give every nested payload `deny_unknown_fields`; `shim.ts:toRustArgs` renames top-level keys to snake_case — a case reading `args.capMicros` gets `undefined` and silently no-ops. **Every new command needs a `web-test/shim.ts` case the same day** — the shim throws, screens swallow it, the screen goes blank. A tool failure must never reach the model as `""` — guard at bridge *and* consumer, and clear stale data on failure.

**Data & migrations** — Migration = SQL/`DATA_MIGRATIONS` + bump `schema_version` + count assertion + table list; rewind tests delete `WHERE version >= N`. **Adding a column proves nothing about the writer** — trace TS router → `store.ts` → command → INSERT (0015: `NULL` ≠ "reported 0"). **`ledger.key_id` is the *provider* credential (`api_keys.id`), not the gateway app key** — **0** gateway rows join `gateway_keys`; 0016 adds `ledger.app_key_id`. **`NULL` ≠ `0`** — "no cap" is `NULL`; two spellings of one state is the defect. `panic = "abort"` — no poison handling; a debounced save reads state when it **fires**. **`settings_set` is a whole-row UPSERT** (`commands.rs:197`) — known keys only erases the rest; `patchGatewaySettings` merges. Clamp from numbers/numeric strings only; **never pre-parse** (`Number("")` = `0` = *unlimited*). A cache needs an **authority**, not just a TTL.

**Tests & specs** — **vitest does not typecheck**: `expect(x).toBe(true,"msg")` is invalid → `expect(x,"msg").toBe(true)`; run the gate. `serde_json` sorts keys — assert by parsing, never substring. **Two fixes for one property mask each other** — adversarial input, select by content not index. Parallel Rust tests: no `pid+timestamp` temp dir (same-ms → `DatabaseBusy`); use `AtomicUsize`. `__webTest.failNext(cmd,msg,afterMs?)`: an immediate failure can't test supersession; a negative assertion on an auto-dismissing surface **can never fail**. **A spec must not prove a round-trip by an input's value** — assert on the row re-read from the host. **An implicit default depends on the install, not the code** — a vitest bump dropped `@types/node` silently; `tsconfig.json` now states `"types":["node"]`.

**UI** — Overlapping reads need a **generation counter** (StrictMode double-fires mounts, `main.tsx:7`). **Seed a draft field only when absent** (`prev[k.id] ?? …`) — re-seeding on refresh wipes the typing; the save then sends `0`. **A switch in two places drifts** — Control owns cross-cutting ones; move, don't mirror; accessible name must not change with state (`aria-checked` carries it). `getByText` matching two elements = a **duplicated fact on screen**; a readiness wait must match only the awaited view. **A swallowed write is invisible to every reader** — one `writeTrail` helper, one channel **per trail**. **The repo is PUBLIC** — `pnpm key-leak-grep` is a gate step; fixtures synthetic. Gateway+assistant both hit `generateText` — cross-cutting rules there.
