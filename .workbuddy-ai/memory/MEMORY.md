# Project memory — AI-Provider Router IDE

**Rules index, not narrative** — depth in `REFERENCE.md` (not injected). **Cap 8,000 chars; past that injection truncates mid-rule.**

## Non-negotiables
- A tool result is not evidence. **A `Write` or `Edit` can report success while the file keeps its old bytes *and* mtime** — and `Read` then serves the *unwritten* text, so reading it back agrees with the lie. Verify edits with `stat` mtime + the **Grep tool** (host FS); bash reads the host correctly. Retry until the mtime moves.
- Falsify **one** probe at a time; measure before recording a cause. **A reason is a claim too** — "cannot be tested" needs the same evidence as "is not tested"; extract the pure part (house pattern) before declaring a default unpinnable.
- Unset **all six** proxy vars on probe *and* app — else `502`; partial → curl `000` (reads as a crash). **A proxy `502` also satisfies a "status != 000" readiness loop**, so the loop exits instantly and every probe after it measures the proxy. Violated 2026-09-22; the reading looked like a vite response.
- `./node_modules/.bin/tsc`, never `npx tsc`. JS tests: managed Node 22 first on PATH. Gate needs `PATH="$HOME/.cargo/bin:$PATH"`.
- **One edit per file per batch** — the 2nd lands on a stale snapshot and clobbers the 1st; both report success.
- Absence claims: **Grep tool** (bash `grep` shim lies) — **skips dot-dirs** (`.github/`, `.workbuddy-ai/` → `cat <dir>/* | grep`). A hit ≠ completeness. Count via node one-liner (`find … | grep -c` → `0`). **`cargo fmt --check` colours its output even when redirected** — every diff line starts `\e[32m+`, so `^[-+]` counting returns **0** and reads as "no changes"; pass `-- --color=never`. Churn is config-dependent: stock **638 hunks / 42% of the host**, `use_small_heuristics="Max"` **354 / 30%**.
- **The bulk-delete guard is sandbox-only and camouflaged.** A Playwright `webServer` timeout is a guard symptom: vite removes `node_modules/.vite/deps` at startup, the guard refuses, vite exits 1, and only the 60s timeout surfaces. Clean it in `web-test:clean`, which must run *after* `pnpm build` — the build recreates that cache. `DEBUG=pw:webserver` separates `ECONNREFUSED` (nothing listening) from a non-2xx answer (a different bug).

## Where things are
- Docs in `docs/`; `ARCHITECTURE.md` is a *spec*, not the app. `dev-book/` = rules/contracts + `07-drift-register.md` (10/10 closed). Old logs cite bare filenames → resolve under `docs/`. `pnpm docs:book` → `book.html`; `check-doc-links` is a gate step. Counts + gate steps: `dev-book/09-status.md` / `05-workflow.md`.
- Playground = **Assistant** (`screens/Assistant.tsx`); skills are frontend-only (SQLite `skills`, `store.rs:230`), gateway blind to them.
- DB `~/Library/Application Support/dev.aiprovider.router/ai-provider-router.db` (`?mode=ro`); version in `schema_version`, not `PRAGMA user_version`.
- Ports: gateway **8800**; AI Hub v2 owns **8787**; `DEFAULT_PORT` stale.
- Identity = **two** strings, either may deny: `AIP-Agent`, `key:<id>`. Use `core.app_keys()`, never `AppKeyProvider`.
- **Clippy is a gate** (`--all-targets -- -D warnings`); triage by lint *kind* — count ≠ signal (64 → 2 real). **Snapshot before `--fix`**: it *moves* code.

## Recall & scope
- Paths differ on **one axis: scope** — gateway `recall_scoped`+`RecallScope` (excludes `Unscoped`) vs Assistant `recall(..., None)`. Corpus **0 vs 14**; L0 denied both.
- Atoms are born unscoped → gateway recall 0 until a human binds: `capture` INSERT (`memory.rs:290`) omits scope; `assign_scope` (`:741`) is the only way in. Drain must NOT auto-bind.
- Session identity **fixed 2026-09-22**: hashes `principal|user|project|agent`. Derive a session from identity, never from place.
- Master switch → per-principal row beats the client's `AIP-Memory` header. `superseded_at` (0014) hides rows from recall/session/injectable, **not** `list`.

