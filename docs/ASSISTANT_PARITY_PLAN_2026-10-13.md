# Assistant parity plan — six fixes, phased

Date: 2026-10-13
Status: **all six phases landed** — 0–6 done. One step was never verified in this environment (Phase 1's browser
spec; see its section) and one item is registered rather than implemented (`ignoreWhen`, drift **D103**). Phase 5
and Phase 6 are otherwise complete with tests; nothing is committed.
Scope: the Assistant's end-to-end capability against a general agent harness: what it can execute, what it can
delegate, what survives a resume, and whether the serving path stays up.
Owner note: this file is a **plan**. Each fact it establishes moves to its owner when the phase lands — the
behaviour to `CHANGELOG.md`, the rules to the [developer book](dev-book/README.md), any disagreement to
[07 Drift register](dev-book/07-drift-register.md). It must not become a second copy of them.

## Why this exists

A capability review of the Assistant (2026-10-13) found it at parity with a general agent harness for
single-workspace coding and research, and short of it in six specific, fixable places:

1. `run_command` starts only from a hardcoded 38-program list, so whole task classes (`cargo`, `curl`,
   `sqlite3`, `docker`, `rm`/`mv`) are unreachable by design — `core/tools.rs:46`.
2. Subagents are read-only by construction (`SUBAGENT_TOOLS` filters `effect === "read"`), so delegation buys
   parallel *research* and never parallel *implementation* — `apps/desktop/src/lib/tools/registry.ts:537`.
3. The transcript is React state; the durable copy is the context graph, so a long session resumed later is
   reconstructed rather than restored — `apps/desktop/src/screens/Assistant.tsx`, `lib/context/recorder.ts`.
4. The Assistant generates only while the gateway is listening, and release builds are `panic = "abort"`, so one
   stray non-lock panic on the request path ends the process and every in-flight client.
5. The Rust serving path implements none of the dialect-shaping fields, and a generated gemini-compat manifest
   cannot pass `lintManifest` — the "worked in the wizard, broke in the Assistant" class.
6. There is no phased fan-out with structured per-item results; the only primitive is one `dispatch_agent` per
   round.

Ordering is by leverage over risk: each phase must stand alone, land green, and be revertible without the next.

## Phase 0 — Baseline and guardrails (done)

Established before any edit, so a later failure can be attributed:

| Check | Baseline 2026-10-13 |
|---|---|
| `pnpm -r typecheck` | green (3 packages) |
| `pnpm -r test` | **1183 passed** — adapter-spec 23, router-core 474, desktop 686 |
| `cargo test --lib` | **1596 passed, 2 failed** |
| The 2 failures | `core::browser::tests::*` — live-Chrome CDP, `Page.navigate timed out after 15s` |

**The two Rust failures are environmental, not a regression.** Chrome is present at
`/Applications/Google Chrome.app`, the test navigates to a `data:` URL (so no network is needed), the harness
launches headless Chrome successfully and reads its debugger port — and then `Page.navigate` never completes.
Chrome's DevTools traffic is blocked in this sandbox. They are therefore excluded from per-phase regression
runs with `--skip browser::tests` and re-checked by the full gate at the end.

**One environment fact worth knowing, and it is not a repository defect.** The managed Node in this harness is
signed with a Team ID that macOS library validation rejects against the signed `rolldown` native binding, so
`vitest` cannot start under it at all (`Cannot find native binding`). Node **22.23.2** (nvm) loads the same
binding and is the version CI uses, so every JS loop below runs under it. Nothing in the repository changes for
this.

## Phase 1 — A user-extensible `run_command` allowlist

**Design.** The static list becomes the *baseline*; a persisted setting may add programs; a small hardcoded
denylist wins over both.

- `core/tools.rs`: `BUILTIN_PROGRAMS` (today's 35, unchanged behaviour), `NEVER_ALLOWED` (privilege escalation
  and machine-level destruction outside any workspace: `sudo`, `su`, `dd`, `shutdown`, `reboot`, `diskutil`,
  `launchctl`, `csrutil`, `kextload`), and a process-wide extension set with `set_extra_programs`.
- A user-supplied name is a **bare executable name** — `[A-Za-z0-9._+-]{1,64}`, no slash, no `..`, at most 32
  entries. Anything else is refused at the setter, so an unusable list cannot be persisted.
