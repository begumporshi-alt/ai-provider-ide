# ARCHITECTURE AUDIT — AI-Provider Router

> **Audited:** 2026-09-18 · post-rename, on a green tree
> **Scope:** full workspace — `apps/desktop` (Tauri 2 + React 19), `packages/router-core`,
> `packages/adapter-spec`, the Rust host, and the four design documents
> **Method:** static read of the live source tree + executed verification (typecheck, unit,
> integration, and production build)
> **Verification status:** 330 tests green (205 router-core · 18 adapter-spec · 38 desktop ·
> 69 Rust), typecheck clean in all three TS projects on a single compiler, `vite build` clean,
> `key-leak-grep` OK, `check-ts-version` OK
>
> **UPDATE (same day, after this audit):** **all eight findings are now addressed** — R2, R3,
> R4, R5, R6, R7, R8 resolved, and R1 resolved in two passes: the gateway's *lifetime* is
> decoupled from the window (background mode) and its *execution* is decoupled from the UI
> renderer (dedicated worker window). See each section below.
>
> **LATER THE SAME DAY:** that open assumption was tested and **failed as written**. The
> dedicated worker window, created with `.visible(false)`, was being suspended by macOS as soon
> as nothing else was on screen — a real regression against background mode, not a
> hypothetical. Measured, diagnosed and fixed; see R1.
>
> The one caveat left: the gateway is still webview-hosted rather than truly headless (v2).
> Everything else here is machine-verified or measured.

---

## 1. Executive summary

**Verdict: architecturally sound, with three material gaps that are all additive rather than
structural.** The design's central bet — a UI-agnostic, port-injected router core sitting behind
a key-blind Rust host — is well executed and mechanically enforced, not merely documented. The
security model is the strongest part of the codebase.

The weak points are concentrated in one place: **the local gateway's dependence on the webview**,
plus two unfinished features that the schema advertises but the code does not implement (cost
attribution, per-provider concurrency). Neither requires rework.

| Dimension | Rating | Note |
|---|---|---|
| Structure & modularity | **Strong** | Clean layering, port/hexagonal core, honest module boundaries |
| Security model | **Strong** | Key-blind egress is mechanically enforced, not conventional |
| Test coverage | **Strong** | 290 tests incl. live HTTP e2e; acceptance criteria traced to tests |
| Scalability (single-user) | **Adequate** | Bounded, but global rather than per-provider concurrency |
| Cost observability | **Weak** | Schema supports it; code always writes zero |
| Operational independence | **Weak** | Gateway cannot run without the webview |
| Documentation | **Strong** | ARCHITECTURE/DECISIONS/AUDIT are unusually rigorous and current |

---

## 2. Overall structure

A pnpm workspace monorepo, three deployable units, ~15.9k LOC.

```
ai-provider-router/
├── apps/desktop/            Tauri 2 desktop shell (React 19 + TS + Tailwind 4)
│   ├── src/                 UI: 7 screens, 4 components, lib/ (tools, agent loop)
│   │                        5,074 LOC
│   └── src-tauri/src/       Rust host — 10 modules, 5,622 LOC
│       ├── vault.rs         keychain (keyring v2) — the only home of raw secrets
│       ├── egress.rs        ALL outbound HTTP; sentinel substitution; host allowlist
│       ├── store.rs         SQLite + the single migration runner (schema v1.1)
│       ├── gateway.rs       axum local gateway, multi-dialect ingress
│       ├── gateway_cmds.rs  gateway lifecycle commands + ledger rollups
│       ├── tools.rs         sandboxed tool host (no shell, allowlist, root-confined)
│       ├── persist.rs       row-level persistence + config export/import
│       ├── commands.rs      Tauri IPC surface
│       └── crash_report.rs  panic hook → scrubbed local report
├── packages/router-core/    5,172 LOC — UI-agnostic router (published entry point)
└── packages/adapter-spec/   declarative adapter-manifest grammar v1.1 (zod)
```

