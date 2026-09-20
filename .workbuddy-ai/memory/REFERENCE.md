# Project memory — AI-Provider Router IDE

## WorkBuddy integration
- **Live config: `~/.workbuddy-ai/models.json`** (top-level JSON **list**); hot-reloads in ~1s.
  `~/.codebuddy/models.json` (`{"models":[…]}`) is referenced in `app.asar` but not read — entries
  added there are dead weight.
- Endpoint `http://127.0.0.1:8787/v1/chat/completions`; master key in the keychain, service
  `ai-provider-router`, account `masterkey`.
- Entry shape: `{"id":"openai/gpt-4o-mini","name":"ai-provider router","vendor":"Custom","url":…,
  "apiKey":"<master key>","supportsToolCall":true,"supportsImages":false,"supportsReasoning":false,
  "useCustomProtocol":false}` + `maxInputTokens`/`maxOutputTokens` (128000/16384) to avoid
  default-cap truncation. Bare and `openrouter/`-prefixed ids both route.
- **The display name marks provenance — do not rename it away.** "ai-provider router" tells Tushu at
  a glance which models come from our gateway. The sync adds a suffix only when a preserved name
  would collide; prefer the marker as a prefix.
- **Sync used to skip on the first launch after a rebuild (fixed 2026-09-19).** It raced the startup
  probe: macOS re-validates the keychain ACL per code signature and two concurrent reads contend for
  one prompt. The sync lost because it *retrieves* the secret while the probe only checks
  *existence*; symptom is `workbuddy sync skipped: no gateway key yet` in the same second as
  `startup: key refs probed`. Fixed by moving it off `gateway_enable`'s thread and retrying while the
  keychain settles (45s ceiling, 3s polls), on one error held as `workbuddy::NO_KEY_YET`. **Do not**
  reorder the sync after the probe — that publishes entries before the listener is up.

## Gateway behaviour
- `/v1/models` advertises **only provider-qualified ids** (`<slug>/<native>`), 457 of them, zero bare.
  Bare ids still route but are not advertised.
- A client supplying its own tools gets **pass-through**; the sandbox tool set engages only when the
  client declares none.
- The gateway worker calls `bootstrap()` and **never** `refreshCatalog` — anything it needs from the
  catalog (pricing, modality) must come from persisted `models_cache` rows.
- Auto-restores from `settings.gateway = {"port":8787,"enabled":true}`, ~20s. Only `gateway_enable`
  logs `enabled on port N`; the failure path uses `tracing`, which a release GUI build discards, so a
  failed restore is *invisible* in `gateway.log`.
- **A hidden worker's heartbeat stops after ~484s idle and does not wake on its own** — measured:
  healthy windows pin at 484–486s, every window >500s contains a re-compositing `gateway_enable`,
  recovery follows a re-composite within 20–50ms (38/38), and load prevents it entirely (25,367
  requests at ~28/s over 900s, zero lapses). It is *idleness*, not hiddenness.
  **Reading the code:** a stale beat means "asleep", not "broken". `is_available()` = intent ∧ beat;
  `gateway_status.running` is intent only; `worker_awake` is the beat. `await_core` revives a sleeper
  (≤5s), which is why the watchdog only logs. Do not raise `HEARTBEAT_STALE_HIDDEN_MS` — it is a
  detector, and an unbounded one makes a dead worker look alive forever.
- The comment that justified `HEARTBEAT_STALE_HIDDEN_MS = 30_000` was wrong — that bound is tripped
  on every idle period. When a constant's rationale is a measurement, re-measure before trusting it.
- **Agnes's catalog lies about modality**: `agnes-image-*`/`agnes-video-*` publish
  `modality='text'`, so `workbuddy.rs` falls back to the model id. Same reason Agnes image models
  publish `supportsImages: false` (known cosmetic wrongness).
- Chat-templated upstreams leak `<|im_end|>`/`<|endoftext|>`; `gateway::clean_assistant_text` strips
  them from non-stream replies, streaming is best-effort.

## Error status propagation (fixed 2026-09-20)
The worker decides the failure status once, in `gatewayStatus()` (`src/lib/gateway-bridge.ts`). It reads
`AllAttemptsFailedError.chain` — each attempt carries the upstream's own status — and applies a deliberate
whitelist: pass through client-attributable codes (400/404/413/422/429), map a missing route to 404,
everything else to 502. A `401`/`403` from an upstream is *our* stored key, never the client's, so it must
not be echoed.

**The Rust edge used to re-decide that with a second, narrower list, and threw most of it away.** There are
**ten** consumer sites of `BridgeMsg::Error` (plus one producer, `Slot::recv`'s timeout, which correctly
synthesises a 503). Per site, before the fix:
- `gateway_handlers.rs` (OpenAI chat, non-stream): knew only 404/429/401/503, `_ => BAD_GATEWAY` — so
  **400 became 502**.
