# Project memory — AI-Provider Router IDE

**A rules index, not a narrative** — depth lives in `REFERENCE.md`. Every line is a rule that already cost a
bug. The host injects this file up to **8,000 chars** (hardcoded in `app.asar`).

## Non-negotiables
- Verify every edit by reading it back — success messages have lied.
- Prove a spec fails before trusting it passes. Falsify **one** probe at a time.
- Measure before recording a cause; never trust a diagnostic's own asserted cause. A timing property needs an
  observable proxy — a correct result proves nothing.
- Unset `HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy` on probe *and* app — else every call is `502 upstream
  connect failed` and the browser suite dies on webServer readiness.
- `./node_modules/.bin/tsc`, never `npx tsc`. JS tests: **managed Node 22** first on PATH.
- **Run the gate with `PATH="$HOME/.cargo/bin:$PATH"`** — without it it ends `FAILED (1): Rust (cargo
  missing)` while every other stage passes, which reads like a Rust failure and is not.
- **One edit per file per batch** — the second lands on a stale snapshot, clobbers the first, and both report
  success.
- **For an absence claim use the Grep tool** — the bash `grep` shim is unreliable. And a grep *hit* is not
  proof of completeness: a search for `generator_audit_record` returned only `store.ts` while `Onboarding.tsx`
  also called it. Chase the doc comment.

## Orientation
- Playground screen = **Assistant** (`screens/Assistant.tsx`); the gateway is a blind proxy for `system`.
  **Skills are consumed frontend-only** — bodies live in the SQLite `skills` table (`store.rs:230`), expanded
  only in `Assistant.tsx` (`:583`, `:702`).
- Live DB `~/Library/Application Support/dev.aiprovider.router/ai-provider-router.db`, `?mode=ro`. Version in
  `schema_version`, not `PRAGMA user_version`. `settings` is **`key`/`value_json`**.
- Tests: core 231 · vitest 193 · Rust `--lib` 433 · browser 98 (87 declarations). Gate `pnpm ci:local`; the
  build moves `dist` aside itself (`build:clean`) — vite's `emptyOutDir` trips the bulk-delete guard.
- Ports: gateway **8800** (`settings.gateway`); AI Hub v2 owns **8787**. `DEFAULT_PORT` (`gateway.rs:33`) is
  still 8787 — the live value is the setting.
- Identity is **two** strings, either may deny: the `AIP-Agent` label and `key:<id>` from the app key. Request
  paths use `core.app_keys()`, never `AppKeyProvider` (memoised).

## Recall & scope
- **The two paths differ on exactly one axis: scope.** Gateway = `recall_scoped` + `RecallScope` (excludes
  every `Unscoped` row); Assistant = `recall(..., None)` → no predicate. Live corpus **0 vs 14**. Both want
  L1/L2/L3; L0 is denied on both.
- **Every atom is born unscoped, so gateway recall returns 0 until a human binds it** — `capture`'s INSERT
  (`memory.rs:290`) omits the scope columns and `assign_scope` (`:741`) is the only way in; the drain must NOT
  auto-bind (`drain.test.ts:142`). Loosening the predicate would destroy the contamination guarantee
  (`store.rs:664-668`). Not a bug.
- Operator precedence (master switch → per-principal row) beats the client's `AIP-Memory` header. A denied
  principal is denied in *both* directions — no injection, no capture.
- `memories.superseded_at` (0014, v14): excluded from `recall_inner`, `session_atoms` and `stats.injectable`,
  **not** from `list`. Superseding a pinned or L3 row is refused.

## Rules that each cost a bug
- Never match nodes on label (80-char truncation); pass the identity a thing already has.
- **An id unique for the life of the DB must not come from a per-process counter** — `next_id` restarts at 1
  each launch. Ids carry a boot marker.
- **A `#[tauri::command]` arg and a serde field are different boundaries** — only a nested payload hits serde,
  and serde *ignores* unknown keys. Every nested payload gets `deny_unknown_fields`; that, not `rename_all`,
  makes a mismatch a hard error. `shim.ts:toRustArgs` renames top-level keys only.
- **Every new `#[tauri::command]` needs a `web-test/shim.ts` case the same day** — the shim throws on unknown
  commands, screens swallow it, and the screen goes silently blank. A test double mirrors the host's
  **strictness**, not just its happy path.
- **Overlapping reads need a generation counter** — StrictMode fires mount effects twice (harness runs vite
  **dev**, `main.tsx:7`), so an older read can reject while a newer resolves. Only the newest may write.
- A tool failure must never reach the model as `""` — guard at bridge *and* consumer. And **a stale value
  under an error is a claim about *now*** — clear the data on failure and show the error alone.
- Migration = `MIGRATIONS`/`DATA_MIGRATIONS` + bump `schema_version` + the count assertion + the
  table-existence list. Rewind tests delete `WHERE version >= N`.
- `panic = "abort"` — no poison handling for `.lock().unwrap()`. A debounced save reads state when it
  **fires**, not when scheduled.
- Parallel Rust tests must not share a temp dir by `pid + timestamp` — same-millisecond runs hit
  `DatabaseBusy`. Use a monotonic `AtomicUsize`.
- **Two fixes for one property mask each other; one bug must not fail several tests.** Test the inner function
  with adversarial input, select what is under test by content not index, and don't assert the collection's
  length.
- **vitest does not typecheck.** `expect(x).toBe(true, "msg")` is invalid — use `expect(x, "msg").toBe(true)`.
  Run the gate, not just vitest.
- A cache needs an **authority**, not just a TTL — and check the mutation sites can reach it.
- Clamp from numbers/numeric strings only. **Never pre-parse before clamping** — `Number("")` is `0`, and for
  the per-provider cap `0` means *unlimited*; hand `clampConcurrency` the raw string.
- **The `gateway` settings row is one JSON object and `settings_set` is a whole-row UPSERT**
  (`commands.rs:197`): a writer serialising only the keys it knows erases the rest silently.
  `patchGatewaySettings` merges, never replaces, and is spec'd against the **stored row**.
- **A switch rendered in two places will drift** — Control owns the cross-cutting ones; move, don't mirror. A
  *read* of the host's own report is not a mirror. By decision the memory master switch stays on Memory,
  beside the notice about what it sends off this machine.
- **A switch's accessible name must not change with its state** — `aria-checked` carries the state. Give the
  state its own element (`SwitchRow`'s `state` prop).
- When a browser spec's `getByText` resolves to two elements, suspect a **duplicated fact on the screen**
  before touching the selector — and scope to the container: a legend that *names* a state satisfies an
  unscoped assertion about that state.
- The harness can fail any command once: `__webTest.failNext(cmd, message, afterMs?)`. Without it a UI `catch`
  branch is unreachable, so "the read failed" and "the read answered with nothing" render identically. **An
  immediate failure cannot test supersession** — it rejects in a microtask, landing before a later read
  resolves, whose success wipes it. Defer with `afterMs` so the superseded read lands last, and outlive it
  before asserting — `toHaveCount(0)` passes instantly.
- **A negative assertion on an auto-dismissing surface can never fail** — it waits for it to go.
- **A swallowed write is invisible to every reader of its table.** Where a card claims completeness, report it
  — one `writeTrail` helper, one channel scoped **per trail** (a global counter makes both cards wrong) — and
  keep the swallow: the work happened.
- **Four losses, four shapes** (depth: REFERENCE.md §Trail health). Lost *row* → count it. Lost *ending* → keep
  the observed value per id (`unrecordedEnd`), not a count. Lost *start* → count the run **once**, since its
  step appends fail for the same cause. Stranded *state* → register the failure **before** anything can fail.