## Rules that cost a bug

**Auth / install** — **Reinstalling costs one keychain approval**; until granted *every* request answers `503 master key unavailable` (that check precedes auth); **401** = healthy. **Never pin a signing identity in `tauri.conf.json`** — CI cannot catch it (no `tauri build`); build to verify. **`memory_enabled` is in-memory only**, off after restart, `Disabled` outranks `WriteOnly` — check the Memory screen, not HTTP.

**Gateway** — Nothing is an image model unless a manifest says so (`endpoints.generateImage` + `modalityRules.image`); measured 455/455 `text`. §3.5 = **two semaphores**: `permits` (8+32) *admits*, `dispatch` (8) *routes*. **Three different 429s — read the body**; a live capacity probe cannot reach the gate. Probe headers are **lowercase** (`h.get("Retry-After")` → `None`) — dump before claiming absence. Client-facing `Retry-After` = the **shortest** named wait. Never match nodes on label (80-char truncation). A DB-lifetime-unique id needs a boot marker — `next_id` restarts each launch.

**Tauri boundary** — A `#[tauri::command]` arg and a serde field are **different boundaries**; only nested payloads hit serde (ignores unknown keys) → give every nested payload `deny_unknown_fields`; `shim.ts:toRustArgs` renames top-level keys only. **Every new command needs a `web-test/shim.ts` case the same day** — the shim throws, screens swallow it, the screen goes blank. A tool failure must never reach the model as `""` — guard at bridge *and* consumer, and clear stale data on failure.

**Data & migrations** — Migration = `MIGRATIONS`/`DATA_MIGRATIONS` + bump `schema_version` + count assertion + table list; rewind tests delete `WHERE version >= N`. **Adding a column proves nothing about the writer** — trace TS router → `store.ts` → command → INSERT (0015: 1530 rows `NULL` ≠ "reported 0"). `panic = "abort"` — no poison handling; a debounced save reads state when it **fires**. **`settings_set` is a whole-row UPSERT** (`commands.rs:197`) — known keys only erases the rest; `patchGatewaySettings` merges. Clamp from numbers/numeric strings only; **never pre-parse** (`Number("")` = `0` = *unlimited*). A cache needs an **authority**, not just a TTL.

**Tests & specs** — **vitest does not typecheck**: `expect(x).toBe(true,"msg")` is invalid → `expect(x,"msg").toBe(true)`; run the gate. `serde_json` sorts keys — assert by parsing, never substring. **Two fixes for one property mask each other** — adversarial input, select by content not index. Parallel Rust tests: no `pid+timestamp` temp dir (same-ms → `DatabaseBusy`); use `AtomicUsize`. `__webTest.failNext(cmd,msg,afterMs?)`: an immediate failure cannot test supersession; a negative assertion on an auto-dismissing surface **can never fail**. **An implicit default is a dependency on the install, not the code**: tsc enumerates the tree at runtime when `types`/`typeRoots` are unset, so the vitest 3.2.7 → 4.1.11 bump dropped `@types/node` silently (`--listFilesOnly`: 409 files/83 `@types` → 238/0) with the package present, complete and symlinked — `apps/desktop/tsconfig.json` now states `"types": ["node"]`. **A `webServer` timeout is not a port problem** — that diagnosis was never established and is superseded by the guard rule above.

**UI** — Overlapping reads need a **generation counter** (StrictMode double-fires mounts, `main.tsx:7`). **A switch in two places drifts** — Control owns cross-cutting ones; move, don't mirror (Memory master switch stays on Memory); accessible name must not change with state (`aria-checked` carries it). `getByText` matching two elements = a **duplicated fact on screen**; a readiness wait must match only the awaited view. **A swallowed write is invisible to every reader** — one `writeTrail` helper, one channel **per trail**. **The repo is PUBLIC** — `pnpm key-leak-grep` is a gate step; fixtures synthetic only.
