# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**The shipping version is the one in `apps/desktop/src-tauri/tauri.conf.json`** — that is what Tauri
stamps onto the bundle and what the gateway reports. Every other manifest is expected to agree with
it, and `pnpm check-version-sync` fails the build when one does not.

## [Unreleased]

### Added

- **A provider can be set up with its models, and each model can be tested before you commit to
  it.** Adding a provider by hand previously recorded a name, a URL and an auth scheme and nothing
  else — no model was ever entered, so a provider whose `/models` endpoint is missing, incomplete or
  gated was installed with an empty catalog and could not serve a request. The manual flow is now
  three steps: **Connection → API key → Models**. Models can be fetched from the provider or typed
  in by hand (id, text/image, optional context window), and each row has a **Test** button that
  sends one real request and reports what came back. A provider can also be **edited** after it
  exists, from an Edit button on its card.

  Two details worth knowing. The wizard creates the provider at the end of step 1 rather than at the
  end of the flow, because a model can only be tested by sending it a request and a request needs a
  key — abandoning the wizard leaves a visible draft provider you can remove or finish, rather than
  a form that cannot answer the question it is asking. And a hand-typed model is stored with
  `origin: 'manual'` (migration 0018, `models_cache.origin`), because a catalog refresh replaces a
  provider's discovered rows wholesale: without that distinction the first Refresh would silently
  erase exactly the models the operator added because the provider never listed them.

