# Project memory — AI-Provider Router IDE

**Index only. `REFERENCE.md` here holds the depth — read the matching section first.**

## Non-negotiables
- Verify every edit by reading it back — success messages have lied.
- Prove a spec fails before trusting it passes (flip the code back).
- Measure before recording a cause.
- Never trust a diagnostic message's own asserted cause.
- Sandbox proxy lies: unset `HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy` on probe *and* app,
  or every call returns `502 upstream connect failed`.
- Bash `grep` shim is unreliable even for plain patterns — use the Grep tool; verify a "not found".
- Use `./node_modules/.bin/tsc`, never `npx tsc`.
- Run JS tests with **managed Node 22** first on PATH.

## Where the depth lives (REFERENCE.md)
| Topic | Section |
|---|---|
| Build / install / verify installed app | Build / install / verify the installed app |
| Code signing, keychain prompts | Code signing — why the keychain prompted on every single build |
| Testing, counts, vitest include globs | Testing · Test counts |
| Browser harness (`web-test`) | Browser harness |
| Gateway behaviour, error status, keychain | Gateway behaviour · Error status propagation · Keychain |
| Ledger honesty | The ledger must not lie |
| Migrations, live DB | Migrations · Live database |
| Context graph rules | Context graph |
| Gateway memory/context layer (proposed) | Gateway memory layer: request-path facts |
| Capture ids, distillation budget | Capture ids must be scoped to the process · §10(2) distillation budget |
| Probing a running app from the sandbox | Probing a running app from the sandbox |
| L0 recall — the two paths disagree | L0 recall: the two paths disagree |
| Skills / orchestrator / memory | Skills · orchestrator · memory engine |
| Sandbox tool policy + audit trail | Sandbox tool policy · Gateway tool audit trail |
| Gate, and why CI is dead | `pnpm ci:local` · CI is dead |
| e2e LIVE, `pnpm install` destructive | Gotchas that each cost real time |
| `vite build` blocked by safe-delete shim | Gotchas that each cost real time |
| Version bump, tag, push | Releasing / bumping the version |

## Quick orientation
- Playground screen = **Assistant** (`assistant`, `screens/Assistant.tsx`).
- Gateway is a blind proxy for `system`; **skills are frontend-only** (`Assistant.tsx`).
- Live DB `~/Library/Application Support/dev.aiprovider.router/ai-provider-router.db` —
  `file:…?mode=ro`; version in `schema_version`, not `PRAGMA user_version`.
- Tests: router-core 231 · desktop 169 (incl. 27 e2e) · Rust `cargo test --lib` **405** · browser
  **70 passing** (59 declarations — the screen sweep runs once per screen). Gate is `pnpm ci:local`
  (browser included by default).
- Per-principal identity is now **two** strings, either may deny: the `AIP-Agent` label and
  `key:<id>` from the presented app key (`principal::allows(_, _, agent, app_key)`). Principals
  named `key:<id>` are offered by `principal::list` from active `gateway_keys` rows.
- `AppKeyProvider` returns `Vec<AppKey { id, secret }>` (was `Vec<String>`). Request paths must go
  through `core.app_keys()`, never the provider directly — it is memoised (see REFERENCE.md).
- `memories.superseded_at` (migration 0014, schema_version 14): set by `supersede`, excluded from
  `recall_inner`/`session_atoms`/`stats.injectable`, **not** excluded from `list` (the UI shows and
  restores). Superseding a pinned or L3 row is refused by policy (§6.4.5).
- Capture ids are `gw-{millis}-{pid}-{n}` (`capture::request_id`), **not** `gw-{n}`. The bare form
  collided across restarts against a DB-lifetime UNIQUE constraint and silently dropped captures.
  The client-visible completion id is still `gw-{n}` / `resp_gw_{n}` — different strings, don't
  conflate them.
- **`cargo` is not on PATH** — use `~/.cargo/bin/cargo` (and unset the proxies or it stalls).
- Gate is `pnpm ci:local`. CI has not started a job since ~2026-09-16 (billing, not code).

## Rules that each cost a bug
- Pass the identity a thing already has; a generated node id is a silent no-op for dedupe. Never
  match nodes on label (80-char truncation).
- **An id that is UNIQUE for the life of the DB must not come from a counter that restarts per
  process.** `GatewayCore.next_id` starts at 1 every launch; `memory_pending.request_id` is UNIQUE
  for 7 days — so after a restart the §3.5.5 idempotency guard read real captures as replays and
  dropped them, silently. Scope ids with a boot marker (`millis-pid`). Measured live: 6 requests,
  the 3 whose ids already existed vanished. Depth: REFERENCE.md §Capture ids.