- `gateway_handlers.rs` (OpenAI chat, **stream**): `BridgeMsg::Error { message, .. }` — discarded the
  status and emitted a fixed `type: "upstream_error"` with `code: null`.
- `gateway_handlers.rs` (**image**): a *third* list, `if status == 404 { NOT_FOUND } else { BAD_GATEWAY }`.
- `gateway_handlers.rs` (`/v1/models`), `gateway_anthropic.rs`, `gateway_responses.rs`: matched
  `BridgeMsg::Error { message, .. }`, discarded the status, always 502.
- `gateway_gemini.rs`: only 503/429 were special-cased, and it mapped **429 to `code: 503, status:
  "INTERNAL"`** while labelling it "gateway unavailable or at capacity" — a rate-limited client was told
  the gateway was broken.

**The count was five when it was first diagnosed, and that was wrong.** The image handler and the OpenAI
streaming arm were found only by enumerating *every* `BridgeMsg::Error` match rather than the ones on the
path being debugged. Grep the variant; do not reason about which handlers exist.

The consequence: the `gatewayStatus()` fix was **dead end-to-end for the 400 case**. Tushu's original bug —
a schema error reported as 502 — was still live. A client told 502 retries; a request that fails on its own
contents can never succeed on retry.

**The fix.** `gateway::worker_status(u16) -> StatusCode`: trust the worker's decision, reject only a value
that is neither a client nor a server error status (degrades to 502). All five sites call it. Where a
dialect needs a *type* rather than a code:
- Anthropic → `anthropic_error_kind(status)` (400 `invalid_request_error`, 401 `authentication_error`,
  403 `permission_error`, 404 `not_found_error`, 413 `request_too_large`, 429 `rate_limit_error`,
  503/529 `overloaded_error`, else `api_error`). Anthropic clients branch on `error.type`, not the status.
- Responses → `responses_error_kind(status) -> (type, code)`; `responses_error` hardcodes
  `invalid_request_error`, which is right for the local validation failures it was written for and wrong
  for an upstream fault.
- Gemini → `gemini_error_body(message, status)` derives both `code` and `status` from the HTTP status so
  the two cannot disagree.

**The streaming arms had the same defect and no HTTP status left to carry the fix** — SSE is committed as
200 before the worker answers, so the event payload is the only channel. Anthropic hardcoded
`overloaded_error`, Gemini hardcoded `code: 502 / INTERNAL`, Responses emitted a bare message. All three now
derive from the status.

**Falsified before trusting, twice.** Neutering `worker_status`/`anthropic_error_kind` failed the four
end-to-end specs and two unit specs with `left: 502, right: 400` — the bug reproduced exactly — while the
negative-direction spec (values that must degrade to 502) correctly still passed. Reverting the three
streaming arms failed the three streaming specs, Gemini's failure output showing the old payload verbatim:
`data: {"error":{"code":502,"message":"upstream refused the request","status":"INTERNAL"}}`.

Test seam: `SynthBridge::fail_with(status)` makes the synthetic worker answer `BridgeMsg::Error { status }`,
which is what lets a spec drive the worker's decision into the edge.

### The shared gate had the same defect, one layer up

`check_gateway_key` is called by all six handlers, and it returned a finished `Response` in **OpenAI
shape** for every refusal: gateway disabled (503), no master key (401), keychain unavailable (503), auth
backoff (429), invalid key (401), and `spend_gate`'s cap (402). An Anthropic client got no top-level
`type: "error"`; a Gemini client got `error.code: null` with no `error.status` at all, so its SDK could
not classify its own auth failure.

This is the same rule as `worker_status`, applied to shape rather than status: **the layer holding the
evidence decides the outcome; the dialect decides the envelope.** The gate now returns
`GateRefusal { status, message, retry_after, openai_type, openai_code }` and each handler calls
`GateRefusal::{openai, anthropic, gemini}`. `Retry-After` is preserved on the paths that had it.

Reachable and cheap to test: `start()` sets `running = true`, so `set_running(false)` exercises the gate's
503 without any dispatch. The `try_slot` refusals (exhausted permits, woken-failure) are reachable by
`s.core.permits.close()` — the test module is a child of `gateway`, so it can touch private fields.

**A separate, smaller finding on the same path:** the Anthropic `try_slot` failure arm hardcoded
`overloaded_error` / "gateway unavailable or at capacity" for every refusal, so a *stopped* gateway
asserted a capacity problem and told Claude Code to back off and retry a service that was switched off.
It now derives the kind from the status (`429 → rate_limit_error`, `503 → overloaded_error`) and says
which one happened.

