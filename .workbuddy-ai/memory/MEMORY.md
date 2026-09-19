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

## Testing

- router-core: `packages/router-core && ./node_modules/.bin/vitest run` (210 tests)
- desktop: `apps/desktop && ./node_modules/.bin/vitest run` (43 tests)
- Rust: `apps/desktop/src-tauri && cargo test --lib` (119 tests)
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