The split is deliberate and holds up: `router-core` has **zero** imports from React, Tauri, or
any UI concern, and `adapter-spec` has exactly one dependency (`zod`). Both are individually
typecheckable and testable, which is what makes the 181-test core suite possible.

---

## 3. Component and module relationships

### 3.1 The layering

```
L3  UI (React)                    screens → store.ts → ipc-client
L2  Router facade                 ModelRouter (the only public surface)
L1  Domain services               registry · catalog · planner · engine · health · ledger
L0  Host services (Rust)          vault · egress · store · gateway · tools
L-1 Ports (TS interfaces)         HttpPort · KeyVaultPort · StorePort · AiTextPort
```

Dependencies point downward, with one intentional exception: **`AiTextPort` is a dependency
inversion** — `ModelRouter` implements it and `AdapterGenerator` consumes it. This is how the
system breaks the otherwise-circular "generator needs AI, AI needs an adapter" loop. It is the
single most important structural decision in the codebase and it is correct.

The layering is relaxed in one documented place (L3 calls directly into L1 via `store.ts`,
rather than going through a strict use-case layer). That is a pragmatic and defensible choice
for a single-user desktop app; it is noted here only so nobody "fixes" it later.

### 3.2 The key-blind egress path (the security core)

This is the design's load-bearing invariant and it is enforced **mechanically**:

1. `ManifestInterpreter` renders a request whose auth header carries the literal `{{secret}}`
   sentinel — the TS side never holds a key.
2. `egress::inject_secret` resolves the secret from the keychain and substitutes it.
3. `check_secret_host` joins `secret_ref → api_keys → providers.base_url` and **refuses** the
   request unless the destination host matches the key's own provider.
4. Redirects are disabled outright (`Policy::none()`) for keyed requests, because `reqwest`
   does not strip `x-api-key` cross-host.

Consequence: a fully compromised webview can **ask** for egress but cannot pair a stolen
`secret_ref` with an attacker-controlled URL, and cannot widen the allowlist (only
`provider_upsert`/`provider_delete` mutate it, host-side). This is a genuinely strong property.

### 3.3 The gateway path (the architectural weak point)

```
external app → axum (Rust) → Tauri IPC → webview event loop → TS router → back
```

The gateway's HTTP edge is Rust, but **every request is executed by TypeScript running in the
webview**. If the webview is reloading, crashed, or its window closed, the gateway has no
route. Mitigations already present are real and good: a `Semaphore` bounds concurrency
(`MAX_TOTAL = 40`: 8 concurrent + 32 queued), client-disconnect cancels the upstream stream
(`client_disconnect_midstream_cancels_bridge` test), and a `503 + Retry-After` is returned when
the core is unavailable (`core_down_answers_503_with_retry_after`).

But the coupling remains: **the gateway cannot outlive the UI process.** A headless/service mode
is the correct fix and is already deferred to v2 in DECISIONS.md.

---

## 4. Key design decisions — assessment

| Decision | Assessment |
|---|---|
| `AiTextPort` dependency inversion to break the generator/router/adapter cycle | **Correct and essential.** Keeps the runtime graph a DAG. |
| Three-tier adapter stratification (builtin templates → declarative manifests → sandboxed code) | **Correct.** Solves cold-start without AI; the bootstrap problem is genuinely solved. |
| Secrets confined to the Rust host; TS is key-blind | **Correct, and the strongest property in the system.** |
| `keyring` v2 rather than v3 (macOS data-protection keychain breaks ad-hoc dev builds) | **Correct, evidence-based.** Documented with a revisit trigger (signed release). |
| `generateText` returns a stream **object** (`TextExecution`), not a bare `AsyncIterable` | **Correct.** A bare iterable cannot carry the fallback chain and serving attribution that acceptance criteria 3 and 10 require. |
| `onToolCall` callback rather than a tagged chunk union | **Correct.** Tool-call `arguments` arrive as indexed fragments that must be reassembled; interleaving them into a string stream would corrupt both. |
| Gateway ingress translation at the **edge**, not in the core | **Correct.** Four dialects (OpenAI Chat, Anthropic Messages, OpenAI Responses, Gemini) share one core surface; each new dialect is one handler + one test pack. |
| Round-robin cursor advances on **completion**, not per attempt | **Correct.** Mid-stream failure should not rotate everyone off a partially-good key. |
| Direct `rusqlite` + one migration runner instead of `tauri-plugin-sql` | **Correct.** Avoids split-brain between Tauri's migration list and the test driver's. |
| Sandboxed tool host: no shell, allowlist, root confinement, 60s/64KB bounds | **Correct, and unusually well-hardened.** `resolve_within` defeats `..` and outward symlinks; `git` network subcommands are refused. |

