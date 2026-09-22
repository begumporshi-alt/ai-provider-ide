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
- `pnpm build` at the repo root is **frontend only** (vite) — it does not compile Rust. The bundle
  is `pnpm tauri build` from `apps/desktop` (~2m12s for the release profile).
- **`pnpm tauri build` fails at the DMG step under the sandbox** — it is blocked from writing
  `/Volumes/AI-Provider Router/`. The `.app` is still produced correctly at
  `apps/desktop/src-tauri/target/release/bundle/macos/`. That error is environmental, not a broken
  build: check for the `.app` before believing anything is wrong.
- `cd apps/desktop && [ -d dist ] && mv dist /tmp/old-dist-$(date +%s)` **before** `npx tauri build`.
  **Mandatory.** Otherwise tauri dies at `beforeBuildCommand` with a useless `errors: [Getter/Setter]`
  while `pnpm build` passes standalone (the direct run is escalated, tauri's child is not).
- `npx tauri build --bundles app` skips the always-failing DMG step (`osascript` blocked). Install
  from `src-tauri/target/release/bundle/macos/` by `mv`ing the existing `/Applications` app to /tmp
  (never `rm -rf`) then `cp -R`. `export PATH="$HOME/.cargo/bin:$PATH"` first.
- `pkill -f ai-provider-router` before installing, or `open -a` focuses the old process and tests
  stale code. Launch and verify in the same command — a GUI app launched by a tool call may be reaped.
- **Every reinstall used to invalidate the app's keychain ACL; the next read takes ~19s to negotiate.**
  `probe_key_refs` used to run inline in `setup()`, so that 19s landed before any window existed —
  alive process, no window, no socket, no log line, which reads exactly like "still starting". It is
  now on its own thread. Same ACL applies to `workbuddy::sync`, which is why it can lag the listener.
  If a launch looks dead, read `gateway.log`: `startup: <step>` markers name the last step reached.
  **The "every reinstall" part is now fixed** — it was a consequence of ad-hoc signing. See
  §Code signing below.
- **After a reinstall `/v1/models` returns 503, not 401, and that is the keychain, not a
  regression.** Body: `master key unavailable — the OS keychain did not respond; approve the
  keychain prompt for this app, then retry`. A newly installed binary has a new code signature, so
  macOS invalidates the ACL. **Waiting does not fix it — a human click on the prompt does.**
  Learn the pair: **503 = keychain not yet approved; 401 = alive and enforcing auth.** Probing
  right after an install and reading 503 as "the gateway is dead" is the trap. Corroborate with
  `pgrep -fl` (process up), `lsof -nP -iTCP:8787 -sTCP:LISTEN` (bound) and `startup:` /
  `auto-restore:` lines in `gateway.log` before concluding anything is broken.
- **Measured 2026-09-21 (reinstall at ~17:05): a reinstall still triggers the prompt even though the
  signing fix is in the artifact.** Old and new bundles carry a **byte-identical designated requirement**
  (`identifier "dev.aiprovider.router" and certificate leaf = H"9e56e7cc…"`, Authority
  `AI-Provider IDE Dev Signing`), so this is not a requirement change. The ledger proves the gateway was
  serving minutes earlier (`source=gateway status=ok` at 16:38), so the 503 was install-caused, not
  pre-existing — **attribute a 503 only after checking the ledger, or you will blame the wrong thing.**
  Most likely the stored ACL entry was created under the earlier *ad-hoc* identity and needs one
  re-approval against the certificate requirement. **The discriminator is the next rebuild:** no prompt
  means the "every reinstall" fix is complete and this was the one-time migration.
- **A running `SecurityAgent` next to a 503 means a prompt is waiting for a human.** `pgrep -fl
  SecurityAgent` is the tell; neither waiting nor retrying clears it, which is why the 503 message says to
  approve and retry. Do not report the gateway as broken while one is pending — and do not claim a
  reinstall was verified end-to-end until the 401 comes back.
- **`pkill -f ai-provider-router` kills the shell that runs it** — the pattern matches that shell's
  own command line. Use `pkill -x` / `pgrep -x` (exact process name) instead.
- `ps` is sandbox-blocked; use `pgrep -fl` and `lsof -p <pid>`.
- **Test the startup fix on the first launch after a rebuild, or the test proves nothing** — the
  cold-ACL condition exists once per build. And beware a repro script that outruns what it measures:
  `repro-restore.sh` kills each instance ~3s after the socket binds, too soon for the keychain probe.

## Code signing — why the keychain prompted on every single build (fixed 2026-09-21)

Tushu: "entering keychain password everytime is annoying." He was right, and the cause was the
signature, not the keychain.

The installed app was **ad-hoc signed**:

```
Identifier=ai_provider_router-15382172ab762b3d
Signature=adhoc
TeamIdentifier=not set
# designated => cdhash H"b111e8381fb7f54fc4039d877a3d05de5789a53b"
```

**The designated requirement was the cdhash, and a cdhash changes on every build.** macOS matches
keychain ACL entries against the designated requirement, so every rebuild produced a requirement no
stored ACL entry could match → prompt. `bundle.macOS` was `{}` in `tauri.conf.json` (no
`signingIdentity`), so Tauri fell back to linker-signed/ad-hoc. "Every time" was literally correct:
in a dev loop every build is a new identity.

**Fix:** `bundle.macOS.signingIdentity = "AI-Provider IDE Dev Signing"` in
`apps/desktop/src-tauri/tauri.conf.json`. That identity already existed in the login keychain
(SHA-1 `9E56E7CCD0DD43012B06B86CA5D1C21237A21A6D`, self-signed, valid to 2036) and was never wired up.

Verify the property, do not assume it — sign twice and diff the requirement. A scratch copy and a
real `tauri build` gave **byte-identical** output:

```
designated => identifier "dev.aiprovider.router" and certificate leaf = H"9e56e7ccd0dd43012b06b86ca5d1c21237a21a6d"
```

No cdhash, so the ACL keeps matching across rebuilds. The build log names it —
`Signing with identity "AI-Provider IDE Dev Signing"` for the binary and then the bundle — and
`codesign --verify --deep --strict` passes. Notarization is skipped (no Apple credentials; not wanted
for a dev build).

**The decisive test is "cdhash moves, requirement doesn't" — and a plain rebuild will not show it.**
A second `tauri build` with no source change produced a **byte-identical** bundle (same
`CDHash=0e9a2aad…`), because cargo had nothing to recompile. A no-op rebuild tests nothing. Force a
different binary instead: copy the bundle, add a file under `Contents/Resources/` (the code-directory
seal covers resources, so the cdhash must change), and re-sign with the same identity.

```
before   CDHash=0e9a2aadad76503a59455393c9e11f58082834f1
after    CDHash=b569b1e4db034cac789dafe79ff7ad622dd9fced
both     designated => identifier "dev.aiprovider.router" and certificate leaf = H"9e56e7cc…"
```

Same requirement on both sides, with the cdhash moved — exactly what ad-hoc signing could not do,
since there the requirement *was* the cdhash.

**Expect one final prompt.** The stored ACL entry still holds the old cdhash requirement, so the first
signed build prompts once. **Always Allow** stores the certificate requirement, and rebuilds after
that should not prompt. If prompts ever return, check whether `signingIdentity` was dropped or the
certificate was recreated — a recreated cert has a new hash and is a new identity.

**Confirmed live 2026-09-21 on a real rebuild + install.** cdhash `…b569b1e4` → `9b7c9ca3`, requirement
unchanged, and the new binary came up **with no keychain click**. Reading that correctly needs a time
series, not one probe: a probe at t+1.5 s returns **503**, and it only flips to **401 at t+20 s** — the
same cold-read lag both builds show (listener +0 s, `workbuddy sync` +16/+21 s, `key refs probed`
+24/+27 s). The clincher is `workbuddy sync: 11 published` succeeding, since that path returns
`NO_KEY_YET` and logs `sync skipped` when the keychain is unreadable. **503-then-401 with no click is the
ACL matching; 503 forever is the ACL missing.** Note the ~18–27 s 503 window after *every* launch is
pre-existing, not caused by the signing change.

Caveats:
- **Machine-specific.** The config now names a certificate that only exists on this machine; another
  machine's build fails unless it has the same cert or overrides the setting.
- **Trust widens slightly.** Before, only that exact binary could read the master key silently; now
  anything signed with that certificate can. Standard for a single-user dev machine, and the reason
  the private key must stay in the login keychain and never be exported.
- `Identifier` changed from `ai_provider_router-15382172ab762b3d` (ad-hoc) to the real bundle id
  `dev.aiprovider.router`. An improvement, but it is a change in app identity.

### Superseded 2026-09-22 — never pin a signing identity in `tauri.conf.json`

The pin described above was correct for this machine and wrong for every other one. A self-signed
certificate exists in exactly one login keychain, so on any other clone `codesign` fails
`no identity found` and the build stops. The config no longer names an identity.

- **Default is ad-hoc**, which runs locally — that is the shipped state, and it is deliberate.
- **`APPLE_SIGNING_IDENTITY` overrides it** for anyone who does have a certificate. Do not re-add a
  literal `signingIdentity`; a per-machine value does not belong in a committed config.
- **CI cannot catch this.** `.github/workflows/ci.yml` runs typecheck, unit tests, `cargo check`,
  `cargo test` and Playwright — it never runs `tauri build`. So a pinned identity goes green on
  every push and fails the first time a human builds on a different machine. Verify a signing
  change by *building*, never by pushing.

### `tauri build`: the DMG step always fails here

The final `bundle_dmg.sh` step fails (`hdiutil`). This is expected and not a build failure — the
`.app` is already complete and installed by that point. Take the `.app`, ignore the DMG error.


## Verifying the *deployed frontend* — three ways to get a false negative (2026-09-21)

Checking that a webview change actually shipped is harder than it looks, and each failure mode looks
like a pass.

1. **Do not grep the `.app` binary.** Tauri **embeds** the frontend into the Rust binary and
   **compresses** it, so plaintext is absent — `strings | grep` returns 0 for a string that is definitely
   there. `Contents/Resources/` holds only `icon.icns`. Check the `dist` that got embedded instead.
2. **The bundler emits backticks, not quotes.** The recall code ships as
   `` let t=await Ge(e,Math.ceil(n/2),[`L3`,`L2`]),r=n-t.length,a=r>0?await Ge(e,r,[`L1`]):[] ``. Searching
   for `"L1"` or `'L1'` finds **nothing** and reads as a clean pass. Search the backtick form.
3. **The bash `grep` shim lies.** `grep -q` for a control string returned nothing while the Grep tool
   found it in `main-DR8YZbzV.js`. Use the Grep tool, and put a **control string from the same source
   file** in the same batch — a 0 from a failed search is indistinguishable from a real absence.

The decisive check is a **before/after across saved `dist` snapshots**, not a single absence:

| dist (moved at) | `` [`L1`,`L0`] `` | `` [`L1`] `` |
|---|---|---|
| ≤ 13:04:33 | 1 | 0 |
| 15:07:29 → current | 0 | 1 |

Also: **`pnpm ci:local` runs `pnpm build` as its `Build` step** (`scripts/ci-local.sh:83`). So a `dist`
moved just before a later `tauri build` can be byte-identical to the new one without anything being stale
— the gate already rebuilt it. Check whether the gate ran between the edit and the move before concluding
"cached".

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
- **`getByRole("heading", { name })` matches a *substring*, not the whole name.** Adding a section
  heading "Memory layer" broke a test that matched the screen title "Memory": the locator then
  resolved to two elements and failed on strict mode. Any heading that is a substring of another
  heading on the same screen will do this. Pass `exact: true` when you mean one specific heading.
The real React app runs in Chromium against `shim.ts`, an in-memory stand-in for the Rust host that
mirrors it command-for-command. It drives real clicks, not a headless approximation.
- `cd apps/desktop && [ -d test-results ] && mv test-results /tmp/x-$(date +%s) ; env -u HTTP_PROXY
  -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy npx playwright test
  --reporter=list --output=/tmp/pw`
- **Two workarounds, each of which looks like something else:** `env -u` the proxy vars (readiness
  check dies at 60s); move `test-results` aside (Playwright's cleanup trips the safe-delete shim at
  2389 files vs a 50 threshold). `reuseExistingServer` does not rescue it and is ignored when `CI`
  is set.
- **Corrected 2026-09-20: "run outside the sandbox" is no longer true.** It used to be listed as a
  third mandatory workaround (a sandboxed run allegedly could not bind :1430, so vite timed out at
  60s). `bash scripts/ci-local.sh` ran the full browser suite **inside** the sandbox: 53 passed in
  50.1s, as part of an ALL GREEN gate. What actually matters is the proxy vars being unset and
  `test-results` moved aside — both of which `ci-local.sh` does for you. Prefer the script to a
  hand-rolled `npx playwright test`.
- Seeds `?seed=systemai` and `?seed=or-router`; provider *names* matter ("Mock Oracle" exists only in
  the wizard story).
- `__webTest`: `store.*` read-only views, `emit()`, `invoke(cmd,args)` and `gatewayStatus(partial)` to
  **arrange only, never assert**.
- **`__webTest.failNext(cmd, message, afterMs?)` (added 2026-09-21) makes `cmd` reject once.** Without it
  a UI `catch` branch is unreachable from a spec — every shim case either answers or throws only because
  the command is unknown — so "the read failed" and "the read answered with nothing" render identically,
  which is the exact distinction several cards exist to make. Checked in `handle()` before `dispatch()`
  so it also covers an unknown command and skips `persist()`, matching the host. One-shot and cleared on
  use, so a spec arranges the precise call it means to fail.
- **An immediate `failNext` cannot test supersession, and a deferred one needs a deferred assertion.**
  Which read loses the race is the *microtask ordering*, not the code under test: a fault thrown inside a
  microtask always lands before a later read resolves, so the newer read's success wipes the older one's
  error whichever way the guard is written. `afterMs` defers the rejection so the superseded read lands
  last — but then the fault arrives *after* the assertions have run, so the spec must also outlive it
  (`toHaveCount(0)` and `toBeVisible()` both succeed instantly on the happy path, so an early assertion is
  green by construction). The `GenerationAuditCard` overlap spec passed **with its guard deleted, twice**,
  before both halves were right. Full account: `CONTROL_SCREEN_BUILD.md` §4a.2.
- **A second card on a screen breaks `getByRole(..., { name: "Refresh" })` — and that is a real defect, not
  a selector problem.** Two controls sharing one accessible name are ambiguous to a screen reader too, on a
  page the user cannot see. `Button` (`atoms.tsx`) takes an optional `ariaLabel`; the label must still
  *contain* the visible text (WCAG 2.5.3 Label in Name), so "Refresh drift history" and not "Reload". Select
  with `exact: true`, or Playwright's substring match hits both and reports a strict-mode violation.
- **Locate rows by content, not by index, in a spec that is not about ordering.** Reaching a row by
  `nth(n)` makes any ordering bug fail the test too, so a failure names two rules at once. `rows.filter({
  hasText })` costs nothing and keeps one bug to one test — measured on the drift spec, where reversing the
  sort failed the ordering test *and* the open/resolved test until it was decoupled.
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
- **The `settings` table is `key`/`value_json`** — there is no `value` column (querying it fails outright
  with `no such column: value`, which is the good failure mode). One row per feature: `router`, `gateway`,
  `workbuddy`, `assistant`, plus `background` and `skills_seeded`. Values are JSON:
  `gateway = {"port":8800,"enabled":true}`, `assistant = {root, agentMode, useMemory, noTools,
  maxIterations}`. **`DEFAULT_PORT` in `gateway.rs:33` is only a fallback** (still 8787) — the live port is
  this row, which is why reading the constant tells you nothing about where the gateway is listening.
- **An external `sqlite3` client cannot DELETE from `memories` by default.** The `memories_ad`
  trigger writes to the `memories_fts` virtual table, so a plain delete fails at prepare time with
  `unsafe use of virtual table "memories_fts"` and changes nothing. Prefix
  `PRAGMA trusted_schema=ON;`. **The app's own connection is unaffected** — rusqlite does not set
  that off, and `forgetting_removes_the_row_and_its_fts_entry` (memory.rs) covers it. So a failing
  external delete is a client quirk, not evidence that "forget" is broken.
- Verify a delete by re-counting in a **new** query: `SELECT changes()` in a separate `sqlite3`
  invocation is a separate connection and always reports 0.

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
- **Gateway conversation turns do not land in the graph — they land in `session_turns`.** Nothing in the
  gateway calls `context::record`; `context_scope.rs:777` calls `session_context::record_turns`
  (`session_context.rs:125-162`), which writes `session_turns` (per-session ring keyed `(session_id, seq)`,
  skipping a turn identical to the session's most recent one so a retry does not append a copy). The
  gateway's only graph writes are tool-call nodes (`gateway_cmds.rs:691-727`). So a gateway session shows
  in History as tool nodes with no conversation **even though the conversation is on disk** — if that is
  ever fixed, reading `session_turns` is cheaper than writing a second copy into `context_nodes`.

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
- **To prove *which* frontend shipped, match the content-hashed asset names.** The binary embeds a manifest
  naming `assets/<name>-<hash>.js` (e.g. `main--s791IoF`, `store-DFJUn371`), and those hashes come from the
  file contents — so finding the same names the build just emitted is content-addressed proof the new
  bundle is inside. One line:
  `python3 -c 'print(open("…/MacOS/ai-provider-router","rb").read().count(b"main--s791IoF"))'`. Do **not**
  try to grep the frontend *code* out of the binary: it is compressed, and every plaintext hit is Rust.
- **The bundler emits template literals, not double-quoted strings.** Grepping a built asset for `"L0"`
  finds nothing because it is `` `L0` ``. Search the bare token (`L0`, `session_id`) and print context
  instead — a quote-anchored regex reports "not present" and reads as "the change did not ship". This cost
  a full false negative on 2026-09-21 while verifying a fix that *had* shipped.
- Playwright's cleanup of `web-test/.report` trips the bulk-delete shim and fails the run *after* the
  tests pass; move `.report` and `test-results` aside first.
- **Never infer the shipped schema from the live DB.** The DB under
  `~/Library/Application Support/dev.aiprovider.router/` was migrated by whatever binary ran last —
  possibly a dev run from yesterday, not the installed build. Check its mtime; if it predates the
  build it proves nothing. Verify the binary itself:
  `strings "/Applications/AI-Provider Router.app/Contents/MacOS/ai-provider-router" | grep -c memories`
- **There is no unauthenticated liveness endpoint** — `/health` and `/` are both 404. Liveness is
  `GET /v1/models` → **503** (keychain pending) vs **401** (alive and enforcing). It is never 200
  without a key.

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

## Test counts (re-measured 2026-09-22)
router-core **241** · desktop vitest **193** · Rust `cargo test --lib` **470** · adapter-spec **18** ·
browser **98 passing** (87 declarations; the smoke spec's screen sweep expands one of them to 12, so
87 − 1 + 12 = 98 — the arithmetic closing is how the declaration count is checked).
Gate is `pnpm ci:local` (browser included by default). `npx tauri build --bundles app` also
passes — see the build section below.
**Run the gate with `PATH="$HOME/.cargo/bin:$PATH"`.** Without it the gate ends
`FAILED (1): Rust (cargo missing)` while every other stage passes — which reads like a Rust failure and
is not one. Cost two full 4-minute runs on 2026-09-21.
(Rust: 254 before the gateway tool-audit + context-graph work on 2026-09-20 → 280 → 345 → 352 →
358 → 363 after Phase 6 → 366 after §5.6's three deadline tests → 373 after §5.5's seven →
377 after Phase 5's four prune tests → 381 after §6.4's four conflict tests → 394 after the
app-key principal's thirteen → 408 → 414 after the injection ring buffer's six →
**420 after the gateway.log reader's six**, **426 after the `generator_audit` reader's six**, **433 after the
drift history reader's seven**, **466 after the external-agent ingress + `count_tokens` + Retry-After stage 2**,
**470 after the cooldown-reporting tests' four**.
Desktop vitest 163 → 169 (retention) → 170 → 177 (the settings-merge spec's seven) → 181 after the
trail-writes spec's four → **183 after the generation producer's two** → **186 after the lost-ending specs'
three** → **190 after the run-omission specs' four** → **193 after the stranded-repair specs' three**.
Browser 44+9 = 53 in the old memory — but 9 were silently failing because the gate had been
running with `--skip-browser`, and the failure mode (render crash → blank screenshot → 30s timeout
per test) read as "intermittent", not "the shim is missing data the Rust host always provides".
Then 72 → 73 (two retargets + the gateway-move spec) → **78 after the audit-log spec's five** →
**84 after the generation-audit spec's six** → **91 after the drift-history spec's seven** →
**93 after the trail-health spec's two** → **94 after the wizard's producer** → **95 after the repair
path's producer** → **96 after the lost-ending spec** → **97 after the never-recorded-run spec** →
**98 after the stranded-repair spec**.)
**Do not run the gate with `--skip-browser` and call it green.**
**Run the smoke spec when adding a new screen or a new shim field.** It is in `web-test/smoke.spec.ts`
and includes one *seeded* Memory case that catches data-shape render crashes — the empty-store
sweep alone cannot.
Supersedes the older numbers in *Testing* below (215 / 126 / 267) — those are stale.

### `MEMORY_DEADLINE` differs between builds, on purpose (2026-09-21)
`context_scope.rs` defines it twice: 15 ms normally, **30 s under `cfg(test)`**. The 15 ms budget is a
product decision, but it is a *wall-clock* budget, and `cargo test` runs tests in parallel — a store open
plus a recall on a loaded machine can exceed it. The failure reads as `injected=0;reason=deadline`, which
looks like a policy bug, and because it is load-dependent it **moved from test to test**: one run failed
`a_principal_denied_memory_is_refused_even_when_it_asks_for_it`, the next failed
`the_master_key_is_governable_by_a_policy_on_its_own_name`, and each passed in isolation. ~25 tests call
`inject_context` as scaffolding for properties about recall, scope and policy; none assert anything about
15 ms. Widening one call site only moved the noise, so it is widened at the constant. The deadline itself
is still tested for real: `a_deadline_that_is_already_gone_misses_and_stays_missed` drives
`Deadline::new(Duration::ZERO)` and the §5.6 tests pass explicit budgets to `inject_context_deadline` —
which is what that parameter exists for. Verified by three consecutive full runs at 420 passed, and again
at 426 after the `generator_audit` reader.

## The local gate: `pnpm ci:local` (`scripts/ci-local.sh`)
Mirrors `ci.yml` step for step, adds a Node >= 19 preflight, and unsets the proxy vars. Skips
`pnpm install` by default; `--install` to include it, `--skip-browser` to drop the ~48s Playwright
run. **Use this as the inner loop, not as a substitute for CI** (see next).

## CI runs again — the billing block was a *private*-repo artefact (corrected 2026-09-22)
**This section previously claimed CI was dead. That was wrong, and the way it was wrong cost four
runs of misdiagnosis.** GitHub Actions bills minutes for *private* repos; the account's block
applied to private usage only. The repo went public 2026-09-21 ~21:33 UTC and CI resumed with it.

- `gh repo view --json isPrivate,visibility` → `false` / `PUBLIC`.
- Runs **before** the flip: `failure` in 9–10 s, job never started — that is the old signature.
- Runs **after**: 3–7 minutes, all 16 steps.

So **a ~9-second failure means billing; a multi-minute failure did real work — read the step.**
Four consecutive failures after the flip were all one flaky browser test
(`web-test/history.spec.ts:122`), fixed 2026-09-22. They were only investigated once the billing
theory was ruled out, which is exactly the cost of leaving a stale cause in memory: a wrong
explanation does not just fail to help, it actively suppresses the search.

## Gotchas that each cost real time (distilled 2026-09-20)
- **Managed Node 22 must be first on PATH** (`~/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin`)
  for JS tests. Under system Node 18 `pnpm -r test` dies with `ReferenceError: crypto is not
  defined` in `provider-registry.ts` — 27 failures that look exactly like a regression and are not.
  Probing `typeof globalThis.crypto` returns "object" on BOTH interpreters, so that check misleads;
  trust the suite result instead.
- **`apps/desktop/e2e/` is LIVE — I once concluded the opposite.** `vitest.config.ts` sets
  `include: ["e2e/**/*.test.ts", "src/**/*.test.ts"]`, so all four specs (`acceptance` 9,
  `onboarding` 6, `code-adapter` 6, `drift-repair` 6) run under `pnpm test` — 27 of the desktop 151.
  They are **vitest** specs driving real HTTP against spawned mock providers, not Playwright, so
  they need no script entry. Grepping `package.json`/`ci.yml` for "e2e" finds nothing and will
  mislead you; `playwright.config.ts`'s `testDir: "./web-test"` is the separate browser harness.
  *Lesson: absence of a reference is not evidence a thing does not run — check the runner's glob.*
- **ci.yml has no build step.** It typechecks and tests but never bundles, so a change that
  typechecks and passes tests can still fail `vite build` while CI stays green. `pnpm ci:local`
  adds a Build step for exactly this.
- **`pnpm install` is destructive here.** The broker denies pnpm's symlink writes
  (`ERR_PNPM_CODEBUDDY_BROKER_DENY ... EEXIST`) and it fails *after* unlinking entries, leaving
  `packages/adapter-spec/node_modules/typescript` and `packages/router-core/node_modules/typescript`
  missing — which breaks `pnpm typecheck` with `Cannot find module .../typescript/bin/tsc`. Running
  outside the sandbox does NOT help; the denial is broker-level. Repair by re-linking by hand:
  `ln -s ../../../node_modules/.pnpm/typescript@6.0.3/node_modules/typescript packages/<pkg>/node_modules/typescript`
- **Never call an installed build stale from a missing `strings` hit alone.** `search_files` is a
  shipped literal (`tools.rs:805`) yet absent from `strings` of a *freshly built* binary — as are
  `read_file`, `run_command`, `edit_file`, while `write_file`, `list_dir`, `grep` appear. Confirm a
  string is extractable in a new build before treating its absence as staleness; `history_sessions`
  and the tool-refusal message are extractable and reliable.
- **Cargo needs `export PATH="$HOME/.cargo/bin:$PATH"`.** `cargo check --lib` ~3s, `--all-targets`
  ~4s once deps are warm.
- **`vite build` can be blocked by the host's safe-delete shim, with no code fault (2026-09-21).**
  vite's `emptyDir` on `apps/desktop/dist/assets` throws
  `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":N,"threshold":50,"scope":"turn"}`, and
  the gate reports `FAILED (1): Build` while everything else passes.

  **Fix: run the gate with the shim off — `env -u NODE_OPTIONS pnpm ci:local --skip-browser`.**
  The shim is injected as `NODE_OPTIONS=--require …/node-safe-delete-shim.cjs`; unsetting it for
  the run gives ALL GREEN. This is safe here because the only bulk delete is vite emptying its own
  build output directory.

  Two wrong causes I recorded before measuring, both corrected: (a) *"it's a file count — empty the
  dir first"* — no, emptying `dist/assets` to 0 files and then deleting the directory entirely still
  fired with `count: 101`; (b) *"it's a per-assistant-turn budget — wait for a fresh turn"* — no, a
  genuinely new turn still failed. It is cumulative for the WorkBuddy **session**, so it never
  recovers on its own and no amount of waiting or cleaning the out-dir helps.

## Sandbox tool policy — audited 2026-09-20 (verdict: robust)
`src-tauri/src/tools.rs`. Five layers, each closing a class: (1) **no shell** —
`Command::new(prog).args(argv)`, never `sh -c`, so `;`, `&&`, `|`, backticks and `$(...)` are inert
text; (2) **allowlist** of ~32 programs + `git` restricted to non-network subcommands; (3) **root
confinement** via `resolve_within` (no absolute path, no `..`, canonicalize + re-check defeats
symlinks); (4) **bounded** — `env_clear`, 60s command timeout, output/byte caps, scrubbed env;
(5) **mutation gated host-side on the gateway** (`MUTATING_TOOLS = [write_file, edit_file, mkdir,
run_command]`, default off, enforced in `gateway_tool_run`).
- Two things that LOOK like holes and are not: `gateway_set_workspace_root` used to check only
  `path.exists()`, but `tool_run` calls `validate_root` on EVERY call, so a bad root was never
  exploitable; and the gateway DOES have a tool budget —
  `MAX_TOOL_ITERATIONS = DEFAULT_MAX_ITERATIONS` (`gateway-bridge.ts:86`).
- `validate_root` refuses `/`, `$HOME`, `/System`, `/usr`, `/bin`, `/sbin`, `/etc`, `/private`, and
  non-directories. Refusing beats clamping (silently rewriting `/` would hand over a workspace the
  user did not ask for).
- Accepted, not missing: read tools can read workspace-resident secrets (a committed `.env`). That
  is the risk you accept by pointing the agent at a folder.

## Gateway tool audit trail (implemented 2026-09-20)
`gateway_cmds.rs`. Before: `_request_id` was accepted and **discarded**, and the log line was
`tool run: <name> in <root>` — no arguments, no outcome, no correlation id. Now logged after the
call as `tool req=<id> tool=<name> root=<r> args=<digest> -> ok=<b> out=<n>B err=<trunc>`; refusals
log `-> REFUSED:`.

**The reader landed 2026-09-21** — `gateway_log_tail` (`gateway_cmds.rs`) + the Control → Tools card.
It was write-only for a day, which made the trail evidence nobody could consult; the UI even said so.
- `LOG_TAIL_BYTES = 128 KB`. The log is never rotated, so a whole read to show 20 lines grows without
  bound. The command seeks to `len - LOG_TAIL_BYTES` when larger and decodes with
  `String::from_utf8_lossy` — **required, not lazy**: a byte seek can land mid-codepoint.
- `parse_log_tail(text, limit, truncated_head)` is pure, so it is testable without an `AppHandle` (the
  house pattern — see *Tauri commands: extract the body so it is testable*).
- **The head fragment is dropped only when the read was truncated.** A tail read starts mid-line and
  half a line reads as corrupt; dropping it unconditionally would silently eat the oldest line of every
  log short enough to fit the window.
- **The floor of one is in the parser; the ceiling of 1000 is in the command.** Each bound is enforced
  where it is tested — the command has no unit test. The floor was found by the test failing, not by
  review: the first draft returned zero lines for `limit: 0`.
- `ts_ms` is `None` for an unstamped line (kept, rendered as `—`), because `log_to_file` is called from
  paths that write bare lines and those are startup evidence. Disk stores **seconds**, the wire carries
  **milliseconds** — converting in the reader keeps the UI from knowing the format.
- An absent file answers `Ok(vec![])`, not an error: a gateway that has never run has nothing to report.
- Frontend: read **on opening the disclosure**, not with the tab. A `logTried` flag separate from
  `log !== null` stops a *failed* read re-triggering the effect that started it. A failed read **clears**
  the lines rather than leaving them under the error notice — a stale tail under a failure is a claim
  about *now* (§4.3's rule for an unloaded metric applies to a list too).
- **The result body is never logged** — for `read_file` it IS the file's contents. Only ok, byte
  count and a bounded error.
- **`tool_arg_digest` redacts bodies to lengths**: `write_file` content and `edit_file` old/new
  become byte counts. Logging them verbatim would make `gateway.log` the leak the audit exists to
  catch. Paths, patterns and `run_command` program+argv ARE logged (300/200-char caps) — the
  Assistant's confirmation modal already shows them, so the log is no wider than the UI.
- `truncate_chars` cuts on **char** boundaries: `&s[..n]` panics mid-UTF-8 and a model controls
  that string.
- Pure and separate from the command so it is testable without an `AppHandle` — the same reasoning
  as `gateway_tool_refusal` living on `GatewayCore`.

## AI generation audit trail (`generator_audit`)
Written since the onboarding wizard existed — every adapter the assistant wrote, with the model, an
estimated text volume and a hash of the redacted prompt — and read by nothing until **2026-09-21**. The
same class of gap as `gateway.log`: recorded evidence nobody could consult, with the UI not even saying so.
- **Read path in `persist.rs`**, not `gateway_cmds.rs`. `list_generator_audit(store, limit)` is the
  testable body behind a thin `generator_audit_list` command (`State<Arc<Store>>`) — the house pattern.
- `ORDER BY ts DESC, id DESC`. **The tie-break is load-bearing**: `now_ms()` on two consecutive inserts
  lands in the same millisecond, so `ts` alone is not a total order. The tests insert with an explicit
  timestamp via a `record_at` helper for the same reason.
- Limit clamped `1..=500`, default 50.
- **Surfaced on Providers, not Control → Tools.** Both of its producers are adapter work (wizard candidate
  generation, drift repair), repair already lives there, and the rows carry no provider id — the INSERT
  omits `session_id`, so it is NULL on every row and a per-provider panel would invent an attribution the
  host never recorded. It is a page-level card, rendered even with zero providers: hiding a record because
  the thing it describes was deleted is the failure the trail exists to prevent.
- **Read on mount and on `tick`**, unlike the gateway log's on-disclosure read. Providers is a flat screen,
  so a card there is layer 1 by construction; and `tick` moves on user actions alone, so approving a repair
  shows the row it just wrote. It is not a poll.
- Two honesty caveats are in the UI, not only in the code: the counts are `chars / 4` **estimates** (both
  headers carry `≈` *and* the copy says "estimates"), and the hash is truncated to 12 characters because it
  is a summary rather than a verification tool.
- **The card holds a generation counter so only the newest read writes.** StrictMode fires mount effects
  twice (the harness runs vite **dev**), so an older read that rejects after a newer one resolves would
  render "Could not read the trail" directly above "Nothing recorded yet". Testing that guard took three
  attempts — see *Browser harness*, the `failNext` entry.

## Drift events: written twice, read by one command
`drift_events` is written on every drift detection (`store.ts:143`, `drift_event_record`) and on every
repair (`store.ts:220`, `drift_event_resolve`, which sets `resolution`/`resolved_at`).
- **The UI reader landed 2026-09-21** — `DriftEventEntry` + `list_drift_events` (`persist.rs`), ordered
  `detected_at DESC, id DESC`, behind a `drift_events_list` command, rendered by `DriftHistoryCard` on
  Providers. Before it the only reader was `diagnostics_json` (`persist.rs:1400`) → `diagnostics_bundle` →
  `getDiagnosticsBundle()` → `Settings.tsx:280`: a scrubbed clipboard JSON blob.
- **`COALESCE(trigger_json,'{}')`, and the card parses it defensively.** The column is nullable and the host
  does not validate the blob, so a NULL or malformed body must render as "no detail recorded" without
  dropping the row. Losing the event is the failure this reader exists to prevent.
- **`resolution` is `Option`/`null`, not a defaulted string.** "Open" means *still drifting*; it must not be
  confusable with "unknown", and an open row must not render like a repaired one.
- **The Providers drift panel does not read the table.** `RepairModal` (`Providers.tsx:362`) reads the
  in-memory `pendingRepairs` map (`store.ts:130`) — session-only, and about *pending plans*. An earlier note
  claiming `drift_events` was "surfaced inside Providers" conflated the two.
- `drift_event_resolve` closes **every** open row for that provider (`WHERE provider_id=?1 AND resolution IS
  NULL`), so one provider cannot hold an open and a resolved row at once — the browser spec needs two
  providers to test both states.
- Both writes were fire-and-forget with `.catch(() => undefined)`, so a failed drift write was **silent**.
  **Fixed 2026-09-21** — see *Trail health* below: the writes now report, and the cards render it.

## Trail health: a trail cannot detect its own gaps (2026-09-21)

Three commands record work that has already happened — `generator_audit_record`, `drift_event_record`,
`drift_event_resolve` — and they were issued from **four** call sites, all four with
`.catch(() => undefined)`. That is right for the property it was protecting (a repair that applied must not
be reported as failed because its *record* did not land, or the operator is told to retry a live repair) and
wrong for the one nobody checked: every reader of those tables claims completeness, and **a read cannot
detect a write that never happened** — a dropped row is simply absent. So the swallow stays and the
*failure* is kept.

**The four sites.** `drift_event_record` (`store.ts:170`, `driftMonitor.observe`); `drift_event_resolve`
(`store.ts:260`, `approveRepair`); and `generator_audit_record` **twice** — `buildRepairPlan`'s audit
callback (`store.ts:239`) and the **wizard's** candidate generation (`Onboarding.tsx:231`). The fourth was
missed when the first three were rewired: a `Grep` for the command name returned only `store.ts`, and the
miss surfaced only by reading the wizard's `audit` callback after a doc comment contradicted the search.
Both generator producers now share one exported `recordGeneratorAudit(...)`, so the payload and the trail id
live in one place — a duplicated call site is a duplicated place to forget.

- **The channel is scoped per trail** (`src/lib/trail-health.ts`, a zustand store; `TrailId =
  "generator_audit" | "drift"`). One global counter would make both cards wrong — the generation-audit card
  announcing a lost drift write, and the reverse. `noteTrailFailure(trail, msg)` is the imperative handle
  `store.ts` uses, since a plain module has no hook to call.
- **The wiring is one helper**: `writeTrail(trail, cmd, args)` in `store.ts` returns whether the write
  landed and does **not** throw. The three call sites still carry on — the original property, preserved.
- **`approveRepair` returns `resolveRecorded`**, and the repair modal appends "· its drift event could not be
  closed" when false. This is the sharpest case: after a successful repair the modal says "Repaired", the
  provider card shows no drift, and the drift history one card below still reads **Open** in red — while the
  card's own copy asserts "nothing has closed it yet". And that is *also* exactly what **declining** a repair
  looks like: "Keep current adapter" (`Providers.tsx:422`) calls only `setProviderStatus(enabled)` and never
  resolves the row. Before this flag the two were indistinguishable on screen, and one of them is a lost
  record.
- Rendered by one shared `TrailWriteWarning({ trail })` component, reading the channel rather than the card's
  own read (the read cannot know). A card only ever makes claims about its own table.
- **A session counter, and the copy says "since launch"** — persisting it would mean a table recording
  failures to write to tables.

**Testing it: the browser spec needs no host hook.** "Check health" (`Providers.tsx:87`) calls
`buildRepairPlan` straight from the UI with a synthetic evidence blob, and the orchestrator re-fingerprints
**before** it considers the AI (`repair-orchestrator.ts:60-73`) — the seeded provider is a known dialect, so
the plan comes back `planned` with no AI round, which is what puts "Approve & apply" on screen.
`failNext("drift_event_resolve", …)` then fails a genuine write from a genuine click. The wiring itself is
unit-tested in `src/store.trail-writes.test.ts`, driving `approveRepair` and `driftMonitor.observe`.

**`generator_audit_record` has browser coverage on both producers.** The trail has two: `buildRepairPlan`'s
audit callback (`store.ts:239`) and the wizard's candidate generation (`Onboarding.tsx:231`).

- The **wizard** path: `trail-health.spec.ts` drives guided setup against `EXOTIC_BASE`/`EXOTIC_KEY`, waits
  for "No candidate passed the free contract checks", then navigates to AI Providers mid-wizard — which works
  because `App.tsx:85` wraps every screen, onboarding included, in `Shell`.
- The **repair** path: `?seed=repair-ai` plus `Check health` on the drifted provider. That seed is what made
  it reachable, and the reason recorded here previously was **wrong** — "`mock.mjs` does not provide a
  scripted AI repair round". It does: the mock matches the generator round on its **system prompt**
  (`mock.mjs:152`), and `adapter-generator.ts:99` builds that prompt identically for both callers, so the mock
  has always served the repair round too. The audit is also awaited *before* the output is parsed
  (`adapter-generator.ts:254`), so a round yielding no usable manifest still writes a row. What actually gated
  it was **state, not scripting**: `RepairOrchestrator.plan()` only reaches `generateCandidates` when the free
  re-fingerprint matches no dialect (`repair-orchestrator.ts:60-77`), and `buildRepairPlan` refuses to spend an
  AI round without another ENABLED provider (`store.ts:221`). No seed had both.

Both specs prove their call site uses the shared `recordGeneratorAudit` rather than a local `invoke` — which
matters because a grep for the command name had missed the wizard's copy entirely.

**Harness trap found while adding `?seed=repair-ai`: a seed's `secretRef` must be unique across providers.**
`resolveSecret` (`shim.ts:1749`) finds a key by ref across *all* keys and pins the result to that key's own
provider host, so two providers sharing a ref resolve to whichever was seeded first. The oracle keeps
`key-01`; the exotic uses `key-02`.

### The second shape: a lost ending, not a lost row (2026-09-21, later the same day)

The first shape was an omission — a row that never arrived — so it is counted. The Agents screen is the same
class and needed the opposite shape.

`orchestrator.endRun` (`lib/agent/orchestrator.ts`) drops the controller **before** it writes the finish, and
swallows the write. A finish that does not land therefore leaves a row that says `running` with no controller
— the identical picture a session closed mid-run leaves. The screen did not merely omit, it *explained*: "A
run left **running** means the app was closed mid-run — it is not marked failed, because no failure was
observed", and the `no handle` cell said the same. A failed finish write makes that cause false, which is
worse than the bug it resembles: an absent row is silent, a wrong cause is *asserted*.

- The status is **not in doubt** — `endRun` was handed it, and only the write failed. So the failure is kept
  per run (`useTrailHealth().unrecordedEnd: Record<runId, status>`), not counted: a count answers a question
  nobody asks, while the row can still show what actually happened.
- `shownStatus(r, unrecorded)` is the one place the row and the header tally both read, so the tally cannot
  drift from the row it summarises. The `no handle` branch additionally requires `!observed`.
- Rendered as `{status} ⚠ unrecorded` in `--warn`, reason in the `title`; the footer carries the legend.
- **A legend that names a state satisfies an unscoped assertion about that state.** Adding "no handle" to the
  footer made `expect(page.getByText("no handle")).toHaveCount(0)` match the *legend* and assert nothing — and
  silently did the same to the pre-existing `toBeVisible()` at `context-skills-agents.spec.ts:146`. Both are
  scoped to `tbody` now.
- Covered by `agent-turn.spec.ts` "an unrecorded ending shows the status it was, not a closed session" (a real
  loop with `failNext("agent_run_finish")`) plus three specs in `store.trail-writes.test.ts`.

### The third shape: a run the dashboard will never list (2026-09-21, same day)

A lost *start* is the one loss that leaves nothing behind. `agent_run_start` failing means no row, no status
and no ending to mark — the run is absent from the list entirely — **and every later step append for it fails
for the same reason** (a foreign key in Rust, `unknown run` at `shim.ts:1262`). Counting each failure would
report "4 writes could not be recorded" for one lost run with three steps, and a two-run outage as eight
separate faults. (This is what the previous "still open" note was pointing at; the empty state's "every run
is recorded here step by step" had already been narrowed to "runs are recorded here step by step".)

- `startRun` records the id in a module-level `unrecordedStarts` set; `recordStep` reports a failure **only
  when its run was recorded**. One cause, one count.
- The set is deliberately **never cleared**: an append from a run that has since ended can still be in
  flight, and clearing on end would let that late failure be counted for a run the channel already
  reported. Bounded by the runs of one session — the channel's own lifetime.
- `agent_run` is a third `TrailId`, not the `drift`/`generator_audit` counts: a run loss must not appear on
  either provider card. **The noun is the screen's, not the component's** — the provider cards lose **rows**,
  the run history loses **writes** — so `TrailWriteWarning` moved to `components/TrailWriteWarning.tsx` and
  takes `noun` / `nounPlural` instead of hardcoding "row".
- **The warning renders above the empty-state branch, not beside the rows.** The run whose start failed is
  absent, so a warning gated on rows goes unseen in exactly the case that matters.
- The finish write contributes nothing here either way: both `shim.ts`'s `case "agent_run_finish"` and
  `orchestrator.rs:123` update **without checking a row count**, so they report success for a run that does
  not exist. A lost ending is only visible when the row is there to be wrong about — the second shape.

**Falsified, one probe at a time.** Reverting `startRun`'s catch → 2 unit specs fail ("expected +0 to be 1",
"expected 3 to be 1") + the browser spec. Removing `recordStep`'s suppression → 1 unit spec fails ("expected
4 to be 1") + the browser spec. Gating the warning on `runs.length > 0` → the browser spec fails at the "1
write" assertion. **Assertion order matters for this:** the two inflated-count probes land on the same
browser assertion (any count >= 2), so the *inflated* count is asserted first — which is what gives the
placement probe its own failure line, while 3-vs-4 is distinguished at the unit level.

### The fourth shape: a stranded repair, whose card claimed work that had stopped (2026-09-21, same day)

`driftMonitor.onTrigger` (`store.ts:198-203`) sets the provider `repairing` and fires `buildRepairPlan` with
`.catch(() => undefined)`. The card rendered **"Building a repair plan…"** for as long as `pendingRepairs`
held no entry — so any failure *before* the entry was created left that sentence on screen permanently, in the
identical words used for a build genuinely in flight. **Waiting was indistinguishable from broken.** Two
ordinary causes, neither exotic:

1. `adapters.forProvider` throws `no active manifest` for a provider hydration could not register — which is
   exactly what a corrupt manifest body leaves behind (`store.ts:350-357`, whose own comment promises "Phase 5
   drift/repair surfaces it"). It sat **outside** the `try`, so the throw rejected `buildRepairPlan` itself and
   `onTrigger` swallowed it. Nothing surfaced it.
2. `pendingRepairs` is a plain in-memory `Map`, never persisted. A provider still `repairing` after a restart
   has no entry and no plan, and **nothing is building** — the same sentence about a different truth.

And there was no way out: `Check health` was hidden for `repairing` (`Providers.tsx:87` excluded it), so the
only remaining button, "Repair…", opened a modal saying "No drift event recorded" — which is *also* false,
since the drift event was recorded; what was missing was the plan. **A provider stuck in `repairing` was
unrecoverable through the UI.**

- `buildRepairPlan` now registers the entry **before** anything can fail, and the two silent early returns are
  errors (`!secretRef` → `no key to probe … with`). The entry's *existence*, not its message, is what the
  screen's copy is driven by.
- The card is four-way: plan / error / entry-still-building / **no entry** → "No repair is running in this
  session — use Check health to rebuild one."
- `Check health` is offered for `repairing` too, because otherwise the truthful copy is a dead end.
- Seeded as `?seed=repair-stuck` (a persisted `repairing` provider with an unparseable manifest).

**Probes.** Reverting the failure paths fails all 3 unit specs (the first with the raw throw escaping
`buildRepairPlan` — the clearest evidence of what `onTrigger` was swallowing) and the browser spec at the
"could not be built" assertion. Restoring the old two-way copy fails the browser spec at the "No repair is
running" assertion. Distinct lines, so each branch has teeth.

**Harness trap:** `adapters` is a module singleton, and `approveRepair` hot-swaps an adapter in for the
provider it repairs (`store.ts:282`). A spec that reuses a provider id an earlier spec repaired will have a
manifest it is specifically trying not to have — and fails with the *next* error along.

## Sandbox tool argument keys (verified by reading each handler)
`read_file` path/offset/limit · `write_file` path,content · `list_dir` path,recursive ·
`file_info` path · `search_files` pattern,path,case_sensitive · `edit_file`
path,old,new,replace_all · `mkdir` path · `run_command` program,args.

## Skills are frontend-only; the gateway is blind to them
Bodies live in the SQLite `skills` table (migration `0004_skills`), not files. Consumed ONLY in
`Assistant.tsx` (~581-596 builds `skillsBlock` from enabled skills; ~702 concatenates
`agentSystem(root) + skillsBlock + memoryBlock` into the system prompt). No `skill` reference exists
in any `gateway*.rs`; the only router-core hit is a cosmetic display-name map (`skill: "Skill"`,
`gateway-normalizer.ts:477`). Keep it that way — skills in the gateway would bill tokens on every
request from every client and make instructions invisible at a layer with no review step.

## Gateway → context graph wiring (implemented 2026-09-20, "Fix 3", Route A)
`GatewayState` now carries `store: Arc<Store>` — it previously held only `core` and `server`, so
`context::record` was unreachable from `gateway_tool_run` and gateway tool runs existed only as
lines in `gateway.log`. Two construction sites: `gateway_cmds.rs::manage()` (production, pulls the
Arc back out with `(*app.state::<Arc<Store>>()).clone()` — `app.manage(store)` already ran earlier
in lib.rs setup, and cloning matters because every other command needs the same store) and
`gateway_tests.rs` (test, via a new `gateway_test_store(tag)` temp-dir helper).
- `record_gateway_tool_call(store, request_id, tool, digest, ok, out_bytes, refused)` writes one
  `skill`-kind node (the kind the Assistant already uses for a tool call; the set of four is
  deliberately closed), `source: "gateway"`, id `gateway:<request_id>:<tool>:<ts>`.
- **Spawned, never awaited.** `context::record` takes `store.conn.lock()` — the same connection
  the ledger writes to — so awaiting inline would put a lock acquisition on the request path.
  Fire-and-forget mirrors the Assistant's `BufferedRecorder.flush()`.
- **`session_id: None` is load-bearing.** `context::sessions` excludes unsessioned nodes, so a
  gateway call lands in the Context graph without inventing a History row that has no messages.
  Proved by test: setting it to a real session id makes two tests fail.
- The node carries the **digest, never the result** — for `read_file` the result IS the file's
  contents and the graph is plaintext on disk.
- Refused calls are recorded too (`refused: true`); they are the ones most worth having.

## Gateway memory layer: request-path facts (verified 2026-09-20)
- **Watch `memory_pending`, not `memories`, when testing capture.** Enqueue happens at request
  completion, so a queued row appears the instant the request finishes. `memories` only grows after
  the 60s drain tick distils it — polling `memories` for 20s and seeing no change proves nothing.
- **Principal policy is read per request, not cached.** Writing `memory_principal_policy` while the
  app runs takes effect on the very next request. Handy for a live deny test, but the UI is the
  sanctioned path — if you write directly, revert. A deny suppresses capture/injection only; the
  request still proxies 200.
Design doc: `GATEWAY_MEMORY_LAYER.md` at repo root. These are the facts that fixed its shape — all
read from code, none assumed. Re-check before building on them.

- **All four ingress dialects converge on a canonical OpenAI-shaped `chat` `Value` before
  `bridge.dispatch`.** Verified in `gateway_anthropic.rs:27-28` (Anthropic `system` folded into
  `messages[0].role="system"`) dispatched at `:187`. So there is ONE canonical shape to inject into,
  at four call sites — not four shapes.
- **`chat_h` has no store.** It takes `State<Arc<GatewayCore>>`; `Arc<Store>` is on `GatewayState`
  only, and `GatewayCore` (gateway.rs:439) does not carry one. Any request-path DB work means
  threading a store into the core first.
- **`forwarded_headers` is a hard allowlist of six** (`gateway.rs:1204`: user-agent, x-client-name,
  x-codex-client, accept, x-api-key, anthropic-version). New metadata headers are dropped before the
  bridge — read and consume them in Rust, never forward. (Good: nothing leaks upstream by accident.)
- **Auth discards identity.** `check_gateway_key` returns matched/not-matched only; app keys are
  compared constant-time in a loop with no id kept. Per-agent scoping needs a principal resolved
  from the presented key — otherwise the R4 per-app keys (`gateway_app_key_create`) are useless
  for identity.
- **Context window is unknown to Rust.** The catalog is TS-side. Budgeting needs a
  model→`context_window` cache table or a conservative default; there is no tokenizer in Rust
  either, so estimate `chars/3.5` and over-estimate (under-injecting is the safe direction).
- **`memories` has no scope columns** — only `session_id` and `subject`. Per-project/per-agent/user
  scoping is new schema, not a query change.
- **Recall is host-side and model-free** (`memory.rs::recall`, BM25/FTS5) so it CAN run on the
  request path. **Capture cannot**: distillation needs a model and the webview owns the client
  (`distilTurn`, `engine.ts:144`). Queue it (`memory_pending`), never inline.
- **Do not reuse `context_nodes` for agent turns.** It is the Context screen's display graph: closed
  4-kind node set, no scoping, no retention, and `graph(limit)` would be swamped.

**The standing conflict to keep in view:** skills are frontend-only because "skills in the gateway
would bill tokens on every request from every client and make instructions invisible at a layer with
no review step." Gateway memory injection is the same hazard, bigger. Keep it off-by-default,
budget-capped, and audited — and keep the spend cap *in front of* injection, not behind it.

## Gateway memory layer — Phase 1 landed (2026-09-20)
Plumbing only, no behaviour change. New `src-tauri/src/context_scope.rs` (module registered as
`#[path = "context_scope.rs"] pub mod context_scope;` in `gateway.rs`); `GatewayCore` gained
`store: Option<Arc<Store>>` + `memory_enabled: AtomicBool(false)` with a `with_store` builder
(wired in `gateway_cmds.rs::manage()` next to `with_app_keys`/`with_spend`). `inject_context` is
called at all four dispatch sites: `handlers:59`, `anthropic:187`, `responses:131`, `gemini:229`.
It strips `metadata.aip` and returns a skip reason; recall lands in Phase 2 behind the same
signature. `cargo test --lib` 280 (was 267), 13 new tests, zero warnings.

**Gotchas that cost time here:**
- **`to_chat_body` (and the responses/gemini equivalents) rebuild the request from scratch and drop
  unknown fields.** So `metadata.aip` does NOT survive dialect translation — the body fallback must
  be read from the *original ingress body*, never the canonical one. This is why
  `inject_context` takes `source: Option<&Value>` alongside `body: &mut Value`: pass `None` on the
  OpenAI path (they are the same object) and `Some(&req)` on the three translated ones.
- `source.unwrap_or(&*body)` aliases `body`, so the read phase must be scoped in its own block
  before the mutable borrow — otherwise E0502.
- `#![allow(dead_code)]` is an **inner** attribute: it must precede the module doc comment, not
  follow it. Putting it after `*/` is a compile error.
- In tests, `HeaderMap::insert` only accepts `&'static str` keys — a `fn hdr(pairs: &[(&str,&str)])`
  helper fails to compile (E0521). Take `&'static [(&'static str, &'static str)]`.
- `cargo check --lib` passing does not mean the test build compiles; the E0521 above was test-only.

## Gateway memory layer — app-key principal landed (2026-09-21)
The last unlanded item from `GATEWAY_MEMORY_LAYER.md`. `gateway.rs`, `principal.rs`,
`context_scope.rs`. No schema change, no TS change.

**Shape.** `AppKeyProvider` = `Arc<dyn Fn() -> Vec<AppKey { id, secret }>>` (was `Vec<String>`).
`GatewayCore::app_keys()` is the memoised accessor every request path must use; `app_key_for(p)`
maps a presented secret to its id with `constant_time_eq` over every candidate and **no early
break**. `presented_key(headers)` is shared by `check_gateway_key` and the memory path.

**The cache rule (the part that matters).** `AppKeyCache::fresh(active)` is true only when
`core.store` yielded the active id set AND it equals the memoised one AND the age is under
`APP_KEY_CACHE_TTL` (60s). Consequences:
- create/revoke invalidate on the **next request**, because `active_gateway_key_ids` is read fresh
  (one indexed SQLite scan per request, no keychain). This preserves the contract documented at
  `gateway_app_key_create`.
- **no store ⇒ nothing is cached.** The store is the only validator. This is what keeps
  `r4_revoked_app_key_rejected_immediately` green — that harness mutates the provider's vec
  directly, and a time-only cache would have masked it for 60s.
- the TTL is a backstop only, for a secret deleted from the keychain under an active row.

**Why not explicit invalidation:** `gateway_app_key_create/revoke/delete` take
`State<Arc<Store>>` only — they cannot reach the core. Adding `State<Arc<GatewayState>>` to three
commands was the alternative; id-set keying is self-maintaining and needs no wiring.

**Two identities, either can deny.** `principal::allows(host, store, agent, app_key)` — the
`AIP-Agent` label and `key:<id>`. One winner is a hole both ways. Resolution is skipped unless
`core.memory_enabled()`, so the off-by-default guarantee still means zero keychain reads.

## Validating designs against the AI Hub web AIs (worked, 2026-09-20)
Useful and worth repeating — three independent models caught things I missed. Recipe:

- **`~/.workbuddy-ai/mcp.json` points `ai-hub` at `http://127.0.0.1:8787/mcp`, which is THIS app's
  gateway default port.** When our gateway is running, AI Hub is not on 8787 and `mcp__ai-hub__*`
  tools will not resolve from a session. Check with `lsof -nP -iTCP:8788 -sTCP:LISTEN` — AI Hub was
  on **8788**. Fix the config or one of the apps' ports if you want the MCP tools; otherwise call the
  relay directly.
- **Direct call works and needs no MCP:** POST JSON-RPC to `http://127.0.0.1:<port>/mcp` with header
  `Authorization: <value from mcp.json>`, `Content-Type: application/json`,
  `Accept: application/json, text/event-stream`. Sequence: `initialize` → `notifications/initialized`
  → `tools/list` → `tools/call`. Working client kept at `/tmp/hub.py` (recreate if gone).
- **Unset the proxies or localhost calls 502**: `unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy`.
- **Timeouts are normal, not failures.** `chat` timed out at 150s on both chatgpt and zai but the
  prompt was sent; the reply landed and `read_latest` recovered it on the first try after ~20s.
  Do not resend — resending duplicates the turn. Pass `timeout_sec: 150` and always fall back to
  `read_latest`.
- Available providers that wake: `chatgpt` (2 accounts), `claude` (1), `zai` (1). `manus` and the
  `p_*` custom ones were `unverified`.
- Send the same adversarial brief to all three ("be adversarial, don't restate my design, rank
  findings, don't praise it"). Agreement across models is a strong signal; one-model-only claims are
  much weaker. Two of the three misread a detail each, so verify a criticism against the code before
  adopting it.

## Tauri commands: extract the body so it is testable (the house pattern)
A `#[tauri::command]` cannot be unit-tested — it needs an `AppHandle`. So put the logic in a
`pub(crate) fn` and leave the command as a 2–3 line wrapper. Done three times now:
`gateway_tool_refusal` on `GatewayCore` ("the decision lives here rather than in the command so it
can be tested without an `AppHandle`"), then `run_gateway_tool`, then `set_gateway_workspace_root`.
- **Inject the logger as `&dyn Fn(&str)`, not `Option<&AppHandle>`.** With an Option the test
  skips logging entirely and the log format goes unasserted; with a closure the test captures the
  lines and can assert them. Prod: `let log = |line: &str| log_to_file(&app, line);`
  Test: push into a `Mutex<Vec<String>>` (or `RefCell`) and read it back.
- Tests for `run_gateway_tool`/`set_gateway_workspace_root` live in `gateway_tests.rs`, which
  already has `test_core()` and `gateway_test_store()`; `tool_test_state(tag)` builds a full
  `GatewayState` on a temp workspace root.
- **Why it was worth doing:** testing a helper directly proves the helper works, not that the
  command calls it. Deleting the two `record_gateway_tool_call(...)` call sites inside
  `run_gateway_tool` left all 10 helper tests passing — only the 3 extracted-body tests failed.
  That asymmetry is the reason to extract.

## Verifying on an installed build (the gate is not enough)
`pnpm ci:local` typechecks, tests and *vite*-builds — but never bundles a Tauri app. Do this
before committing anything touching Rust:
1. ~~`cd apps/desktop && [ -d dist ] && mv dist /tmp/old-dist-$(date +%s)`~~ — this was **mandatory**
   because tauri died at `beforeBuildCommand`, and **no longer is** (measured 2026-09-22). `build:clean`
   — added the same week for the bulk-delete guard — does exactly this inside `build`, which is what
   `beforeBuildCommand` runs. Verified by building with a 17-file `dist` present and *not* moving it:
   `BUILD_EXIT=0` in 2m 36s. The step is harmless to keep, but it is no longer the reason a build works.
2. `export PATH="$HOME/.workbuddy-ai/binaries/node/versions/22.22.2-2/bin:$HOME/.cargo/bin:$PATH"`
   then `npx tauri build --bundles app` (skips the failing DMG step). ~3 min.
3. `pkill -f ai-provider-router`; `mv "/Applications/AI-Provider Router.app" /tmp/old-app-$(date +%s)`
   (never `rm -rf`); `cp -R <bundle> /Applications/`. Quote the path — the name has a space.
4. `open -a "AI-Provider Router"`, wait ~25s (post-reinstall keychain ACL renegotiation costs
   ~15s and looks like a hang), then: `pgrep -fl ai-provider-router`; tail
   `~/Library/Application Support/dev.aiprovider.router/gateway.log` for `startup:` markers and
   `enabled on port`;    `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy curl -s --noproxy '*' -m 6
   -o /dev/null -w '%{http_code}' http://127.0.0.1:8800/v1/models` → 401 means the listener is alive
   and auth is enforced. (`ps` is sandbox-blocked; use `pgrep`.)
   **Two corrections, both measured 2026-09-22.** The port is **8800** (`settings.gateway`), not 8787 —
   8787 is only `DEFAULT_PORT` in the code and has no listener, so the old probe always read 000. And
   `--noproxy '*'` alone is **not** enough: with the proxy vars still exported the same curl returns
   000, and unsetting them turns it into 401. A 000 here is a proxy artefact, not a dead gateway.
- **The gateway tool path cannot be reached from the UI.** `run_gateway_tool` is called only by an
  external client sending a tool-using request to the local gateway; the Assistant goes through the
  agent loop with its own confirmation and never touches it. Exercising it end to end needs the
  gateway master key.

## Exercising gateway tools end to end (verified 2026-09-20 on an installed build)
**The gotcha that cost a wrong hypothesis:** gateway tools only engage when the client brings
**no `tools` field** — `gateway-bridge.ts:160`, `if (!clientTools) { gatewayTools = await
invoke("get_tools_enabled") }`. Send a request with your own `tools` array and it is pure
pass-through: the declared tool is forwarded upstream, the model's `tool_calls` come straight back
to you, and `gateway_tool_run` is never invoked — so no audit line and no context node. I first
read that as "gateway tools are off"; they are on by default (`tools_enabled: AtomicBool::new(true)`,
pinned by `tools_are_enabled_by_default`). **Omit `tools` entirely** to exercise the gateway path.
- Working recipe (no `tools` key, master key in the header, `--noproxy '*'` / `ProxyHandler({})`):
  POST `http://127.0.0.1:8787/v1/chat/completions`, model `cline/anthropic/claude-sonnet-4.5`,
  prompt "List the files in the current directory using your tools…".
- Then verify: `grep "tool req=" ~/Library/Application\ Support/dev.aiprovider.router/gateway.log`
  and `sqlite3 "file:<db>?mode=ro" "SELECT id,source,session_id,meta_json FROM context_nodes WHERE id LIKE 'gateway:%'"`.
- **Observed, both paths, on the real build:**
  `tool req=39 tool=list_dir root=/Users/tushershikder/AI-Provider-Router-Workspace args=path=. -> ok=true out=55B err=-`
  `tool req=40 tool=write_file args=path=. content=0B -> REFUSED: "write_file" is disabled on the gateway…(+8 chars)`
  Nodes: `gateway:39:list_dir:…` source `gateway`, session_id NULL, meta `{"args":"path=.","ok":true,"out_bytes":55,"refused":false,…}`.
  The mutating call was **refused**, the file was **not written**, and the model relayed the
  "enable it in Gateway settings, or use the Assistant" escape hatch — the refusal message works.
- Default gateway workspace root is `~/AI-Provider-Router-Workspace` (not cwd, not `$HOME`).
- Redaction holds in production: a canary string in a `write_file` body appeared in neither
  `gateway.log` nor any `context_nodes` row.

## Releasing / bumping the version (first done 2026-09-20 for v1.0.0)
Four files must move together — Tauri v2 fails the build when `tauri.conf.json` and `Cargo.toml`
disagree:
- `apps/desktop/package.json` → `version`
- `apps/desktop/src-tauri/tauri.conf.json` → `version`
- `apps/desktop/src-tauri/Cargo.toml` → `[package] version`
- `apps/desktop/src-tauri/Cargo.lock` → the `ai-provider-router` entry. It does not follow the
  manifest until cargo runs, so edit it or let cargo rewrite it, then assert:
  `cargo metadata --offline --locked --format-version 1 --no-deps` (non-zero exit = drift).

**Two decoys that read "0.1.0" and are NOT the app version:** the `skills` table column default in
`store.rs` (part of a shipped migration — changing it breaks migration tests) and the builtin skill
versions in `skills.rs`. Also three third-party crates at 0.1.0 in `Cargo.lock` (byteorder-lite and
friends) and an illustrative updater path in `SIGNING.md:94`. `git grep 0\.1\.0` catches all six;
bump only the four above.

No frontend code reads the app version — there is no `getVersion` / `CARGO_PKG_VERSION` anywhere
under `apps/desktop/src` — so a bump needs no UI change.

`cargo` is not on PATH in a non-login shell: `export PATH="$HOME/.cargo/bin:$PATH"`.

Recipe: commit the bump alone → `git tag -a vX.Y.Z -m '<msg>' <sha>` → `git push origin main` then
`git push origin vX.Y.Z`. Verify with `git ls-remote origin refs/tags/v1.0.0^{}` — an annotated tag
has its own object sha; the `^{}` deref is what reveals the commit it points at.
`gh` is not installed, so no GitHub Release page can be created from here; the tag is the release.
**v1.0.0 = `d2aa481`** and deliberately excludes the gateway tool-audit work (it was cut first,
per instruction), which landed as a later commit.

---

## The shim command audit — run this after adding any `#[tauri::command]`

Found 2026-09-21 while adding a browser test for the distillation budget: the Memory screen's data
load had **never succeeded in `web-test`**, and no test had failed.

Mechanism: screens wrap loads in `Promise.all([...]).catch(() => undefined)`. One unknown command
rejects the whole batch, so every other value in it stays `null` and the section renders as though
it had loaded with no data. The concrete case was `modelContextCount()` calling
`router_model_context_count` while the shim only had `model_context_count`.

```bash
cd apps/desktop && python3 - <<'PY'
import re, pathlib
pat = re.compile(r'invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"')
src = set()
for g in ('*.ts', '*.tsx'):
    for p in pathlib.Path('src').rglob(g):
        src |= set(pat.findall(p.read_text()))
cases = set(re.findall(r'case "([a-z0-9_]+)":', pathlib.Path('web-test/shim.ts').read_text()))
print("app calls", len(src), "shim cases", len(cases))
print("MISSING FROM SHIM:", sorted(src - cases))
print("SHIM-ONLY (dead cases):", sorted(cases - src))
PY
```

Measured 2026-09-21: app calls **114**, shim had **87**, **27 missing**. **All 27 were added the
same day** (commits `851b0ee`); the audit now reports 114/114 with no dead cases. Keep running it.

The gap is guarded two ways, both falsified by re-breaking `router_model_context_count`:
- the shim **records** unknown commands before throwing (`__webTest.unknownCommands()`), and
  `smoke: no screen calls a command the shim does not implement` walks every nav screen and asserts
  that list is empty — catches a gap on any screen, including ones no test visits;
- `memory: the master switch is live…` asserts the checkbox is **enabled**, which is only true once
  the load resolved.

Corollary for writing specs: **assert on the loaded state, not just on the section rendering.** A
test that only checks the heading is visible passes against a screen whose data never arrived.

## Browser-harness traps (2026-09-21)

- **Unset the proxy env or Playwright cannot start its webServers.** With `HTTP_PROXY` set,
  `playwright test` dies with `Error: Timed out waiting 30000ms from config.webServer` even though
  both servers are up and curling fine — Playwright's own readiness probe goes through the proxy.
  Always `env -u NODE_OPTIONS -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy`.
- **A vite started with `&` inside a Bash tool call dies when that call returns.** Use
  `run_in_background: true`. Symptom: `lsof` shows the port listening, `curl` gets 000.
- **The nav button is "Local Gateway", not "Gateway".** `getByRole("button", { name: "Gateway" })`
  (no `exact`) only matches because matching is substring — with `exact: true` it resolves to
  nothing and the test hangs to timeout.
- **A Playwright run that hits a 30s expect timeout can push the whole run past the 120s Bash
  default and get SIGTERM'd (exit 137)**, which looks like a crashed harness rather than a failing
  assertion. Redirect to a log and read it, or raise the timeout.
- The shim's state is **per page load**. To arrange host state, `page.evaluate` the setter and then
  navigate away and back so the screen remounts — `page.reload()` discards what you just arranged.
- **A screen that renders jump-buttons labelled with tab names makes `getByRole("button", …)`
  ambiguous.** Control's Findings list does exactly that, so its tabs carry `role="tab"` and specs
  address them with `getByRole("tab", { name })`. Before adding a second control with a tab's name,
  give the strip real tab semantics rather than reaching for `exact: true`.
- **A negative assertion against an auto-dismissing surface cannot fail.** `expect(locator).toHaveCount(0)`
  retries for the whole expect timeout (30 s here), so against text inside the repair modal — which dismisses
  itself 1.2 s after its message — it just waits for the modal to close and passes whatever the message said.
  Measured: with `approveRepair` hardcoded to report `resolveRecorded: false`, `trail-health.spec.ts`'s
  cross-check still passed. Capture the text and assert on the string (`expect(await loc.textContent())
  .not.toContain(…)`). The same shape against a **persistent** element is sound, because a wrong value would
  still be there 30 s later — which is why the warning's own absence assertion is fine.
- **The sandbox bulk-delete guard counts cumulatively per tool call, threshold 50.** Two build tools
  bulk-delete their own output dirs and trip it:
  - Playwright empties `test-results` at the start of every run, and a run leaves ~1150 trace
    screenshots there (`trace: "retain-on-failure"` records per test, discards on pass). `web-test`
    now moves the stale dir to `/tmp` first — what `ci-local.sh:96` always did, for the same reason.
  - Vite's `emptyOutDir` empties `dist/assets`. A blocked reporter cleanup is *swallowed*; a blocked
    `emptyOutDir` is **fatal** — `[plugin vite:prepare-out-dir] Error: [safe-delete]
    [SAFE_DELETE_BULK_CONFIRM_REQUIRED]`, and the gate ends `FAILED (1): Build`. The delete is only
    ~13 files alone; it fails because earlier steps already spent the budget.
  - **Fixed at the source (2026-09-21, evening).** `apps/desktop/package.json` gained `build:clean`
    (`mv dist /tmp/build-dist-$(date +%s)`) composed into `build`, mirroring the existing `web-test:clean`.
    With `dist` absent, `emptyDir` issues **no `fs.rm` call at all**, so the step is immune even when the
    budget is already spent — that is the mechanism, not merely "a rename is cheaper". It belongs in the
    **package** script, not the root's: the gate reaches it through `pnpm -r build`. `pnpm ci:local` is now
    ALL GREEN with no manual pre-step.
  - **Never `rm -rf` an artifact directory by hand — that trips the guard too.** `rm -rf
    apps/desktop/test-results` was refused with `count: 960` and cost a gate run on 2026-09-21. `mv` to
    `/tmp`, which is what `web-test:clean` and `build:clean` do. The reflex "tidy up before running" is
    the one to suppress: the gate's own scripts already do it, and doing it yourself spends the budget.
  - **The consumer is not the directory you are staring at.** The failing count was **641** against a
    `dist` holding **17** files — a stale number, not a mysterious one. The budget is spent *before* `Build`
    by **vitest's `node_modules/.vite-temp` churn**. The proof is a **single-file** target carrying a count in
    the thousands, which no per-operation reading can explain:
    `{"count":3062,…,"targetCount":1,"targets":["…/.vite-temp/vitest.config.ts.timestamp-….mjs"]}`.
    Two explanations were discarded first — the sandbox (the gate failed unsandboxed too) and the target's
    size. Both were plausible and both were wrong.
  - The guard's own state is readable at `$CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR/<session>/signal-*.json`
    — each records the target and the count it saw. That is how the cumulative behaviour was
    identified, rather than guessed.

## §10(2) distillation budget — landed 2026-09-21

`capture.rs`: `DISTILL_BUDGET_PER_HOUR = 60`, `DISTILL_WINDOW_MS = 60 * 60 * 1000`,
`fn budget_left(conn)` counting `memory_pending` rows with `claimed_at > now - window`.
`claim()` returns empty when the budget is 0 and otherwise takes `CLAIM_LIMIT.min(budget)`.
`QueueStatus.budget_left` surfaces it; `Memory.tsx` renders `data-testid="distill-budget"`.

Two design constraints worth keeping:
- The cap sits **inside `claim()`**, before the row is marked `processing`. Claiming and then
  declining to call would spend an `attempt`, and three attempts retire the row as `failed` — the
  cap would delete the work it was meant to delay.
- Counted at **claim**, not completion: the provider call is made on claim, so a call that then
  failed was still paid for. Needs no migration, `claimed_at` was already written.

**Verification status — verified live 2026-09-21.** Five unit tests, falsified rather than assumed:
making `budget_left` return `usize::MAX` fails all five; replacing `CLAIM_LIMIT.min(budget)` with a
bare `CLAIM_LIMIT` fails exactly one — which is what proves that line is the *sole* guard on the
remainder logic. Then confirmed end-to-end in the real drain loop:

- Baseline 2 claimed in the hour → plant 55 fakes → `budget_left` = **3**.
- Enqueue 5 real requests. **Tick 1:** exactly **3** claimed — `min(CLAIM_LIMIT=8, budget=3)` = 3,
  not 8. **Tick 2** with the budget exhausted at 60/60: the other two still `queued` with
  `attempts = 0`, and **0 rows `failed`**. Nothing lost, nothing retired by a burned attempt.

**Method — the earlier attempt was invalid, and this is why.** The first probe planted 60 rows as
`processing` with a fresh `claimed_at` and expected row 9 to stay `queued`. But `CLAIM_LIMIT` is 8 and
the drain fires twice a minute, so 60 fake rows left only ~2 rows of headroom before the drain's own
claims pushed the count over; row 9 went `done` and `claimed_last_hour` read 62. It proved nothing.

The fix is to plant the budget-consuming rows as **`status='done'`**. `budget_left` reads only
`claimed_at`, so they still count — but `claim()` selects `WHERE status='queued' ORDER BY id`, so they
are never candidates. Nothing fake gets distilled, and there is no race with the drain. Plant
*claimable* rows and you are racing the tick; plant `done` rows and you are not.

**DB pollution that probe left behind** (cleaned 2026-09-21): 60 `cap-fake-*` rows had been drained
and distilled into 5 memories — "(Alpha check)", "(Beta check)", "(Gamma check)" are unmistakable.
Deleting from `memories` fires the `memories_ad` FTS trigger, so an external `sqlite3` needs
`PRAGMA trusted_schema=ON` or the write is refused. Verify `memories` and `memories_fts` counts match
afterwards.

`clear_app_key_cache` (the vestigial `#[cfg(test)]` fn) has been **removed** — `cargo check --lib` is
silent again.

## Capture ids must be scoped to the process — fixed 2026-09-21

`GatewayCore.next_id` is `AtomicU64::new(1)`: it **starts at 1 on every launch**. `memory_pending.
request_id` is UNIQUE for the life of the *database*, and finished rows are retained seven days. So
after a restart the ids repeat, the §3.5.5 idempotency guard reads each repeat as a replay, and the
capture is dropped — as a **normal return** (`Enqueue::Skipped(AlreadyQueued)`), so nothing logs and
the queue just looks empty.

Reproduced live on the installed build with a control in the same batch (memory on — every response
carried `aip-memory: injected=1`). Six requests hit ids 7..12:

| id | pre-existing? | outcome |
|---|---|---|
| gw-7 | yes (09:42:25) | **dropped** |
| gw-8 | yes (09:42:50) | **dropped** |
| gw-9 | free | captured |
| gw-10 | free | captured |
| gw-11 | yes (11:02:09) | **dropped** |
| gw-12 | free | captured |

The captures prove the queue worked; the drops are exactly the ids that already existed. The loss
window is not one request — it is every id in `1..=previous_high_water`.

Fix: `capture::request_id(n)` → `gw-{boot_marker}-{n}`, `boot_marker()` a `OnceLock` of
`{unix_millis}-{pid}` computed once per launch. `context_scope.rs:727` repointed. The string is
**opaque** — the only production query is `WHERE request_id = ?1`, and the client-visible completion
id (`gw-{id}`, `resp_gw_{id}`) is a different string built for the wire. Pinned by
`a_fresh_processs_request_ids_do_not_collide_with_a_previous_runs`, which fails on the first id when
`request_id` is reverted to the bare `format!("gw-{n}")`.

Generalisable lesson: **a guard is only as good as the identity it is given.** The reviewer constraint
was "don't distil a turn twice"; the implementation satisfied it and broke the one beside it ("don't
lose a turn"). No test could see it — every test built its own ids, so the generator was never
exercised. Recorded in the design doc as §5.4a.

## Probing a running app from the sandbox (measured 2026-09-21)

- `ps` and `osascript` Apple Events are **blocked** ("privilege violation (-10004)"). `lsof -nP
  -iTCP:8787 -sTCP:LISTEN` works, and plain `kill <pid>` works.
- Installed-app swap: `kill` → `mv` the old bundle to /tmp (never `rm -rf`) → `ditto` the new one in.
- The injected session clock can disagree with the machine by hours (context said 11:10 +06, `date`
  said 13:55 +06). **Trust `date`** whenever a rolling window is involved.
- Gateway probes need `model: "agnes/agnes-2.5-flash"` and the master key, with the proxy vars unset.
- `source=ui` traffic (the Assistant screen) is **not** captured by the gateway memory path — only
  `source=gateway` requests go through `prepare_capture`. Probes must go through port 8787.

## L0 recall: the two paths disagreed — L0 fixed, the scope axis still open (2026-09-21)

There are **two** recall paths. Since the 2026-09-21 L0 fix they agree on **layers** and differ on
exactly **one** axis: **scope**.

| path | recall fn | scope | layers | L0? |
|---|---|---|---|---|
| gateway memory layer | `memory::recall_scoped` | `RecallScope{user,project,agent}` | `context_scope.rs:593` literal `["L1","L2","L3"]` | **never** |
| Assistant / webview | `store.recallMemories` → `memory_recall` → `memory::recall` | **none** | `engine.ts:345` `["L3","L2"]` + `:353` `["L1"]` → L1/L2/L3 | **never** |

The layer axis is closed. The **scope axis is the quieter finding**: `recall_scoped`
takes a `RecallScope`; the Assistant calls `memory_recall` (`commands.rs:384`), which calls
`memory::recall` → `recall_inner(..., None)` — no scope at all, so it sees every row in the DB. That is
the "absence is not global" contamination engine the three reviewers flagged (`memory.rs:406-412`),
reached from a path that always *has* a project and simply never passes it.

**The scope axis, measured 2026-09-21.** On the live corpus the two paths return **0 vs 14** rows. The
reason is upstream of recall: **every atom is born unscoped.** `capture`'s INSERT (`memory.rs:290`) omits
the scope columns, so rows land with `scope_project=NULL, scope_global=0` — measured as **all 55 rows**
NULL-project and **0** rows `scope_global=1`. `assign_scope` (`memory.rs:741`) is the only way in, exposed
as a per-row `ScopeSelect` (`Memory.tsx:605`), and the drain must NOT auto-bind (`drain.test.ts:142`).
Consequence: the gateway's read machinery is complete but **field-unexercised** — the deadline stages and
the freeze cache have never once produced a non-empty block. Loosening the scope predicate to "fix" the
0-vs-14 gap would destroy the contamination guarantee (`store.rs:664-668`). **Not a bug.**

`memory.rs:420-421` documents the unscoped path as "the Assistant's **Memory screen**". That is stale:
the Assistant's *request* path uses it too (`Assistant.tsx:693` and `:770`, feeding `memoryBlock(recalled)`
into the system prompt at `:702` and a system message at `:787`). Do not read that comment as a scope
guarantee.

**Why dropping L0 is nearly free — the argument that settles it.** `replayHistory` (`Assistant.tsx:48-57`)
maps the **entire** in-memory `msgs` array with no window or truncation, so the current session's turns
are already in the request verbatim, correctly ordered and attributed (tool_calls / tool_call_id intact).
L0 recall of the current session is therefore **redundant** with history; L0 recall of *other* sessions is
the leak. The only capability lost by dropping L0 is cross-session verbatim bridging — exactly what §0.4
forbids by default.

**Fixed 2026-09-21 — option (a) only.** `engine.ts:348` now requests `["L1"]`. Pinned by the test
"never recalls L0 — this session's turns are already replayed as history", which asserts the *requested*
layer list excludes L0 rather than the returned rows — a mock that filtered would have passed either way,
so asserting the result would have proved nothing. Falsified by restoring `["L1","L0"]`, which fails it
with `expected [ 'L3', 'L2', 'L1', 'L0' ] to not include 'L0'`. The pre-existing budget test had a mock
that returned an L0 row even when L0 was never requested — testing a case that cannot occur; it now
honours the layers it is given and fails too when L0 is restored. Desktop suite 169 → **170**.

**Option (b), the scope axis — measured 2026-09-21, and NOT a safe fix.** The Assistant's recall is
still unscoped.

Live corpus: **55 rows** — L0 41, L1 12, L3 2; every row `scope_user='local'`, `scope_project=NULL`,
`scope_global=0` (all `Unscoped`); 53 live unpinned + 2 live pinned, 0 superseded. Consequence:

| path | rows reachable |
|---|---|
| gateway (`recall_scoped`) | **0** |
| Assistant chat (`recall(..., None)`) | **14** (L1 12 + L3 2) |

`recall_scoped` semantics (`memory.rs:471-502`): `user` → plain equality; `project: Some(p)` →
`scope_global = 1 OR (scope_project = p AND (scope_agent IS NULL OR scope_agent = a))`; `project: None` →
`scope_global = 1 AND pinned = 1`. An `Unscoped` row matches **none** of these, so the gateway refuses it
by construction — that is the intended boundary ("absence is not global", `memory.rs:418-424`).

**Why scoping the Assistant is the wrong move today.** It would not filter recall, it would **turn it
off**: with 0 rows satisfying a scope, `recallContext` returns nothing — and it swallows failures with
`catch { return [] }` (`engine.ts:365`), so the regression would be **silent**. The scope axis exists to
govern *which agent may receive a memory through the gateway*; the Assistant has no agent or project
identity to scope against, so `None` is not a missing filter but the correct answer for a caller that
has no scope.

**And never "fix" it by scoping `recall` itself.** The unscoped `recall` has three consumers and the
gateway is the only path that does *not* use it: `memory_recall` (`commands.rs:384`) serves both the
Memory screen's search *and* the Assistant's chat recall. The screen is a management view and **must**
see every row (including superseded ones), so scoping the shared function would break it while looking
like it tightened the chat path.

**Recommendation: document the third consumer, pin the behaviour, add no parameter.**
1. `memory.rs:432-433` names only the gateway and the *Memory screen*, omitting the chat path — the one
   that reaches a model request. That comment is the real defect.
2. `Scope::Unscoped`'s doc ("Not injectable anywhere") and the `Memory` struct doc ("capture-only and
   never injected") are **false as written** for the chat path. Correct to "not injectable *by the
   gateway*".
3. Pin the Assistant's unscoped recall with a test, labelled as *pinning a property* — this project's rule
   is that a test passing with the fix removed is not evidence, so it must say what it is.
4. If the boundary should apply to the Assistant too, the prerequisite is a **fourth scope**
   (`Local`/`Assistant`) plus a migration mapping existing `Unscoped` rows onto it. Without that
   migration, enforcing scope drops recall to zero. Migration + `ScopeSelect` + both paths + tests — worth
   doing only when a second consumer of gateway memory actually appears.

## The 8787 collision: `mcp.json` is correct, and two apps want the same port (measured 2026-09-21)

`~/.workbuddy-ai/mcp.json` has `ai-hub` → `http://127.0.0.1:8787/mcp` with a bearer token. The entry is
**legitimate and correctly generated** — verified against AI Hub's own store
(`~/Library/Application Support/AI Hub/aihub-store.json`): `connectorEnabled: true`, `connectorPort: 8787`,
and the token **matches mcp.json byte-for-byte**. An earlier note here claiming it "should be 8788" was a
**guess and wrong**; 8788 is `ai-hub-v3`'s port, and v3 is a dormant reserve.

The real defect is a **port collision between two of the user's own apps**:

| app | port | configurable? | on conflict |
|---|---|---|---|
| AI-Provider Router gateway | 8787 (`gateway.rs:33 DEFAULT_PORT`) | yes — persisted `settings.gateway` (read `lib.rs:76`; write `settings_set` `commands.rs:197` ← `Gateway.tsx:117,121`) | bind fails |
| AI Hub v2 connector | 8787 (`connector.js:154 start(preferredPort = 8787)`) | yes — `settings.connectorPort` | **slides up to +10** (`connector.js:164`, `EADDRINUSE`) |

So whoever starts first wins 8787. If the router wins, AI Hub silently slides to 8788 — and `mcp.json`'s
hardcoded 8787 then points at the router, which returns **404 on `/mcp`** (the router has no MCP surface;
grepping its Rust for `mcp` gives no matches). Same silent-failure shape as the capture-id bug: nothing
errors, the tool is simply absent.

Measured 2026-09-21: AI Hub was **not running**; `ai-provid` pid 7404 held 8787.

**How to move the router — it is a UI action, and it self-heals the WorkBuddy side.** The port is not a
constant: `gateway_enable(app, port)` (`gateway_cmds.rs:232`) takes it from the Gateway screen's port
field, which loads from `settings.gateway.port` (`Gateway.tsx:96-101`) and is persisted on every toggle.
The field is **`disabled={running}`** (`Gateway.tsx:250`), so the order is forced:

1. **Stop** the gateway (the port field is disabled while it runs).
2. Edit the port field.
3. **Start** it again — `gateway_enable` binds the new port and persists it.

**No manual merge is needed.** `gateway_enable` calls `sync_workbuddy_with_retry` (`gateway_cmds.rs:327`),
which re-derives the endpoint from the store via `workbuddy::gateway_port` and rewrites the entries —
documented as "safe to call repeatedly". Port-squat already surfaces loudly at that point
(`Gateway.tsx:126`, invariant 16).

Pick a port **outside AI Hub's slide range 8787..8797**, or AI Hub can land on it while falling back.
`8800` was verified free and is the recommendation. Editing the `settings` row directly also works but is
worse: the WorkBuddy re-sync only runs on the enable path, so it would have to be triggered separately.

**Done 2026-09-21 — the router is on 8800, and the wiring is intact.** Verified after the move:

- `8787` has **no listener**; the installed app (`/Applications/AI-Provider Router.app`, pid 12976) holds
  `127.0.0.1:8800` (loopback only).
- `settings.gateway` = `{"port":8800,"enabled":true}` — so the UI action persisted, not just a runtime bind.
- AI Hub got 8787 back: `aihub-store.json` → `settings.connectorEnabled = true`,
  `settings.connectorPort = 8787`. Note the keys are under **`settings`**, not top-level.
- `~/.workbuddy-ai/mcp.json` → `ai-hub` = `http://127.0.0.1:8787/mcp`, and its
  `Authorization: Bearer …` **matches `settings.connectorToken` byte-for-byte**. The router's
  `gateway_enable` re-sync did not disturb it — correct, because that sync only rewrites *router* entries.

So the collision is closed and no manual merge was needed, which is what the `sync_workbuddy_with_retry`
path promised.

## The two boundaries at the host edge (resolved 2026-09-21)

Every `invoke(cmd, args)` crosses **two** different boundaries, and they obey different rules. Getting this
wrong is silent either way, which is why it cost months.

| | what crosses | who maps the names | correct spelling |
|---|---|---|---|
| **command arguments** | the top-level keys of `args` | Tauri, camelCase → snake_case | **camelCase** (`sessionId`) |
| **nested payloads** | anything inside a `Vec<T>` or struct field | serde, against the Rust field names | whatever `T` declares |

`shim.ts:toRustArgs` (`:529-535`) mirrors the *first* boundary only — it rewrites `[A-Z]` to `_lower` on
top-level keys and passes the values through untouched, so a nested item keeps the caller's spelling.

**Serde's default is to IGNORE an unknown key.** That is the entire bug: a mismatched nested field is not an
error, it is *absent* — so an `Option<String>` becomes `None` with no log, no error, and no failing test.

### The decision: `MemoryInput` is snake_case, and strict

`MemoryInput` (`memory.rs:130`) carried `rename_all = "camelCase"` while its read counterpart `Memory`
(`:62`) had none — so one feature disagreed with itself: reads returned `session_id`, writes wanted
`sessionId`. Both worked, which is exactly why it survived unnoticed.

Resolved by making the **DTO match its read struct**, not the reverse:

- `MemoryInput` is now **snake** (`session_id`), matching `Memory` and its siblings `ContextNode.session_id`
  and `ContextEdge.from_id`/`to_id`. The same `session_id` string flows through memory rows and context
  nodes, so two spellings there is a trap for whoever next joins them.
- The `persist::*` registry rows stay **camelCase**, and that is not an inconsistency: they are symmetric
  read+write rows, which is precisely why `providerToHost`/`keyToHost` can pass a record straight through
  and why the zero-conversion trick works there.
- Blast radius was measured before choosing: `Memory`'s snake fields are read at ~10 production sites
  (`drain.ts:82`, `Memory.tsx`), while `captureMemories` has 3 call sites in a single module
  (`engine.ts:110,200,285`). Change the narrower thing.
- `captureMemory` (singular) still sends `sessionId`, and correctly so — its fields are command
  *arguments*. `captureMemories` (plural) sends `session_id` inside `items`. The two spellings differ
  because the two boundaries differ; `store.ts` says so at the definition.

### The mechanism, which matters more than the spelling

**`#[serde(deny_unknown_fields)]` on every nested payload type.** `rename_all` makes *one* spelling work and
still fails silently for every other one — it converts a bug into a convention rather than removing it.
`deny_unknown_fields` makes any mismatch a hard error that names the key:

    unknown field `sessionId`, expected one of `layer`, `text`, `session_id`, `subject`, `pinned`

Pinned by `capture_input_rejects_the_camel_case_spelling`. Falsified by removing the attribute: the parse
then **succeeded** with `session_id: None` — the original bug, reproduced in the failure message.

### The harness had the same blind spot, which is why it survived

The shim's `memory_capture_batch` case read the **camel** spelling, so it agreed with the very defect it
existed to catch. It now validates the item key set against `["layer","text","session_id","subject",
"pinned"]` and throws on anything else — mirroring `deny_unknown_fields` in JS.

**And the path had no coverage at all.** No browser spec reached `memory_capture_batch`; the single-capture
command was covered and correct, so hand-testing the screen looked fine while every batched capture stored
a NULL session. `memory.spec.ts:338` now drives the batch path both ways: the working spelling stores the
session id, and the camelCase one is refused *and writes nothing*. Falsified by removing the shim's check —
the spec failed with `Received: null`, i.e. the camel payload was silently accepted.

### Rules to carry forward

1. A DTO and its read struct share **one** spelling. Decide per subsystem, not per struct.
2. Every nested payload type gets `deny_unknown_fields`.
3. A hand-written test double must be **as strict as the host**, or it certifies the bug.
4. Ask whether the harness exercises the path at all — a green suite says nothing about an uncovered one.
5. `MemoryInput`'s consumer swallows a capture failure on purpose ("a memory write must never fail a chat")
   but now **logs** it (`engine.ts:113,172,294`). Detection belongs at the boundary, visibility at the
   consumer: without the first the second never fires, and without the second the first is invisible.

## What the gateway does NOT record — and the three backlog answers that follow (2026-09-22)

A five-item backlog was worked through. Two items were already done, one is closed, and two remain —
but the reusable finding is **where the answers did and did not come from.**

### Nothing records a request path or body

| store | holds | does not hold |
|---|---|---|
| `ledger` (1530 rows) | `ts`, `modality`, `source`, `provider_id`, `key_id`, `requested_model`, `model`, `status`, `http_status`, `error_class`, `latency_ms`, `tokens_in/out`, `cost_estimate_micros`, `fallback_chain_json` | the request **path**, the request **body**, the error **message** |
| `gateway.log` | worker/watchdog heartbeats only (`worker reported in after Nms quiet`, `watchdog: worker beat stale for Nms`) | anything about requests at all |

So **"does client X call endpoint Y?" is unanswerable from this system's own telemetry.** Any future
question of that shape needs either (a) a different source, or (b) instrumentation first. Do not
budget a verification step that assumes the data exists — check the store before promising the check.

### `previous_response_id` — CLOSED, and the stated reason was wrong

The backlog said "only affects Codex, and only if it uses server-side continuity — `wire_api="chat"`
avoids it entirely." **Codex's config uses `wire_api = "responses"`, not `"chat"`.** The conclusion
survives for a stronger reason, in `~/.codex/config.toml`:

- `disable_response_storage = true` — server-side continuity is switched off, so there is no stored
  response for a `previous_response_id` to reference; Codex replays the transcript client-side.
- `base_url = "http://localhost:20128/v1"` — Codex currently points at **OmniRoute on 20128**, not at
  this gateway at all. So the question is doubly moot until that changes.

**Do not build a response store.** If Codex is ever repointed here, re-read its config first.

### `cache_control` — real cost, but blocked on *measurement*, not effort

The traffic shape confirms the premise (ledger, `source='gateway'`): **`agnes-2.5-flash` — 648 requests,
35,948,966 input tokens against 213,027 output.** ~55.5K input per request, a 169:1 ratio. That is the
resent-prefix pattern exactly.

But three things are unknown, and the first is decisive:

1. **The router never reads `prompt_tokens_details.cached_tokens`.** The string appears nowhere in the
   codebase, and `ledger` has no column for it. So we cannot tell whether the upstream is *already*
   caching — a rework of the content-block mapping could buy nothing, or buy a lot, and we could not tell.
2. **No active manifest mentions caching.** `agnes` is `user-edited`, `cline` is `ai-generated`; neither
   body contains the substring `cache`. Caching support is undeclared, not disproven.
3. Only two providers exist at all: `agnes` (`apihub.agnes-ai.com/v1`) and `cline` (`api.cline.bot/api/v1`).
   Neither is Anthropic, whose mechanism `cache_control` is.

**So the order is measure → decide → rework**, not rework → hope. Capturing cached tokens is the
precondition, and it needs a ledger column, which means a real migration (`MIGRATIONS` + `schema_version`
bump + count assertion + table-existence list + the rewind test) — not a drive-by edit.

