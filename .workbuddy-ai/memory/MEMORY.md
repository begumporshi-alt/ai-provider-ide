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

## Gateway behaviour worth remembering

- `/v1/models` advertises **only provider-qualified ids** (`<slug>/<native>`), 457 of them, zero
  bare. Bare ids still route but are not advertised.
- A client that supplies its own tools gets **pass-through** — no sandbox tools injected. The
  sandbox tool set engages only when the client declares none.
- The gateway worker window calls `bootstrap()` and **never** `refreshCatalog`. Anything the
  gateway needs from the catalog (pricing, modality) must come from the persisted
  `models_cache` rows. This is why pricing had to be persisted, not just computed.
- Auto-restores on launch from `settings.gateway = {"port":8787,"enabled":true}`.

## Build / install

- `cd apps/desktop && [ -d dist ] && mv dist /tmp/old-dist-$(date +%s)` **before** `npx tauri build`
  — vite's `emptyOutDir` trips the sandbox safe-delete shim (>50 files).
- `export PATH="$HOME/.cargo/bin:$PATH"`; cargo is not on the default PATH.
- DMG bundling always fails in this sandbox (`osascript` blocked). The `.app` builds fine —
  install from `apps/desktop/src-tauri/target/release/bundle/macos/`.
- Quit any running instance (`pkill -f ai-provider-router`) before installing, or `open -a`
  focuses the old process and verification tests stale code.
- GUI apps launched by a tool call are reaped when the call ends — launch and verify in the
  same command.

## Testing

- router-core: `packages/router-core && ./node_modules/.bin/vitest run` (199 tests)
- desktop: `apps/desktop && ./node_modules/.bin/vitest run` (43 tests)
- Rust: `apps/desktop/src-tauri && cargo test --lib` (88 tests)
- Use `./node_modules/.bin/tsc`, never `npx tsc` (the latter tries to install `tsc@2.0.4`).
- The sandbox `grep` shim silently returns nothing for alternation (`a|b`) — use the Grep tool.
