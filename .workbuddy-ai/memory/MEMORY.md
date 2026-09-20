# Project memory — AI-Provider Router IDE

**Index only. `REFERENCE.md` (same dir, 34 KB) holds the depth — read it before non-trivial work.**

## Non-negotiables
- **Verify every edit by reading it back** — success messages have lied.
- **Prove a spec fails before trusting it passes** (flip the code back).
- **Measure before recording a cause.**
- Sandbox proxy lies: unset `HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy` on probe *and* app, or every upstream call returns `502 upstream connect failed`. Tell: a proxied request writes no ledger row.
- Use `./node_modules/.bin/tsc`, never `npx tsc`. Sandbox `grep` shim is broadly unreliable, not just on alternation — plain `grep -rn "x"` returned empty for a string present in the file. Use the Grep tool, and verify a "not found" before acting on it.
- **Never trust a diagnostic message's own asserted cause.** The 503 blamed "the gateway window may be suspended"; measurement showed the window was healthy and the request was merely slow. A message reports what was observed, not why.
- Test counts (2026-09-20, after the first-turn liveness fix): router-core 231 · desktop vitest 151 (14 files) · Rust `cargo test --lib` 254 · browser 53. All green.
- **Run JS tests with managed Node 22 first on PATH** (`~/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin`). Under system Node 18 `pnpm -r test` dies with `ReferenceError: crypto is not defined` in `provider-registry.ts` — 27 failures that look exactly like a regression and are not. Probing `typeof globalThis.crypto` on both interpreters returns "object", so that check will mislead you; trust the suite result instead.

## Build / install
- `mv dist /tmp/old-dist-$(date +%s)` **before** `npx tauri build`, or tauri dies at `beforeBuildCommand`.
- `npx tauri build --bundles app` (skips the failing DMG step); `export PATH="$HOME/.cargo/bin:$PATH"`.
- Install: `mv` the old `/Applications` app to /tmp (never `rm -rf`), then `cp -R`. `pkill -f ai-provider-router` first.
- Test a startup fix on the **first launch after a rebuild**, or it proves nothing.
- **`pnpm ci:local` (`scripts/ci-local.sh`) is the gate.** It mirrors ci.yml step for step, adds a Node >= 19 preflight, and unsets the proxy vars. Skips `pnpm install` by default (see below); `--install` to include it, `--skip-browser` to drop the ~48s Playwright run.
- **After renaming a UI concept, grep the old name across the whole repo, not just the frontend.** The Playground → Assistant rename was complete in `src/`, but the old name survived in a Rust *string literal* (`gateway.rs` `gateway_tool_refusal`, read by the model), in Rust doc comments, and throughout `ARCHITECTURE.md`. The literal was the real defect: a model told to use a screen that no longer exists. Test assertions pin the wording too, so they must move with it.
- **`pnpm install` is destructive in this environment.** The broker denies pnpm's symlink writes (`ERR_PNPM_CODEBUDDY_BROKER_DENY ... EEXIST`) and it fails *after* unlinking entries, so it left `packages/adapter-spec/node_modules/typescript` and `packages/router-core/node_modules/typescript` missing — which broke `pnpm typecheck` with `Cannot find module .../typescript/bin/tsc`. Running outside the sandbox does **not** help; the denial is broker-level. Repair by re-linking by hand:
  `ln -s ../../../node_modules/.pnpm/typescript@6.0.3/node_modules/typescript packages/<pkg>/node_modules/typescript`
- **CI has not actually started a job since ~2026-09-16.** Every run reports `failure` in ~8s with the annotation "The job was not started because recent account payments have failed or your spending limit needs to be increased". That is billing, not code — do not chase it as a regression. Run the gate locally instead: `pnpm typecheck`; `pnpm test` (managed Node 22 on PATH); `pnpm key-leak-grep`; `pnpm check-ts-version`; `cargo check` and `cargo test` under `apps/desktop/src-tauri`; `pnpm --filter ai-provider-router-desktop web-test` (53 browser tests, `mv test-results /tmp/...` first).

## Gateway
- `/v1/models` advertises only provider-qualified ids (`<slug>/<native>`); worker calls `bootstrap()`, never `refreshCatalog`.
- Failure status decided once in `gatewayStatus()` (`gateway-bridge.ts`); the Rust edge passes it through at all ten sites. Whitelist 400/404/413/422/429; upstream 401/403 is our key, never echoed.
- No keychain reads on the request path (`MasterKeyCache`). Rotate only via `GatewayCore::rotate_master_key`.
- **Agnes 400s on an empty `content`**, and on flat/`""`/`null` tool-call ids. Never append a filler turn. Full table + the diagnosis method (direct probe vs through-gateway probe) in REFERENCE.md → "Upstream content rules".
- Display name "ai-provider router" marks provenance — do not rename.

## Ledger honesty
- `errorClass` is a bare `string`, not `ErrorClass` — invalid values type-check.
- `providerId`/`keyId` = *who served*, never the last attempt. NULL on an error row = nothing served.
- A stream completing without serving is not success. `NO_ROUTE` is written only where no candidate was attempted.
- Live DB: `~/Library/Application Support/dev.aiprovider.router/ai-provider-router.db`, read with `file:…?mode=ro`. Version in a `schema_version` table, columns snake_case.

## Rules that each cost a bug
- Pass the identity a thing already has; a generated node id is a silent no-op for dedupe. Never match nodes on label (80-char truncation).
- `runAgentLoop` returns `{text, messages}` where `messages` EXCLUDES the closing assistant turn — callers append `text`.
- A tool failure must never reach the model as `""` (Rust `ToolResult::err` leaves `output` empty). Guard at bridge *and* consumer.
- Playground screen = **Assistant** (`assistant` / `screens/Assistant.tsx` / `AssistantScreen`).
- `invalid` is an eviction, not a label — `isKeyUsable`/`refreshProvider` exclude it. Classify in `src/lib/keys/verdict.ts`.
- Migration = `MIGRATIONS`/`DATA_MIGRATIONS` + bump hardcoded `schema_version` + update the count assertion. Rewind tests must delete `WHERE version >= N`.
- Recover from stored data, never invent it.
- Nav = three edits: `ui-state.ts`, `Shell.tsx`, `App.tsx`. Missing `App.tsx` = unreachable screen that compiles.
- `panic = "abort"` makes lock poisoning unreachable — never write poison handling for `.lock().unwrap()`. Remove panic *sources*, not `unwrap` sites.
- A debounced save must read state when it **fires** (latest-ref), not when scheduled.
- Clamp user numbers from numbers/numeric strings only; `Number(null/[]/true)` is 0/0/1 → fall back to the default, never 1.
- Counting prod vs test in Rust: cut only on `#[cfg(test)] mod X {` blocks.

## Browser harness (`apps/desktop/web-test`)
Real React app in Chromium against `shim.ts`. Use for UI work.
- `mv test-results /tmp/x-$(date +%s)` first.
- Run outside the sandbox **and** with proxy vars unset; ~41s for the suite.
- A screen with no shim command can't be tested and its specs pass anyway. `__webTest.invoke()` arranges, never asserts. Shim renames camelCase→snake_case.