## The ledger must not lie (2026-09-19)
- **`LedgerEntry.errorClass` is a bare `string`, not `ErrorClass`** — which is why the invalid value
  `NO_ROUTE` type-checked for every failure. `wrapLedger`'s catch wrote
  `errorClass: served ? "NETWORK" : "NO_ROUTE"`, discarding the cause while the chain beside it held
  the provider, key and class. The live DB had **50 failure rows, all `NO_ROUTE`, all with
  `http_status` and `provider_id` NULL** — every failure ever recorded.
- **`providerId`/`keyId` mean *who served*, never the last attempt.** Null on an error row *is* the
  signal that nothing served; non-null means it served then broke. Do not "improve" this by falling
  back to `last.candidate` — that erases the distinction and names a provider that never answered.
- **A stream completing without serving is not a success.** The engine returns normally in that state
  only on abort (plan exhaustion throws), so 7 rows claimed `ok` for requests that never reached a
  provider — two after 99.5s/83s (client timeouts). Now `CANCELLED` (aborted) or `PARSE_ERROR`
  (empty 200); `wrapLedger` needs the signal threaded in to tell them apart.
- `idx_ledger_drift` is partial on `error_class IN ('NOT_FOUND','BAD_REQUEST_SCHEMA','PARSE_ERROR',
  'AUTH_FAILED')`, so writing `NO_ROUTE` for everything made the drift index blind. `CANCELLED` is
  deliberately outside it — a cancel is not provider drift.
- **A request for a model nothing can serve is recorded** (`recordNoRoute`): `status: "error"`,
  `errorClass: "NO_ROUTE"`, no provider, `fallbackChain: []`. Until 2026-09-20 the guard threw before
  the engine ran and wrote no row at all, so an error appeared in the UI and the log showed nothing.
  `NO_ROUTE` is now written in exactly one place, where no candidate was ever attempted — which is
  what it always claimed to mean.
- Activity's chain close comes from `finalLine()` in `src/lib/ledger/format.ts` — a `.ts` module
  because vitest here has no jsdom and `.tsx` is outside the include glob. It used to print a
  hardcoded `✓`, so a failed row read `final: — · — → ✓`.

