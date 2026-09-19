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
- `memory` nodes are supported but **nothing produces them yet** — no memory subsystem exists.
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
- `memory` nodes in the context graph finally have a producer: `recordRecall()` emits them with
  `message -recalled-> memory` edges.

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

## Testing

- **The sandbox sets HTTP_PROXY/HTTPS_PROXY to a local port that can die.** When it does, the app
  inherits it and every upstream call returns `502 upstream connect failed: Connection refused
  (os error 61)` — which looks exactly like a regression but is not. Test the app with
  `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy`.

- router-core: `packages/router-core && ./node_modules/.bin/vitest run` (210 tests)
- desktop: `apps/desktop && ./node_modules/.bin/vitest run` (55 tests)
- Rust: `apps/desktop/src-tauri && cargo test --lib` (140 tests)
- browser UI: `apps/desktop && pnpm web-test` (16 specs) — see the harness section above
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