- `tools_policy()` reports `programs` (baseline, unchanged shape), plus `extra_programs` and
  `never_allowed`, so the UI shows provenance rather than one merged list. The existing comment on
  `ToolAllowlist` — *"so the UI can show the user what is actually permitted, rather than making them trust a
  checkbox"* — is the reason the denylist is published too.
- Persistence under the settings row, read at boot and written by the command; the mutation site calls the
  setter, so the in-process set cannot go stale (the rule in [06](dev-book/06-conventions.md): *a cache needs an
  authority, not just a TTL*).
- **Unchanged:** the child still gets a scrubbed `PATH`, relative paths still resolve against the workspace
  root, absolute paths and `..` in arguments are still refused, and `python3 -c` remains arbitrary execution by
  design — the boundary there is confirmation, and this phase does not pretend otherwise.

**Surface.** `#[tauri::command] tools_set_extra_programs` (+ its mandatory `web-test/shim.ts` case), a Settings →
Tools section that lists effective programs and edits the extension, and a `store.ts` wrapper.

**Tests.** Rust: baseline still allowed; an added program allowed; a configured program on the denylist still
refused; malformed names refused; the policy payload reports all three sets; **default-deny preserved when the
setting is empty** (the existing refusal test must still pass untouched). TS: store wrapper + shim case. UI: one
browser spec — add a program, see it in the effective list.

**Falsification probe.** Revert the setter to a no-op; the "added program is allowed" test must fail and the
"denylist still refused" test must still pass.

### Phase 1 — landed, and what verified it

| Step | Result |
|---|---|
| `cargo test --lib -- --skip browser::tests` | **1601 passed, 0 failed** (baseline 1596; 7 new) |
| The pre-existing golden test | `destructive_and_network_programs_are_absent` failed on first run and was **sharpened, not relaxed** — `sudo` is now refused as `never allowed` rather than as merely unlisted |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `cargo fmt --check` | clean (rustfmt touched only the seven edited files) |
| `cargo check --no-default-features --all-targets` | clean — the D17 step, which is what catches a headless break |
| `pnpm -r typecheck` | clean |
| `pnpm web-test:types` | clean |

**Two probes, each isolating its own mechanism** (one at a time, as [05](dev-book/05-workflow.md) requires):

1. `program_allowed` reverted to ignore the configured set → **exactly one** failure,
   `a_configured_program_passes_the_gate`; the default-deny, denylist and policy assertions all still passed.
2. The denylist check moved *after* the allow check → **exactly one** failure,
   `a_never_allowed_program_is_refused_even_when_configured`; the setter-level test still passed, which is
   what isolates the gate from the setter.

**The one step this environment could not verify: the browser spec.** `tool-sandbox.spec.ts` is written and
typechecks, but it has **not been executed**, and it must not be reported as passing until it is. The reason is
environmental and was isolated rather than assumed: a plain `node` HTTP server on `127.0.0.1` binds and serves
(curl 200), while `vite` — with this project's config or with an empty one — accepts the TCP connection and then
never answers a file request, so Playwright's `webServer` health check on `http://127.0.0.1:1430/web-test/` times
out at 60 s. `@vitejs/plugin-react` is implicated in the startup variant (a config with `tailwindcss()` alone
starts and listens; the real config prints nothing), but even the plugin-free config hangs on the first
transform. Nothing here is a repository defect and nothing in the repository was changed for it; it is the same
class as the sandbox/vite interaction [05](dev-book/05-workflow.md) already documents. Run it in a normal shell
before trusting the UI half.

## Phase 2 — Opt-in write-capable subagents

**Design.** Capability is the *user's* decision, never a definition file's, which preserves the existing
invariant that a definition is never a permission upgrade.

- `registry.ts`: `SUBAGENT_TOOLS` (read-only const) stays as the default and gains a sibling
  `subagentTools({ canWrite })`. With `canWrite`, the child also gets the mutating and executing tools but
  **never** `dispatch_agent` (no unbounded recursion), `todo_write`, or the plan pair.
- A `SubagentDef.tools` allowlist still only ever **filters** from the granted set — narrowing is unchanged.
- `AssistantSettings.subagentsCanWrite`, default **false**: the shipped posture does not change.
- Summary cap becomes `subagentsSummaryCap` (default 4000, clamped ≤ 16000) rather than a constant, so the
  larger-context case is opt-in and the token cost is visible.
