# Project memory — AI-Provider Router IDE

**Index only. `REFERENCE.md` holds the depth — read its matching section first.**

## Non-negotiables
- Verify every edit by reading it back — success messages have lied.
- Prove a spec fails before trusting it passes (flip the code back).
- Measure before recording a cause. Never trust a diagnostic's own asserted cause.
- Unset `HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy` on probe *and* app, or every call returns
  `502 upstream connect failed`.
- Bash `grep` shim is unreliable even for plain patterns — use the Grep tool; verify a "not found".
- `./node_modules/.bin/tsc`, never `npx tsc`. Run JS tests with **managed Node 22** first on PATH.

## REFERENCE.md sections
Build / install / verify the installed app · **Code signing — why the keychain prompted on every build**
· Testing · Test counts · Browser harness (`web-test`) · Gateway behaviour · Error status propagation ·
Keychain (ACL + fix) · The ledger must not lie · Migrations · Live database · Context graph · Skills ·
orchestrator · memory engine · Gateway memory layer: request-path facts · Capture ids must be scoped to
the process · §10(2) distillation budget · Probing a running app from the sandbox · L0 recall: the two
paths disagree · Sandbox tool policy · Gateway tool audit trail · `pnpm ci:local` · CI is dead ·
Gotchas that each cost real time · Releasing / bumping the version

## Orientation
- Playground screen = **Assistant** (`assistant`, `screens/Assistant.tsx`). Gateway is a blind proxy
  for `system`; **skills are frontend-only**.
- Live DB `~/Library/Application Support/dev.aiprovider.router/ai-provider-router.db` — `file:…?mode=ro`;
  version in `schema_version`, not `PRAGMA user_version`.
- Tests: router-core 231 · desktop **170** (incl. 27 e2e) · Rust `cargo test --lib` **405** · browser
  **70 passing** (59 declarations — the screen sweep runs once per screen). Gate `pnpm ci:local`
  includes the browser.
- **`cargo` is not on PATH** — use `~/.cargo/bin/cargo`. CI has not run since ~2026-09-16 (billing).
- Per-principal identity is **two** strings, either may deny: the `AIP-Agent` label and `key:<id>` from
  the presented app key (`principal::allows(_, _, agent, app_key)`). `principal::list` offers `key:<id>`
  from active `gateway_keys` rows.
- `AppKeyProvider` returns `Vec<AppKey { id, secret }>` (was `Vec<String>`). Request paths must go
  through `core.app_keys()`, never the provider — it is memoised.
- `memories.superseded_at` (migration 0014, schema_version 14): set by `supersede`; excluded from
  `recall_inner`/`session_atoms`/`stats.injectable`, **not** from `list` (the UI shows and restores).
  Superseding a pinned or L3 row is refused (§6.4.5).
- Capture ids are `gw-{millis}-{pid}-{n}` (`capture::request_id`), **not** `gw-{n}` (see below). The
  client-visible completion id is still `gw-{n}` / `resp_gw_{n}` — different strings.

## Rules that each cost a bug
- Pass the identity a thing already has; a generated node id is a silent no-op for dedupe. Never match
  nodes on label (80-char truncation).
- **An id UNIQUE for the life of the DB must not come from a per-process counter.** `GatewayCore.next_id`
  restarts at 1 every launch while `memory_pending.request_id` is UNIQUE for 7 days, so after a restart
  the §3.5.5 idempotency guard read real captures as replays and dropped them silently
  (`Enqueue::Skipped(AlreadyQueued)` is a normal return — nothing logs). Ids now carry a boot marker.
  Measured live: 6 requests, the 3 whose ids pre-existed vanished.
- **An ad-hoc signed app's designated requirement is its cdhash, which changes every build**, so a
  keychain ACL anchored to it re-prompts forever. Sign with a stable identity
  (`bundle.macOS.signingIdentity`); the requirement becomes `identifier … and certificate leaf = H"…"`.
