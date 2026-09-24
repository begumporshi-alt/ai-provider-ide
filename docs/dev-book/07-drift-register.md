# 07 — Drift register

## Why this file exists

Documentation drifts behind code, always. The damage is not the drift itself — it is a stale claim that **looks
authoritative**, because a new contributor who finds one false statement stops trusting all of them.

So the rule is not "never drift". The rule is:

> **If you change a fact, update its owner — and if you cannot, log it here.**

A claim that is known to be stale, and written down as stale, costs nothing. The same claim left unmarked is
what makes every other page suspect.

## The change checklist

The practical half of this chapter. Find your change, update every row.

| If you change | Also update |
|---|---|
| A `#[tauri::command]` | `apps/desktop/web-test/shim.ts` **the same day**, and the command count in [03](03-contracts.md) |
| A migration or a table | version + count assertions in `store.rs`, the table list in [04](04-data-model.md) |
| The product version | `pnpm check-version-sync` covers six manifests; add a `CHANGELOG.md` entry |
| The gate (`ci.yml`) | `scripts/ci-local.sh` (the mirror) and the step table in [05](05-workflow.md) |
| An HTTP route | the surface table in [03](03-contracts.md), plus a gateway test |
| An invariant | [03](03-contracts.md) **and** `ARCHITECTURE.md` §5 |
| A screen | the `NAV` constant in `components/Shell.tsx` **and** the screen map in [01](01-orientation.md) |
| A dependency's major version | the toolchain table in [01](01-orientation.md) |
| A design decision | a dated entry in `DECISIONS.md` |
| A chapter, or any link inside one | regenerate the HTML — `pnpm docs:book` fails on a broken reference |
| Any fact stated in two places | delete one of them, or add a row below |

## The register

| ID | Claim | Where | Evidence | Verdict | Status |
|---|---|---|---|---|---|
| **D1** | "Status: greenfield, pre-scaffold" | `ARCHITECTURE.md:8` | The app ships v1.0.0 with 15 migrations, a release workflow and a licence | **False** | **Fixed** |
| **D2** | OS keychain CRUD via `keyring` **v3** | `ARCHITECTURE.md:125`, `:702`, `:871` | `Cargo.toml:33` is `keyring = "2"`; `DECISIONS.md` 2026-09-16 records the v3→v2 downgrade because v3's macOS data-protection keychain breaks unsigned dev builds. Line `:782` already said v2 correctly, so the file contradicted itself | **False** | **Fixed** |
| **D3** | "Per-app gateway keys … are a stated v1 limitation — one master key for now"; "a single master key (no per-app keys) is a stated v1 limitation" | `ARCHITECTURE.md:516-518`, `:812-813` | Per-app keys **ship**: `gateway_app_key_create`, `gateway_app_keys`, `gateway_app_key_revoke`, `gateway_app_key_delete` (`commands.rs:713-716`), the `gateway_keys` table, and `CHANGELOG.md` 1.0.0 | **False** | **Fixed** |
| **D4** | "per-app keys + budgets are the follow-up" | `ARCHITECTURE.md:848-850` | Half true when written. Per-app keys shipped, but the spend cap was **global and monthly** — `gateway_spend_status` compared one `month_micros` against one `cap_micros`, with no per-key dimension | **Half** | **Fixed** — the remaining half closed 2026-09-23 (0017: `gateway_keys.cap_micros` + per-app enforcement). The `ARCHITECTURE.md` line now states both ship |
| **D5** | The local mirror "runs the same steps in the same order as `ci.yml`" | `ci-local.sh:2`, `:10`; `CONTRIBUTING.md:21` | The step **sets** were identical; the **order** differed in one place. Measured by extracting both: `dependency audit` was step 2 in `ci.yml` and step 7 in `ci-local.sh`. Every other shared step was in the same relative order | **False** (ordering only) | **Fixed** — the claim was corrected first, then the script was aligned on 2026-09-22. Both mirrors are now step-for-step identical |
| **D6** | Module map lists 7 screens from the spec era | `ARCHITECTURE.md` §1.2 | The app ships **13** screens (`ScreenId` in `ui-state.ts`; 13 files in `screens/`). Seven post-date the map — and one of those is a **rename**, not an addition: `screen-usage` no longer exists, and `Activity.tsx` is headed "the request ledger first". So the map is missing 6 genuinely new screens and stale on 1. Their subsystems are designed in `GATEWAY_MEMORY_LAYER.md` and `CONTROL_SCREEN_BUILD.md` | **Stale** | **Fixed** — a shipped-screens table was *added* below the spec map rather than replacing it, so both the plan and the difference survive |
| **D7** | "The gateway listens on port 8800" vs "a fresh install starts on 8787" | `README.md:121-122` | Both are correct and describe different things: **8787** is `DEFAULT_PORT` (`gateway.rs:36`), **8800** is this machine's persisted setting because AI Hub v2 also claims 8787. Not drift | **Correct** | **Verified** — recorded so the next person does not re-check it |
| **D8** | "The column exists; the data does not yet" (`cached_tokens`) | `PRODUCT_COMPLETION_PLAN.md:449-454` | The live database **was** at `schema_version = 14` and `ledger.cached_tokens` **was** absent (`pragma_table_info`), because the installed bundle had not been rebuilt since migration 0015 landed | **Inaccurate, now true** | **Fixed** — rebuilt, reinstalled and relaunched 2026-09-22. Measured afterwards: `schema_version = 15`, `ledger` has 17 columns, all **1530** pre-existing rows carry `cached_tokens IS NULL`, and 0 rows report a value |
| **D9** | Six relative references to the diagram assets — `diagrams/architecture.html`, `diagrams/self-construction.html`, `diagrams/gateway.html`, `diagrams/memory-context-gateway-read-path.svg`, `diagrams/memory-context-gateway-write-path.svg`, `diagrams/` | `ARCHITECTURE.md:16-18`, `AUDIT_REPORT.md:4`, `MEMORY_CONTEXT_GATEWAY_INTEGRATION.md:16,17,34,205` | The diagram assets live at the **repository root** in `diagrams/`, not under `docs/`. The 2026-09-22 reorganisation moved 19 docs into `docs/` and verified "17 markdown links across 36 files, 0 broken" — but that check validated `.md` targets only, so **every `.html`, `.svg` and directory link broke silently**. Two of the four in `MEMORY_CONTEXT_GATEWAY_INTEGRATION.md` are image embeds, so they render as broken images | **False** | **Fixed** — all six now use `../diagrams/` |
| **D10** | "closing the window stops the gateway, and the Gateway settings screen says so plainly"; "a reloading, crashed or **closed** window means `503` for every client" | `ARCHITECTURE.md:520-521`, `dev-book/09-status.md:58` | The opposite ships, and has since R1. `RunEvent::WindowEvent` (`lib.rs:262-275`) calls `prevent_close()` then `hide()` whenever `hide_on_close(app)` is true, and `hide_on_close` (`lib.rs:131-148`) reads `settings.background.hideOnClose`, **defaulting to true** — including when the store state is absent. The line it logs is "window hidden — gateway still serving in background". The UI agrees with the code (`screens/Gateway.tsx:193-199` — "closing the window hides the app and the gateway keeps serving"; `:312` — "including with the window closed, once background mode is on"), and `DECISIONS.md:541-556` records the R1 decision that fixed precisely this: "This change fixes the first; the other two need a real headless core (v2)". Both docs therefore describe pre-R1 behaviour, and `ARCHITECTURE.md` is wrong twice over — about the behaviour *and* about what the screen says. **Nothing pinned it:** `hide_on_close` appeared in exactly two places — its definition and its call site — with no test on the default. Closed by extraction: `hide_on_close_from` (`lib.rs`) now holds the decision, and `hide_on_close_defaults_on_and_only_an_explicit_false_turns_it_off` pins all 12 inputs, both arms falsified | **False** | **Fixed** |