- The parent's confirm gate already rides along into children, so a write from a child prompts exactly as the
  parent's would. **Unchanged, and asserted:** in `ask` mode a child write raises the modal; denying it does not
  fail the delegating run.

**Tests.** Default is read-only (regression guard on the shipped posture); opt-in includes write tools; both
modes exclude `dispatch_agent`; a definition narrows; the cap truncates. UI: the Subagents screen copy names the
security change.

### Phase 2 — landed, and what verified it

Everything this phase needed is TypeScript, so unlike Phase 1 it is verified end to end here.

| Step | Result |
|---|---|
| `vitest run src/lib/tools/agentLoop.test.ts` | **71 passed** — 7 new, and the desktop suite moved 686 → 693 in step with it, so nothing else shifted |
| `pnpm -r typecheck` | clean — and it earned its place: it caught a real type error in a new test (`content` is `string \| ContentPart[]`) that **vitest had passed** |
| `pnpm -r test` | **1190 passed** — adapter-spec 23, router-core 474, desktop **693** (baseline 686) |
| `web-test:types` | clean |

**Two probes, one at a time:**

1. `subagentTools()` made to ignore its argument → exactly **two** failures, both naming the enabled path
   (`…writes, once enabled…`, `…can never widen it`); the default-posture, never-list and empty-allowlist
   assertions all still passed.
2. The definition filter reverted to `def?.tools?.length` → exactly **one** failure, `an empty specialist
   allowlist narrows to no tools instead of granting everything`.

**Two deliberate deviations from the sketch above, both to keep a claim true rather than convenient:**

- The security copy lives in the **Assistant's run panel**, beside the switch that grants the capability,
  rather than on the Subagents screen — a grant and its explanation belong on the same surface. The Subagents
  screen's own copy ("can narrow the read-only toolset") stays true and was left alone.
- Definitions remain **read-effect scoped** at parse time. Extending them to name write tools would have made
  the tool picker offer tools that the current grant silently drops — a screen promising what the gate refuses.
  So a specialist that lists tools is scoped to read tools, and a specialist that lists none inherits the full
  grant, writes included. The `SubagentDef.tools` doc now says exactly that, including that `[]` means none.

## Phase 3 — Lossless resume (persist the transcript)

**Design.** A forward-only migration appended as `0027` — never inserted, which would shift every data migration
(the rule in [04](dev-book/04-data-model.md)). A `session_messages` table keyed `(session_id, seq)` carries role,
content, `tool_calls`, `tool_call_id`, reasoning, attachment references and `ts`; the Assistant writes it in the
same paths that already record the graph, and History/resume prefers rows, falling back to today's graph
reconstruction for sessions recorded before the migration. **The graph stays append-only and becomes the
derived view**; rows become the record.

**Tests.** Rust: migration applies once and is idempotent, round-trip CRUD, ordering by `seq`, and a pre-migration
database upgrading cleanly. TS: write path, read path, and the fallback for a row-less session. Browser: a
session resumed from History shows its tool calls and its plan card.

### Phase 3 — landed, and what verified it

Split so that each half was verifiable where it was written: slice 1 the durable layer (Rust), slice 2 the
wiring (TypeScript). Both are in, and the CHANGELOG entry landed with slice 2 — the point at which resume
became user-visibly lossless.

| Step | Result |
|---|---|
| `cargo test --lib context_graph_tests` | **25 passed** (18 before; 7 new) |
| `cargo test --lib -- --skip browser::tests` | **1608 passed, 0 failed** |
| `cargo clippy --all-targets -- -D warnings` · `cargo fmt --check` | clean |
| `cargo check --no-default-features --all-targets` | clean |
| `pnpm -r typecheck` · `web-test:types` | clean |
| `pnpm -r test` | **1197 passed** — desktop **700** (693 after Phase 2; 7 new) |

What landed: migration `0027_session_messages`; the transcript API in
[`context.rs`](../apps/desktop/src-tauri/src/core/context.rs) (`SessionMessageRow`,
`append_session_messages`, `session_messages`, `max_message_seq`); the `transcript_append` /
`transcript_list` / `transcript_max_seq` commands; the `store.ts` wrappers; stateful shim cases; a
`TranscriptPorts` seam on the turn engine with **both** branches appending; and `resumeSession` preferring
rows with the timeline as the pre-0027 fallback. `delete_session` takes the transcript with it.

