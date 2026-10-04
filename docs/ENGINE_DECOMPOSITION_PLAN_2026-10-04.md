# Engine decomposition plan — D98 (audit A4), 2026-10-04

**Target:** `apps/desktop/src-tauri/src/core/engine.rs` (re-measured 2026-10-04: 4,076 lines).
**Status:** plan recorded; moves not started. Per D98's own rule — "decomposition plan wanted
before any move" — this document is the gate the moves need. Produced by a read-only planning
pass over the file at `9c9e97a..4a9ac2f`.

## 1. The map

One module, three `// ----------` separators, one flat `#[cfg(test)] mod tests` (line 1719 → EOF).

| Lines | Section | Key identifiers |
|---|---|---|
| 1–42 | Module doc | the port's contract notes (`errors.ts`, `health-tracker.ts`, `minRetryAfterMs`) |
| 43–56 | Imports | |
| 59–345 | **Error taxonomy** (pure, no deps) | `ErrorClass`, `BodyHint`, `ALL_CLASSES`, `classify`, `reason_from_body`, `is_retryable_with_next_key`, `COOLDOWN_FLOOR_MS` |
| 348–781 | **Attempt records + per-attempt policy** | `AttemptLabel`, `AttemptOutcome`, `min_retry_after_ms`, `MAX_ATTEMPTS_DEFAULT`, `PLAN_BUDGET`, `AttemptError`, `classify_attempt_error`, `AttemptDisposition`, `CandidateGate` |
| 783–936 | **Image loop** | `ExecuteImageArgs`, `ImageSuccess`, `execute_image` (the D22 asymmetry at :870–914), `now_ms` |
| 938–1004 | **Terminal aggregate** | `AllAttemptsFailed` |
| 1006–1430 | **Text loop** | `ExecuteTextArgs` (four callback seams), `TextSuccess`, `TextFailure`, `execute_text` — the `Ended` enum, the four local-closure forwards (`record_usage`, `forward_tool`, `forward_finish`, `forward_reasoning`), the load-bearing `let refusal` binding |
| 1432–1717 | **HealthTracker** | `HealthTracker`, `KeyHealth`, `KeyBlock`, breaker constants |
| 1719–4076 | **One flat test module** (55 tests) | classify / retry / health / budget / policy / image doubles / text doubles |

External consumers keep resolving through `crate::core::engine::…`: `router.rs`, `adapter.rs`,
`bridge_policy.rs`, `planner.rs`, `egress.rs` (`PLAN_BUDGET`), `router_bridge.rs`,
`manifest.rs` / `interpreter.rs` / `code_adapter.rs` / `sandbox.rs` (`AttemptError`, `FailureKind`).

## 2. Target shape — `core/engine/*.rs` submodules, `engine.rs` as the re-exporting root

`pub mod engine;` in `core/mod.rs` does not change; **no external `use` in the crate changes**;
test paths stay `core::engine::tests::…` until the optional final phase. This is the
lowest-merge-pain option versus sibling files, which would fragment the module's identity
without reducing the re-export work anyway.

```
core/engine.rs            ← root: module doc, now_ms, AllAttemptsFailed, pub use re-exports
core/engine/taxonomy.rs   ← :59–345
core/engine/attempt.rs    ← :348–781
core/engine/health.rs     ← :1432–1717
core/engine/image.rs      ← :783–936
core/engine/text.rs       ← :1006–1430
```

## 3. Phases — cold → warm → hot, each independently green and revertible

Every phase is a **verbatim contiguous block move** plus a `mod`/`pub use` pair in the root.
No function body is edited — the doc comments inside `execute_text` record measured
borrow-checker behavior (E0499/E057) that any "cleanup" would falsify. Verify per phase:
`cargo test` (same count), `cargo build --bin aiproviderd --no-default-features`,
`cargo clippy --all-targets -- -D warnings`.

0. **Baseline** — record the suite count, the 55 engine test paths, headless build, clippy, and
   the `wc -l` re-measurement (done: 4,076).
1. **taxonomy.rs** — the coldest code; pure functions, zero intra-file deps.
2. **attempt.rs** — still pure; unblocks the loops' vocabulary. `PLAN_BUDGET`'s consumers keep
   resolving through the root.
3. **health.rs** — self-contained; the D38 story moves with it.
4. **image.rs** — smaller and less contended than the text loop; D22 moves untouched.
5. **text.rs** — the hot one (usage forwarding, D86/D87 finish-reason, failover). Last, on a
   clean tree, as a pure cut-and-paste; `git diff --stat` should read as a rename, not a
   rewrite.
6. *(optional, separately mergeable)* distribute the flat test module per child, shared doubles
   into `engine/test_doubles.rs`. Trades file size for test-name churn — every engine test
   becomes `core::engine::<child>::tests::…`, which the exact-count tracking in 09-status
   records.

## 4. Explicit non-goals

1. No extraction *inside* `execute_text` — the seam comments are measurement records.
2. No dedup of the image/text loop prologues; the two paths deliberately differ (D22).
3. `AllAttemptsFailed` stays here, does not become `std::error::Error` — deliberate (:943–946).
4. The per-module `now_ms` copies stay — "no shared clock" is a stated convention (:929–930).
5. No `cfg(feature = "app")` in `engine/` (core/mod rule 2); no new dependencies.
6. No renames, no TS-wire spelling changes, no doc-comment trimming while moving.

## 5. Known doc coupling to close out with the moves

`DECISIONS.md:1246/:1252` cite `engine.rs:1013/:1158` by line; `egress.rs:528`, `manifest.rs:42`,
`adapter.rs:19/:515` cite `engine::` paths by name (those keep resolving). Line-cited docs are
updated in the phase's own commit, not preemptively.

**Risk:** low for phases 1–4, medium for 5 (hot, borrow-sensitive — mitigated by zero editing).
One commit per phase; `git revert` is the rollback.