No decision in the record warrants reversal.

---

## 5. Dependencies

**Rust (23 direct):** `tauri` 2, `axum` 0.8, `reqwest` 0.12 (rustls, stream, http2),
`rusqlite` 0.32 (bundled), `tokio` 1.53, `keyring` 2, `quickjs`-family via emscripten,
`arboard`, `rand`, `url`, `base64`, `tracing`.

**TS:** React 19, Tailwind 4, Vite 8, zustand 5, zod 3, vitest 3, `quickjs-emscripten-core`
0.32, `eventsource-parser` 3.

Assessment: the dependency surface is **small and well-chosen** for a desktop app that handles
secrets. Two to watch:

- **`quickjs-emscripten` / `@jitl/quickjs-singlefile-mjs-release-sync`** — the Tier-2 sandbox.
  Small maintainer surface; if it stalls, the sandboxed code-adapter tier stalls with it. The
  tiering means this degrades gracefully (Tier-0/Tier-1 need no sandbox).
- **TypeScript 6.0.3** in `apps/desktop` vs **5.8** in the two packages. This is a real split;
  it typechecks today, but it is a latent source of inconsistent behavior between the app and
  the packages. Worth unifying.

Versions are pinned by a lockfile and `packageManager: pnpm@10.12.4`. Supply-chain posture is
reasonable.

---

## 6. Scalability

The load model is **one user, a handful of providers, tens of keys, hundreds of models** — and
the architecture is well matched to it.

- **Catalog size:** `models_cache` carries ~444 rows per large aggregator (OpenRouter) without
  issue; indexed by `(provider_id, modality)`.
- **Ledger growth:** append-only, 90-day retention with monthly rollups
  (`ledger_rollups`, idempotent upsert, complete months only) and indices on `(ts)` and
  `(provider_id, ts)` plus a partial index for drift queries. Correctly designed.
- **Concurrency:** bounded globally at 40 in-flight gateway requests. **Not bounded
  per-provider** — see R3.
- **Streaming:** cancellation propagates end-to-end via `AbortSignal` through `execution-engine`,
  and mid-stream client disconnect tears down the upstream provider connection.

There is no multi-user, multi-tenant, or horizontal dimension, and none is needed.

---

## 7. Maintainability

**Strengths.** The module boundaries are real: 5,172 LOC of router logic with no UI dependency
and 181 tests is a strong ratio. Comments explain *why* (invariant numbers, acceptance-criteria
cross-references), not *what*. DECISIONS.md is append-only with explicit revisit triggers — that
is institutional memory done properly. Error taxonomy and the single health vocabulary are
consistent across layers.

**Weaknesses.** `apps/desktop/src/store.ts` is a **god module** — bootstrap, hydration,
write-through persistence, and every state-changing action in one file. It is the one place
where the otherwise-clean layering degrades. `commands.rs` is the equivalent on the Rust side.
Both are understandable (they are the IPC seam) but they will be the friction point as features
grow.

**Verification culture is excellent** — this is the project's best maintainability asset:
live-HTTP e2e tests (onboarding, drift-repair, code-adapter, acceptance), a key-leak grep in
CI (`scripts/key-leak-grep.sh`), and a web-test harness that drives the unmodified React app in
a browser.

