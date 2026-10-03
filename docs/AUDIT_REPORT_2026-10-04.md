# Full Audit — main branch

> **Audited:** `main` @ `b6f1473` on 2026-10-04 — the tree after the add-context merge (`7dd9dd9`),
> the test hardening (`714751b`), the doc correction (`d51b519`), the crash-resilience merge
> (`ebda122`) and the dev-up binary-swap merge (`b6f1473`). CI green on all four jobs at this HEAD.
> **Method:** four independent review passes dispatched in parallel — an architecture audit, a
> bug sweep of everything changed since the 2026-10-03 report, a persistence-layer audit (code +
> read-only inspection of the live database), and a three-way verification of both hand-resolved
> merge conflicts. Every finding cites `file:line`; what could not be verified is marked UNKNOWN.
> **Companion documents:** [`AUDIT_REPORT_2026-10-03.md`](AUDIT_REPORT_2026-10-03.md) (the
> reasoning/audit-fix pass this one follows up), the [drift register](dev-book/07-drift-register.md)
> (D1–D88), [`10-headless-service.md`](dev-book/10-headless-service.md).

---

## Executive summary

Main is in good shape structurally, and every fix the 2026-10-03 audit recorded was verified
present in the code and pinned by tests. The two merges resolved by hand this session were verified
clean three-way against both parents — nothing was silently lost. The persistence layer's
22-step migration chain is transactional, ordered, idempotent, and confirmed healthy against the
live database.

The audit's findings are concentrated in three places, none architectural:

1. **Three real bugs in the newly-merged composer code** (one P1, two P2) — race conditions
   inherent to async attachment handling with closure-captured state. All are small, well-understood
   fixes; none is pinned by a test yet.
2. **Retention and cleanup that exists but never runs** (P1s in effect, not in design): the
   documented 90-day ledger cap has no caller, and deleting a session leaves its agent runs,
   memories, and context rows behind.
3. **Doc decay**: the dev book's §10 status line has decayed into self-contradiction (D88's
   remaining half), now the only P1 outside the bug list.

Verified sound: the Tauri-free core boundary (CI-enforced, not prose-enforced), the egress
chokepoint with key-blind webview, the reasoning-knob plumbing end to end, the gateway
finish-reason mapping in all four dialect surfaces, the agent-loop retry counters, and both merge
resolutions.

---

## 1. Bugs found (bug sweep of post-audit changes)

### B1 — P1 · Stale-draft closure drops all but the last of multiple inlined text files

`apps/desktop/src/components/Composer.tsx:319-330` (`appendToDraft` reads `draft` from the render
closure) and `:404-409` (`addFiles` appends inside an async loop, one `await readAsText` between
appends). For N text files dropped or picked in one gesture (`multiple` input; drag-and-drop passes
the whole `FileList`), each append computes from the draft captured at last render, so file 1's
fenced block is overwritten by file 2's — the user's attached context is silently lost, with no
notice. Repro: drag two `.md` files onto the composer; only the second appears. Images are
unaffected (separate state path). "Previous results" and the project picker append exactly once per
open, so the window is exclusive to `addFiles`.
**Fix shape:** `setDraft(prev => …)` via a ref mirror of the draft (~6 lines).
**Test that would catch it:** a composer spec attaching two text files and asserting both fenced
bodies are in the composer input — current specs attach single files only.

### B2 — P2 · Send re-entry: duplicate turn on rapid/double Enter with an @-reference draft

`Composer.tsx:449-494` (`send`), `:469` (awaits `readFile(path)` per @mention **before** `onSend`
and before the parent can set `busy`), `:496-531` (`onKeyDown` → `void send()`). During that await
window a second Enter passes both the `busy` and `sendDisabled` guards — two identical chat
requests and two user turns. The parent's guard cannot help: it reads the same stale prop.
**Fix shape:** a `sendingRef` set synchronously on entry, cleared on failure (~4 lines).

### B3 — P2 · Paste-attachment vs send race: image silently missing from the turn

`Composer.tsx:688-698` (`onPaste` → `void addFiles`), `:364` (`await readAsBase64`), `:449-494`
(`send` reads `attachments` from the render closure). Enter pressed while a screenshot's base64
read is pending sends with the *old* empty attachments — the image never reaches the provider —
and when the read completes, the chip appends onto the cleared composer, claiming the *next* turn
carries an image the user believes was sent. Window is milliseconds for small images; realistic
for large screenshots on slow IO. Current specs always await the chip before sending, so the race
is unpinned.
**Fix shape:** share B2's `sendingRef` with `addFiles`, or disable Send while `addFiles` is in
flight (~5 lines).

### Notes (known or trivial)