- **A provider can carry custom request headers, and they reach every endpoint — including the model
  list.** Some gateways serve only a set of recognised clients and refuse everything else before they
  look at the key. `agentrouter.org` is one: measured 2026-09-29, holding the credential constant and
  varying only `User-Agent`, an unrecognised client gets
  `401 unauthorized_client_error` ("unauthorized client detected") on every path, while
  `claude-cli/2.0.0 (external, cli)` or a UA containing `zcode` gets a real answer about the key.
  There was nowhere to put such a header: the manifest grammar allowed per-endpoint headers on
  `generateText` and `generateImage` but **not on `listModels`**, and `listModels` is the call every
  probe, key test and catalog refresh makes — so a gateway of this kind was unreachable even with
  text generation configured correctly.

  `LIST_MODELS_ENDPOINT` now carries `headers` (both interpreters merge it, and the Rust read model
  gained the field), the manual form has a **Custom headers** field that applies to every endpoint,
  and auto setup offers the same field when it meets a gate. Two details: the field refuses a header
  named like the auth header, because the endpoint merge would replace the `{{secret}}` sentinel and
  the request would then be refused by `EgressError::SentinelMissing` — a correct refusal that looks
  like a credential fault; and editing a provider hydrates the field from its stored manifest
  (`headersToLines`, minus the template's own headers), because `save()` rebuilds the manifest
  whenever anything differs and an empty box would have deleted them while the operator was editing
  the provider's *name*.

- **Outbound provider requests now identify the client.** `egress.rs` built both reqwest clients
  without `user_agent()`, and nothing in `interpreter.rs`, the TS `ManifestInterpreter` or any
  manifest set one, so the app sent **no `User-Agent` at all** — non-conformant (RFC 9110 §10.1.5
  says one should be sent) and, on the gateway above, the direct cause of the refusal. The
  credentialed client now sends `AI-Provider-Router/<version>`, which covers both request paths
  (`EgressState::new` is what the app and the `aiproviderd` gateway each construct). It is the honest
  name and **not** a client these gateways already trust: opening them by impersonation, for every
  provider, is not a default this product should apply on the operator's behalf. A per-provider
  header overrides it, which is what the field above is for.

### Changed

- **The gateway no longer advertises tools it will refuse.** Four of the eight agent tools
  (`write_file`, `edit_file`, `mkdir`, `run_command`) are refused at call time while gateway
  mutation is off, which is the default — but all eight schemas went out on every request from
  every client that brought none. The gateway now advertises only the four it will actually run
  (`gateway_tool_set`), and the eight descriptions were trimmed by 318 characters (26%).
  **Measured on the live gateway: 1,721 → 1,042 prompt tokens, a 39.5% cut**, with the
  tools-suppressed control unchanged at 534 — so the whole delta is the registry. The saving is
  conditional on mutation being off; see `FIXED_CONTEXT_STRATEGY.md` §6.4 for why the two hosts
  disagree about that. Applies to the `aiproviderd` gateway and the in-app Assistant.

- **A key excluded by the auth breaker is no longer excluded forever.** Three consecutive auth
  failures opened a breaker that only a *successful* attempt could clear — and an open breaker meant
  the key was never tried again, so no success could ever arrive to clear it. A credential rotated
  back into service, or an upstream that had a bad five minutes, stayed dead to the router for the
  life of the process. The breaker is now half-open after 60 s: the key is tried again, and that one
  attempt either clears the breaker or re-arms it, so a genuinely revoked key costs one `401` per
  window instead of being silently dropped forever. Applies to both the `aiproviderd` gateway and
  the in-app Assistant. See `DECISIONS.md` 2026-09-27.

### Fixed

- **A gateway that refused the *client* was reported as a provider that rejected the *key*, and the
  key was taken out of rotation for a decision the provider never made.** Adding `agentrouter.org`
  produced `key-01: the provider rejected this key — HTTP 401: {"error":{"message":"unauthorized
  client detected, contact support for assistance at https://discord.gg/HgekCyHJqB"},...}. It is out
  of rotation until you enable it.` Every word of that is wrong in a specific way. The provider did
  not reject the key — measured, it answers `unauthorized_client_error` to *any* unrecognised client
  and only reads the credential once the client is accepted, at which point the same dummy key is
  judged normally as `无效的令牌`. `verdictFor` mapped every `401`/`403` to `invalid`, and `invalid`
  is conclusive: `store.ts` writes it and `HealthTracker.isKeyUsable` then keeps the key out of
  rotation, so a working credential was disabled by a request that never examined it.

  A `401`/`403` whose body names a *client* problem is now classified `unverified` — the verdict that
  means "leave the status alone" — and the notice says the client was refused and the key was never
  judged. Detection lives in one place (`client-gate.ts`), because the desktop key test and the probe
  both need it and two copies of one rule is this repository's most reliable defect. The marker list
  is deliberately two strings long, both quoted from the measured response, and the module says what
  that costs: a gateway that words its refusal differently is not recognised and falls back to
  blaming the key, which is the status quo — the opposite direction would tell an operator their
  rejected key is fine. Four tests; falsified by disabling the detector, which reproduced the
  operator's message character for character.

- **Auto setup could not diagnose a client gate, and reported it as a fingerprint failure.**
  `runProbes` sent only `accept`, and `ProbeAttempt` recorded no body for a non-2xx response, so a
  gateway that refuses the caller looked exactly like one that refuses the key: nine `401`s with no
  shape. `fingerprint` then returned `unknown` — and, worse, still emitted "chat/completions endpoint
  exists" and "messages endpoint exists", which are vacuous on a host that answers `401` to every
  path, and handed the operator two confident facts that were artefacts of the refusal. The probe now
  reads a refusal body far enough to ask one question of it, keeps only the matched marker (never the
  body — `shapeOf` strips values, so the signal would not have survived redaction anyway), and
  `fingerprint` checks for a gate **first**, because a uniform refusal invalidates every other
  reading.

  The gate is now a configuration answer rather than a dead end. `runProbes` accepts extra headers,
  `OnboardingInput` carries them, and the wizard shows a panel naming the marker with a header field
  and **Retry with these headers** — which re-probes with them and keeps them on the provider, so
  they are used for every later request too. The generator is deliberately *not* run for a gate: it
  would spend calls on a refusal that is already explained, and it cannot know which client the
  gateway will accept. The failed provider row is deleted before the retry, because `start()` always
  creates a fresh pending provider and retrying without that would leave one abandoned row per press.

- **The automatic provider setup — probe, fingerprint, AI-written adapter, contract tests — was
  built, tested, and had no way in.** `Onboarding.tsx` implements the whole pipeline: create the
  provider, probe it, classify it with the deterministic `fingerprint`, and either instantiate the
  built-in template or — when no known dialect matches — run best-of-N AI candidate generation
  gated by schema → lint → free contract checks, with a Tier-2 sandboxed code adapter as the last
  resort. It is covered by `e2e/onboarding-e2e.test.ts` and by the live-UI harness. And
  `go("onboarding")` appeared **nowhere** in the app: the string existed only in the `ScreenId`
  union and the render branch in `App.tsx`, and the sidebar's `NAV` carried no entry. A screen that
  is implemented, tested and unreachable is indistinguishable to a user from a feature that was
  never built — the only provider flow anyone could find was the manual modal.

  The Providers screen now offers **Set up automatically**, from the first-run hero and from the
  header, and the sidebar carries **Auto setup** — which also gives an interrupted wizard a way
  back, since it persists its session and offers to resume. The manual flow keeps its own entry
  point and its Quick-add presets; the two buttons are deliberately worded differently so neither
  the user nor a test has to guess which flow a label means.

  Two live-UI specs had been reaching the wizard through an "Any other provider — guided setup"
  entry inside `AddProviderModal` that no longer exists in any component, so `web-test` cannot have
  been passing; they now navigate through the new button. `smoke.spec.ts`'s hand-copied
  `NAV_LABELS` gains the new item, which puts the screen under both the "every screen renders
  without an uncaught error" guard and the "no screen calls a command the shim does not implement"
  guard.

- **`?seed=systemai` could not boot the app, so every spec that used it timed out.** The seed's
  model rows carried five fields; `HostModelRow` declares seven, and `isHostModelRow` guards
  `pricingJson` and `capabilitiesJson` with `nullable` — which, unlike `maybe`, rejects an **absent**
  key (`host-boundary.ts:52`). So `arrayOf(isHostModelRow)` failed, `fetchAdminAs` threw
  `HostShapeError: GET /admin/models-cache: the host sent a shape this build does not understand`,
  and the app rendered its "App data could not be opened" card instead of the shell. Every
  `?seed=systemai` spec then failed on its first `getByRole` — 13 smoke tests, all of `memory.spec.ts`,
  `audit-log`, `agent-graph`, `app-budget` and `trail-health` — and each burned the full 120 s test
  timeout rather than reporting a boot failure.

  `SeedInput.models` is now host-shaped and **requires** both JSON columns, so the next omission is a
  compile error naming every offending row rather than a boot failure in an unrelated spec; the seven
  rows were given `pricingJson: null, capabilitiesJson: null`. Measured: the smoke spec's "AI
  Providers" render check went from a 2 m 11 s timeout to **1.1 s**, and `smoke.spec.ts` from
  never finishing to **14 passed in 22.5 s**.

- **`pnpm web-test` could not start its own server, so the live-UI suite never ran.** Playwright's
  `webServer` availability check resolves `http://127.0.0.1:1430/web-test/` through the ambient
  `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` variables, and a proxy that cannot reach a loopback
  address answers `404`. Playwright therefore waited its full 60 s and reported `Timed out waiting
  60000ms from config.webServer` — while vite was listening on the port and answering `200` to
  every other client. Measured on 2026-09-28: vite ready in **849 ms**, `curl` and Node's
  `http.get` both `200` on that exact URL, Playwright `404`; and the same suite green in **842 ms**
  with the six variables unset. The `web-test` script now unsets them itself, so the gate no longer
  depends on the shell it happens to be invoked from.

- **A provider whose base URL was missing its API path reported the symptom, never the cause.**
  A "New API"/One-API gateway serves an HTML single-page app from `/` and every unknown path — at
  **status 200** — while the real API lives under `/v1`. With `baseUrl` set to the bare host, all
  three of the wizard's probes hit the SPA and were parsed as JSON: **Fetch from provider** reported
  `JSON Parse error: Unrecognized token '<'`, the **key test** reported the same, and **Test** on a
  model reported *"answered with an empty response — the request succeeded but no content came
  back"*. Three different messages, one misconfiguration, and none of them named the URL or the
  likely remedy. Reproduced live on 2026-09-28: `api.hcnsec.cn/models` → `200 text/html`,
  `api.hcnsec.cn/v1/models` → `401 application/json`.

  Bodies are now parsed through `jsonBody(raw, url)`, which on a non-JSON body reports the URL it
  asked, quotes the first 80 characters of what came back, and — when the body opens with `<` —
  says the base URL is most likely missing its API path and suggests `https://<host>/v1`. The
  streaming path gets the same treatment: the first non-blank SSE line is checked for `<`, so an
  HTML body is named rather than read as a stream that ended cleanly. Guarded at all four parse
  sites (`listModels`, non-stream `generateText`, `generateImage`, the SSE loop). Four tests in
  `packages/router-core/test/non-json-body.test.ts`; the two guard tests were falsified against the
  unguarded interpreter.

  The wizard's Base URL field also asked for the wrong shape: its placeholder was
  `https://api.example.com` while onboarding's has read `https://api.example.com/v1` since the
  profile flow was written — the manual path was the one out of step, and the field takes the value
  **verbatim** (`buildManualManifest` assigns it to `provider.baseUrl` unchanged, while the template
  appends `/models` and `/chat/completions`). It now matches onboarding and carries a one-line hint.

- **Onboarding's first write left a ghost provider behind when the host refused it.**
  `createPendingProvider` added the provider to the registry and *then* wrote it host-side, with no
  rollback — while `addProvider` eleven lines up has had one since 26j, and the note above `addKey`
  names the same hazard for a credential. A refused write (the gateway down, a 401, a duplicate slug)
  therefore left a provider the host had never heard of: `addKey` ran against an id the host did not
  know, and every probe was refused for a host the allowlist never received — surfacing as "could not
  identify this API", a claim about the API produced by a local bookkeeping failure. It now removes
  the record it just added. `deleteProvider` rather than `refreshFromHost`: an unreachable host fails
  the resync too, which would leave the ghost in exactly the case that created it.

- **A provider added after the app started was refused on every request — `HTTP 599`, "host not
  allowlisted" — because the app process and the gateway each keep their own egress allowlist and
  only one of them was being maintained.** The app seeds its list once, in `setup()`
  (`tauri::app::initial_allow_hosts`). Provider CRUD from the webview goes over HTTP to the admin
  route, and `app.rs` **probes the port and delegates to the launchd agent when the agent already
  holds it** — so with the service installed that route recomputed the *agent's* list and left the
  app's untouched. The app's list was only ever correct when the app itself had bound the port,
  because then its embedded gateway shares the same `Arc`. Reproduced live on 2026-09-28: provider
  `vice` at `vyceai.com`, status `pending`, created 21:05 into an app started 20:54 — every request
  refused before any upstream dial, so the ledger held no row for it at all and a stale cache in a
  second process read as a network fault.

  `EgressState` now re-derives its list from `providers` before deciding (`refresh_allow`, called
  from `build` and `fetch_image`), so the refusal cannot be made on a stale list. The webview gains
  nothing by this: the rows are host-written (invariant 12) and its only way to add one is the
  gateway's authenticated admin route, which already widened the gateway's list. Two tests pin it —
  one asserted through `build`, so deleting the call site fails rather than passing on a helper, and
  one asserting a `draft` provider's host is still refused.

- **A successful turn whose only output was a tool call was recorded as `PARSE_ERROR`.** Tool calls
  travel by `on_tool_call`, never through the text sink, so a tool-call turn delivered zero chunks —
  and "did anything get served?" was being answered by counting chunks. The row said
  `status=error, error_class=PARSE_ERROR` for a request the client received intact, while the same
  request was recorded as `OK` in key health. 11 of the 42 rows written on 2026-09-27 were this.
  "Served" now means *delivered output*: a text chunk or a tool call. A `200` with an empty body is
  still `PARSE_ERROR` and an aborted request is still `CANCELLED`. Applies to both the
  `aiproviderd` gateway and the in-app Assistant. See `DECISIONS.md` 2026-09-27.

- **A tool call delivered and then a mid-stream break still failed over, re-issuing the tool call.**
  `emitted` — the flag that decides whether a break can still fail over to the next candidate — was
  chunk-only, so a tool call delivered and then a break produced `Next` rather than `Rethrow`. The
  next candidate re-issued the same tool call, and the consumer held two for the same turn. A
  delivered tool call now also ends failover: the predicate folds in a tool-call count, so the
  break produces `MidStream` (not `AllAttemptsFailed`) with the serving candidate named. The
  `records_key_health` invariant — a rethrown failure must be a drift class — still holds, because
  a mid-stream break after a tool call classifies the same way as one after a chunk. Applies to
  both the `aiproviderd` gateway and the in-app Assistant. See `DECISIONS.md` 2026-09-27.

- **A provider that answered with headers and then sent no body was recorded as a client abort.**
  The egress bounded the wait for *response headers* at 20 s but left the wait for the **first body
  byte** inside the 120 s streaming budget — four times the gateway's 30 s first-message bound — so
  the gateway always gave up first, cancelled the request, and the ledger wrote `CANCELLED` with an
  empty attempt chain and `http_status` null: a timeout filed under the name of a client disconnect,
  with no line in any log and no failover, because the engine sees a stream that ended cleanly rather
  than an attempt that failed. One deadline now encloses both phases, stamped *before* the request is
  sent, so a body that never starts fails at the same 20 s as one that never gets headers — with a
  real class, a populated chain, and a `warn!` naming the phase that expired. A request whose body
  has demonstrably started is untouched: the 120 s budget still governs silence between chunks.
  Measured on ledger row 1671. See `DECISIONS.md` 2026-09-27 and drift-register **D74**.

- **Adding a key could strand its secret in the vault with no row to reach it.** `addKey` writes the
  secret to the keychain and *then* records the `api_keys` row; when the row insert failed — a 500
  from the provider foreign key, a dead gateway, a 401 — the secret was left behind. It was invisible
  to the keys list, which reads `api_keys`, and so could be neither selected nor revoked anywhere in
  the UI. The secret is now deleted again when the row does not land, matching the rollback the host's
  `key_create_h` and `addProvider` already performed. See `DECISIONS.md` 2026-09-27.

- **Two operator scripts dialled a port nothing was listening on.** `soak-gateway.sh` defaulted to
  `8787` — the *other* gateway's compiled default — and `repro-restore.sh` probed the same port, while
  the service listens on `8800`. Both then took recovery paths that could not work either:
  `open -a "/Applications/AI-Provider Router.app"`, a bundle that is not installed there. Three more
  defects sat behind the port, each hidden by the one before it. `repro-restore.sh`'s
  `pkill -f "AI-Provider Router"` matched no process — the service is `aiproviderd` — so it killed
  nothing and reported a successful restore on every attempt. The soak's TSV wrote the five literal
  characters `$'\t'` between its fields, so every row carried 3 tab-separated columns against a
  4-column header. And the listener's supervisor was misidentified, because `launchctl list` prints
  nothing from a non-interactive shell while `launchctl print` reports the job running. Both scripts
  now resolve the port through a shared `scripts/lib/gateway-port.sh`, drive `launchctl` against the
  job that owns the listener, and emit parseable output. See `docs/dev-book/07-drift-register.md` D72.

- **A slow upstream was being aborted at 10 s and then retried with the same prompt — so a healthy
  request failed as `CANCELLED` at 30 s.** Four requests failed this way in eight minutes on
  2026-09-27 (ledger rows 1652/1655/1656/1658), reported to the client as *"the router produced no
  response within 30000ms"*. Three separate defects stacked behind that one symptom:

  **(1) The pre-headers budget was too small.** `first_msg_ms` — the only in-path time-to-first-byte
  this system records — measures **p50 2.1 s, p90 7.1 s, p99 18.6 s, max 18.6 s** across 54 real
  requests. At 10 s the bound was *manufacturing* the stall it existed to survive: 4/54 requests
  exceeded it and then succeeded on the retry, two of them measurably (attempt 2 delivered 2.80 s
  and 8.60 s after the stall). It is now **20 s**, which covers every success ever recorded.

  **(2) The retry was on the wrong arm.** A header timeout looped and re-sent the identical prompt
  to the identical host; a genuine transport error returned with no retry at all. The two are now
  the right way round: a transport error gets one more dial, because a *fresh connection* is a
  different roll; a header timeout does not, because it cannot be. The header budget is no longer
  multiplied by a retry count.

  **(3) Nothing bounded the plan.** `execute_text` walks every candidate, and with two candidates the
  worst case was `2 x 20 s = 40 s` against a 30 s gateway bound — so the last candidate was *always*
  cut off mid-attempt. The log proves it: entry 2 starts its own `attempt=1` 18 ms **after** the
  gateway has already given up. The engine now holds a **26 s plan budget** and admits a candidate
  only when it can fund a full attempt, so `20 s <= 26 s < 30 s` is a real ordering. A request that
  exhausts it now fails at ~20 s through the router's own path and is recorded with the class its
  attempts produced, instead of reaching 30 s and being filed as `CANCELLED`.

  The old invariant test pinned only one candidate's budget and so could not see (3); it now asserts
  the three-constant ordering. All three new tests were falsified against the previous behaviour
  before being trusted. See `docs/dev-book/07-drift-register.md` D73.

## [1.2.0] - 2026-09-26

### Changed

- **The OS keychain is gone. Secrets live in `<data_dir>/.secrets.json` (mode 600, atomic write).**
  `keyring` was removed from the dependency graph. This is a **one-time migration**: existing
  keychain entries are abandoned, not migrated. The first launch after this change answers
  `401 no master key configured` until you run `aiproviderd mint` (or use the UI's mint flow)
  to rotate a new key. Provider keys need one re-entry in the UI. See `DECISIONS.md` 2026-09-26.

- **`aiproviderd` subcommands.** Five new subcommands let you manage the headless service
  without opening the UI:
  - `aiproviderd install` — copy the binary to `~/Library/Application Support/…/bin/`,
    write the plist, `launchctl bootstrap`
  - `aiproviderd uninstall` — `launchctl bootout` + remove the plist
  - `aiproviderd status` — print the job's loaded/pid/health state
  - `aiproviderd self-install` — copy the running binary to `/opt/homebrew/bin` or
    `/usr/local/bin` (whichever exists)
  - `aiproviderd mint` — rotate the master key and write it to `.secrets.json`;
    prints the new key once (the old key stops working immediately)

### Added

- **Phase 6 — headless service end-to-end.** The `.app` bundle now ships the Tauri-free
  `aiproviderd` (no WebKit linkage). `scripts/substitute-tauri-free-aiproviderd.sh`
  (`pnpm build:headless`) is the post-bundle step; `scripts/check-bundled-aiproviderd-links.sh`
  is the gate. Both CI mirrors (`ci.yml`, `ci-local.sh`) and `release.yml` run the two steps.

- **`launchd_live` tests** (`#[ignore]`, Aqua session required). Test 1: `service::install`
  produces a job launchd actually runs. Test 2: a real `aiproviderd` binary is installed as
  the agent payload, `/health` is asserted live, and the app's probe-and-delegate decision
  reads `Some(port)` against the agent's port. Run from Terminal.app after building the
  Tauri-free binary.

## [1.1.0] - 2026-09-26

### Added

- **Headless service, Phase 1 — the gateway no longer has to live inside the desktop app.** The Rust
  half of the codebase is now split into `src/core/` (no dependency on the Tauri glue) and
  `src/tauri/` (commands, the worker-window bridge, app setup), and a new binary, `aiproviderd`,
  starts the HTTP server with no window, no WebView and no Tauri app.

  **What this does and does not do.** It proves the HTTP server starts and binds on its own:
  `aiproviderd` opens the same SQLite file, reads the master key from the same keychain, binds
  `127.0.0.1:8800` (persisted setting first), and answers `GET /health` with `200 {"status":"ok"}`.
  It does **not** serve completions, and is not meant to yet — the router core is still TypeScript
  running in a hidden webview, so the standalone service has nothing to bridge to and every
  completion route answers `503` by design. Porting the router core to Rust is Phase 2.

  `GET /health` is the one new route, and the one unauthenticated one: it reports that a process is
  listening and nothing more, so a client that does not yet hold a key can still find the service.
  All seven existing routes, and both the 404 and 405 refusals, still authenticate first.

  Three notes on the split, because they are not what the plan predicted: `persist.rs` and
  `egress.rs` sit in `core/` — not in `tauri/` — because `gateway.rs` calls `persist` in non-test
  code and `persist` in turn needs `egress` and `CommandError`; `core/` still imports the `tauri`
  *crate* (`persist.rs` carries 32 `#[tauri::command]` handlers), so the service is Tauri-free in
  source but not in dependency; and one `cfg(test)` edge in `gateway_tests.rs` still points back at
  `tauri/`, which affects `cargo test` and not `cargo build --bin aiproviderd`.

  CI gains a `headless-service` job building `aiproviderd` on macOS, Windows and Linux.

- **Per-app budgets.** A per-app gateway key can now carry its own monthly cap, so one runaway
  consumer — an agent loop in a connected IDE — is stopped without touching any other app, and
  without touching the owner's global budget. Until now the only cap was global and monthly: one
  `month_micros` against one `cap_micros`, which a single app could exhaust while every other app
  sat idle.

  The two limits are enforced **independently**, and the refusals are distinguishable. Both are
  `402 insufficient_quota`, but the body names which limit bound: `spend_cap_exceeded` for the
  global cap, `app_budget_exceeded` for one app's own. That distinction is load-bearing, because
  the remedies are opposite — the first is an operator problem that stops every app, the second is
  fixed by raising one key's budget or waiting for the month to turn.

  Migration 0017 adds the nullable `gateway_keys.cap_micros` and the index the per-app spend SUM
  needs, `ledger(app_key_id, ts)` — which 0016 deliberately declined to ship until a query existed
  to justify it. `cap_micros` is nullable and clearing stores `NULL` rather than `0`, so there is
  one spelling of "no budget" rather than two that behave identically until something queries
  `IS NULL`.

  Budgets are set per key on **Local Gateway**, beside the key they limit; the global cap stays on
  **Control**. Per-app *attribution* (0016) is the prerequisite and landed first — a budget has
  nothing to sum without it, and rows written before 0016 stay unattributed, so an app's total
  starts from the first request made after it.

- **Auto context compression.** Long conversations no longer overflow the model's window. Tier 1
  (hard truncation) and Tier 2 (summarization) are both included.

  Tier 1 drops the oldest **complete turns** until the prompt fits the budget, sized against the
  narrowest context window in the failover plan. Three properties are preserved, each pinned by a
  test: the `system` turn survives; the **newest** turn survives even when it alone exceeds the
  budget; and a tool call and its results are always dropped together.

  Tier 2 replaces the dropped turns with a compact summary, wired for the assistant via
  `createSummarizer`. The summarizer's own inner call sets `skipCompression: true`, because
  without it the chain would be unbounded — compressing would trigger a summary, which would
  compress again. The gateway stays on Tier 1 (stateless, latency-sensitive); Tier 2 is available
  via `generateText`'s `summarize` option for callers that want it.

  Both tiers are covered by the **same** trim: the two callers converge on `router.generateText`,
  so there is one rule rather than two that could drift apart.

- **Prompt-cache measurement.** The ledger now records `cached_tokens` for every request, read in
  whichever dialect the provider uses: OpenAI-shaped `prompt_tokens_details.cached_tokens`, or
  Anthropic's top-level `cache_read_input_tokens`.

  The column is **nullable on purpose**. `NULL` means the provider reported no cache block at all,
  which is a different finding from reporting a zero — and telling those apart is the entire point.
  Without it, every provider would look like a provider that caches nothing, and the question
  "would sending `cache_control` help?" could not be answered in either direction.

  This release is **measurement only**. No request shape changed and nothing sends `cache_control`
  yet; the data has to exist before that decision can be made honestly.

- `pnpm check-version-sync` — asserts the root `package.json`, both workspace packages,
  `apps/desktop/package.json`, `Cargo.toml` and `tauri.conf.json` all agree on one version.

- **Coverage measurement.** `pnpm test:coverage` runs all three vitest suites under
  `@vitest/coverage-v8` and prints one weighted figure across the workspace: **43.8% statements,
  37.3% branches, 31.1% functions, 45.4% lines**. Previously `coverage/` was gitignored and nothing
  produced it, so "did this change make things worse" had no answer at all.

  It is a **report, not a gate**. A coverage threshold fails unrelated refactors, and the cheapest way
  out of that failure is to lower the threshold — after which nobody reads the number. The gate keeps
  holding the line that matters: all 460 unit, 98 browser and 481 Rust tests must pass.

  Two mechanics worth knowing. The aggregate is **weighted** — counts are summed and the percentage
  recomputed, never the three `pct` values averaged, which would weight a 300-line package the same as
  a 6,000-line one. And a missing report is a hard error rather than a zero, because summing two of
  three and printing a confident percentage is the failure mode that matters most here.

- **Dependency auditing.** `pnpm audit --audit-level=moderate` now runs in `ci.yml` and in the local
  mirror, and a weekly `.github/workflows/audit.yml` re-runs it alongside a RustSec audit of the
  Tauri host on `ubuntu-latest`.

  The level started at `high` earlier the same day, and that was a measurement rather than a
  preference: two moderate advisories shared a single root cause — a `vitest` devDependency whose
  patched line (`>=4.1.11`) was a whole major version away — so `moderate` could not pass without a
  test-runner migration first. That migration landed the same day (see `### Changed`), so the level
  was raised to `moderate` and both mirrors re-verified. The scheduled job exists because an
  advisory can be published against code that has not changed, and a push-triggered gate never
  fires for that.

- **Per-app spend attribution.** The ledger now records *which* app key paid for a request
  (`ledger.app_key_id`, migration 0016), so a per-app budget finally has something to sum. The
  gateway's own app key (`gateway_keys.id`) previously appeared in no column at all: `ledger.key_id`
  holds the *provider* credential, and the two are different ids that both answer to "key".

  The column is only half of it. The identity is now returned by the gateway's auth check instead of
  being looked up a second time, threaded through all six dispatch sites, carried across the bridge
  to the webview, and mapped into the ledger write — and that last hop is the one that mattered,
  because the ledger is written on the webview side. A column, a TypeScript field and a sink mapping
  together would still have recorded nothing. Four tests cover it, each falsified before being
  trusted.

  This is **attribution only**. Nothing yet sets or enforces a per-app cap, and existing rows stay
  `NULL` — nothing can reconstruct which app paid for them.

- **A self-verifying release pipeline.** A release build can no longer succeed into a broken
  artefact. `scripts/release-preflight.sh` runs first and refuses to start the build when an Apple
  secret is missing, when the `.p12` will not open with the given password, or when a signing
  identity has been pinned in `tauri.conf.json`. `scripts/verify-release-signature.sh` then reads
  the built artefacts back and requires them to be Developer ID signed, hardened, and notarized; if
  they are not, the job fails and the draft release is deleted.

  The defect this closes was silent rather than loud. `tauri build` succeeds with **no** Apple
  secrets at all and emits an **ad-hoc signed** app, which launches fine locally — where Gatekeeper
  does not assess it — and is refused on a user's machine. A tag push therefore produced a green
  job and a draft Release containing something macOS refuses to open, and the failure surfaced for
  a user instead of in CI.

  **`codesign --verify` is not sufficient, which is why the verifier does not rely on it.** Measured
  against an ad-hoc bundle, it prints `valid on disk` and `satisfies its Designated Requirement` and
  **exits 0** — an ad-hoc signature is a valid signature. The checks that separate signed and
  notarized from ad-hoc are `spctl` (exit 3 vs 0), `stapler validate` (exit 65 vs 0), the
  `CodeDirectory` flags word (`0x2(adhoc)` versus `0x12a00(…,runtime)`) and the `Authority=` chain.
  Both scripts were falsified against both states before being written into the workflow.

  Provisioning the certificate and the six repository secrets remains a one-time manual step,
  written out in `CONTRIBUTING.md` under "Releasing" — it is an Apple Developer account action that
  no code change can perform.

### Fixed

- **A client-facing `Retry-After` is now the shortest wait, not the longest.** The route planner
  *drops* a cooled key rather than deprioritising it, so the earliest a retry can be served is when
  the first cooled key frees up. The gateway was telling clients to wait for the last one, which was
  longer than necessary. The value is still floored so a client is never told to retry into a window
  that has not closed.

### Changed

- **Licensed under Apache-2.0** (`LICENSE`), with a `license` field added to every manifest.
- `bundle.targets` narrowed to what is actually built and tested (macOS). The previous `"all"` also
  produced Windows and Linux installers that this project has never run.
- CI now runs `pnpm build`, so a bundle that no longer compiles cannot pass. Previously the
  Playwright harness exercised a **dev server**, which meant nothing in CI touched the production
  bundle — the local gate (`pnpm ci:local`) was the stricter of the two.
- CI now runs `pnpm check-version-sync`, which fails when any manifest disagrees with
  `tauri.conf.json` about the product version.
- **`vitest` 3.2.7 → 4.1.11 across all three packages**, clearing GHSA-82fw-gwwq-j7x9 (a path
  traversal in `@vitest/mocker`, vulnerable `>=2.1.0 <4.1.11`). **No test changed**: every vitest
  config used only long-stable options, so all 460 tests passed on 4.1.11 as written.

  The one real cost had nothing to do with vitest. `pnpm typecheck` then failed with
  `TS2591: Cannot find name 'node:child_process'` in `e2e/mock-servers.ts` and
  `src/lib/tools/agentLoop.test.ts`, while `@types/node@26.6.0` sat in the tree complete (89 `.d.ts`)
  and correctly symlinked. `tsc --listFilesOnly` enumerated **409 files including 83 `@types/node`
  files** before the bump and **238 including zero** after, so the reshaped dependency graph had
  stopped `@types/node` being auto-included at all. `apps/desktop/tsconfig.json` now states
  `"types": ["node"]` rather than inferring it: an implicit default is a dependency on the install,
  not on the code.

- **The Rust host is now rustfmt-formatted, and the gate enforces it.** `cargo fmt --check` runs in both
  mirrors, first in the Rust block. Adoption had been deferred because a stock config rewrites most of
  the host and destroys `git blame` for no behavioural change — measured on the 24,006-line host, that
  is **638 hunks / 42.2% of it**. `use_small_heuristics = "Max"`, the single non-default setting in the
  new `apps/desktop/src-tauri/rustfmt.toml`, cuts that to **354 hunks / 30.1%** by keeping the compact
  "one line if it fits" style the code already uses — so the rewrite preserves the host's look rather
  than replacing it. The 24 files, 4,172 insertions and 3,473 deletions it did touch carry no meaning
  whatsoever, which is exactly why they are their own commit rather than part of a release batch.

### Removed

- **The auto-updater documentation and scripts.** They described a mechanism that was never
  implemented, and three details were wrong in ways that would have cost real time:
  `SIGNING.md` claimed `tauri.conf.json` contained an `updater` block it did not contain, and put it
  at the top level where Tauri v1 kept it rather than under `plugins.updater` where Tauri v2 keeps
  it; it exported `TAURI_SIGNING_PUBLIC_KEY`, which is not a variable Tauri reads; and
  `generate-updater-keys.sh` produced an **RSA** keypair with `openssl`, while Tauri's updater
  verifies **minisign/ed25519** keys produced by `tauri signer generate` — so keys from that script
  could never have verified an update.

  A document that describes update signing incorrectly is worse than no document, because it is what
  the next contributor trusts. Updates are manual for now; see `README.md`.

- Three empty directories at the repository root (`IDE/`, `ai/`, `provider/`), untracked and so
  invisible to `git status`.

## [1.0.0] - 2026-09-22

The first release. A local-first desktop app that routes LLM requests across the user's own AI
provider accounts.

### Added

- **Provider management.** Providers are described by a declarative adapter manifest. Known profiles
  are available as quick-add; anything else can be added manually, or discovered by a guided
  probe → identify → contract-test → approve wizard that only enables a provider after you confirm
  it.
- **Local OpenAI-shaped gateway** on `127.0.0.1`, so other tools can reach every configured provider
  through one endpoint. Per-app gateway keys mean a leaked or retired client can be revoked without
  rotating the master key.
- **Keychain-backed secrets.** API keys are held in the OS keychain and never written to disk.
- **Usage ledger** with per-request tokens, cost estimates, latency and error class, plus monthly
  rollups — including source attribution, so UI, gateway and internal generator traffic are
  distinguishable.
- **Drift detection and repair** for providers whose API changes under them.
- **A memory layer** with scoped recall, plus a context graph of artifacts, memories, skills and
  messages.
- **An agent loop** with sandboxed tool execution and a visible step trail.

### Known limitations

- Developed and tested on **macOS only**. Windows and Linux are untested: the keychain-backed secret
  store and the gateway have never been exercised there.
- Updates are manual — there is no auto-updater.
- Distribution is not yet notarized; see `SECURITY.md` and `CONTRIBUTING.md`.