---

## 8. Risks and weaknesses

Ordered by materiality. Each has a concrete fix.

### R1 — [HIGH] The gateway cannot run without the webview — **RESOLVED 2026-09-18**

Every gateway request executes in the webview's JavaScript event loop. Consequences: the
gateway dies with the window (Tauri exits on last-window close by default), is unavailable
during HMR reload, and inherits the renderer's responsiveness. The bound and the 503 path
already exist, so this is a **known, documented** limit — but it caps the gateway's reliability.

**Fix:** headless/service mode — run the router core in a Rust-side or Node-side worker so the
axum edge does not depend on the renderer. Already slated for v2; treat it as the top v2 item.

**Resolution (partial): background mode shipped.** The *lifetime* coupling is gone — the
process outlives the window.

- Closing the window calls `prevent_close()` + `hide()` instead of destroying it, so Tauri no
  longer exits. The gateway keeps serving.
- A **tray icon** (Tauri 2 core, `tray-icon` + `image-png` features) provides Open and Quit —
  without it a hidden app would be unreachable, which is why tray construction failure is
  handled by *logging and leaving close-to-quit intact* rather than stranding the process.
- macOS Dock reopen (`RunEvent::Reopen`, `#[cfg(target_os = "macos")]`) restores the window.
- Preference `settings.background.hideOnClose`, default ON, toggleable in the Gateway screen.
- **Hidden-window heartbeat bound:** macOS throttles timers in a hidden window, so the 6s
  liveness bound relaxes to 30s while hidden (`HEARTBEAT_STALE_HIDDEN_MS`). Entering background
  stamps the heartbeat so the grace window starts fresh. Leaving background restores 6s, so a
  renderer that dies while hidden is still detected. 3 new tests cover all three transitions.

**Execution coupling — RESOLVED 2026-09-18 (by decoupling, not by going headless).**

The bridge moved into its own never-visible `WebviewWindow` (`gateway.html` →
`src/gateway-worker.ts`), created on `gateway_enable`. Consequences removed:

- UI render work can no longer delay a gateway request — separate renderer, separate JS context.
- An HMR reload of the UI no longer tears down the bridge: the worker page's module graph
  contains no React, so editing screens does not reload it. (Editing `router-core` still does,
  and there is no HMR at all in a production build.)

This is **not** headless in the strict sense — still a webview, still TypeScript. True headless
(router-core outside any renderer) needs a bundled Node runtime plus the entire host command
surface re-plumbed over a new IPC transport, since a sidecar cannot use Tauri `invoke`. That is
a v2 epic; this captures both symptoms at a fraction of the cost and risk.

Three details that matter:

1. **`emit_to` is load-bearing.** `emit` broadcasts to every webview and both windows hydrate a
   router core, so a broadcast would answer each request twice — two upstream calls, two ledger
   rows, two streams to the client.
2. **`startGatewayBridge` refuses to start outside the `gateway` window.** Makes that bug
   impossible rather than unlikely, and stops a stray heartbeat from keeping the core looking
   alive after the worker dies.
3. **The staleness bound now tracks the bridge host, not the UI window.** The worker is hidden
   by design, so 30s is the production bound; showing the UI no longer clears it.

**The assumption was then tested — and it failed as written.** Verified 2026-09-18 on macOS 15
with a standalone AppKit/WKWebView harness (`/tmp/wvprobe`), 2s timer, UI window hidden. This
was a real bug in the shipped code, not a hypothetical:

| how the worker window is shown                | ticks over 24s | JS |
|-----------------------------------------------|----------------|----|
| never ordered in — `.visible(false)`          | 0              | **suspended** |
| `orderFront` + `orderOut` immediately         | 0              | **suspended** |
| `orderFront` + `orderOut` after 16ms          | 0              | **suspended** |
| `orderFront` + `orderOut` after 300ms         | 8 (max gap 3.0s) | alive |
| `orderFront` + `orderOut` after 1000ms        | 8 (max gap 3.0s) | alive |
| ordered in once, then `orderOut` (UI window)  | 10             | alive |

