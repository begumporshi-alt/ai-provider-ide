# Live gateway test — 2026-09-22

**Target:** the running app (`ai-provid`, gateway on `127.0.0.1:8800`) — not a test harness, not a mock.
**Credentials:** the master key and the one active per-app key (`ak-fc85350a2fb1dc67`, "Work buddy"), read from
the OS keychain (service `ai-provider-router`, accounts `masterkey` / `gwkey:<id>`). Values are deliberately
not reproduced in this file — the repo is public.
**Providers live:** `agnes` (manifest, enabled), `cline` (manifest, enabled). Both keys `active`, no cooldown.
**Artifacts:** probe scripts under `/tmp/aip-live/` (outside the repo, so no key can be committed).

Everything below is measured. Where a designed limit could not be reached, that is stated rather than papered over.

---

## 1. Auth — correct, and the anti-brute-force bound is exact

| Probe | Result |
|---|---|
| No credential | `401 invalid_api_key` |
| Wrong credential | `401 invalid_api_key` (when the window is open), else `429` |
| Master key | `200` |
| Per-app key | `200` |
| `x-api-key` (Anthropic dialect) | `200` |
| `x-goog-api-key` (Gemini dialect) | `200` |
| `Authorization` without `Bearer ` | `401` |

**Measured backoff curve** (gap between consecutive *admitted* failures, no success in between):

```
0.55  1.05  2.03  4.03  8.04  16.04  32.01   (seconds)
```

Doubling from 500 ms, capped at 32 s — matches `note_auth_failure` exactly.

The important property holds: **a valid key is never throttled.** During an open backoff window the master
key returned `200` immediately, and a success clears the counter so the next failure starts again at 500 ms.
The throttle only ever rejects attempts that would have been rejected anyway.

## 2. Route surface

- `GET /v1/models` → `200`, **458 models** (446 `cline`, 12 `agnes`).
- Unknown route → `404 {"code":"unknown_route"}` (OpenAI-shaped).
- Malformed JSON → `400 invalid JSON body`.
- Missing `model` → `400 model is required`.
- `functions` param → `400 unsupported_parameter`.
- Wrong method (`GET /v1/chat/completions`) → `405`.

## 3. Live chat — real provider round-trip

- Non-streaming: `200` in **0.79 s**, `id=gw-25`, `finish_reason=stop`, real content, usage reported.
- Streaming: `text/event-stream`, 3 SSE frames, `[DONE]` sent, usage present in the finish chunk
  (nested at `choices[0].usage`, not top level). Chunked delivery verified with `read1()` — 3 chunks,
  so real SDKs consume it incrementally.
- Unknown model → `404 no route for model … (no enabled provider carries it)`.
- Empty `messages` → `400 BAD_REQUEST_SCHEMA` (upstream classification surfaced correctly).

## 4. Memory / context layer

Modes, scope resolution and the response headers all behave as specified:

| Probe | `AIP-Memory` | `AIP-Memory-Scope` |
|---|---|---|
| default | `injected=1;items=0;tokens=348;ctx=8` | `user=local;project=p4618…;agent=-` |
| `aip-memory: off` | `injected=0;reason=client_off` | — |
| `on` + full identity | `injected=0;reason=no_candidates` | `user=tushu;project=live-test-proj;agent=jarvi-probe` |
| `read` | `injected=0;reason=no_candidates` | `agent=jarvi-probe` |
| `write` | `injected=0;reason=client_off` | `agent=jarvi-probe` |
| budget `999999` | clamped, no error | — |
| `metadata.aip` body fallback | honoured | `project=body-proj;agent=cursor-like` |

- **Capture works:** a chat produced `memory_pending` **+1**, carrying `scope_project` / `scope_agent`, with
  the user text **redacted** on the way in (`[REDACTED]`). `memories` did **not** grow — consistent with the
  known design: the pending row is scoped, the atom written after the drain is not, so gateway recall stays at
  `items=0` until a human binds a scope.
- **Header injection is blocked.** A CRLF-smuggled `aip-agent: evil\r\nAIP-Memory: injected=99` was sanitised to
  `evil`; the forged value never reached the response.