- **N1 —** the TS reference still sends `thinkingBudget: 0` on Off (`packages/router-core/src/
  manifest-interpreter.ts:100`) — the exact request the Rust side calls a deterministic Gemini 2.5
  Pro 400. Known and recorded (D87); listed here because any TS-path consumer of a Pro endpoint
  inherits it.
- **N2 —** `scripts/dev-up.sh:180-184` leaves a hidden `.aiproviderd.new-$$` temp file if the
  install/rename fails mid-write. Harmless (hidden, PID-suffixed, never executed); a one-line
  `trap … EXIT` closes it. The rename-swap logic itself is correct (verified: same-directory
  `mv -f` is rename(2), running process keeps the old inode).

---

## 2. Persistence layer (SQLite: store.rs, persist.rs, live DB)

### Verified sound

- **Migration chain 0001–0022** (`store.rs:588-633`): single ordered sequence; every step runs in
  its own transaction with the version row committed in the same tx — a crash mid-step rolls back
  the whole step, a crash between steps resumes on next launch. Column-adding steps guard with
  `table_has_column`; 0019's table rebuild preserves the `generator_audit` FK; 0022 skips
  unparsable bodies rather than failing startup. A numbering guard test pins `22 ==
  MIGRATIONS.len() + DATA_MIGRATIONS.len()`.
- **Live DB (read-only inspection):** `integrity_check`/`quick_check` ok; all 22 versions applied
  in order; **zero manifests missing the 0022 thinking placeholder** (all 5 anthropic-dialect rows
  carry it; the 5 openai rows correctly untouched); **`failure_detail` provably populating since
  the 0021 fix** (0 rows before 2026-10-01, then 10/12/65 on Oct 1/2/3); 0 orphan agent_steps;
  ledger 3022 rows over 15 days.
- **Corrupt-manifest handling** is consistently skip-not-fatal (activation, migrations 0008/0022),
  and activation upserts are transactional deactivate+activate pairs — no window with zero active
  manifests.
- **App + daemon concurrency is safe in normal operation:** both processes join the same WAL;
  writes contend through a 5s `busy_timeout`; the daemon's error log shows zero busy/locked events.
  What would actually happen if both ran at once: reads/writes interleave fine; the two failure
  modes are the first-open migration race (below) and any write transaction longer than 5s.

### Findings

| ID | Sev | Finding | Where |
|---|---|---|---|
| **P1** | P1 | **The documented 90-day ledger cap never runs.** `ledger_rollup_run` (`persist.rs:744-769`) is app-gated, has no webview caller, no daemon route, no scheduler. Live DB: `ledger_rollups` = 0 rows after 15 days of traffic. Growth is modest today (~200 rows/day) — latent, not acute | `persist.rs:744-769` |
| **P1** | P1 | **`history_delete_session` is a partial, non-transactional cleanup** (`core/context.rs:578-585`): deletes `context_nodes` + `session_titles` only. A deleted session's `agent_runs`/`agent_steps` (session_id is TEXT, **no FK**), live-context rows, and memories all survive | `context.rs:578-585` |
| P2 | P2 | **agent_runs/agent_steps are unbounded** — no DELETE anywhere outside tests; 180 runs / 1041 steps in 15 days, with full prompt text per run. 5 runs stuck `status='running'` since Sep 20 by design, but nothing ever ages them out | `orchestrator.rs:257-268` |
| P2 | P2 | **Concurrent first-open migration race** (inferred, not observed): both processes read `MAX(version)` before the loop; a second process opening a pre-22 DB mid-migration hits the version PK and fails startup (self-heals next launch). Window is milliseconds | `store.rs:594-596` |
| P2 | P2 | **Pruning only runs while the webview is open** — the retention scheduler is a webview timer (`src/lib/memory/retention.ts:34,65-69`) driving admin prune routes the daemon serves but nothing schedules headless. If the memory master toggle is off, `session_turns` are not pruned either | `retention.ts:54-56` |
| P2 | P2 | Doc nit: `persist.rs:649` says `failure_detail` was written "before migration 0018" — it is 0021 | `persist.rs:649` |
| P3 | P3 | ~28 `*.pre-install-*.bak` DB snapshots (~80MB) accumulate in the data dir with no rotation | data dir |
| P3 | P3 | One stale 0-byte `router.db` and `state.db` in the data dir — harmless clutter | data dir |

### UNKNOWN

Contention under a genuine simultaneous app+daemon launch (would require running both); unbounded
reads beyond the clamped `ledger_recent_rows` (limit 1–1000) in the webview export path.

---

## 3. Architecture (module graph, boundaries, drift)

### Verified sound