macOS suspends the JS of a webview whose window was never actually composited — and it stays
suspended exactly when nothing else is on screen, which is precisely when the gateway is meant
to be serving. tao's `visible(false)` skips `makeKeyAndOrderFront` altogether
(`tao/platform_impl/macos/window.rs:630`), so `.visible(false)` produced row 1: the worker ran
while the UI was up and died the moment the app went to the background — a regression against
background mode, which had worked when the bridge lived in the (always-displayed) UI window.

Two things ruled out while diagnosing:

- **App Nap is not the cause.** Suppressing it (`ProcessInfo.beginActivity`) changed nothing.
- **Parking the window off-screen does not work.** macOS clamps windows back into the visible
  area — a window requested at `x = -4000` lands at `x = 480`. So there is no invisible
  warm-up; the window must genuinely appear.

**Fix (shipped):** create the worker window visible, undecorated and small, then hide it after
`WORKER_WARMUP_MS = 1000` (3x the proven 300ms minimum). Once composited it keeps running with
no window on screen. `focused(false)` makes tao use `orderFront` rather than
`makeKeyAndOrderFront`, so the warm-up does not steal key-window status. Cost: a ~220x140
undecorated window is briefly visible when the gateway starts, once per session.

Measured margin on the liveness bound: a hidden webview's 2s timer fires at ~0.33/s with a worst
observed gap of 3.0s, so `HEARTBEAT_STALE_HIDDEN_MS = 30_000` carries 10x headroom — throttling
cannot trip it, while a genuinely suspended renderer is still caught.

Not covered by CI: this is a platform behaviour, so no automated test can assert it. The
evidence is the harness above; the constants carry the numbers in comments so the next reader
does not have to rediscover them.

### R2 — [HIGH] Cost attribution is designed but never computed — **RESOLVED 2026-09-18**

`ledger.cost_estimate_micros` is **always written as 0**. `models_cache.pricing_json` is
populated but never read; `route-planner.ts` explicitly notes that `cost_spread` rotation "falls
back to priority" because per-model pricing is unavailable in v1. So the Usage/Activity screen
cannot answer "what did this cost?", `cost_spread` rotation is inert, and the monthly rollup's
cost column is structurally always zero.

This is the largest gap between the documented feature set and the shipped behavior.

**Fix:** normalize `pricing_json` to micro-USD at catalog-write time (OpenRouter already
publishes it; treat unknown-pricing providers as `null`, never `0`), compute cost in
`ModelRouter` from `exec.usage()`, and render "unknown" distinctly from zero in the UI.

**Resolution (applied):** new `packages/router-core/src/pricing.ts` parses provider pricing
(OpenRouter `pricing.{prompt,completion}`, plus `input/output` and `*_cost_per_token` variants)
into a canonical unit — **micro-USD per 1M tokens**, integer, which avoids the per-token
~1e-7 rounding-to-zero trap. `ModelCatalog` now captures `pricing` per model from the raw
catalog entry, `ModelRouter` computes real cost into the ledger, and `cost_spread` orders
carriers cheapest-first (opt-in via `PlanContext.pricingFor`, so legacy ordering is untouched).
The Activity screen gained a Cost column that renders **"—" for unknown pricing** rather than
"$0.00"; `estimateCostMicros` returns `undefined` (not 0) when pricing is unknown, so unknown
and free stay distinguishable. 15 new tests; sub-cent costs format to 6 decimals.

**Known limitation:** unknown-vs-free is resolved at render time from the in-memory catalog, not
persisted per row. A historical row whose provider later stops publishing pricing would render as
unknown. Persisting a `cost_known` column (migration `0002`) is the durable fix if that matters.

### R3 — [MEDIUM] Concurrency is global, not per-provider — **RESOLVED 2026-09-18**