**Four probes, one at a time — three falsified, one did not:**

1. `resumeSession` made to ignore rows → exactly **2** failures, both rows-dependent; the pre-0027 fallback
   test still passed.
2. The plain path recording `streamed` instead of `recordedText` → exactly **1** failure — the "a failed turn
   is recorded as what the bubble shows" assertion.
3. Dropping `ON CONFLICT … DO UPDATE` → exactly **1** failure — re-appending a turn duplicating the
   conversation.
4. **Did not falsify:** removing `ORDER BY seq ASC` left the ordering test passing, because the
   `(session_id, seq)` primary key makes SQLite return that order anyway. The clause is kept as the
   *guarantee* and is explicitly **not** claimed as a verified mechanism.

**A bug the tests found, rather than a test written around a bug.** The first version of the agent path
recorded `fullMessages.slice(history.length)`, and `history` *already contains the user's turn* (it is built
that way so the loop can send it) — so the transcript was missing every question. The graph gets away with the
same slice because it records the user node separately. The fix prepends the user entry explicitly, and the
assertion that caught it stays as the regression guard.

**Two things worth carrying forward.** The repository's own coherence guard caught the migration count
(`assert_eq!(27, MIGRATIONS.len() + DATA_MIGRATIONS.len())`) on the first full-suite run — the guard working,
not an obstacle. And **one deviation from the sketch above:** the History screen's timeline *view* still
renders from the graph, because that is a graph view rather than a transcript read; the phase's promise was
that a *resume* is lossless, and `resumeSession` is where that is delivered.

## Phase 4 — Gateway liveness and panic hardening

**Design.** Deliberately **not** flipping `panic = "abort"` — that is a recorded decision, and the blast radius
is a symptom. Instead: re-derive the non-lock `expect`/`unwrap` census with the instrument
[06](dev-book/06-conventions.md) names (the 2026-09-27 figure of eleven is stale by its own warning), classify
each as construction-time or request-reachable, and convert the request-reachable ones to `Result`. Add a test
that the gateway survives the specific malformed inputs the census names. If that leaves a request path that can
still abort, the process split is the next lever — and that is a decision entry, not a patch.

### Phase 4 — landed, and what verified it

The plan said "re-derive the census with the instrument 06-conventions names". **There was no script** — the
figure lived in prose and had drifted. So the first deliverable is the instrument; the second is the fixes it
named.

**`scripts/panic-census.py`** — production code only, `#[cfg(test)]` items blanked, line numbers preserved,
lock unwraps separated from the ones that can end the process. It exists because writing it the naive way
produced a *wrong* answer twice, and both mistakes are recorded in its header:

- Brace-counting raw text let a test fixture containing `"{"` unbalance the skip, so the scan ended *inside*
  the test module and reported four test-only `.unwrap()`s as production.
- Deleting stripped lines renumbered the file, so every reported line number pointed at unrelated code.
- A line-local lock test read a `.lock()\n.unwrap()` chain as non-lock — inventing the one "real" non-lock
  unwrap in the host.

**Re-derived 2026-10-13, before the fixes: 130 `.unwrap()` (130 lock, 0 non-lock) · 25 `.expect()` · 4 panic
promises · 2 assertions.** After: **24 expects and 0 panic promises.**

**Six request-path panic expressions fixed:**

| Site | Why it was a real risk |
|---|---|
| `core/browser.rs` runtime | lazy init on the **first browser tool call**; `build()` can fail under resource exhaustion, and abort ends the process |
| `core/web.rs` runtime | the same shape on the search/fetch path — found by the census, not by the plan |
| `browser.rs` `expect("list_pages refuses empty")` | the refusal lives in *another* function |
| `browser.rs` `expect("just connected")` | invariant held three lines earlier |
| `browser.rs` `unreachable!` | the loop returns on both arms — today |
| `mcp.rs` `expect("checked above")` | re-fetched `inputSchema` after testing it, on a **third-party server's** payload; now one lookup and a match, so there is no invariant to hold |
| `engine/taxonomy.rs` `is_none` + `unwrap` | folded into one `unwrap_or_else` |