- **The 15 ms deadline works.** An oversized 400-char label produced `reason=deadline` — the memory path was
  abandoned whole and the model request still returned `200`.
- Garbage `aip-memory-budget: abc` is ignored rather than fatal.

## 5. Capacity and cancellation — the designed gate was not reachable

- 50 concurrent requests → upstream answered `429 all attempts failed … [agnes/key-01:RATE_LIMITED]` for most
  of them. **Attribution matters:** this is the *provider* rate-limiting, not the gateway. Both `api_keys` rows
  stayed `active` with no cooldown, and the gateway propagated the upstream status faithfully.
- **The gateway's own 8-concurrent + 32-queued gate was never hit**, because upstream rejects before in-flight
  can build to 40. It remains unverified against live traffic.
- **Cancellation is fine:** 12 streams aborted mid-flight (hard socket close); the gateway stayed healthy and
  served subsequent traffic with no slot leak.

## 6. Wire dialects — all four answer

| Route | Credential | Result |
|---|---|---|
| `POST /v1/messages` (Anthropic) | `x-api-key` | `200`, `msg_gw_*`, `stop_reason=end_turn` |
| `POST /v1/responses` | `Bearer` | `200`, `resp_gw_*` |
| `POST /v1beta/models/{m}:generateContent` | `x-goog-api-key` | `200`, Gemini-shaped |
| same, `?key=` query credential | query param | `200` |
| `POST /v1/images/generations` | `Bearer` | `404 no route for image model` |

---

## Findings worth acting on

### A. Session-less requests share one default session *(the significant one)*

`session_turns` shows that **every gateway request without `aip-session` lands in the same session**
(`s-096fcb7345906f50`), regardless of which credential presented it. Confirmed two ways:

1. Deterministic — turns from the master key, the per-app key, and differently-labelled agents all sit in that
   one session (12 distinct sessions exist overall; the rest are explicit ones like `sess-BOB`).
2. Observed — a model answer referenced earlier, unrelated prompts verbatim
   (*"There are 5 instances that start with 'Reply' in the context above"*).

So caller A's prompts and completions are injected into caller B's context whenever neither sets
`aip-session`. For a single-user loopback gateway this may be intended convenience; the moment more than one
app holds a key (there is already a per-app key separate from the master) it is cross-client context bleed.
The memory layer is explicitly guarded against exactly this class of contamination — the session layer is not.

Suggested fix: derive a default session from the resolved principal (`key:master` / `key:<id>`) when the client
supplies no `aip-session`, so the default is per-caller rather than global.

### B. `aip-memory: write` is reported as `reason=client_off`

The client did not opt out — it asked for capture-only. The response header says `client_off`, which reads as
"this caller turned memory off". Misleading label, trivial fix (a distinct `write_only` reason).

### C. Upstream `429` carries no `Retry-After`

The design attaches `Retry-After` to capacity rejections. When the *provider* rate-limits, the gateway returns
`429` with no `Retry-After`, so a well-behaved client has nothing to back off against.

### D. Minor

- **Unknown routes are answered before auth** — an unauthenticated caller gets `404 unknown_route` instead of
  `401`, which is a route-existence oracle. The table is static and public, so severity is low.
- **`405` returns an empty body**, not an OpenAI-shaped error.
- **Every request carries ~1700–1900 prompt tokens** of fixed overhead (memory on adds ~100 of that). Worth
  knowing for cost; it is the core's context, not the gateway's.
- **`max_tokens` ≤ 32 yields empty content** on `agnes-2.5-flash` — the model spends the budget on hidden
  reasoning. The gateway faithfully returns `200` / `finish_reason=stop` and bills the tokens; `length` would
  be the more honest finish reason when the cap is what stopped it. This is the model, not the router.
- **No routable image model** — `/v1/images/generations` answers correctly but `agnes-image-2.0-flash` has no
  route, so the endpoint is currently dead. **Corrected 2026-09-22, see §7: this is not one model. The catalog
  tags zero of 455 models as `image`, so *every* image request fails.**

## Resolution — findings A and B are fixed, built, installed and re-verified

Both were changed, gated, rebuilt into the app and re-tested live on 2026-09-22.

### A. Session isolation — fixed