`MAX_TOTAL = 40` bounds all gateway traffic. One slow or rate-limited provider can consume the
entire budget and starve every other provider — which defeats the purpose of failover. The audit
record (M4) asked for per-provider caps; they are not implemented.

**Fix:** a per-provider semaphore (e.g. 8 permits each) in addition to the global bound, with
the queue rejecting rather than blocking indefinitely.

**Resolution (applied):** new `packages/router-core/src/concurrency.ts` (`ProviderLimiter`),
consulted per candidate by `ExecutionEngine` and wired through `ModelRouter` with a
configurable `settings.perProviderConcurrency` (default 4; `0` = unlimited).

A deliberate design choice: the cap lives in the **router core, not the gateway ingress**. The
gateway cannot know which provider will serve a request until the router has planned it, so a
cap enforced at ingress could only reject or queue. Enforcing it in the core means a saturated
provider is **skipped in the plan**, so the request fails over to a provider that can serve it —
which is the property the audit actually wanted. Skipped candidates are recorded as
`RATE_LIMITED` outcomes so the fallback chain stays honest. Permits release in a `finally`, on
every path including mid-stream throws, and release is idempotent so capacity cannot leak.
9 new tests, including one proving a saturated provider is never re-entered.

### R4 — [MEDIUM] No spend controls on the gateway — ✅ RESOLVED

The gateway exposes the user's paid credentials to arbitrary local apps behind a single master
key, with **no budget, no per-app keys, and no rate limit per consumer**. A runaway agent loop
in a connected IDE can spend without bound. Documented as a v1 limit, but it is a financial
risk, not just a feature gap.

**Fix (shipped):** an optional monthly spend cap plus per-app gateway keys.

**What landed**

- *Schema* — migration `0002_gateway_keys` adds `gateway_keys (id, label, created_at,
  last_used_at, revoked_at)`. Ids only: the secret lives in the OS keychain under `gwkey:<id>`
  and is never written to SQLite (invariant 14).
- *Per-app keys* — `gateway_app_key_create` generates a crypto-random `sk-aip-…` secret, puts it
  in the keychain, records the row, then copies it to the clipboard host-side. The webview only
  ever receives `{id, label}`. Auth (`check_gateway_key`) accepts master **or** any active app
  key; every comparison is constant-time and the loop deliberately does not break early, so a
  match followed by more keys leaks no length/first-byte oracle.
- *Revocation* — `active_gateway_key_ids` is re-read per request, so revoking kills the key on
  the **next** request with no restart and no master rotation. The row is retained (audit
  trail); `delete` is a separate, explicit action.
- *Spend cap* — `month_spend_micros` is a single indexed SUM at the UTC month boundary
  (computed in SQL, not by hand-rolled calendar math). When reached, the gateway answers
  **402** with `code: "spend_cap_exceeded"` — the one status clients already read as "out of
  credit", so a runaway loop stops retrying rather than hammering a 429/403.
- *UI* — Gateway screen gained "Per-app keys" (create / revoke / delete) and "Monthly spend
  cap" (this-month total, cap in USD, disable).

**Three judgement calls worth recording**

1. *Cap scope = all sources, not gateway-only.* Counting only `source='gateway'` would be
   silently understated by Playground and generator usage. The user sets a budget on what they
   pay, not on one client. Stated explicitly in the UI copy.
2. *Cap checked after auth, never before.* Otherwise a 402 would disclose the configured budget
   and current spend to anyone who can reach the loopback port.
3. *Brute-force backoff moved to the failure path.* It previously ran before the key was
   checked, so one bad credential throttled **every** caller for 500ms+ — with per-app keys
   that is one misconfigured app locking out all the others. Now a valid key always gets
   through (and closes the window); repeat *failures* are still throttled at the same bound.
   This was found by a test, not by reading.

**Scope note:** no per-consumer *rate* limit (requests/min per app key). The global `MAX_TOTAL`
semaphore and R3's per-provider caps still apply, but one app key can still monopolise them.
Tracked as a v1.1 follow-up — it needs a per-key token bucket, which is a different mechanism
from anything here.