**One approach was tried and reverted, which is worth recording:** adding `From<String> for ToolResult` so
the four `ToolResult`-returning tools could use `?`. It does not work — `?` requires the *function* to return
a `Result`, and a `From` impl cannot change that. `browser.rs` uses a two-line local `rt!()` macro instead,
and `web.rs`'s four sites already return `Result`, so they take `?` directly. The dead impls were removed
rather than left behind.

| Step | Result |
|---|---|
| `cargo test --lib -- --skip browser::tests` | **1613 passed, 0 failed** (1608 before; 4 taxonomy + 1 mcp new) |
| `cargo clippy --all-targets -- -D warnings` · `cargo fmt --check` | clean |
| `cargo check --no-default-features --all-targets` | clean |
| `python3 scripts/panic-census.py` | 130 unwrap (**all lock**) · **24** expect · **0** panic promises |

**The probe, and what it does and does not prove.** Removing the `unwrap_or_else` fallback failed **three** of
the four new taxonomy tests, panicking — including `a_body_that_is_not_json_is_still_the_reason`. So the
fallback is load-bearing for three inputs. What it does **not** prove is that the shipped code panicked: the
original `if reason.is_none() { … }` guard covered the same inputs, so this change is about the *distance*
between the proof and the panic, not about a live bug. The other five fixes have no falsifying probe
available — four are unreachable by any input, and forcing a runtime `build()` failure needs a thread-limit
environment this sandbox cannot create. They are structural removals, reported as such rather than as
test-proven.

**Deliberately not changed:** `panic = "abort"` itself. It is a recorded decision, the blast radius is the
symptom rather than the cause, and the process split belongs in a decision entry.

## Phase 5 — Close the Rust dialect-shaping port

**Design.** Differential, not a rewrite: a shared conformance corpus of fixture manifests plus recorded
request/response shapes, executed by the TS interpreter and the Rust interpreter, asserting **identical**
shaping (role mapping, `contentField`, tool declarations, finish-reason translation, stream deltas). The corpus
extends the existing two-loop pattern (`apps/desktop/conformance/loop-scenarios.json`, pinned from both sides).
The gemini-compat lint failure is fixed in the same phase, and drift **D47** (a manifest declaring no `stream`
block still sending `stream: true`) is resolved because it is the same misread.

### Phase 5 — slice 1 landed (the corpus and both drivers); the port was already mostly closed

**The plan's premise was stale, and measuring it was the first finding.** "The Rust serving path implements
none of the dialect-shaping fields" is false as of this run: `core/dialect_shaping.rs` is 984 lines and
implements role mapping, content-part templates, `contentField`, tool declarations, tool-call reading and
finish-reason translation, while `interpreter.rs` handles `toolChoiceMap` and `streamPath`. A mechanical diff of
every field the grammar declares against the Rust source found **one** shaping field with no reader on either
side (`ignoreWhen`, honoured by neither implementation) plus three provenance-only fields (`contractResult`,
`createdAt`, `validatedAt`) that are metadata rather than shaping. **The gap was in proof, not in feature** —
a much smaller job than the plan assumed, and worth stating because the old claim is still repeated in
[`ASSISTANT_GAP_PLAN_2026-09-30.md`](ASSISTANT_GAP_PLAN_2026-09-30.md).

| Step | Result |
|---|---|
| `pnpm -r test` | **1212 passed** — desktop **715** (700 + 15 conformance), router-core 474, adapter-spec 23 |
| `cargo test --lib -- --skip browser::tests` | **1614 passed, 0 failed** |
| `pnpm -r typecheck` · clippy `-D warnings` · `cargo fmt --check` | clean |

**What landed:** `conformance/dialect-scenarios.json` (15 scenarios), the reference driver
`src/lib/dialect-conformance.test.ts`, and the port driver inside `dialect_shaping.rs`. Both apply the
corpus's stated null-normalisation rule, because Rust serialises `Option::None` as an explicit `null` where
TypeScript omits the key.