## Build / install / verify the installed app
- `cd apps/desktop && [ -d dist ] && mv dist /tmp/old-dist-$(date +%s)` **before** `npx tauri build`.
  **Mandatory.** Otherwise tauri dies at `beforeBuildCommand` with a useless `errors: [Getter/Setter]`
  while `pnpm build` passes standalone (the direct run is escalated, tauri's child is not).
- `npx tauri build --bundles app` skips the always-failing DMG step (`osascript` blocked). Install
  from `src-tauri/target/release/bundle/macos/` by `mv`ing the existing `/Applications` app to /tmp
  (never `rm -rf`) then `cp -R`. `export PATH="$HOME/.cargo/bin:$PATH"` first.
- `pkill -f ai-provider-router` before installing, or `open -a` focuses the old process and tests
  stale code. Launch and verify in the same command — a GUI app launched by a tool call may be reaped.
- **Every reinstall invalidates the app's keychain ACL; the next read takes ~19s to negotiate.**
  `probe_key_refs` used to run inline in `setup()`, so that 19s landed before any window existed —
  alive process, no window, no socket, no log line, which reads exactly like "still starting". It is
  now on its own thread. Same ACL applies to `workbuddy::sync`, which is why it can lag the listener.
  If a launch looks dead, read `gateway.log`: `startup: <step>` markers name the last step reached.
- `ps` is sandbox-blocked; use `pgrep -fl` and `lsof -p <pid>`.
- **Test the startup fix on the first launch after a rebuild, or the test proves nothing** — the
  cold-ACL condition exists once per build. And beware a repro script that outruns what it measures:
  `repro-restore.sh` kills each instance ~3s after the socket binds, too soon for the keychain probe.

## Testing
- **The sandbox sets HTTP_PROXY/HTTPS_PROXY to a local port that can die.** The app then returns
  `502 upstream connect failed` on every call, which looks like a regression and is not. Use
  `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy`.
- router-core `./node_modules/.bin/vitest run` (215) · desktop same (126) · Rust `cargo test --lib`
  (171) · browser `npx playwright test` (41, see below).
- **`vitest` is `environment: "node"`, include `["e2e/**/*.test.ts","src/**/*.test.ts"]`** — no jsdom,
  and `.tsx` is not in the list. Keep anything needing a unit test out of `.tsx`.
- **An invariant spec beats an example spec.** A `find`-based assertion is indifferent to duplicates
  and passed while agent turns recorded the whole conversation twice. When a structure should hold an
  invariant, assert the invariant.
- **Prove a spec fails before you trust it passing** — flip the code back and watch it fail. A spec
  written after the fix only proves the author's model of the bug.
- Use `./node_modules/.bin/tsc`, never `npx tsc` (which tries to install `tsc@2.0.4`).
- **The sandbox `grep` shim silently returns nothing for alternation (`a|b`)** — use the Grep tool.
  Bitten repeatedly; do not trust a shell grep that returns nothing when you expected a hit.
- Isolating an egress failure: test a *second* provider through the same gateway first. OpenRouter
  once returned `NETWORK` in 36–40ms (far too fast to be a connection) while Agnes served 200s and
  `curl` reached openrouter.ai fine — provider-specific, not app egress.
- A three-key comparator is easy to get backwards in one key and the compiler will not say so.

## Browser harness (`apps/desktop/web-test`) — use it for UI work
The real React app runs in Chromium against `shim.ts`, an in-memory stand-in for the Rust host that
mirrors it command-for-command. It drives real clicks, not a headless approximation.
- `cd apps/desktop && [ -d test-results ] && mv test-results /tmp/x-$(date +%s) ; env -u HTTP_PROXY
  -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy npx playwright test
  --reporter=list --output=/tmp/pw`
- **Three mandatory workarounds, each of which looks like something else:** `env -u` the proxy vars
  (readiness check dies at 60s); move `test-results` aside (Playwright's cleanup trips the safe-delete
  shim at 2389 files vs a 50 threshold); run **outside the sandbox** (a sandboxed run cannot bind
  :1430, so vite times out at 60s while the mock looks healthy). `reuseExistingServer` does not rescue
  it and is ignored when `CI` is set.
- Seeds `?seed=systemai` and `?seed=or-router`; provider *names* matter ("Mock Oracle" exists only in
  the wizard story).
- `__webTest`: `store.*` read-only views, `emit()`, `invoke(cmd,args)` and `gatewayStatus(partial)` to
  **arrange only, never assert**.
- **A screen with no shim command cannot be tested and its specs pass anyway.** Gateway had no
  coverage because `gateway_status` was missing: the invoke threw, `status` stayed null and the screen
  rendered its "Stopped" branch whatever the host would have said. Confirm the command is in the table
  before writing the spec.
- The shim renames args camelCase→snake_case (`toRustArgs`) because Tauri does — a new command with a
  multi-word argument silently receives `undefined` otherwise.
- `store.requests()` is a bounded log of outgoing egress bodies, captured in `egressUnary` and
  `egressStream` — how to assert **what the app actually sent** rather than what it rendered.
- Waiting for a turn: poll for one more assistant *message node* (created after the answer streams and
  flushed in `finally`). The answer bubble is not a signal (it exists empty from the start) and
  neither is a recalled edge (written before the model is called).

## Live database
- `~/Library/Application Support/dev.aiprovider.router/ai-provider-router.db` (bundle id
  `dev.aiprovider.router`). **Not** `com.ai-provider-router.app` — that path does not exist and a
  query against it looks like a missing install.
- Schema version lives in a `schema_version` table (one row per applied migration), not
  `PRAGMA user_version` (which reads 0). Read concurrently with `file:…?mode=ro`.
- Column names are the snake_case ones (`fallback_chain_json`, `http_status`); guessing a name
  silently returns `None` and looks like missing data.

## Migrations (`src-tauri/src/store.rs`)
- **Two ordered lists.** `MIGRATIONS` = SQL batches numbered by position; `DATA_MIGRATIONS` =
  `fn(&Transaction) -> rusqlite::Result<()>` steps for backfills needing real logic, numbered
  `MIGRATIONS.len() + idx + 1`. Forward-only; never edit an applied entry. A test asserts the combined
  count so a data migration cannot reuse a version number and be skipped.
- Adding a migration also means bumping the hardcoded `schema_version` and the table list in
  `store::tests::migrations_apply_once…`.
- **Why not SQL for backfills:** the edge table has a derived PK plus a unique index on
  `(from_id,to_id,kind)`; `ON CONFLICT(from_id,to_id,kind)` does not catch a PK conflict, so a merge
  needs delete-then-reinsert ordering. Explicit `UPDATE`-then-`INSERT` in Rust is clearer and testable.
- **Rewind to test a backfill:** seed the old shape, then `DELETE FROM schema_version WHERE
  version >= N` — **the tail, not just `= N`.** The runner skips a step when `version <= MAX(version)`,
  so deleting only `N` does nothing once a later migration exists, and the fixture silently asserts
  against un-backfilled data. Then call `migrate()`, which exercises the real runner path. **Verify
  against real data** by copying the live DB into a temp *directory* as `ai-provider-router.db` and
  calling `Store::open` on that dir — or by backing up the live DB and letting the built app migrate
  it, which is the actual production path.

## Context graph
- Persisted `context_nodes` (artifact|memory|skill|message) + `context_edges`, migration
  `0003_context_graph`, `src-tauri/src/context.rs`. Derived, not stored: routing topology and live
  request flow, built in `src/lib/context/engine.ts` from registry/catalog/ledger.
- **A generated node id is a silent no-op for every dedupe path.** The host upserts on id and
  accumulates `weight = MIN(weight + excluded.weight, 50)` on the `(from_id,to_id,kind)` conflict, but
  `BufferedRecorder` is a naive append log that does **not** dedupe — so minting an id turns that
  machinery into dead code, silently, with no failing test. Three bugs so far: `recordAgentTurn`
  re-recording the whole transcript, the user node created twice, and `recordRecall` scattering one
  node per recall (leaving every `recalled` edge at weight 1). **Rule: if the thing being recorded
  already has an identity, pass it** (`Recorder.node(kind,label,meta,id)`, `memoryNodeId(id)`).
- The node upsert refreshes label/ts/meta on every record, so anything derived from the source row
  self-heals on the next recall — do not report it as a gap without checking. Node labels are
  truncated (`text.slice(0,80)`), so **never match nodes on label**.
- `recordAgentTurn` takes the caller's `userNode` and only *this* turn's messages; `runAgentLoop`
  returns all of its working copy, so callers must `slice(history.length)` or the graph goes quadratic.
- The agent branch flushes in `finally`, not only on success — otherwise a stopped run leaves nodes
  buffered and prepends them to the next batch.

## Skills · orchestrator · memory engine
- A skill is a **procedure, not a capability** — it cannot widen the tool surface, only steer how the
  four sandbox tools are used. Migration `0004_skills`, `src-tauri/src/skills.rs`; builtins seed once
  (marker `settings.skills_seeded`), `skills_catalog` exists so a revoked builtin can be reinstalled.
  No install-from-file-picker: that is arbitrary FS reads from an untrusted webview.
- `Chat` in Playground.tsx is keyed on the UI tick and **remounts on every bump** — any per-mount
  state there resets. Use module-level state (this is why the orchestrator's controller map is).
- `0005_agent_runs` = `agent_runs` + `agent_steps` (FK cascade, `UNIQUE(run_id,seq)`). A run left
  `running` stays `running` — an unobserved status is unknown, never relabelled as failed.
- Nav needs three edits: `ScreenId` in `ui-state.ts`, the Tools group in `components/Shell.tsx`, the
  route in `App.tsx`. Forgetting `App.tsx` gives an unreachable screen that compiles.
- **`runAgentLoop` returns `{text, messages}` where `messages` EXCLUDES the closing assistant turn** —
  `text` *is* that answer, so callers must append it themselves. Caused two shipped Playground bugs.
- Memory engine: four layers **L0 raw, L1 atoms, L2 scenarios, L3 core** (`0006_memories`,
  `src-tauri/src/memory.rs`, webview `src/lib/memory/engine.ts`).
  - **Retrieval is BM25 over SQLite FTS5, not embeddings** — no embedding model, no vector index, no
    second process, and the UI says keyword search. FTS5 is compiled into the bundled SQLite
    (`libsqlite3-sys 0.30.1` sets `-DSQLITE_ENABLE_FTS5`; a stale 0.25.2 also sits in the registry).
  - **Split: host stores and ranks, webview distils** — extraction needs a model, and the webview owns
    the gateway client.
  - `memories_fts` is **external-content**: the three triggers are the only thing keeping the index
    honest, so any new write path must go through them. Recall queries are tokenised and re-quoted
    (`match_expr`) — raw FTS5 syntax turns a typo into a thrown error, and an error into zero results.
  - **Distillation is batched (`DISTIL_EVERY = 3`), never per turn** — per-turn doubles token spend and
    puts two ledger rows per message (`ui.spec.ts:277` caught exactly that).
  - **All four layers need producers or the layered recall is theatre:** L0 `rememberTurn`; L1
    `distilTurn` (every 3 turns); L2 `distilScenarios` (every 6 L1 atoms, per-session cursor that
    rolls back on failure, needs oldest-first via `sessionMemories`/`memory_session_atoms`); L3
    **user-authored**, pinned by default. `recordRecall()` produces the graph's memory nodes.
  - **A paraphrase that overlaps in meaning but not in words returns nothing** — "remind me of the
    timezone" does not match an atom containing only "Dhaka"/"GMT". Stated as a product limitation.
  - Timestamps are unix **millis**, NOT NULL, surfaced thinly: relative age, "first <age>" only when
    the two would *read* differently (compare rendered strings), absolute in the `title` attribute.
  - Recall ranking is **relevance band → recency → layer**. The band is measured from the **best
    hit**, not the spread of the candidate set (a spread-relative band degenerates with 2 candidates,
    which is the common case). A band, not a weighted blend, so displayed bm25 stays monotonic.
    **L3 is exempt from decay.** `recall` fetches `limit * 4` before re-ranking.
    `RELEVANCE_BAND = 0.15` is a **tuned default, not a measured optimum** — say so if questioned.
  - **Assert the candidate set, not just the winner** — `hits[0] == wanted` passes vacuously when the
    distractor is never a candidate. Assert `hits.len()` too.

## API key status
- **`invalid` is an eviction, not a label.** `isKeyUsable` returns false for `disabled` *and*
  `invalid`, and `refreshProvider` only considers `active` keys — so writing it takes a key out of
  rotation until a human re-enables it. Never write it from an inconclusive test.
- Classify first: `src/lib/keys/verdict.ts`. `invalid` is for 401/403 only; 429 → `cooldown`; 5xx and
  odd 4xx are the provider's problem; `status: 0` (DNS/TLS/timeout/offline/no listModels endpoint)
  yields `unverified`, which writes no status.
- An explicit `rateLimited: true` beats `status: 0` — a positive claim beats the absence of a status.
- Stored vocabulary is `active | cooldown | invalid | disabled` (schema CHECK). Do not widen it to
  carry "unknown" — that needs a SQLite table rebuild, and not writing a verdict is enough.
- `web-test/key-verdict.spec.ts` drives the real `store.testKey` (not stubbed) and forces failure with
  `page.route`. Verify new specs **fail on the old code**.

## macOS App Nap
- `app_nap.rs` suppresses it via `NSProcessInfo::beginActivityWithOptions_reason` with
  `UserInitiatedAllowingIdleSystemSleep`, called **after** `tracing_subscriber` init or its
  confirmation line is dropped (`lib.rs:162`).
- **It is NOT the root-cause fix for the heartbeat lapse — measured.** With it wired in the beat still
  hard-stops after ~484s idle. Process-level App Nap and a hidden WKWebView's own timer suspension are
  different mechanisms; what handles the lapse is on-demand recovery (`await_core` + `request_warm`).
  Keep the suppression, but do not credit it with fixing the lapse.
- `objc2`/`objc2-foundation` are macOS-only deps pinned to the versions already in Cargo.lock (0.6.4 /
  0.3.2). Build with `CARGO_NET_OFFLINE=true`.
- To see the app's own logs (`open -a` discards stderr), run the binary directly: `nohup
  "/Applications/AI-Provider Router.app/Contents/MacOS/ai-provider-router" > /tmp/router-app.log 2>&1 &`.

## Verifying the *installed* app
- `osascript` works for pure computation, but System Events / Finder UI scripting fails with a
  privilege violation — the running app cannot be driven by script.
- Frontend assets are brotli-compressed inside the binary: `strings` proves Rust literals but **not**
  frontend strings. Check the frontend against `apps/desktop/dist/assets/` — that is what got embedded.
- Playwright's cleanup of `web-test/.report` trips the bulk-delete shim and fails the run *after* the
  tests pass; move `.report` and `test-results` aside first.

## Keychain: ACL, and how it can wedge the whole gateway
Measured 2026-09-20 on a build installed minutes earlier.

**The failure.** After a reinstall the app's keychain ACL is invalidated, so the next read needs
re-authorization. If that authorization never completes, the app does not error — it **hangs**, and
takes the entire HTTP surface with it:

- The listener still binds (`enabled on port 8787` in `gateway.log`) and still accepts TCP
  connections, so `lsof` shows a healthy LISTEN and `pgrep` shows a live process.
- **No request is ever answered** — `/v1/models` included, which is purely local and needs no upstream.
- Nothing is logged: the failure is a hang, not an error. The release GUI build discards `tracing`.
- **No ledger row is written**, so the Activity screen stays empty and the app looks merely idle.
- `pkill` + relaunch does **not** clear it. Three consecutive launches each logged a clean startup and
  each answered nothing.

**The marker.** `startup: key refs probed` appears ~21 s after a healthy startup. If it is absent from
`gateway.log` for the current instance, the gateway is dead — this is the fastest test, and it needs
no tooling beyond `grep`. Do not infer "still starting": a healthy restore takes ~20 s.

**The mechanism** (from `sample <pid> 2`, grep `SecKeychainFindGenericPassword`). The Security
framework serializes keychain access behind **one process-wide mutex**, and three of the app's own
threads were queued on it at once:

| Thread | State |
|---|---|
| app-created (`workbuddy::sync`) | **holds** the mutex, blocked in `ClientSession::decrypt` → `mach_msg2_trap` (securityd IPC round-trip) |
| app-created (`probe_key_refs`) | `_pthread_mutex_firstfit_lock_wait` → `__psynch_mutexwait` |
| **tokio-rt-worker** | same mutex wait — **this is the request path** |

The tokio worker is the load-bearing one: `gateway.rs:67` `vault_key_provider()` is
`Arc::new(|| vault::get(MASTER_ACCOUNT).ok().flatten())` — a bare keychain read with **no cache and no
timeout**, invoked per request to validate the bearer token. So a stalled keychain does not fail one
request, it blocks every request indefinitely. It is also a *blocking* OS call made directly on an
async worker rather than via `spawn_blocking`.

**Two traps when diagnosing this.**
1. **The main thread is not blocked.** It idles in `__CFRunLoopRun` → `mach_msg` and is actively
   servicing WebKit IPC (`WebProcessProxy::didReceiveMessage`). A frozen-app theory is wrong; only the
   keychain path is wedged. Read the sample per thread, not just the top frame.
2. **A resident `SecurityAgent` proves nothing** and `sample`ing it for `NSAlert`/`runModal` frames
   shows nothing useful. It is a persistent agent. And `osascript` cannot list the app's windows
   (privilege violation), so *whether a prompt is on screen is not locally determinable*. What is
   provable is that the read never returns.

**Resolving it.** Approving the keychain prompt unblocks it immediately and confirms the diagnosis.

## Keychain: the fix (2026-09-20)

**Chosen: cache the read, bound the wait, share the load.** `MasterKeyCache` in `gateway.rs` wraps the
injected `KeyProvider` and is what `check_gateway_key` and `gateway_status` now use:

- **Cached** — one keychain read, not one per request. Rotation stays instant because each value is
  stamped with a generation and `invalidate()` bumps it. This is the part that had to be got right: the
  old per-request read was *documented* as the rotation guarantee (`gateway.rs:899`: "the old key dies
  instantly because every request re-reads the keychain"), so a naive cache would have silently broken
  `criterion8_rotation_kills_old_key_instantly`.
- **Bounded** — `MASTER_KEY_WAIT` = 1500 ms. Measured in the shipped build: three sequential requests
  against a stuck keychain returned `HTTP 503 in 1.502s`, `1.502s`, `1.511s`.
- **Single-flight** — concurrent callers share one in-flight load, so a stuck keychain parks one thread
  instead of one per request. Nothing can cancel a blocking `SecKeychainFindGenericPassword`, so that
  thread is abandoned deliberately; it frees itself when the prompt is answered.
- **`Unavailable` ≠ `Absent`** — the first is "the keychain did not answer" (→ 503), the second is "no
  key configured" (→ 401). Both used to be `None`, and the request path reported both as 401, blaming
  the client's credential for a local fault.

**Invalidation is not left to the caller.** `generate_master_key`/`revoke_master_key` are now private and
`GatewayCore::rotate_master_key`/`revoke_master_key` do write-then-invalidate as one operation, because a
caller that wrote the keychain and forgot to invalidate would leave the OLD key working — silently, with
no failing test, since the write itself succeeds.

**Specs, all falsified first.** Reverting `MasterKeyCache::get` to a bare `resolve(&(self.inner)())`
(one temporary line) made four specs fail with the expected signatures, and the suite time went from
0.79s to 30.08s — the hang, made visible:
- `a_stalled_keychain_answers_503_instead_of_hanging` → *"the gateway must answer while the keychain is
  stalled — it hung instead: Elapsed(())"*
- `the_master_key_is_read_once_not_once_per_request` → 3 reads, expected 1
- `concurrent_requests_share_a_single_keychain_read` → 8 reads, expected 1
- `an_unanswered_keychain_is_not_reported_as_a_missing_key` → `Absent`, expected `Unavailable`

Also added `rotation_during_a_cold_load_yields_the_new_key`: reading the generation once, up front, made
a waiter give up with `Unavailable` when the load it was waiting on completed stamped with a superseded
generation. `get` now re-reads the generation inside the loop.

**The measurement trap that cost a cycle.** The verification first reported `502 upstream connect failed`
for all three cases, which reads exactly like a gateway defect. It was the sandbox proxy: `env -u` had
been applied to the *app launch* but not to the probe, so the probe's requests never left the machine.
**The tell was the ledger** — no row was written, because the request never reached the gateway. Check
for the row before believing a 5xx came from the app.

**Still open:** the three client-facing status codes (400 / 404 / 200) remain unverified end-to-end.
Every reinstall re-invalidates the ACL, and the wedge returned on the 4th build, so no request can
authenticate and none reaches the router. That verification needs the prompt approved, not more code.

**Rejected alternatives:**
- `spawn_blocking` + timeout alone — leaves the read on every request and still parks a runtime thread.
- `security add-generic-password -U -A …` to grant every app silent access. Removes the prompt
  permanently and **downgrades the key's protection** — not done, and not to be done without asking.
- Serializing the startup readers is still worth doing: `probe_key_refs` and `workbuddy::sync` were meant
  to stop contending for one prompt, yet both were in the keychain at once again, plus a request.

## Upstream content rules — Agnes, measured 2026-09-20

Probed `https://apihub.agnes-ai.com/v1` directly (key: `security find-generic-password -s
ai-provider-router -a key:<api_key_id> -w`; unset the proxy vars first).

**Agnes answers HTTP 400 for:**
| Request shape | Upstream message |
|---|---|
| `tool_calls[]` flat (`{id,name,arguments}`, no `type`/`function`) | `missing field \`type\`` |
| `tool_calls[].id` = `""` or `null` | `missing field \`tool_call_id\`` / `invalid type: null, expected a string` |
| `function.arguments` as an object, not a JSON string | `invalid type: map, expected a string` |
| a **user** message with `content: ""` (trailing or mid-history) | `messages: Validation error: message content cannot be empty` |
| `max_tokens` > 65536 | `max_tokens exceeds the limit of 65536` |

**Agnes accepts:** `content: null` on assistant (with or without tool_calls), `content: ""` on
*tool* messages, content as `[{type:"text",…}]` arrays, a `tool` message with no matching
assistant `tool_calls`, `tool_choice` objects, `response_format: json_object`, 200k-token contexts,
`max_tokens: 32000`.

### The bug this found (fixed 2026-09-20)
`gateway-normalizer.ts` appended `{role:"user", content:""}` whenever the last message was a
`tool` message ("some providers require a user turn after tool results"). Appended on **every**
request, it broke exactly the request it was meant to protect: turn 1 succeeded, the continuation
carrying the tool result got a 400 → `BAD_REQUEST_SCHEMA`. Removed; replaced by a comment block
recording the measurement. Two specs in `gateway-normalizer.test.ts` had *encoded the bug*
(asserting the trailing turn exists) — both inverted.

**Diagnosis method that works here:** probe the upstream directly for the real 400 body, then send
the identical payload through the live gateway (`/v1/chat/completions` on 127.0.0.1:8787, master key
via `-a masterkey`) and read the ledger row that appears. Direct 200 + gateway 400 isolates our own
request rewriting as the cause, with no rebuild.

**Still unguarded (same class, not yet seen failing):** `ensureArrayContent` rewrites every string
`content` into an array for all providers; `ensureUserTurnForZai` and `fixMissingToolResponses`
both insert `content: ""`. Safe on Agnes, unverified elsewhere.

### Second filler removed (2026-09-20) — and a rule that first looked like our bug
Probing a no-user-turn request, both a zcode UA and a generic UA 400'd through the gateway, which
looked like `ensureUserTurnForZai` corrupting the request. **It was not.** Probed directly: Agnes
rejects a history with no user turn on its own — `400 "No user query found in messages."` — and an
*empty* user turn does not satisfy it (`"message content cannot be empty"`). Measure before blaming.

`ensureUserTurnForZai` pushed `{role:"user", content:""}` when no user turn existed, so it could
never have rescued the request it was written for; it could only inject a bogus turn. It was also
gated on `clientHint`, which says who *called*, not which provider *serves*. Removed, same treatment
as the first filler. A request with no user turn now fails with the upstream's own 400, passed
through unchanged — the honest answer.

**Rule of thumb for this normalizer:** never append filler with empty `content`. Either the provider
does not need it, or empty content cannot satisfy it.

### PARSE_ERROR: what it actually means (investigated 2026-09-20)
Written at `model-router.ts:338` when a stream **completes without ever serving** (`!exec.served()`)
and the caller did not abort — i.e. partial tokens arrived, then the stream ended without finishing.
Signature in the ledger: `http_status` NULL, small non-zero `tokens_out` (5–14), short latency,
empty `fallback_chain_json`.

Observed intermittently on Agnes and historically on Cline and Kimi — so it is upstream truncation,
not a provider-specific or dialect-specific bug. **Not reproducible on demand:** 10 identical plain
requests through the live gateway came back 10/10 `ok`. The gateway tool loop recovers from it (a run
containing one PARSE_ERROR row still finished 200).

Do not "fix" this by loosening the classification — the row is the honest one. If it ever needs
handling, the fix belongs in retry/continuation, not in the error class.

### Two hazards measured down to "no change justified" (2026-09-20)
- **`ensureArrayContent`** (string → `[{type:"text",…}]` for every message, all providers): measured
  against Agnes — **zero cost and no behavioural difference**. `prompt_tokens` 294 (array) vs 296
  (string) on a small pair, and **1490 vs 1490 exactly** on a ~7.5 KB payload. Agnes accepts both.
  Leave it alone; there is no measured failure to fix.
- **`fixMissingToolResponses`** inserts `{role:"tool", …, content:""}` for a declared call with no
  result. Agnes accepts an empty *tool* message (verified) even though it rejects an empty *user*
  one. It also has a real purpose — OpenAI requires one result per declared `tool_calls` entry.
  Leave it alone.

**Fix generalises past Agnes:** the tool-result pair was re-tested on **Cline**
(`cline/anthropic/claude-sonnet-4.5`), a different provider and an Anthropic-family model — 200
direct and 200 through the gateway, with two `ok` ledger rows.