- **An ad-hoc signed app's designated requirement is its cdhash, which changes every build** — so any
  keychain ACL anchored to it breaks on every rebuild and re-prompts. That was the "keychain password
  every time" complaint. Sign with a stable identity instead
  (`bundle.macOS.signingIdentity = "AI-Provider IDE Dev Signing"`); the requirement becomes
  `identifier … and certificate leaf = H"9e56e7cc…"` and survives rebuilds. Depth: REFERENCE.md
  §Code signing.
- `runAgentLoop` returns `{text, messages}` where `messages` EXCLUDES the closing assistant turn.
- A tool failure must never reach the model as `""` — guard at bridge *and* consumer.
- `invalid` is an eviction, not a label (`src/lib/keys/verdict.ts`).
- Migration = `MIGRATIONS`/`DATA_MIGRATIONS` + bump hardcoded `schema_version` + update the count
  assertion and the table-existence list. Rewind tests delete `WHERE version >= N`.
- Precedence on the memory path: operator (master switch → per-principal row) beats the client's
  `AIP-Memory` header. A denied principal is denied in *both* directions — no injection, no capture.
- Nav = three edits: `ui-state.ts`, `Shell.tsx`, `App.tsx`.
- `panic = "abort"` — never write poison handling for `.lock().unwrap()`.
- A debounced save reads state when it **fires** (latest-ref), not when scheduled.
- Parallel Rust tests must not share a temp dir by `pid + timestamp` — two opening in the same
  millisecond hit `DatabaseBusy`. Use a monotonic `AtomicUsize` counter.
- Falsify one probe at a time. Running two at once got 5/5 failures and attributed nothing.
- Two fixes for the same property mask each other: an end-to-end test passes with either one
  removed. Test the inner function directly (drive it with adversarial input) or you proved nothing.
  Cost a wasted probe on §5.5 — the SQL `ORDER BY` fix alone satisfied the e2e ordering test.
- A test that passes with the fix removed is not evidence. Label it as pinning a property, or delete
  it — don't leave it implying coverage it does not have.
- **vitest does not typecheck.** A test can run green and still fail `tsc`. Notably
  `expect(x).toBe(true, "msg")` / `toHaveBeenCalledTimes(2, "msg")` — neither takes a message; use
  `expect(x, "msg").toBe(true)`. Always run the gate, not just vitest.
- Never let "newer than" depend on two captures landing in different **milliseconds** — they usually
  land in the same one. A test that passed alone and failed in the full suite cost a gate run; force
  the timestamps explicitly.
- **A cache needs an authority, not just a TTL.** Keying the app-key memo on the SQLite active-id
  set (not time) is what keeps revocation immediate; keying it on time alone broke a *pre-existing*
  contract test. If the only validator is a clock, don't cache it.
- **Check whether the mutation sites can even reach the cache** before designing invalidation.
  `gateway_app_key_create/revoke/delete` take `State<Arc<Store>>` only — no core — so explicit
  invalidation was impossible and the design had to be self-maintaining.
- A timing property needs an observable proxy to be asserted. "The scan does not short-circuit" is
  untestable by asserting a correct result (`find` passes); giving two candidates the *same* secret
  makes `find` and a full scan answer differently.
- Clamp user numbers from numbers/numeric strings only.
- Recover from stored data, never invent it.
- **Every new `#[tauri::command]` needs a case in `web-test/shim.ts`** on the same day. The shim
  throws on unknown commands, screens wrap loads in `Promise.all(...).catch(() => undefined)`, and
  the result is a silently blank screen, not an error. `--skip-browser` hides this completely.
- **There are two recall paths and they disagree on L0.** Gateway: `context_scope.rs:593` hardcodes
  `[L1,L2,L3]` — never L0. Assistant: `Assistant.tsx:693,770` call `recallContext(text)` with no
  `layers`, so `engine.ts`'s default branch pulls `["L1","L0"]` with no session filter. Never claim
  "L0 is never injected" of the product — only of the gateway layer. Depth: REFERENCE.md §L0 recall.
- **Testing a queue/claim cap live: plant the budget-consuming rows as `status='done'`** with a fresh
  `claimed_at`. `budget_left` reads only `claimed_at`, so they count against the cap — but `claim()`
  selects `WHERE status='queued'`, so they are never candidates: nothing fake gets distilled and
  there is no race with the drain tick. Planting them `queued` races the tick and proves nothing
  (cost a wasted probe on §10(2)).
