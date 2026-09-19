# Project memory — AI-Provider Router IDE

## WorkBuddy integration (confirmed working 2026-09-19)

The local gateway is registered as a custom model provider inside WorkBuddy AI, and chatting
through it works end to end.

- **Live config file: `~/.workbuddy-ai/models.json`** (top-level JSON **list**). Confirmed
  empirically — an entry added through the UI appeared here and showed up in the model picker.
- `~/.codebuddy/models.json` (shape `{"models": [...]}`) is referenced in `app.asar` but appears
  **not** to be read. Two entries were added there earlier and are probably dead weight.
- Gateway endpoint: `http://127.0.0.1:8787/v1/chat/completions`
- Gateway master key: macOS keychain, service `ai-provider-router`, account `masterkey`
  (`security find-generic-password -s ai-provider-router -a masterkey -w`).
- Working entry shape:
  ```json
  {"id":"openai/gpt-4o-mini","name":"ai-provider router","vendor":"Custom",
   "url":"http://127.0.0.1:8787/v1/chat/completions","apiKey":"<master key>",
   "supportsToolCall":true,"supportsImages":false,"supportsReasoning":false,
   "useCustomProtocol":false}
  ```
  Bare `openai/gpt-4o-mini` and `openrouter/openai/gpt-4o-mini` both route. Add
  `maxInputTokens`/`maxOutputTokens` (128000/16384) to avoid default-cap truncation.
- Config hot-reloads in ~1s; no restart needed.
- **Tushu wants the display name to mark provenance.** "ai-provider router" is deliberate, not
  leftover: it tells him at a glance which models are served by our gateway rather than by one of
  his other providers. Do not rename it away. The sync gives published entries a unique name
  (`Router: <id>`) only when a preserved name would collide, because six rows all reading
  "ai-provider router" made the picker unusable — but the *marker* is the point, so prefer
  "ai-provider router" as a prefix over a bare or differently-worded name.

## Gateway behaviour worth remembering

- `/v1/models` advertises **only provider-qualified ids** (`<slug>/<native>`), 457 of them, zero
  bare. Bare ids still route but are not advertised.
- A client that supplies its own tools gets **pass-through** — no sandbox tools injected. The
  sandbox tool set engages only when the client declares none.
- The gateway worker window calls `bootstrap()` and **never** `refreshCatalog`. Anything the
  gateway needs from the catalog (pricing, modality) must come from the persisted
  `models_cache` rows. This is why pricing had to be persisted, not just computed.
- Auto-restores on launch from `settings.gateway = {"port":8787,"enabled":true}`.
- **Agnes's catalog lies about modality** — it publishes `agnes-image-*` and `agnes-video-*` as
  `modality = 'text'`. So `modality` from `models_cache` cannot be trusted to identify an image
  model for Agnes; `workbuddy.rs` falls back to the model id (`-image`/`-video`). This is why
  Agnes image models also publish `supportsImages: false` — a known, unfixed cosmetic wrongness.
- Chat-templated upstreams (Agnes included) leak `<|im_end|>` / `<|endoftext|>` into streamed
  text. `gateway::clean_assistant_text` strips them from non-stream replies; streaming deltas
  are best-effort.

## Build / install