- `runAgentLoop` returns `{text, messages}` where `messages` EXCLUDES the closing assistant turn.
- A tool failure must never reach the model as `""` — guard at bridge *and* consumer.
- `invalid` is an eviction, not a label (`src/lib/keys/verdict.ts`).
- Migration = `MIGRATIONS`/`DATA_MIGRATIONS` + bump hardcoded `schema_version` + update the count
  assertion and the table-existence list. Rewind tests delete `WHERE version >= N`.
- Memory-path precedence: operator (master switch → per-principal row) beats the client's `AIP-Memory`
  header. A denied principal is denied in *both* directions — no injection, no capture.
- Nav = three edits: `ui-state.ts`, `Shell.tsx`, `App.tsx`.
- `panic = "abort"` — never write poison handling for `.lock().unwrap()`.
- A debounced save reads state when it **fires** (latest-ref), not when scheduled.
- Parallel Rust tests must not share a temp dir by `pid + timestamp` — two in the same millisecond hit
  `DatabaseBusy`. Use a monotonic `AtomicUsize`.
- Falsify one probe at a time. Two at once got 5/5 failures and attributed nothing.
- Two fixes for one property mask each other: an e2e test passes with either removed. Test the inner
  function directly with adversarial input, or you proved nothing.
- A test that passes with the fix removed is not evidence. Label it as pinning a property, or delete it.
- **vitest does not typecheck.** Green can still fail `tsc`; `expect(x).toBe(true, "msg")` is invalid
  (neither `toBe` nor `toHaveBeenCalledTimes` takes a message) — use `expect(x, "msg").toBe(true)`.
  Always run the gate, not just vitest.
- Never let "newer than" depend on two captures landing in different **milliseconds** — they usually land
  in the same one. Force the timestamps explicitly.
- **A cache needs an authority, not just a TTL.** Keying the app-key memo on the SQLite active-id set
  keeps revocation immediate; a clock-only validator broke a pre-existing contract test.
- **Check whether the mutation sites can reach the cache** before designing invalidation.
  `gateway_app_key_create/revoke/delete` take `State<Arc<Store>>` only — no core — so the design had to
  be self-maintaining.
- A timing property needs an observable proxy. "The scan does not short-circuit" is untestable by
  asserting a correct result (`find` passes); two candidates with the *same* secret make `find` and a
  full scan differ.
- Clamp user numbers from numbers/numeric strings only. Recover from stored data, never invent it.
- **Every new `#[tauri::command]` needs a case in `web-test/shim.ts`** the same day. The shim throws on
  unknown commands, screens wrap loads in `Promise.all(...).catch(() => undefined)`, and the result is a
  silently blank screen. `--skip-browser` hides it completely.
- **L0 is now denied on both recall paths** (fixed 2026-09-21). The gateway hardcoded `[L1,L2,L3]`
  (`context_scope.rs:593`); the Assistant's default pulled `["L1","L0"]` (`engine.ts:348`) and is now
  `["L1"]`. Nothing is lost — `replayHistory` already sends this session's turns verbatim, so L0 recall
  only duplicated them. **Still open:** the Assistant's recall is *unscoped* (`memory_recall` →
  `recall_inner(..., None)`) while the gateway passes a `RecallScope`. Never claim "L0 is never
  injected" of the *product* without checking this.
- **8787 is contested.** The router gateway (`gateway.rs:33`) and AI Hub v2's connector
  (`connector.js:154`, slides +10 on conflict) both want it. Moving the router is a UI action in the
  Gateway screen — `gateway_enable` also re-syncs WorkBuddy's endpoint, so no manual merge.
- **Testing a queue/claim cap live: plant the budget rows as `status='done'`** with a fresh `claimed_at`.
  `budget_left` reads only `claimed_at` so they count, but `claim()` selects `WHERE status='queued'` so
  they are never candidates — nothing fake gets distilled and no race with the drain tick. Planting them
  `queued` races the tick and proves nothing.