`session_context.rs` now hashes `principal|user|project|agent`. The principal comes from
`key_principal_for`, which the policy check already computed, so the hot path gained no work; it is threaded
into the three `resolve_session` sites (`freeze_key`, `live_context`, `prepare_capture`). `None` renders as
`-` and is what a request gets when memory is off — inert, because no session is read or written then.

**Before:** master key and per-app key both → `s-096fcb7345906f50` (247 turns, one shared transcript).
**After:**  master key → `s-64ff32ac307f0593`, per-app key → `s-233fcaf2e7aba642`.

Two apps sharing the master key still share a session; `aip-agent` / `aip-session` remain the finer split.

### B. `write` reported as `client_off` — fixed

New `SkipReason::WriteOnly` → `write_only`, returned when the client asked for `MemoryMode::Write`, with the
plain-language label added to `Control.tsx` (it would otherwise have rendered the raw token).

**After:** `aip-memory: write` → `injected=0;reason=write_only`; `aip-memory: off` → `reason=client_off`,
unchanged.

### Evidence the tests are real

- **Falsified before trusting:** reverting just the key — leaving the new signature in place — collapses both
  principals back to `s-6f7ff06f5efdc319` and `two_principals_in_the_same_scope_do_not_share_a_session` **fails**.
  Restoring the fix makes it pass.
- `pnpm ci:local`: **ALL GREEN** — 98 browser tests, Rust 436 (was 433, +3), typecheck, build, key-leak grep.
- The `write_only` label is present in the shipped bundle (`dist/assets/main-DYi6nvga.js`).
- Installed to `/Applications/AI-Provider Router.app`, old bundle backed up to `/tmp`, gateway auto-restored
  on 8800.

Build note: `tauri build` fails at the **DMG** step (`bundle_dmg.sh`, needs `hdiutil`, blocked here). The
`.app` is already built and signed at that point, so the failure is cosmetic.

## Second pass — items 3, 4 and the image finding (done 2026-09-22)

All three were implemented, gated **ALL GREEN**, rebuilt, reinstalled and re-verified live. Every new test was
falsified first: reverting each fix makes its test fail, and it was restored afterwards.

### C. Upstream `429` now carries `Retry-After`

One middleware (`gateway.rs::ensure_retry_after`) over the whole router, rather than ten dialect call sites —
a dialect that forgot would drift from the others with no failing test. It only fills a *missing* header, so
the values the gateway already chooses survive. The value is `1`, a floor matching the core's own key-cooldown
floor (`health-tracker.ts`), not a claim about the provider's real window.

| | Before | After |
|---|---|---|
| auth backoff | `Retry-After: 30` | `Retry-After: 30` (untouched) |
| upstream 429 | *(absent)* | `Retry-After: 1` |

### D. The route table is no longer an oracle

`unknown_route` and the new `method_not_allowed` both authenticate first. A 404 or a 405 is itself a statement
that a route exists, so an unauthenticated caller must not be able to buy that fact. `405` also gained an
OpenAI-shaped body; axum's default is empty, which is the one refusal a JSON-parsing client cannot read.

| Probe | Before | After |
|---|---|---|
| `POST /v1/unknown/path`, **no** credential | `404` | `401` |
| `POST /v1/unknown/path`, valid credential | `404 unknown_route` | unchanged |
| `GET /v1/chat/completions` (POST-only) | `405`, empty body | `405 unsupported_method` |

### E. The image finding was understated — and is configuration, not code

The first pass said "no routable image model". The truth is broader and the fix is different:

`select modality, count(*) from models_cache group by modality` → **`text|455`**. Zero image rows. Both
configured providers (`agnes`, `cline`) declare `capabilities: {text: true, image: false}`, their manifests
carry no `modalityRules.image`, and neither has a `generateImage` endpoint at all. So `tagModality` classifies
every model as text — including the 15 the gateway advertises with "image" in the id — and `plan(model,
"image")` is empty for every one of them. **The model ids were never wrong.**

That is a wiring gap, not a bug, so no routing code was changed. What was wrong is the *diagnosis*: the caller
was told `no route for image model "x"`, which sends them to check a string that is already correct. Three
distinct failures now produce three distinct messages (`model-router.ts::whyNoImage`):