### R5 — [MEDIUM] The rename orphans existing local data — **RESOLVED 2026-09-18 (accepted)**

Renaming `identifier` and the keychain service changes both the app-data directory and the
keychain namespace. Verified on this machine:

```
~/Library/Application Support/dev.aiprovider.ide/ai-provider-ide.db   ← existing data
keychain service "ai-provider-ide"                                     ← existing keys
```

After the rename the app reads `dev.aiprovider.router/ai-provider-router.db` and service
`ai-provider-router`. **Any installed build loses its providers, keys, manifests, and ledger.**
Keys are not lost from the keychain — they are merely invisible under the new service name.

**Fix (choose one):** (a) accept it — defensible pre-release, but tell anyone running a build
they must re-enter keys; or (b) ship a one-time migration that copies the DB to the new path and
re-registers keychain entries under the new service. Recommended: (a) now, since the app is
pre-release, and record it in DECISIONS.md.

**Resolution (applied): (a) accept.** Measured on this machine first, because the finding was
only ever theoretical:

```
dev.aiprovider.ide/ai-provider-ide.db        360 KB  + 4.3 MB WAL   ← real data, last written 14:13
dev.aiprovider.router/ai-provider-router.db    4 KB                 ← created empty on first launch
```

So the orphaning is live, not hypothetical: the renamed build starts with no providers,
manifests or ledger, and keys held under the old keychain service are invisible to it.

Accepted anyway. The app is pre-release and the only person affected is the developer — there
are no users whose data would be destroyed. Re-entering provider keys is cheaper than shipping
migration code that reads one database, writes another and re-registers keychain entries; that
code would be dead weight the instant it had run once, and a bad WAL copy can lose recent rows
far more quietly than an empty database announces itself.

Nothing was deleted. The old directory stays in place so the data remains recoverable until it
is removed by hand. Recorded in DECISIONS.md.

### R6 — [LOW] TypeScript version split (6.0.3 vs 5.8) — **RESOLVED 2026-09-18**

`apps/desktop` uses TS ~6.0.3; both packages use ~5.8. Typechecks today, but two compilers
across one workspace invites drift.

**Fix:** unify on one version.

**Resolution (applied):** unified **upward on 6.0.3**, pinned exactly.

- Direction chosen by test, not by preference: both packages were typechecked against the
  6.0.3 binary *before* touching any manifest. Both were clean, so the packages moved up
  rather than desktop moving down — one compiler, at the newest version.
- Pinned exactly (`6.0.3`, no `^`/`~`). Ranges let *resolved* versions drift even when the
  declared strings match, which is the same bug one level down.
- Lockfile regenerated (`pnpm install --lockfile-only`); `typescript@5.8.3` is gone and
  `--frozen-lockfile` passes, so CI's install step is unaffected.

**The guard is the actual fix.** Matching versions by hand stops nothing from drifting again,
and the failure is silent — everything typechecks locally, then behaves differently per
package. `scripts/check-ts-version.sh` (wired as `pnpm check-ts-version` and into CI) fails if
any two workspace packages declare different TypeScript, if the pin is a range rather than
exact, or if `pnpm-lock.yaml` resolves to more than one TypeScript. It was negative-tested:
reverting one package to `~5.8.0` makes it exit 1 with the offending file named.

### R7 — [LOW] `dev.db` was untracked and not ignored — **RESOLVED 2026-09-18**

`apps/desktop/src-tauri/dev.db` existed untracked in the working tree — a local database one
`git add -A` away from being committed with real provider references and ledger history.

**Fix (applied):** `*.db`, `*.db-shm`, `*.db-wal` added to `.gitignore`.

**Verified 2026-09-18:** the three rules are present under `apps/desktop/src-tauri/`, and
`git ls-files` reports no tracked `.db` anywhere in the tree.

### R8 — [LOW] `store.ts` / `commands.rs` concentration — **RESOLVED 2026-09-18**