| **D11** | "Required secrets (see CONTRIBUTING.md)" | `.github/workflows/release.yml:52` (as written 2026-09-22) | `CONTRIBUTING.md` documented **no** `APPLE_*` secrets at all. A Grep for `APPLE_\|secret\|release\|sign` returned two unrelated hits — `:13` ("Xcode command line tools for `codesign`") and `:68` (a clippy note). The six secrets were documented only in `docs/dev-book/05-workflow.md:166-167`, so a maintainer following the workflow's own pointer found nothing and had no way to provision a release. The gap was compounded by `09-status.md`'s "**No notarized release**" row, which named the *symptom* and implied the pipeline was missing — when the real defect was that it was **unfalsifiable**: `tauri build` succeeds with no secrets and emits an ad-hoc signed app, so the job went green and a draft appeared | **False** | **Fixed** — a "Releasing" section was added to `CONTRIBUTING.md` on 2026-09-23 with the one-time provisioning; `release-preflight.sh` and `verify-release-signature.sh` make the pipeline fail loudly instead of silently emitting an unusable artefact; the gap row was reworded to "Release not provisioned" |

| **D12** | The Phase 1 task prompt's module layout: "`persist.rs` … MOVED" to `core/` and "`egress.rs` … MOVED" to `core/` — as files that can move **unchanged**; and "104 Rust tests + 460 TS unit tests + 27 e2e tests" | `AGENT_PROMPT_HEADLESS_SERVICE.md:99,103,55` | Both placements are impossible as stated. `gateway.rs` calls `crate::persist::{active_gateway_key_ids, gateway_key_cap, month_spend_micros, app_month_spend_micros, spend_cap_micros}` in **non-test** code (`gateway.rs:217,316,907`), so `persist` in `tauri/` makes `core/` depend on the glue; and `persist` in `core/` fails from the other side because `persist.rs` imports `crate::egress::EgressState` and `crate::commands::CommandError`. `{persist, egress, CommandError}` is one cluster — all three moved and `CommandError` was extracted to `core/error.rs`. The test count is **489**, not 104 (measured `cargo test`, 2026-09-23). The prompt's `104` appears to be a count of `gateway_tests.rs` alone — and that file holds **113**, so the figure is wrong under either reading: too low for the file, and a fraction of the crate. The prompt's file list covers **15 of 29** `.rs` files | **False** | **Fixed** — see [10](10-headless-service.md) §2.1.1 |
| **D13** | Every `file:line` citation in the docs that names a module moved by the Phase 1 split — `gateway.rs`, `store.rs`, `persist.rs`, `commands.rs`, `gateway_cmds.rs`, `egress.rs`, `vault.rs`, `tools.rs`, `memory.rs`, `crash_report.rs`, `context_scope.rs`, `lib.rs` | ~230 matches across 23 markdown files (Grep, 2026-09-23) | The split moved 27 of 29 modules into `src/core/` or `src/tauri/`, so a reader following "`gateway.rs:1755`" lands on nothing. **Scoped deliberately rather than swept:** the *live* docs were updated — `09-status.md` (5 references plus a new Phase 1 row), `03-contracts.md`, `02-architecture.md`, `04-data-model.md`, `10-headless-service.md`. The **dated** audit and plan files (`SECURITY_AUDIT_2026-09-20.md`, `ARCHITECTURE_AUDIT.md`, `AUDIT_TRAIL_READER_2026-09-21.md`, the `*_PLAN.md` files and similar) are point-in-time records with the date in the filename, and rewriting their citations would misrepresent what was measured and when. Earlier entries in this register are in that second class: their `lib.rs` and `gateway.rs` citations describe the tree as it was | **Stale** | **Partly fixed** — live docs current, dated snapshots left as history |
| **D14** | "Tauri build \| `pnpm build` \| Yes" — `pnpm build` is presented as the gate that proves the Tauri app still builds; §10 restates it as "`pnpm build` produces a working Tauri app" | `AGENT_PROMPT_HEADLESS_SERVICE.md:232`, `:302` | `pnpm build` never invokes Tauri. Root `build` is `pnpm -r build`; the desktop `build` is `pnpm build:clean && tsc && vite build` — TypeScript and Vite only, ~17 s, no `cargo` and no bundler. The bundler runs only under the `tauri` script: `pnpm --filter ai-provider-router-desktop tauri build` (~2m42s). **This is a gate that cannot fail on the error it exists to catch**, and Phase 1 proved it: adding the second `[[bin]]` broke `tauri build` with `failed to find main binary` — its own suggested remedy, `default-run`, being the actual fix — while `pnpm build`, `cargo check`, `cargo test`, `cargo clippy` and `cargo fmt --check` were **all green**. Only a real `tauri build` found it | **False** | **Met by running the real command** — the criterion was satisfied with `tauri build` and the fix (`default-run` in `Cargo.toml`) is in place. Note the `checks` CI job still runs only `pnpm build`, so the same blind spot persists in CI |