- no image model in the catalog → `no enabled provider is configured for image generation`
- an id nobody carries → `no enabled provider carries it`
- a known model tagged text → `it is not tagged as an image model in the catalog`

The phrase "no route" is kept in all three because `gatewayStatus` maps it to 404.

**To actually enable images:** add `endpoints.generateImage` and `modalityRules.image` to a provider's
manifest (a builtin profile gets both from `builtin-templates.ts` when it declares an image endpoint). No image
request can route until then, and that is a configuration decision, not something to guess in code.

## F. The §3.5 concurrency bound was never enforced

Chasing "the 8+32 gate is unproven live" turned up something better than a missing test.

`ARCHITECTURE.md` §3.5: *"max concurrent routed requests (default 8) with a bounded queue (default 32);
overflow answers 429 + Retry-After."* The code had **one** semaphore:

```rust
const MAX_TOTAL: usize = 8 + 32;   // and `try_slot` dispatched as soon as it admitted
```

Acquiring a permit *was* dispatching. So there was no queue and no cap of 8 — up to **40 requests could be
routed to the provider simultaneously**, 5× the specified concurrency. Nothing asserted either number, so
raising or lowering them would have passed every test.

It also explains the first pass's own observation that live capacity probing "rate-limits upstream first": 40
simultaneous calls to one provider will draw a 429 long before a 40-deep gateway gate is reached.

**Fix:** two tiers. `permits` (40) admits; a new `dispatch` semaphore (8) is awaited before the request is
handed to the worker. `try_acquire` on admission still refuses the 41st with 429 immediately; the wait for a
routing slot *is* the queue. `Semaphore::acquire_owned` is cancel-safe and hyper drops the future on client
disconnect, so a queued request never holds a slot for a caller that has gone.

**Tests** (both falsified):
- `no_more_than_eight_requests_are_dispatched_at_once` — 20 concurrent, slow worker; the worker must have been
  handed exactly 8 while the rest wait, and all 20 still complete. Reverting the cap fails with
  *"the worker was handed 20"*.
- `admission_refuses_the_forty_first_request` — holds 8+32 permits, then expects 429 + `Retry-After: 1`.

Gate ALL GREEN; rebuilt and installed.

**Live proof is still not available, and now I know why.** 20 concurrent chat requests: 4 succeeded, 16
answered `429 all attempts failed … [agnes/key-01:RATE_LIMITED]` — the provider's own rate limit, and then its
key cooldown. The upstream caps out well before the gateway's 40-deep gate, on a single provider with a single
key. Proving it live needs a provider that accepts ~40 concurrent or a deliberately slow local upstream, and it
cannot be done against `agnes` without fighting its rate limit. The two unit tests now pin both numbers, which
is what was actually missing.

## What is left

- Live exercise of the admission ceiling (above) — needs a slow local upstream, not a real provider.
- Per-principal memory denial is **not** a coverage gap: it is unit-tested in both directions (recall *and*
  capture), including "either identity may deny" and the master key's own name. Only live exercise is missing,
  and `memory_principal_policy` has no HTTP surface to populate.

## Reinstall note — a rebuild costs one keychain approval

Replacing the app binary invalidates the keychain item's ACL, so macOS asks again before the app may read the
master key (`ai-provider-router` / `masterkey`). Until it is approved, **every** request answers:

```
503 {"error":{"message":"master key unavailable — the OS keychain did not respond; approve the keychain
prompt for this app, then retry","type":"service_unavailable"}}   Retry-After: 5
```

including unauthenticated ones, because the master-key check precedes auth. It is a prompt, not a failure:
approve it and the gateway recovers immediately (measured: 455 models on the next request). `SecurityAgent`
appearing in `pgrep` is the tell.

This is easy to misread as the earlier post-relaunch symptom, which also answers 503 but clears on its own —
that one is a stale worker heartbeat. The message distinguishes them; the status does not.

## Not verified

- The 8+32 capacity gate (upstream rate-limits first).
- Per-principal memory denial: `memory_principal_policy` is empty and there is no HTTP surface to add a row, so
  operator precedence was not exercised live. Client-side denial (`client_off`) was.
- Master-switch-off behaviour: the host toggle is currently on; flipping it needs the app, not HTTP.