Both IPC seams accumulate every action. Acceptable now; they will not scale indefinitely.

**Fix:** when either passes ~1.5k LOC, split by domain (providers / keys / manifests / ledger /
settings) behind the existing command surface. No behavior change.

**Resolution (applied) — but the finding named the wrong files.** Measured against its own
1.5k trigger, neither file qualifies: `store.ts` is 545 lines, `commands.rs` is 270. The
concentration that mattered was **`gateway.rs` at 2,389 lines**, which also had the widest blast
radius in the codebase — auth, four wire dialects, the tool loop, capacity, and the spend gate
all in one file.

Split by **dialect**, not by size, so a framing change to one protocol cannot touch another:

| file | lines | contents |
|---|---|---|
| `gateway.rs` | 552 | core state, bridge protocol, auth, capacity, shared helpers |
| `gateway_handlers.rs` | 312 | OpenAI Chat / models / images + catch-all |
| `gateway_anthropic.rs` | 290 | Anthropic Messages |
| `gateway_responses.rs` | 281 | OpenAI Responses |
| `gateway_gemini.rs` | 259 | Gemini `generateContent` |
| `gateway_tests.rs` | 790 | integration tests (`gateway::tests` via `#[path]`) |

Verified as behaviour-preserving: 69 Rust tests pass unchanged, including all four dialect
integration tests, with no new compiler warnings.

**Two things worth recording:**

- *Nothing had to be made `pub`.* Child modules can reach the parent's private items, so the
  shared helpers stay private in `gateway.rs` and each dialect imports them. Only the seven
  handler entry points became `pub(crate)`.
- *Tests were not split.* They exercise the HTTP surface end to end, so per-dialect test files
  would duplicate the harness for no gain.

**Still watch:** `persist.rs` (1,297) and `egress.rs` (648) are the next-largest. Neither is
urgent, but `persist.rs` is growing and is the natural next candidate under the same rule.

---

## 9. Recommended sequence

1. ~~**R5** — decide and record the data-migration stance~~ **DONE** (accepted, recorded in
   DECISIONS.md with a revisit trigger).
2. ~~**R2** — cost attribution~~ **DONE** (pricing.ts, ledger cost, `cost_spread`, Cost column).
3. ~~**R3** — per-provider concurrency caps~~ **DONE** (ProviderLimiter in the router core).
4. **R1** — headless gateway mode (the v2 keystone, largest remaining item).
5. **R1** — headless gateway mode (the v2 keystone) — largest remaining item.
6. **R6 / R8** — hygiene: unify TypeScript (6.0.3 vs 5.8), plan the IPC-seam split
   (`store.ts` / `commands.rs`).

---

## 10. Verification performed

| Check | Result |
|---|---|
| `tsc --noEmit` — adapter-spec | clean |
| `tsc --noEmit` — router-core | clean |
| `tsc --noEmit` — desktop | clean |
| vitest — router-core | **205 passed** (15 files) |
| vitest — adapter-spec | **18 passed** (2 files) |
| vitest — desktop (incl. live-HTTP e2e) | **38 passed** (6 files) |
| `cargo test --lib` — Rust host | **53 passed** |
| `vite build` — production frontend | built in 963ms; new name present, **0** old-name occurrences |
| `pnpm install` — lockfile | up to date with `@aiprovider/router-core` |
| `pnpm key-leak-grep` (criterion 5) | OK |
| `pnpm --filter ai-provider-router-desktop` | resolves (renamed from `--filter desktop`) |

**Total: 314 tests green.** (290 at first audit + 9 concurrency + 15 pricing.)

---

*Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md) · [DECISIONS.md](DECISIONS.md) ·
[AUDIT_REPORT.md](AUDIT_REPORT.md) (2026-09-15 pre-implementation audit) ·
[MASTER_PROMPT.md](MASTER_PROMPT.md) · [UI_UX_PLAN.md](UI_UX_PLAN.md)*