**The corpus found a real divergence on its first run — which is the reason to build one.** The reference
tested `systemField === undefined`; a manifest file carries `null`, so `"systemField": null` hoisted the system
prompt into a field literally named `"null"` on the reference path while the port's `Option<&str>` read the same
manifest as having no system channel and dropped that content. Identical manifests, two behaviours, decided by
which path served the request. Fixed in the reference (`== null`), and the probe proves the corpus catches it:
reintroducing `=== undefined` fails **exactly one** scenario and leaves the other 14 passing.

**Where the driver lives was a real constraint, not a preference.** It first sat beside the reference in
`packages/router-core/test/`, where `node:fs` does not typecheck — that package's `tsconfig` carries no node
types. It moved to the desktop package, which already has the identical pattern in
`tools/agentLoop.conformance.test.ts`. The corpus is shared; only the driver moved.

**Still open from this phase:**

1. **`attachToolParts`** — the one shaping function not in the corpus. Its reason is its *semantics*
   rather than its signature (unlike the other two, which are covered): a tool result's name is
   resolved by looking back at the assistant turn that declared the call, and a run of consecutive
   results collapses into one message, so its scenarios need that behaviour read rather than guessed.

### Phase 5 — slice 2 landed (the renderer seam, and a second divergence)

Slice 2 covered the two renderer-seam functions whose semantics are local, and the corpus immediately
found the **same defect class a second time**:

- `shapeToolDeclarations` and `shapeMessageContent` joined the corpus, the reference driver passing the
  package's own `renderTemplate` (exported for exactly this) and the Rust driver rendering with
  `render_object`. Corpus: **19 scenarios**.
- **The divergence:** `shapeMessageContent` tested `contentField !== undefined`, so
  `"contentField": null` renamed the content field to a key literally called `"null"`, while the Rust
  port's `Option<&str>` read the identical manifest as having no rename. The same shape as slice 1's
  `systemField` finding, in a different function — which is what makes it a *class* rather than an
  incident.
- **Reachability, stated honestly:** both fields are `z.string().optional()` in the grammar, so `null`
  is **not reachable through a validated manifest**. It arrives through the bypass the drift register
  already tracks (a hand-edited row, an imported config, a manifest written by an older build). Both
  are fixed anyway, because a differential corpus carrying an "except when the input is null" caveat
  is a corpus people learn to ignore.

| Step | Result |
|---|---|
| `pnpm -r test` | **1217 passed** — desktop **720** (715 + 5 scenarios), router-core 474, adapter-spec 23 |
| `cargo test --lib -- --skip browser::tests` | **1614 passed, 0 failed** |
| `pnpm -r typecheck` · clippy `-D warnings` · `cargo fmt --check` · headless check | clean |

**Probes, one at a time:** reverting `contentField != null` fails **exactly the two** null-shaped
scenarios and leaves the other 18 passing; reverting the slice-1 `systemField` fix fails **exactly one**
and leaves 14 (of the then-15) passing.

### Phase 5 — slice 3: D47 closed, in both implementations at once

The register's own candidate repair, taken. `{{stream}}` is bound to **one** decision — "the caller
asked to stream AND this manifest can read a stream" — and that decision now also governs whether
`stream_options` is requested, which endpoint is dialled, and which branch reads the answer. Four
things that used to disagree cannot.

**Why it waited until now, and what changed:** the earlier entry is explicit that the repair "would be
a behavioural divergence no increment has authorised, and it would put the port at odds with the
reference it is measured against". Slice 1's corpus is the mechanism that makes a both-sides change
checkable, so the repair became takeable. Each side carries the same pair of tests — *a manifest with
no `stream` block asks for a unary answer even when the caller streams* and *one with the block still
streams* — in the reference's `dialect-messages.test.ts` and the port's `interpreter.rs`.

**Probes, one side at a time:** reverting the reference's `stream: streaming` → `stream: args.stream`
reddens **exactly** its new ask-side test; reverting the port's `Value::Bool(streaming)` →
`Value::Bool(stream)` reddens **exactly** its own. In both cases the pre-existing read-side test
(`a_stream_request_against_a_manifest_with_no_stream_block_is_answered_unary`) keeps passing — which is
the point: the read half was always right, and only the ask half could be seen by a new assertion.