| **D15** | The `headless-service` CI job — "a module split that accidentally reached back into Tauri glue would surface here, not in `checks`" — offered as evidence that the service is Tauri-independent | `.github/workflows/ci.yml:118-119`, `:143` (as written 2026-09-23) | The job ran `cargo build --bin aiproviderd --release` with **default features**. When written that was not a wrong flag but a wrong *claim*: `tauri` was an unconditional dependency, so no flag existed that could have excluded it — the job built what every other job built, and the WebKitGTK install beside it was honest evidence of the coupling. It became a live blind spot the moment the `app` feature landed, because `default = ["app"]` means the flagless command still compiles Tauri — the job would have stayed green while proving nothing about the split it exists to test. Fixed by building with `--no-default-features` and dropping the GTK/WebKit packages, now unreachable: `cargo tree --no-default-features --edges all \| grep -ci 'webkit\|wry\|gtk'` → **0** | **False** (after the split) | **Fixed** 2026-09-23 |

| **D16** | `AGENT_PROMPT_HEADLESS_SERVICE.md` §8.1 lists the dev book as a gate step — "Dev book, `pnpm docs:book`, Yes" | `AGENT_PROMPT_HEADLESS_SERVICE.md:235` | `pnpm docs:book` runs in **neither** mirror: not among `ci.yml`'s 17 `checks` steps, not among `ci-local.sh`'s 18. The prompt has claimed it since Phase 1, so the gap is old; it became visible on 2026-09-23 when a table row in [10](10-headless-service.md) carried **two adjacent escaped pipes inside one code span**. The generator rejected it — "table row has 4 cells but the header has 2" — while the entire local gate, `Doc links resolve` included, reported **ALL GREEN**. A book that will not build could therefore be committed, and the failure is quiet by construction: the offending row reaches a reader as a mangled table rather than as an error. The two checks are not substitutes — `check-doc-links` resolves links, `docs:book` parses structure — and the generator does tolerate a *single* escaped pipe inside a code span (D15's row relies on exactly that), but not two adjacent ones | **False** | **Fixed** 2026-09-23 — `Dev book builds` added to both mirrors at position 11, and the parity table re-measured to 18/19 |

| **D17** | The Phase 1 acceptance for the Tauri-free split — `core/` "must not name `crate::tauri::*`" — carried by building the service with `--no-default-features` | `.github/workflows/ci.yml` headless job step 2; `scripts/ci-local.sh:136`; `AGENT_PROMPT_HEADLESS_SERVICE.md` §8.1 | The check is real but **narrower than the claim it is offered for**. Both mirrors build `--no-default-features` *without* `--all-targets`, so the lib's `cfg(test)` code is never compiled in that configuration — and it does not compile: `cargo check --no-default-features --all-targets` fails with **33 errors**, the first being `persist.rs:2349` calling `list_drift_events`, which is defined behind `#[cfg(feature = "app")]` at `persist.rs:825`. So `core/`'s *shipping* code is Tauri-free — which is what the claim was about, and it holds — while `core/`'s *tests* are not. Measured 2026-09-23 while landing increment 3 of Phase 2. `persist.rs` is untouched by that work (`git diff --name-only` lists nine files, none of them `persist.rs`) and `cargo check --no-default-features` without `--all-targets` passes, so this is pre-existing and invisible rather than newly introduced. **Closed 2026-09-23:** `persist.rs`'s three test modules now carry the `app` gate — the four individual tests in `persist_tests` that call app-gated readers, and the two trail modules wholesale, because every test in them does — and `gateway_tests.rs`'s one helper that went dead once they were gated carries it too. Both mirrors gained a `Headless targets check` step (`cargo check --no-default-features --all-targets`), which is the flag whose absence this entry is about. Measured after: that command compiles with **0 errors and 0 warnings**, and `cargo test` is still **541 / 0**, so gating lost no test — the ten tests in `persist_tests` that never needed the feature still compile without it, which is the proof the step exists to make. The flag is shown to be the whole of the difference: a `cfg(test)` probe naming `tauri::AppHandle` fails the check with an `E0433` (cannot find module or crate) **with** `--all-targets` and passes **without** it | **Half** | **Fixed** |

| **D18** | "release is idempotent — a double release cannot leak capacity" — the test's own name, offered as the guard on `ProviderLimiter.acquire`'s `released` flag | `packages/router-core/test/concurrency.test.ts:134-142`; the flag at `concurrency.ts:77-80` | The test does not test idempotence. Measured 2026-09-23: deleting the `released` flag leaves the test **passing** — `vitest run -t "release is idempotent"` reports 1 passed, 272 skipped. With `maxPerProvider = 1` the count is 0 and the entry already deleted after the first release, so the second and third calls compute `0 - 1 = -1`, take the `next <= 0` branch and delete again: a no-op either way, flag or no flag. The property only bites with **two** permits held, where releasing one twice drops the count from 2 to 0 while the other is still in flight, so the limiter then admits two more and three attempts run concurrently against a cap of two. The code is correct — only the test's claim is broader than its check. The Rust port (increment 5) keeps the test for fidelity, marks it as weak in place, and carries the property in `an_explicit_release_followed_by_drop_counts_once` (cap 2), whose falsification fires | **False** | **Open** |

| **D19** | The classification of a caught attempt error — spelled twice in `executeText` as though it were one rule | `execution-engine.ts:113` (already-emitted path) and `:118` (not-yet-emitted path) | The two spellings are **not equivalent**, and they agree on every input reachable today only because of a constant at the throw site. `:113` tests only `classify(status) === "OK"`; `:118` additionally forces `PARSE_ERROR` whenever the failure kind is `mid-stream`. Measured 2026-09-23 by executing the real `classify` against both expressions: a mid-stream `429` is `RATE_LIMITED` under `:113` and `PARSE_ERROR` under `:118`, and a mid-stream `503` is `SERVER_ERROR` under `:113` and `PARSE_ERROR` under `:118` — two divergences — while the input a producer actually emits (mid-stream, status `200`) agrees. That agreement is not the two rules meeting; it is one constant at the throw site. `manifest-interpreter.ts:360` is `new ManifestHttpError(200, JSON.stringify(err), "mid-stream")`, and it is the only one of the three `ManifestHttpError` construction sites that is not `kind: "response"` (`:246` and `:304` both pass a real status). So the divergence is **latent rather than live** — no reachable input separates the branches. It is not cosmetic either: `:113` is the branch that skips `recordResult`, so under that spelling a mid-stream `429` would classify as `RATE_LIMITED`, the one class that cools a key, and then never cool it. The Rust port (increment 6 of Phase 2) states the rule once, takes the `:118` spelling because it does not depend on a constant chosen at a throw site, and pins the choice with `the_two_spellings_agree_only_because_the_midstream_producer_reports_two_hundred` | **False (unreachable today)** | **Recorded** — the TypeScript is left exactly as written, so the reference the port is measured against does not move under it |

| **D20** | The Phase 4 note on recursive compression — "The `skipCompression` flag (`gateway-bridge.ts:102`) prevents infinite recursion — the same flag exists in the Rust port" | `docs/dev-book/10-headless-service.md:866-867` | Both halves are false, measured 2026-09-23. **The citation names the wrong file:** `gateway-bridge.ts` contains no `skipCompression` at all — a Grep for `skipCompression`, `compress` and `summar` over that file matches nothing, and the line the citation points at is inside a doc comment about `GATEWAY_WINDOW`. The flag's real homes are `model-router.ts:108` (the option on the request), `:134` (the branch that skips the compressor) and `Assistant.tsx:100` (the caller that sets it). **And the flag does not exist in the Rust port:** `src-tauri` has no path that compresses the *client's* `messages` — the gateway forwards them verbatim. **The evidence here was too strong, corrected 2026-09-23:** the tree is not without a compression path, it is without *this* one. `context_scope.rs:884-1020` estimates tokens (`estimate_tokens`, `estimate_prompt_tokens`), sizes a budget (`plan_budget_for`, against `DEFAULT_WINDOW_TOKENS` and `MEMORY_CHARS_PER_TOKEN`) and drops what will not fit (`rank`, `trim`, `compose_block`), and `inject_context` runs it on the gateway's read path. That path compresses *recalled memory* into a system message; it never touches the conversation, and `skipCompression`'s recursion guard has no counterpart at all. The distinction is load-bearing for Phase 4: a porter who read the original sentence would look for a missing module, when what is actually missing is a second input to a path that already exists. Phase 4 had not started when this was measured, so the sentence stated as present fact something that could not yet be true; Phase 4 has since begun (increment 14a, 2026-09-24), and the sentence has been rewritten to describe the port rather than the absence. The second half is the more dangerous of the two: a reader planning Phase 4 would conclude the recursion guard is already in place and omit it, and the omission is invisible until the first summary recurses. Fixed by correcting the citation and marking the flag as a Phase 4 deliverable rather than an existing one | **False** | **Fixed** 2026-09-23; re-read 2026-09-24 as Phase 4 opened |

| **D21** | Three names the pending Phase 3 ports must take from the TypeScript unchanged | `context_scope.rs:929` (`Candidate`), `:871` (`CHARS_PER_TOKEN`), `:878` (`RESERVE_FRACTION`) against `route-planner.ts:13-17`, `context-compress.ts:42`, `:45` | Measured 2026-09-23 while landing increment 7. Each name already means something else in this crate. `context_scope::Candidate` was `{id, layer, text, pinned}` — *a recalled memory headed for the prompt* — while `route-planner.ts`'s `Candidate` is `{provider, key, model}`, a planned attempt. `context_scope::CHARS_PER_TOKEN` is **3.5**; `context-compress.ts:42` is **4**. `context_scope::RESERVE_FRACTION` is **0.20**; `context-compress.ts:45` is **0.25**. The shared window *was* considered and does agree (`DEFAULT_WINDOW_TOKENS` is 8192 on both sides, and `context-compress.ts:32-34` says so deliberately — "Matches the host's `DEFAULT_WINDOW_TOKENS` so both sides of the bridge plan against the same conservative number") — so one of the three was checked and the other two were not. None of it fails today, because the two sides are in different languages. All of it fails the moment the ports land in the same crate, and `Candidate` failed *immediately*: increment 7's loop needs the routing meaning. The rename has to happen on the Rust side, because the TypeScript is this port's reference and cannot move | **False** (a name that will mean two things) | **Fixed** 2026-09-23 — `Candidate` → `MemoryItem`, `CHARS_PER_TOKEN` → `MEMORY_CHARS_PER_TOKEN`, `RESERVE_FRACTION` → `MEMORY_RESERVE_FRACTION`, freeing all three of the TypeScript's names. `SkipReason::NoCandidates` was **left alone on purpose**: `as_str()` renders `"no_candidates"` into the `aip-memory` response header (`apply_memory_headers:447`), so the variant's string is on the wire and renaming the variant would have meant either a wire change or a name contradicting its own value |

| **D22** | The image path treats a provider failure the way the text path does | `execution-engine.ts:183-188` against `:113-130`; `manifest-interpreter.ts:461` against `:246`/`:304`; the type at `:57-60` | Measured 2026-09-23. **Two differences, one of them live.** *(1) Reachable.* `generateImage` returns `{ok: false, status, errorBody}` for `>= 400` (`manifest-interpreter.ts:461`) and never calls `retryAfterFrom`, although `res.headers` is in scope on that very line — while `listModels` (`:246`) and `generateText` (`:304`) both pass it. `ImageAttemptResult` (`:57-60`) has **no field** for it, so the wait cannot travel even in principle. `executeImage` therefore records `{cls, status}` with no `retryAfterMs` (`:184`) and calls `recordResult(c.key, cls)` with none (`:185`), so `health-tracker.ts:64`'s `Math.max(retryAfterMs ?? 0, COOLDOWN_FLOOR_MS)` lands on the **1000 ms floor**. A `429 Retry-After: 30` on the image path retries after one second. The text path fixed exactly this and says so at `:126-128` — "a key that asked for a minute is retried a second later — straight back into the window it was told to wait out" — one path away. It reaches the client too: no image attempt can name a wait, so `AllAttemptsFailedError.minRetryAfterMs()` is **0** for an image-only chain and the client is told nothing. *(2) Latent.* `catch {}` (`:186`) names `NETWORK`/`0` and keeps nothing the error carried, where `:117-121` classifies a thrown `ManifestHttpError` by its status. The two agree only because a status-bearing refusal is **returned** rather than thrown, so that arm is never reached with a status — the same "agrees only because of a producer's contract" shape as D19 | **False** | **Recorded** — the port keeps the image path's behaviour, so Rust and TypeScript stay comparable. `a_status_bearing_adapter_error_still_records_network_on_the_image_path` pins the latent half, `an_image_refusal_cools_its_key_by_the_floor_not_the_named_wait` pins the live one, and `a_whole_chain_of_failures_reports_every_attempt_in_order` pins the reporting half. The fix belongs in `manifest-interpreter.ts:461` plus the `ImageAttemptResult` shape, which would correct both implementations at once; fixing it in Rust alone would create a silent behavioural difference between the two, which is the defect class this register exists to catch |

| **D23** | `ports.ts` shapes — "already realised: `UsageTokens.cached_tokens` is `LedgerRow.cached_tokens` plus `BridgeMsg::Usage`" | `docs/dev-book/10-headless-service.md:784` against `ports.ts:106-117`, `persist.rs:491`, `gateway.rs:365-368` | **Half, and the half that is missing is the third field.** The sentence groups two types as though they jointly realise the shape; only one of them can carry `cached_tokens`. `UsageTokens` has **three** fields; `LedgerRow.cached_tokens` is one of them (`persist.rs:491`, `Option<i64>`, nullable with no default — `store.rs:1083-1102`); `BridgeMsg::Usage` (`gateway.rs:365-368`) is `{prompt_tokens: u64, completion_tokens: u64}` and carries the other two, not all three — as do the four dialects that destructure it (`gateway_handlers.rs:184`,`:221`; `gateway_responses.rs:341`,`:429`; `gateway_anthropic.rs:479`,`:564`; `gateway_gemini.rs:295`,`:351`) and the client-facing bodies they build (`gateway_handlers.rs:260`,`:267`). A Grep for `UsageTokens`, `struct Usage` and `TokenUsage` over `src-tauri/src` matches **no file**: the bridge variant is the crate's only usage type. **This is not a second finding of the client-facing gap** — `09-status.md:179` already states that in full, with the same citations and with §8.2 as the reason its fix is deferred. What was unrecorded is the port-planning consequence, and the two sides cost different things: a client loses a field it cannot derive, while a **porter** loses the measurement. Today's routing is TypeScript, so the ledger row is built where the full three-field shape is in scope (`model-router.ts:435`, `:519`, in process, never through the bridge); route in Rust and no webview holds the third value, making "reuse the crate's only usage type" the obvious move — the exact silent drop `ports.ts:101-104` describes that field suffering the first time. Closed for the port by `core::usage::UsageTokens` (increment 8), which is the shape `on_usage` now hands over; `BridgeMsg::Usage` is deliberately left as written, because widening it changes a response body §8.2 protects | **Half** | **Fixed** (the plan's sentence and the port's shape; the client-facing half stays deferred under §8.2) |

| **D24** | The prescription for Tier 2's recursion guard — "Phase 4 must introduce the compression and the guard together, and the guard is the part that is easy to leave out because its absence is invisible until the first summary recurses", and §12's open question "whether the summarization call … works correctly when the engine calls itself recursively. The `skipCompression` flag is designed for this" | `docs/dev-book/10-headless-service.md` §7 (Phase 4) and §12, both as written 2026-09-23 | **The guard is not needed, because the recursion it guards against is not expressible in Rust.** The TypeScript's summarizer is `createSummarizer` (`Assistant.tsx:55-106`), which closes over the `router` singleton and calls `router.generateText` from inside `router.generateText`; the flag is what stops that becoming unbounded. Measured 2026-09-24 rather than reasoned about: a minimal reproduction — an inherent method `async fn generate_text(&mut self, …)` taking a callback that calls the same method on the same value — is rejected with **`E0501`**, "cannot borrow `*self` as mutable more than once at a time". The first guess was `E0499` and the compiler disagreed, which is the reason the measurement exists. The sequenced counterpart (summarize, *then* route) compiles and runs, so the constraint is the re-entrancy and nothing else. **What the wiring actually needs is a seam, not a guard**: the summarizer handed to the router as a `&dyn Fn`-style boundary the router calls and does not own, which is this crate's existing shape for `AdapterFactory` and the usage callbacks. The claim was not merely unnecessary — it was **unfalsifiable as written**. Nothing in the Rust tree could have contradicted it, because the code it warns about cannot be written; a reader following it would have gone looking for a guard to add, and the honest answer is that the design removes the need for one. Same shape as D10's "cannot be tested": a *prescription* is a claim too, and this one had no evidence behind it until increment 14a tried to write the code | **False** (a prescription with no referent) | **Fixed** 2026-09-24 — increment 14a's section records the measurement, §7 and §12 were rewritten, and the wiring increment is scoped as "add a seam" rather than "add a guard" |

| **D25** | The "what must move" table's third column, reading "Must be ported to Rust" — for the execution engine, the route planner, the model router, the health tracker, the concurrency limiter and the usage ledger | `docs/dev-book/10-headless-service.md` §2.1, the six rows between "Model adapters" and "Gateway bridge" | **Six of the eight rows were false, measured 2026-09-24.** Every one of those modules has had a Rust counterpart for several increments: `core/engine.rs` (increments 1–10, and `HealthTracker` lives there too), `core/planner.rs` (11b), `core/router.rs` (13), `core/limiter.rs` (5), `core/ledger.rs` (12). The table was accurate when written — it was a *plan* — and it is the one place in the chapter that lists every module at once, so it was the one place no increment had a reason to revisit. Each increment updated the prose section it added and the parked row in [09](09-status.md); this table stayed at its pre-port state for the whole of Phase 2 and Phase 3. **Nothing could have caught it mechanically:** `build-dev-book` validates structure and links, and no test asserts that a doc's prose matches the tree, so a claim can be arbitrarily stale and every gate stays green. **What it cost is misdirection of the worst kind** — a reader planning the remaining work would have budgeted six modules that are already done, and would have had no reason to doubt it. **And the staleness concealed a real gap:** the adapter runtime is the only module genuinely unported, and it is also the only one with no phase assigned to it. Phases 1–6 are numbered and none of them covers the manifest interpreter or its sandbox; the table was the sole record that the module existed, and it was listed as "must be ported" rather than as "has no owner". Corrected rows carry the file and the increment; the missing phase is now the open decision, and §12's `rquickjs`/`boa` question is what decides it | **Stale** | **Fixed** 2026-09-24 |

### Notes on the entries

**D5 — closed.** The claim was corrected first, deliberately, and the script was aligned in a later pass once
the doc-link step was being added to both mirrors anyway. The audit now runs second in both, so a bad advisory
fails the local gate in seconds rather than after the whole suite has run.

That two-step sequence is the point worth keeping: a false *claim* and a divergent *script* were two separate
defects. Correcting the claim did not fix the script, and recording the residual in the register is what kept
the second one from being forgotten.

**D6 — the module map, closed as an addition.** `ARCHITECTURE.md` is a spec document with a dated provenance,
and §1.2 is a spec-era module map. Rewriting it to match the shipped app would erase the record of what was
planned, so a **shipped-screens table was appended below the map instead** — six new screens plus the one
rename, each with its relation to the original row stated explicitly.

Checking the map against `ScreenId` *before* writing that table corrected this entry's own wording. It had said
Activity was "absent from the map"; Activity in fact **replaced** `screen-usage`, which no longer has a file.
An absence and a rename are different facts, and a register is the wrong place to be approximately right.

**D8 — closed, and the closing taught something.** The prompt-cache measurement exists to accumulate
`cached_tokens` across real traffic. Migration 0015 had added the column; the installed bundle simply had not
been rebuilt since it landed, so the column was absent and the measurement could not record a single row.

Rebuilding was necessary but, on its own, **not sufficient** — which is the part worth keeping. A migration that
adds a column proves nothing about whether anything writes to it. So before calling D8 fixed, the whole producer
chain was traced, not just the schema:

```
manifest-interpreter.ts   reads prompt_tokens_details.cached_tokens (OpenAI) and Anthropic's cache blocks
  → model-router.ts:353   carries the value through as-is, `undefined` included
  → usage-ledger.ts:38    `cachedTokens?: number` — optional, never defaulted
  → store.ts:118          `e.cachedTokens ?? null` — `undefined` becomes SQL NULL, `0` stays `0`
  → persist.rs:440        INSERT … cached_tokens …
  → store.rs:830          ALTER TABLE ledger ADD COLUMN cached_tokens INTEGER (no default)
```

That chain was already complete. The gap was purely that the schema on disk sat one version behind the schema
in the source.

The measured state after the relaunch is exactly what the column was designed to produce: `schema_version = 15`,
`ledger` at 17 columns, **1530 rows preserved and every one of them `NULL`**. All 1530 predate the column, so
`NULL` is the correct value for them — and it is a different statement from "the providers reported zero cached
tokens". The open question is now empirical rather than structural: under real traffic, is `cached_tokens` mostly
`0` or mostly `NULL`? That needs traffic, not another rebuild.

**D10 — the docs understated the product.** This entry is unusual: the code is right, the UI is right, and
`DECISIONS.md` is right — only two prose claims lagged, and they lagged in the direction of making the app sound
*less* capable than it is. `ARCHITECTURE.md` told a reader the gateway dies when they close the window; in fact
background mode is on by default and the gateway keeps serving, which is the entire point of R1.

The failure mode is worth naming: **a doc describing a limitation you have already removed is as harmful as one
describing a feature you never built.** Both send the reader to the wrong conclusion, and this one would have
had a user keeping a window open for no reason.

**D14 and D15 — one class, twice.** Both are gates that could not fail on the thing they existed to catch, and
both were found by *running what the gate claims to run* rather than by reading the gate. D14 was a command that
never invoked the bundler; D15 was a command that invoked it with the wrong feature set. Neither was caught by
any other gate, and neither could have been caught by re-reading the workflow — D15 in particular could not
exist until the `app` feature did. The general form: **a gate is evidence only for the narrowest thing it
actually does**, and the way to establish what that is, is to change the thing it is meant to protect and watch
whether it goes red.

It surfaced while reading the lifecycle in `lib.rs` to assess the backlog — not by looking for drift. That is
the honest argument for keeping this register beside the code rather than trusting a periodic sweep.

It also settles two things:

- **The "main structural risk" framing survives, narrowed.** The gateway is still bound to the webview's
  *process*: a reloading or crashed renderer is `503`, and quitting the app takes it down. That is the real
  limitation, and it is now stated as such instead of being conflated with closing a window.
- **`hide_on_close` was untested — and my first reason for leaving it that way was wrong.** I wrote that
  pinning it "needs a window-lifecycle harness, not a unit assertion". That is half true, and the wrong half
  was the one I acted on. The end-to-end behaviour (close → hidden → still serving) does need a harness. The
  *default*, which is the part that decides whether the headline feature works, is a pure parse over one
  settings string — and this repository already had a house pattern for exactly that split.

  So the note recorded a limitation that did not exist. Fixed rather than re-recorded: the decision moved into
  `hide_on_close_from(raw: Option<&str>)` and a 12-input table test now pins it. Both arms were falsified
  before being trusted — flipping `None` fails the first case, flipping `unwrap_or` fails on `key absent`.
  Rust suite 472 → **473**, clippy clean.

  The lesson is the register's own: **a reason is a claim too.** "Cannot be tested" deserved the same evidence
  as "is not tested", and it did not get it.

**D24 — the same lesson one step further out, and it is the sharper form.** D10 corrected a claim about what the
code *does*. D24 corrects a claim about what the code *should be given* — and that claim turned out to describe
a construct the language rejects. Two things follow, and the second is the one worth carrying forward:

- **"Add a guard" is an answer to a question nobody asked.** The TypeScript needs `skipCompression` because its
  summarizer closes over the singleton it runs inside. Rust's borrow rules make that shape a compile error, so
  the correct work is a *seam* the router calls and does not own — which is already this crate's pattern for
  `AdapterFactory` and the usage callbacks. Reaching for the reference implementation's mechanism is the mistake;
  the reference's *problem* is what travels.
- **An unfalsifiable prescription survives every review.** No test, no compiler error and no Grep could have
  contradicted the sentence, because the code it warns about cannot exist. It read as careful — it named the
  failure mode and called the omission "invisible until the first summary recurses" — and that tone is exactly
  what kept it from being checked. The check was cheap: write the shape and see whether it compiles. It took one
  file and one `cargo build`.

  So the generalisation: **when a doc says "remember to add X", the first question is whether X's absence is
  even representable.** If it is not, the sentence is not a warning — it is a misdirection with a citation.

## The control that was added

D9 is the strongest argument in this file for a mechanical check. A claim about links was made, verified, and
still wrong — because the verification only looked at `.md` targets. The same is true of any property asserted
by hand.

**And it recurred the same day.** Adding [08 Flows](08-flows.md) introduced the identical bug — `../diagrams/`
written from a chapter two levels deep resolves to `docs/diagrams/`, which does not exist. Seven references,
caught only by re-running the scan. **Two instances in one day is the argument: a property you check by hand is
a property you will get wrong.**

**Partly built — 2026-09-22.** `scripts/build-dev-book.mjs` now enforces exactly this for the book itself:
it resolves every relative link *and image*, checks every in-page anchor against a real `id`, and fails on a
miss. Run it with `pnpm docs:book`. It is not a general `.md` linter — it validates the *rendered* book, so it
catches a broken reference inside `docs/dev-book/` and nowhere else.

Two further defects surfaced the moment it ran, both invisible to a by-eye check:

- **Colliding SVG ids.** Every diagram in `diagrams/` defines its own `<marker id="arrow">`. Inlining three of
  them into one page makes `marker-end="url(#arrow)"` resolve to whichever definition comes first, so the
  others render with the wrong arrowhead — silently. The generator now namespaces every id, and every
  `url(#…)` / `aria-labelledby` reference to it, per diagram.
- **A duplicate `id="next"`.** Seven chapters end with a `## Next` heading, and an unscoped slug gives all
  seven the same id. Heading ids are now scoped to their chapter, and disambiguated within it.

Neither is documentation drift. Both are the same lesson as D9 in a different medium: a property nobody checks
mechanically is a property that is already wrong.

**Now built — 2026-09-22.** `scripts/check-doc-links.mjs` resolves every relative link *and image* in every
markdown file in the repository, including non-`.md` targets and bare directories, and fails the gate on a
miss. It is wired into both mirrors, so this is the one entry in this file whose fix is mechanical rather than
editorial. Two details are worth keeping:

- **It strips fenced blocks and inline code spans before looking.** The memory logs and
  `PRODUCT_COMPLETION_PLAN.md` *quote* link syntax in order to discuss it, and those quotations are not
  references. A checker that reports them is a checker people learn to ignore.
- **It refuses to report success on an implausible scan** — fewer than 10 files or 20 links and it exits 1
  rather than print a confident zero. This repository has already produced wrong conclusions from searches
  that never reached the directory.

`scripts/build-dev-book.mjs` stays the stricter check for the book: it also validates in-page anchors against
generated ids and refuses duplicate ids, which the repo-wide check cannot see.

## Adding an entry

```
| **D<n>** | the claim, quoted | file:line | what you measured, and with what | False / Half / Stale / Correct | Open / Fixed |
```

Three rules for an entry:

1. **Quote the claim.** A paraphrase cannot be verified later.
2. **Carry the evidence, not the reasoning.** "`Cargo.toml:33` says `keyring = "2"`" is checkable. "The docs
   are out of date" is not.
3. **`Correct` is a valid verdict.** D7 is in the register precisely because it was *checked and found fine* —
   recording that stops the next person spending the same effort.