- `cd apps/desktop && [ -d dist ] && mv dist /tmp/old-dist-$(date +%s)` **before** `npx tauri build`
  — vite's `emptyOutDir` trips the sandbox safe-delete shim. **This step is mandatory, not
  optional.** Skipping it makes `npx tauri build` die at `beforeBuildCommand` with a useless
  `errors: [Getter/Setter]` while `pnpm build` passes standalone (the direct run is escalated,
  tauri's child process is not). If you ever see that error, check `dist` first.
- Build with `npx tauri build --bundles app` — skips the always-failing DMG step.
- `export PATH="$HOME/.cargo/bin:$PATH"`; cargo is not on the default PATH.
- DMG bundling always fails in this sandbox (`osascript` blocked). The `.app` builds fine —
  install from `apps/desktop/src-tauri/target/release/bundle/macos/`. Install by `mv`ing the
  existing `/Applications/AI-Provider Router.app` to /tmp (never `rm -rf`), then `cp -R`.
- Quit any running instance (`pkill -f ai-provider-router`) before installing, or `open -a`
  focuses the old process and verification tests stale code.
- GUI apps launched by a tool call are reaped when the call ends — launch and verify in the
  same command.

## Context graph (P4)

- Persisted: `context_nodes` (artifact|memory|skill|message) + `context_edges`, migration
  `0003_context_graph`, module `src-tauri/src/context.rs`. Derived (not stored): routing
  topology and live request flow, built in `src/lib/context/engine.ts` from registry/catalog/ledger.
- **A GENERATED NODE ID IS A SILENT NO-OP FOR EVERY DEDUPE PATH.** The host upserts nodes on id
  and accumulates edge weight (`weight = MIN(weight + excluded.weight, 50)` on the
  `(from_id, to_id, kind)` conflict); `BufferedRecorder` is deliberately a naive append log and
  does **not** dedupe. So any recording path that mints an id instead of reusing a stable one
  turns that host machinery into dead code — silently, and no test fails unless a spec asserts
  uniqueness. This has already caused three bugs: `recordAgentTurn` re-recording the whole
  transcript every turn, the user node being created twice, and `recordRecall` scattering one node
  per recall (which left every `recalled` edge at weight 1).
  **Rule: if the thing being recorded already has an identity, pass it.** `Recorder.node(kind,
  label, meta, id)` takes an optional explicit id; `memoryNodeId(id)` → `memory:<id>`.
- `recordAgentTurn` takes the caller's `userNode` id and only *this* turn's messages. `runAgentLoop`
  seeds its working copy from the replayed history and returns all of it, so callers must slice:
  `fullMessages.slice(history.length)`. Passing the whole transcript makes the graph quadratic.
- The agent branch flushes in `finally`, not on the success path only — a stopped run would
  otherwise leave nodes buffered and prepend them to the next turn's batch.
- Adding a migration: `MIGRATIONS` in store.rs is a `&[(&str, &str)]` of tuples; also bump the
  hardcoded `schema_version` and the table list in `store::tests::migrations_apply_once...`.

## Skills (P5)

- A skill is a **procedure, not a capability** — it cannot widen the agent's tool surface, only
  steer how the four sandbox tools get used. Keep that framing for any future skill work.
- Migration `0004_skills`, module `src-tauri/src/skills.rs`. Builtins seed **once** (marker in
  `settings.skills_seeded`); `skills_catalog` exists so a revoked builtin can be reinstalled.
- No install-from-file-picker: that would be arbitrary FS reads from an untrusted webview.
  Needs the Tauri dialog plugin if Tushu wants it.
- `Chat` in Playground.tsx is keyed on the UI tick and **remounts on every bump**. Any per-mount
  state there (recorders, sessions, accumulators) will reset — use module-level state instead.

## Agent orchestrator (P6)

- Migration `0005_agent_runs`: `agent_runs` + `agent_steps` (FK cascade, `UNIQUE(run_id, seq)`),
  module `src-tauri/src/orchestrator.rs`. Steps append as they happen. A run left `running`
  stays `running` — an unobserved status is unknown, never relabelled as failed.
- `src/lib/agent/orchestrator.ts` holds a module-level controller map so the Agents screen can
  stop a run the Playground started. The `Chat` remount rule above is why this is module-level.
- Nav: `ScreenId` in `ui-state.ts`, the Tools group in `components/Shell.tsx`, and the route in
  `App.tsx`. Three places; forgetting `App.tsx` gives a screen that is unreachable but compiles.
- **`runAgentLoop` returns `{ text, messages }` where `messages` EXCLUDES the closing assistant
  turn** — `text` *is* that answer. Callers must append it themselves or the answer is neither
  rendered nor recorded. This caused two shipped bugs in `Playground.tsx` (the other: agent mode
  built `history` from the stale `msgs` closure and never sent the user's prompt).

## Memory engine (P7)

- Four layers: **L0 raw conversation, L1 atoms, L2 scenarios, L3 core**. Migration `0006_memories`,
  module `src-tauri/src/memory.rs`, webview side `src/lib/memory/engine.ts`.
- **Retrieval is BM25 via SQLite FTS5, not embeddings** — no embedding model, no vector index, no
  second process. That is why search is keyword search, and the UI says so.
- FTS5 is already compiled into the bundled SQLite: `libsqlite3-sys 0.30.1` sets
  `-DSQLITE_ENABLE_FTS5`. Check `Cargo.lock` for the version — a stale 0.25.2 also sits in the
  registry and will mislead you.
- **Split: host stores and ranks, webview distils.** Extraction needs a model, and the webview
  owns the gateway client; doing it in Rust would duplicate provider selection + key handling.
- `memories_fts` is an **external-content** FTS5 table — the three triggers are the only thing
  keeping the index honest. Any new write path must go through them.
- Recall queries are **tokenised and re-quoted before reaching FTS5** (`match_expr`). Raw FTS5
  syntax turns a typo into a thrown error, and a thrown error into zero results.
- **Distillation is batched (`DISTIL_EVERY = 3`), never per turn.** A per-turn model call doubles
  token spend and puts two rows in the activity ledger for every message — `ui.spec.ts:277` caught
  exactly that. If you ever change this, watch the ledger.
- **All four layers have producers, or the layered recall is theatre.**
  - L0 raw: written by `rememberTurn` on every exchange.
  - L1 atoms: distilled by `distilTurn` (batched, every 3 turns).
  - L2 scenarios: distilled by `distilScenarios` (batched, every 6 L1 atoms per session).
    Cursor per session, rolls back on failure so the next pass retries the same atoms.
    Needs oldest-first (use `sessionMemories` / `memory_session_atoms`, not `listMemories`).
  - L3 core: **user-authored**, not auto-distilled — the stable facts about a person are the
    facts the person knows. Pinned by default; the whole point is that L3 always rides along.
- `memory` nodes in the context graph have a producer: `recordRecall()` emits them with
  `message -recalled-> memory` edges.
- **Recall is BM25 over tokens with NO embeddings.** A paraphrase that overlaps in meaning but not
  in words returns nothing — "remind me of the timezone" does not match an atom containing only
  "Dhaka"/"GMT". Stated as a product limitation, not a bug to fix silently.
- **Timestamps: stored everywhere, surfaced thinly.** `memories.created_at` / `updated_at` and
  `context_nodes.ts` are unix **millis** and NOT NULL. Rows show a *relative* age; "first <age>"
  appears only when the two would **read** differently (compare the rendered strings, not the raw
  delta) — otherwise a re-record seconds after the first prints "just now · first just now".
  Absolute timestamps live in the `title` attribute.
- **Recall ranking is relevance band → recency → layer** (`rerank` in memory.rs).
  - The band is measured from the **best hit**, not from the spread of the candidate set: a
    spread-relative band degenerates when the set is small (with two candidates the extremes *are*
    the spread, so they never share a band and recency never fires). Two or three candidates is
    the common case.
  - A band, not a weighted blend — blending would stop the displayed bm25 scores being monotonic,
    so a correct list would look broken.
  - **L3 is exempt from decay**: core because the user wrote it down, not because it is recent.
  - `recall` fetches `limit * 4` candidates before re-ranking.
  - `RELEVANCE_BAND = 0.15` is a **tuned default, not a measured optimum** — there is no ground
    truth for "the right memory". Say so if it is ever questioned.
- **Assert the candidate set, not just the winner.** A test asserting `hits[0] == wanted` passes
  vacuously when the distractor shares no query token and is never a candidate. Assert
  `hits.len()` too.

## Live database

- Path: `~/Library/Application Support/dev.aiprovider.router/ai-provider-router.db`
  (bundle id `dev.aiprovider.router`). **Not** `com.ai-provider-router.app` — that path does not
  exist and a query against it silently looks like a missing install.
- Schema version lives in a `schema_version` table (one row per applied migration), not
  `PRAGMA user_version` (which reads 0).

## Tauri command args (cost a rebuild once)

- The command macro **always** converts Rust param names to camelCase for the JS side. A Rust
  param named `runId` compiles, but JS sends `runId` → macro looks for `run_id` → every invoke
  fails on a missing argument. Rust stays snake_case; JS keys stay camelCase.
- `commands.rs` exposes `handlers()` (a function returning `impl Fn`), not a `generate_handler!`
  attribute on the builder — so grepping `lib.rs` for command names finds nothing.
  Verification: diff the `generate_handler!` list against the `invoke("...")` strings in
  `store.ts`.
- Test-only seams (`set_warm`, `set_first_msg_timeout`) need `#[cfg(test)]` or they show up as
  dead-code warnings in the release build.

## The browser harness (`apps/desktop/web-test`) — use it for any UI work

The genuine React app runs in Chromium against `shim.ts`, an in-memory stand-in for the Rust host
that mirrors its command-for-command (including rejection rules). This is how to actually *see* a
screen without the built app. It is not headless-by-default in spirit: it drives real clicks.

- Run: `cd apps/desktop && [ -d test-results ] && mv test-results /tmp/x-$(date +%s) ;
  env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy NO_PROXY=127.0.0.1,localhost
  pnpm web-test` (types + Playwright, 14 specs).
- Both workarounds are mandatory: without `env -u`, Playwright's webServer readiness check goes
  through the dead proxy and dies at 60s; without moving `test-results`, Playwright's cleanup
  trips the safe-delete shim and aborts with a misleading error.
- Seeds: `?seed=systemai` (provider "System AI (mock)") and `?seed=or-router` ("OpenRouter (mock)").
  Provider names matter — "Mock Oracle" only exists in the story that creates it via the wizard.
- `__webTest` on `window`: `store.*` read-only views, `emit()` for host→webview events, and
  `invoke(cmd, args)` to arrange state the UI cannot produce itself. Arrange only, never assert.
- **The shim renames args camelCase→snake_case (`toRustArgs`) because Tauri does.** Any new shim
  command must read snake_case (`args.run_id`), and any new command with a multi-word argument
  will silently receive `undefined` otherwise. This already caused one invisible failure.
- `store.requests()` returns a bounded log of outgoing egress bodies (oldest first), captured in
  both `egressUnary` and `egressStream`. The shim is the only thing that talks to the mock, so this
  is equivalent to capturing on the wire — it is how to assert **what the app actually sent**
  (e.g. that a recalled-memory system message reached `/chat/completions`) rather than what it
  rendered. Use it for any "is this feature wired up" question.
- Waiting for a turn to finish: an assistant message node is created after its answer streams and
  flushed in `finally`, so polling for one more of those is race-free. The answer *bubble* is not
  a signal (it exists empty from the start), and neither is a recalled edge (written before the
  model is even called).

## Testing

- **The sandbox sets HTTP_PROXY/HTTPS_PROXY to a local port that can die.** When it does, the app
  inherits it and every upstream call returns `502 upstream connect failed: Connection refused
  (os error 61)` — which looks exactly like a regression but is not. Test the app with
  `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy`.

- router-core: `packages/router-core && ./node_modules/.bin/vitest run` (210 tests)
- desktop: `apps/desktop && ./node_modules/.bin/vitest run` (93 tests)
- Rust: `apps/desktop/src-tauri && cargo test --lib` (156 tests)
- browser UI: `apps/desktop && npx playwright test` (30 specs) — see the harness section above
- **`vitest` is `environment: "node"`, `include: ["e2e/**/*.test.ts", "src/**/*.test.ts"]`** — no
  jsdom, no testing-library, and `.tsx` is not in the include list. Component logic is only
  testable through the browser harness, so keep anything needing a unit test out of `.tsx`.
- **An invariant spec beats an example spec.** `agent-turn.spec.ts` asserted with `find`, which is
  indifferent to a duplicate, so it passed while agent turns recorded the whole conversation twice.
  Asking "does each turn appear exactly once?" found two real bugs immediately. When a data
  structure is supposed to hold an invariant (unique ids, one node per thing, linear growth),
  assert the invariant — do not assert that an example is present.
- **Prove a spec fails before you trust it passing.** For the graph fixes the spec was run first and
  observed failing ("list files" twice after one turn). A spec written after the fix only proves
  the author's model of the bug.
- A three-key comparator is easy to get backwards in exactly one key, and the compiler will not
  tell you. `band(b).cmp(&band(a))` sorted bands *descending* when band 0 was the best match.
- **Isolating an egress failure:** test a *second* provider through the same gateway before
  believing it is a router bug. On 2026-09-19 OpenRouter returned `NETWORK` on every attempt
  (36–40 ms — far too fast to be a real connection) while Agnes served 200s and `curl` reached
  openrouter.ai fine. Provider-specific, not app egress.
- Use `./node_modules/.bin/tsc`, never `npx tsc` (the latter tries to install `tsc@2.0.4`).
- The sandbox `grep` shim silently returns nothing for alternation (`a|b`) — use the Grep tool.
  This has now bitten twice; it made a real API look absent. Do not trust a shell grep that
  returns nothing when you expected a hit.

## macOS App Nap

- `app_nap.rs` suppresses App Nap at startup via
  `NSProcessInfo::beginActivityWithOptions_reason` with `UserInitiatedAllowingIdleSystemSleep`.
  It is the root cause fix for heartbeat lapses and the 60s hang — the earlier gateway fixes
  only treated symptoms.
- The call must come **after** `tracing_subscriber` init or its confirmation line is dropped.
- `objc2` / `objc2-foundation` are macOS-target deps pinned to the versions already in
  Cargo.lock (0.6.4 / 0.3.2, pulled in by Tauri). Build with `CARGO_NET_OFFLINE=true`.
- To see the app's own logs (they go to stderr and `open -a` discards them): run the binary
  directly — `nohup "/Applications/AI-Provider Router.app/Contents/MacOS/ai-provider-router" >
  /tmp/router-app.log 2>&1 &`.