**One thing the change surfaced that is worth recording**, because it is the kind of consequence a
one-line edit hides: the reference's branch condition was doing double duty as a TypeScript narrowing
guard, so replacing `!args.stream || !ep.stream` with `!streaming` lost the narrowing of `ep.stream`
inside the streaming branch and `tsc` failed in seven places. The fix was to bind `const spec =
ep.stream` once and narrow through **it**, which is also the clearer statement of the rule — the branch
now reads the same bound value the request body does.

| Step | Result |
|---|---|
| `pnpm -r test` | **1219 passed** — router-core **476** (474 + 2), desktop 720, adapter-spec 23 |
| `cargo test --lib -- --skip browser::tests` | **1616 passed, 0 failed** (1614 + 2) |
| `pnpm -r typecheck` · clippy `-D warnings` · `cargo fmt --check` | clean |

Register: **D47 marked Fixed** with the evidence, and the sentence that recorded it as deliberately
untaken is now the sentence explaining what authorised it.

### Phase 5 — slice 4: the other two open items, resolved without a port change

Both remaining items turned out to be **claims that needed testing rather than work that needed doing** —
the same shape as slice 1's discovery that the port was already closed.

**1. "A generated gemini-compat manifest cannot pass `lintManifest`" — the prior question was never asked.**
The claim is about *generated* manifests; what nobody had checked is whether the product's own shipped
templates satisfy the product's own rule. `builtin-templates-lint.test.ts` now lints **every** entry in
`BUILTIN_TEMPLATES` against its own dialect's `REQUIRED_SHAPING`, plus a guard that the map still holds
exactly the three known dialects. **All three lint clean**, so there is no gemini defect to fix: the
earlier "gemini-compat manifest cannot pass the lint" reading came from a generated manifest *omitting* a
required shaping field, which is the lint doing its job. The gap was coverage — the builtins were
constructed in code and nothing ever ran the lint over them — and it is closed.

**2. `ignoreWhen` — registered as drift D103 rather than implemented.** The grammar declares it with a
purpose (*"events whose mismatched chunkMap must not classify as PARSE_ERROR"*); a grep over both engines
finds no reader at all, while its sibling `stopWhen` is honoured in both. That makes the declaration a
claim the product cannot honour, which is the register's business: **D103** carries the measurement, the
two candidate resolutions (implement in both engines, or remove it in a manifest version bump), and why
neither was taken this round. A pointer at `manifest.ts:298-311` now names the register at the point of
use, so the next reader meets the entry rather than the comment alone.

| Step | Result |
|---|---|
| `pnpm -r test` | **1223 passed** — router-core **480** (476 + 4 lint tests), desktop 720, adapter-spec 23 |
| `pnpm -r typecheck` · `docs:book` · `check-doc-links` | clean |

No CHANGELOG entry for this slice: nothing user-visible changed. A new test, a register row and a comment
are real work, but none of them alters what the product does.

**One self-inflicted error worth recording, because it is the second of its kind in this phase.** Editing
the register with a multi-line anchor that *included* content I did not intend to change deleted two
separate fragments of the file's closing rules; both were caught by reading the result back and repaired.
The lesson is the one the repo's own conventions already state — short anchors, verify by reading — and I
applied it to every subsequent edit in this slice.

### Phase 5 — slice 5: the corpus is complete, and Phase 5 closes

`attachToolParts` was the last shaping function in, and it was the one that could not be written from a
signature. Its output depends on **relations between messages** — a tool result's name is resolved by
looking back at the assistant turn that declared the call, and a run of consecutive tool results
**collapses into one message** — so its three scenarios were authored from the semantics (read out of
both implementations first) rather than from the function's inputs.

**Both implementations agreed with the authored expectations on the first run.** That is the evidence
worth having: the two readings of the semantics were the same reading, which a test that merely
compared the implementations to each other could not have shown.

The three scenarios pin the rules that exist for real measured bugs: a call becomes a content part and
its result answers it (`{{argumentsObject}}` / `{{id}}`); consecutive results collapse while each
resolves its **own** name by looking back (the rule a template language could not express); and a
result whose content arrived as a **part array** still carries its text — the 2026-10-05 regression
where a gateway-normalized tool result reached an Anthropic-dialect provider empty.

**Probe:** disabling the look-back name resolution in the port fails exactly the scenario that names
it — *"consecutive results collapse into one message, and each resolves its own tool name by looking
back"* — and nothing else.