- **The Tauri-free core boundary holds and is enforced by CI, not prose.** `core/` names `tauri`
  only inside `#[cfg(feature = "app")]` gates (47 in `core/persist.rs:8-112`); CI compiles
  `--no-default-features --all-targets` and otool-verifies the bundled daemon
  (`.github/workflows/ci.yml:61-70,191`). The webview cannot bypass key-blind egress: the TS router
  emits `{{secret}}` sentinels; Rust injects secrets.
- **Every R1–R6 fix from the 2026-10-03 audit is real and test-pinned** at HEAD: R1
  (`gateway_responses.rs:402,448`), R2 (`BridgeMsg::Liveness` replied when ProseGate holds,
  `router_bridge.rs:354`), R3/R4 (`interpreter.rs:1213-1236` + the two pinning tests at
  `:2158`/`:2227`), R5/R6 in `agentLoop.ts:60-63,127-207`.
- **The new UI additions follow the house patterns.** `AddContextMenu.tsx` is presentational with
  all decisions in the tested `lib/chat/context-blocks.ts` (23 tests) and no dialect knowledge;
  `ErrorBoundary.tsx` is mounted at the root with its logic in pure `lib/errors/crash.ts` (18
  tests) and honestly documents what it cannot cover.
- **The drift register remains an honest instrument** — four Open rows spot-checked against the
  code, all four accurate (D76/D77/D78/D87).
- **Both hand-resolved merge conflicts verified clean three-way** — no silently-lost hunks or
  assertions; the dropped branch test's assertions are subsumed by the kept main test; the branch's
  other files are byte-identical to the branch tip; `cargo test core::context` passes all three
  resolved tests by name (diff-review verdict: **approve** on both merges).

### Findings

| ID | Sev | Finding |
|---|---|---|
| **P1** | P1 | `docs/dev-book/10-headless-service.md:3-4` is now **internally contradictory**: "builds and serves" / "Phases 2–6 are still plan only" / "Phase 1 does not serve completions" — the middle and last are false at HEAD (the daemon serves completions, `bin/aiproviderd.rs:3-7` + e2e test; Phases 2–6 landed through 25f/26x). D88 owns this pass; it remains owed |
| P2 | P2 | The R6 "open half" — a run-config warning when the chosen model's manifest declares no thinking placeholder — is still unbuilt and is registered nowhere outside the 2026-10-03 report, so nothing pins it |
| P2 | P2 | S1 + S2 compound: the non-expiring full-admin webview bearer (`lib/gateway-client.ts:31`) plus localhost-wide CORS (`gateway.rs:2222-2226`) means any local page can authenticate and never lose access. Individually recorded; no drift-register row points at either |
| P3 | P3 | `tool_registry.rs.bak` sits in `core/` untracked (gitignored) — sweep it |
| P3 | P3 | Open audit items (M1/M2, S1/S2, A1–A4) live only in the audit reports, not in the drift register — adding rows would close the loop |

### Status of every open item from 2026-10-03 (re-verified at HEAD, all accurate)

**Still open:** M1 (`usage: null` on non-stream chat, `gateway_handlers.rs:311`), M2 (streaming
tool-call arm skips usage + capture, `gateway_handlers.rs:188-205`), S1 (CORS trusts all localhost
origins, `gateway.rs:2222-2226`), S2 (`ui_session_key` never expires — no TTL in
`core/ui_session.rs`), A1 (dual-language core: the webview still runs the TS `ModelRouter` at
runtime, `store.ts:192`), A2 (no provider-level circuit breaker; `engine.rs:1597-1599` is still
the static enabled-check), A3 (no idempotency on `/v1`), A4 (`engine.rs` still 4,076 lines).
**Closed as designed:** M3.

### UNKNOWN (architecture)

Rust suite not re-run end to end by the architecture pass (done separately: 1501 passed);
live daemon serving behavior (code + e2e test read only); QuickJS sandbox escape resistance;
tracing's secret-freedom end to end.

---

## 4. Recommended fix order

1. **B1** (multi-file attach drops context) — user data loss, ~6 lines + a spec.
2. **Ledger retention + complete session deletion** (the two P1s from §2) — both have small,
   well-scoped fixes: call `ledger_rollup_run` from the daemon or `retention.ts::pruneOnce`; wrap
   `history_delete_session` in one transaction and extend its DELETEs.
3. **B2 + B3** (send re-entry, paste race) — one shared `sendingRef` fixes both, ~9 lines total.
4. **The §10 status-line rewrite** (D88's owed half) — one editorial pass, then mark D88 Fixed.
5. **B2-adjacent hardening:** age out stuck `running` agent runs in the prune step; rotate the
   `.pre-install` snapshots.
6. **D87 reconciliation** (one coordinated change, both engines, one commit) — the register's own
   plan; closes N1.