| Step | Result |
|---|---|
| `pnpm -r test` | **1226 passed** — desktop **723** (720 + 3), router-core 480, adapter-spec 23 |
| `cargo test --lib -- --skip browser::tests` | **1616 passed, 0 failed** |
| `pnpm -r typecheck` · clippy `-D warnings` · `cargo fmt --check` | clean |
| Corpus | **22 scenarios, every shaping function covered** |

**Phase 5 is closed.** Its four claims were: the port was missing the dialect-shaping fields (slice 1
found it already ported — the gap was proof, not feature); the renderer seam needed a driver (slice 2,
which found two `null`-vs-`undefined` divergences); D47 needed closing in both implementations (slice
3); and the gemini lint plus `ignoreWhen` were open (slice 4 — the lint item was not a defect, and
`ignoreWhen` is registered as **D103** because implementing it in two engines is real work that nothing
measured has needed). Every item is either closed with evidence or registered with its evidence and its
two candidate resolutions.

## Phase 6 — Workflow-style fan-out

**Design.** Phased fan-out with structured per-item results, on top of `dispatch_agent`, honouring Phase 2's
`canWrite` setting and the subagent concurrency cap. Last because it multiplies whatever capability the earlier
phases grant: fan-out over read-only children is a research tool, and fan-out over write-capable children is a
migration engine — the ordering is the safety property.

### Phase 6 — landed

`fan_out` takes a list of tasks and returns **JSON keyed by the caller's own label** — one object per task
with its summary, iteration count and tokens — where a `dispatch_agent` batch returned N prose summaries the
model had to keep straight itself. A bad item fails only that item (an unknown specialist names the valid ids,
and the other children's completed work survives), the cap of 12 is refused before any child starts, and a
batch larger than the concurrency cap runs in waves rather than being refused.

**The implementation is a refactor before it is a feature, and that is the safety property.** `runChild` was
extracted from the inline `dispatch_agent` block so both tools call one implementation of: the granted tool
set (the user's setting) with the definition narrowing it, the child's system prompt, its step budget and hard
backstop, the parent's approval gate, one ledger row per child, and the inactivity watchdog. A second copy is
how a fan-out child ends up at a different privilege level from a dispatched one.

**The refactor was verified before the feature was added** — 80 tests (including the cross-language
conformance suite) green on the extraction alone, so a later failure could not be blamed on both changes at
once.

| Step | Result |
|---|---|
| `pnpm -r test` | **1232 passed** — desktop **729** (723 + 6), router-core 480, adapter-spec 23 |
| `cargo test --lib -- --skip browser::tests` · clippy `-D warnings` · fmt | **1616 passed**, clean, clean — no Rust changed, and it is checked rather than assumed |
| `pnpm -r typecheck` · `web-test:types` | clean |

**Probes, and the one that proves the sharing:**

1. `subagentTools(false)` in `runChild` — the child grant ignoring the user's setting — reddens **three**
   tests: the two Phase 2 tests that pin the granted set *and* the new fan-out one. A duplicated
   implementation would have reddened only its own, so this is the evidence that the privilege rule is
   genuinely shared rather than re-stated.
2. `fan_out` removed from `SUBAGENT_NEVER` fails **exactly** the recursion assertion in the fan-out test.

**One deliberate asymmetry, checked rather than assumed:** `fan_out` is Assistant-only. So is the *execution*
of `dispatch_agent` — the Rust side holds subagent definitions (`agent_defs.rs`) and the delegation tree
(migration 0024) but never runs a child; the loop is TypeScript on both paths. The gateway's tool registry
stays static by design, so nothing diverges.

## Verification discipline, per phase

Applied as [05](dev-book/05-workflow.md) requires, not as a formality:

1. **Prove the test fails before trusting it passes** — flip the mechanism back, watch the named assertion fail
   and the others pass; one probe at a time.
2. **Typecheck, not just vitest** — `vitest` does not typecheck, and this repo has been bitten twice by exactly
   that.
3. **Run the phase's suites plus the neighbouring one** — a tools change runs the Rust tool tests *and* the
   desktop unit suite; a registry change runs the browser spec that walks the screens.
4. **Never `pnpm install`** to fix a test problem; the tree's `node_modules` is not reproducible from a sandboxed
   install (see [05](dev-book/05-workflow.md), `--install`).
