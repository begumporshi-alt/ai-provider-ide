# Control screen — unified switchboard + context observability

**Status:** design, not built. Wireframes in `diagrams/` and inline.
**Author context:** designed 2026-09-21, grounded in a survey of all 12 existing screens and the
`AIP-Memory` header path.

---

## 1. The problem

Two complaints, one root:

1. **The gateway context system has no proper visual UI to observe or control.**
2. **Toggles are scattered** across five screens, so there is no single place to answer
   "what is switched on, and is it working?"

The root is the same: **control and observation live in different places, and neither is complete.**

---

## 2. What the survey found

### 2.1 The observability data exists at runtime and is discarded

The `AIP-Memory` / `AIP-Memory-Scope` headers are built on **every** gateway response
(`context_scope.rs:430`, `apply_memory_headers`), from `InjectionOutcome` (`:394`). Verified:

- **No DB table** stores them.
- **No logging** writes them.
- **Zero frontend references** anywhere in `src/`.

`InjectionOutcome` is dropped immediately after the header insert. So this is not a "display the data"
problem — it is a **capture** problem. Nothing to display exists yet.

### 2.2 Three switches do not survive a restart

| Switch | Default | Persistence | Source |
|---|---|---|---|
| Memory master switch | **off** | in-memory; *deliberately* not remembered | `Memory.tsx:87`, `gateway.rs:666` |
| Gateway tools | on | in-memory `AtomicBool` | `gateway_cmds.rs:529` |
| Allow writes and commands | off | in-memory `AtomicBool` | `gateway_cmds.rs:542` |

A switchboard whose switches forget themselves is broken UX. But the memory switch looks
**intentionally** non-persistent — memory cannot be left on by accident across restarts. Treat that as
a product stance to *surface*, not a bug to silently fix.

### 2.3 Some recorded data has no reader

- ~~`generator_audit` is write-only~~ — **closed 2026-09-21.** Every adapter the assistant wrote has been
  recorded since the wizard existed, with no way to read it back. Providers now carries a
  `GenerationAuditCard`: the newest 50 rows, read on mount and again on `tick` (so approving a repair
  shows the row it just wrote, on the screen it was approved from).
- ~~`drift_events` has no UI reader~~ — **closed 2026-09-21.** The table is written on every detection
  (`store.ts:143`) and every repair (`store.ts:220`), and its only reader was `diagnostics_json`
  (`persist.rs:1400`) — the scrubbed JSON that Settings → Config & diagnostics copies to the clipboard. So
  the recorded history, `resolution` and `resolved_at` included, was visible only as raw JSON pasted into a
  bug report. Providers now carries a `DriftHistoryCard` (newest 50, read on mount and on `tick`).
  **A correction measured on the way:** "surfaced inside Providers" was imprecise. The Providers drift
  panel (`RepairModal`, `Providers.tsx:362`) reads the in-memory `pendingRepairs` map (`store.ts:130`) —
  session-only, and about *pending plans*. It never touches the table.
- ~~`gateway.log` is write-only~~ — **closed 2026-09-21.** Every gateway tool call had been appended to
  it since 2026-09-20 with no way to read it back, which made the trail evidence nobody could consult.
  Control → Tools now reads a bounded tail (last 128 KB, newest 50 lines).

Part of the observability gap closes **for free**, because the data is already being written — the
`gateway.log` reader is the worked example: it needed a parser and a card, not a new recording path.

### 2.4 Toggles today

| Screen | Owns |
|---|---|
| `Settings.tsx` | failover, per-provider concurrency, default models, system AI model, rotation strategy |
| `Gateway.tsx` | gateway on/off, port, serve-while-closed, tools, mutation, spend cap, app keys |
| `Memory.tsx` | memory master, per-principal policy, pin, scope, distil-now |
| `Providers.tsx` | per-provider enable/disable |
| `Models.tsx` | expose/unexpose to client |

---

## 3. The design principle

> **Switches live where you think about them.**
>
> The Control screen owns **cross-cutting, set-once** switches. It does **not** own per-entity
> controls.

Concretely:

- **Moves to Control** — gateway on/off, port, serve-while-closed, spend cap, memory master, tools,
  mutation, routing policy, budgets.
- **Stays where it is** — per-provider enable (on the provider card), per-memory scope and pin (in
  Memory), per-app key revoke (Gateway), expose/unexpose a model (Models).

Control **links out** to the entity screen rather than duplicating it.

**Move, do not mirror.** Mirroring one value in two places creates two sources of truth; they drift,
and then the switchboard lies about the system state.

---

## 4. Screen structure

One new screen, `screens/Control.tsx`, with category tabs. Each tab is a two-column layout:
**switches on the left, live detail on the right.**

| Tab | Cross-cutting switches | Live detail |
|---|---|---|
| **Gateway** | gateway on/off, port, serve-while-closed, spend cap | status, worker heartbeat, MTD spend, app-key count, endpoint |
| **Memory & context** | memory master, live context, per-principal policy, record-detail | usable vs total facts, turns held, distil budget, **injection reasons**, recent requests |
| **Tools** | gateway tools, allow writes/commands | calls today, denied, audit-trail link |
| **Routing** | failover, per-provider concurrency | last routing decision, failover count, provider health summary |

Budget and deadline are **compiled-in constants** today (`context_scope.rs:37,50`); the tab shows them
read-only until they become settings.

**Decided — Routing splits by kind.** Control takes the *operational* switches (failover, concurrency);
Settings keeps the *preferences* (default models, system AI model, rotation strategy). The rule that
produced the split: **Control is about state, Settings is about preference.** Failover is a switch you
flip in response to something; a default model is a choice you make once.

After the split, `Settings.tsx` still holds a coherent job — default models, system AI model,
per-provider rotation strategy, and crash reports — so it keeps its nav entry.

### 4.0 Two kinds of tab

The tab set splits by what dominates:

- **Switch-first** — Gateway, Tools, Routing. Few switches, light telemetry. The switch column carries
  the tab.
- **Telemetry-first** — Memory & context. One meaningful switch cluster, rich telemetry. The detail
  column carries the tab.

This is why the two-column proportion is **1/3 switches, 2/3 detail** rather than an even split:
switches are a label and a control, detail is a breakdown and a table.

### 4.0.1 Why Memory and context are one tab, not two

An earlier draft had them separate. That was wrong, and the reason is visible in a single response
header:

```
injected=1;items=3;tokens=96;ctx=1
```

`items` is memory, `ctx` is live context — **one header, one injection pipeline, one shared budget**
(`context_scope.rs:636` splits the remainder). They are meaningless apart, and Context alone has only
one or two real switches. Merging them matches the system.

The two *screens* stay separate: Memory keeps pin, scope, conflicts, and the core profile; Context
keeps the graph. Only the Control tabs merge.

### 4.1 Two-layer treatment

Because the audience is the operator *plus* future users, each tab renders:

- **Layer 1 — plain language.** A status sentence, the blockers, and 2-3 metric cards. No jargon.
- **Layer 2 — raw detail**, behind a `Show detail` disclosure. Reasons, counts, per-request rows,
  mono formatting.

### 4.2 Reason translation (layer 1 vocabulary)

The raw skip reasons are precise but opaque. Layer 1 translates them:

| Raw (`SkipReason`) | Plain language |
|---|---|
| `no_candidates` | Nothing matched this question |
| `no_store` | Memory had no store to search |
| `recall_failed` | The memory search itself failed |
| `principal_off` | Off for this app |
| `client_off` | The app asked for no memory |
| `disabled` | Memory is switched off |
| `no_project` | Couldn't tell which project this is |
| `below_floor` | Found facts, but none fitted the budget |
| `deadline` | Too slow, skipped to keep the reply fast |
| `injected` | Used |

Layer 2 always shows the raw token alongside, so the two layers stay reconcilable.

### 4.3 Required states

Specify these explicitly — the empty and error states are where fail-open systems look broken:

| State | Treatment |
|---|---|
| **Loading** | Skeleton on the metric cards; tabs usable |
| **Empty — never used** | "No requests yet. Point a client at the endpoint." |
| **Empty — memory on, nothing scoped** | The §5.1 hint, with a link to Memory |
| **Partial — counters exist, ring empty** | Counters render; recent list says "cleared on restart" |
| **Error — host unreachable** | One inline banner; switches disabled, not hidden |
| **Error — single switch fails** | Inline error on that row; other switches stay live |

### 4.4 The blocker rule — and why telemetry is what makes it work

The screen's real job is answering **"is anything wrong?"** in about three seconds. So blockers lead
the tab rather than sitting in a detail view. The header shows the aggregate count and links to the
first.

The hard question: **a switch that is off by choice is not a problem — so how does the UI tell the
difference?** The app cannot read intent. The rule:

| Class | Definition | Treatment |
|---|---|---|
| **Blocker** | Something *failed* — deadline miss, auth denial, port conflict, dead worker | Warning, top of tab |
| **Warning** | Off, **with evidence it is wanted** — requests arriving with nothing injected | Warning, top of tab |
| **Neutral** | Off, with no evidence of want | Just the switch state; no banner |

**The telemetry is what supplies the evidence.** `no_candidates × 98` is the fact that turns "memory is
off" from a neutral state into a warning. Without the ring buffer there is no way to distinguish a
deliberate off from a broken one — so the observability work is not merely reporting, **it is what
makes the switchboard honest.** This is the strongest argument for building §5 before the UI.

Two consequences to respect:

- A blocker must always name the **evidence**, not just the condition. "Memory is off" is a state;
  "98 of the last 100 requests arrived with nothing injected" is a reason to act.
- Never auto-resolve a blocker. The scope hint links to Memory; it does not scope anything (§9).

### 4.5 Switch interaction states

Switches have different apply latency, so a blanket optimistic flip would lie about state:

| Switch kind | Examples | Treatment |
|---|---|---|
| **Slow, can fail** | gateway on/off (binds a port) | **Pending** state; commit only on confirm |
| **Instant** | in-memory switches (tools, mutation) | Immediate flip |
| **Persisted, may fail** | memory master, spend cap | Pending if the write can fail; revert on error |
| **Destructive** | revoke key, forget everything | Inline confirm for a switch; **modal** for data loss |
| **Apply failed** | any | Toggle reverts to the previous value **and** shows an inline error on that row |

The governing rule: **the control never shows a state the host has not confirmed.** A gateway toggle
that appears on while the port bind failed is worse than a spinner.

### 4.6 Shell integration

The Shell already carries `Router healthy/idle` and `System AI ready/locked` chips
(`Shell.tsx:71-79`). These become the **entry point**: clicking a chip lands on the Control tab holding
the relevant blocker. Ambient status should lead to the detail, not sit beside it as a duplicate.

---

## 5. The capture mechanism

This is the gating decision. **In-memory counters plus a bounded ring buffer. No DB write on the
request path.**

Rationale: the memory layer is built to *never* block a request (15 ms deadline, `context_scope.rs:50`).
A SQLite write per request would contradict that philosophy and grow without bound.

### 5.1 Shape — as built

```rust
pub struct InjectionEvent {
    pub ts_ms: i64,
    pub id: String,        // client-visible `gw-{n}`
    pub model: String,
    pub scope: String,     // as reported on `AIP-Memory-Scope`
    pub injected: bool,
    pub items: usize,
    pub context: usize,
    pub tokens: usize,
    pub reason: String,    // SkipReason::as_str(); "injected" on success
}
```

- `Mutex<InjectionLog>` in `GatewayCore`, beside the freeze cache. `InjectionLog` holds a `VecDeque`
  capped at `RING = 100`, a `HashMap<String, u64>` of per-reason counts, and a `total`.
- Counters survive ring eviction, so the aggregate is lifetime-of-process rather than last-100.
- Cost per request: one uncontended mutex lock and a push. Negligible against a network call.
- Lives in `injection_log.rs` at the crate root, not under `gateway`, because it is a leaf that
  `gateway` depends on rather than part of the gateway's own surface.

**Two deviations from the first draft, both deliberate.**

1. **Counters are a `HashMap` under the same mutex, not `AtomicU64`.** One lock means a reader gets a
   consistent pair. A snapshot assembled across two locks can show a count that disagrees with the
   list printed beside it — which is exactly the class of bug this screen exists to catch.
2. **`id` is the client-visible `gw-{n}`, not the capture id.** The draft specified the capture id
   (`gw-{millis}-{pid}-{n}`) "so a row here can be matched against the Activity ledger". **That
   rationale does not hold** — measured, not assumed: `ledger_append` (`store.ts:97`) sends
   `ts, modality, source, providerId, keyId, requestedModel, model, status, httpStatus, errorClass,
   latencyMs, tokensIn, tokensOut, costEstimateMicros, fallbackChainJson` and **no request id**, so no
   id form can be joined to a ledger row. The client-visible id is kept instead for a different
   reason: it is the string the *client* sees and quotes when it reports a failure, so an operator can
   go from a user's message to the row that explains it. The capture id would also be a category
   error — it identifies a row in the *write* queue (`memory_pending`), while this event describes the
   *read* path.

The event deliberately carries **no second id.** Exposing the capture id here would mean threading it
out of `prepare_capture` (`context_scope.rs:727`) for a join that has no consumer yet.

### 5.2 Exposure

New tauri command `gateway_injection_stats() -> { counters, recent }`, read by the Control screen.

**Trap — do not skip:** every new `#[tauri::command]` needs a case in `web-test/shim.ts` **the same
day**. The shim throws on unknown commands, screens wrap loads in `.catch(() => undefined)`, and the
result is a **silently blank screen**. `--skip-browser` hides it.

### 5.3 Explicitly not chosen

| Option | Why not |
|---|---|
| Per-request SQLite table | A write on the request path, against the fail-open design; grows forever |
| Counters only | Cannot answer "which request did that" — the main debugging question |
| Opt-in table behind a switch | Deferred. Reasonable later if the ring proves too short; noted as a follow-up, not v1 |

### 5.4 Privacy note

`InjectionEvent` carries **scope and counts, never memory text**. The injected block is already in the
prompt; duplicating it into a diagnostic buffer adds exposure for no diagnostic gain. Keep the event
free of content.

---

## 6. Priority

**Must have**

1. **`InjectionEvent` ring buffer + counters first** — §4.4 argues the UI cannot be honest without it,
   so this is the prerequisite, not a parallel workstream.
2. The four tabs with their cross-cutting switches, moved from the existing screens. **Landed
   2026-09-21** — failover + the per-provider cap (Settings → Control → Routing), the gateway tools and
   mutation switches, and the gateway on/off, port and spend cap (Gateway → Control → Gateway). **One
   exception, decided against this spec:** the memory master switch stays on `Memory` (§7.2.4). The
   staging was deliberate — the screen was verified before the removals, so there is never a commit
   where a switch exists in neither place.
3. The blocker rule (§4.4): blockers lead the tab, each naming its evidence.
4. Switch interaction states (§4.5) — pending, revert-on-failure, inline confirm.
5. **Persist gateway tools and mutation** (decided, §7) — **landed 2026-09-21, but not as drafted.** The
   draft said to extend the `gateway` settings object to `{port, enabled, toolsEnabled, mutationEnabled}`
   **with `#[serde(default)]` on the new fields**, "the established pattern in `persist.rs`". There is no
   Rust struct for this object to keep in sync: the startup restore reads the row as a
   `serde_json::Value` and looks keys up by name (`persisted_gateway_port`, `lib.rs:77`), so an added key
   is invisible to it and no serde default is involved. The real hazard was on the TypeScript side, and
   it was a **clobber**, not a deserialize failure: `settings_set` is a whole-row UPSERT
   (`commands.rs:197`), and `Gateway.tsx`'s Start/Stop handler wrote `JSON.stringify({ port, enabled })`
   — so adding the switches without a merge would have erased them on every gateway restart, silently,
   until the next launch. `store.ts` now exposes `readGatewaySettings` / `patchGatewaySettings` (merge,
   never replace) / `applyPersistedGatewaySwitches`, and the merge property is pinned in
   `store.gateway-settings.test.ts` against the stored row rather than the return value.
6. Honest session-only marking on the **memory master switch** — the one switch that stays in-memory
   by decision, not by omission.
7. The two-layer treatment and the reason translation table.
8. All six states in §4.3.

**Nice to have**

9. ~~Surfacing the recorded audit trails~~ — **landed 2026-09-21.** The `gateway.log` reader is live on
   Control → Tools (bounded tail read, 128 KB / 50 lines) and the `generator_audit` reader on Providers
   (newest 50). They are different trails in different stores, which is why they landed on different
   screens: both of `generator_audit`'s producers are adapter work, repair already lives on Providers,
   and the rows carry no provider id (the INSERT omits `session_id`), so it had to be a page-level card.
10. ~~A view for the recorded `drift_events` history~~ — **landed 2026-09-21** as a card on Providers
    (§2.3), beside the repair surface: no nav change, the data is per-provider, and it mirrors the
    `generator_audit` card. A dedicated screen remains possible if the history ever needs to be filtered
    or paged, but nothing today needs more than the newest 50 rows.
11. Making budget and deadline editable — requires lifting the constants.
12. Opt-in persisted detail behind a switch.
13. Shell chips as blocker entry points (§4.6).

---

## 7. Decisions and remaining questions

### 7.1 Decided

| Question | Decision | Consequence |
|---|---|---|
| Telemetry depth | Counters + last-100 ring buffer, in-memory | No DB write on the request path; history is lost on restart |
| Ownership | **Move, don't mirror** | The existing screens lose their cross-cutting toggles |
| Audience | Operator + future users | Two-layer treatment; the reason translation table is required, not optional |
| Routing scope | **Hybrid — split by kind** | Control takes failover + concurrency; Settings keeps default models, system AI, rotation |
| Switch persistence | **Asymmetric** | Tools + mutation persist; the memory master switch stays session-only |
| Nav position | Regular sidebar entry | Launch screen unchanged; Shell chips still surface blockers globally |

### 7.2 Still open

1. **Does Control replace or complement the Gateway screen?** The move has now happened, so this is no
   longer hypothetical: `Gateway.tsx` holds per-app keys, the master key, the endpoint URL and the
   copy-paste presets — a coherent **credentials** screen. It still needs renaming or merging, or the app
   has two screens both called some flavour of "Gateway". **Live, not blocking.** One seam the move
   created, recorded rather than hidden: starting the gateway is now on a different screen from the
   endpoint URL it makes usable, so first run crosses between them. `Gateway.tsx` says where the switch
   went, in the place the Start button used to be.
2. **Is one screen right at this scale?** Four tabs is comfortable. If the Memory & context tab grows
   a timeline or a live feed, splitting into **Control** (switches) + **Observe** (telemetry) is the
   clean next move. The tab structure is built so that split is a lift-and-shift, not a rewrite.
3. **Should the memory master switch ever persist?** Decided *no* for now, on the reading that its
   non-persistence is deliberate — memory cannot be left on unattended. Worth revisiting if it proves
   annoying in daily use; it is a one-line change, and the UI would then drop the session-only notice.
4. **Where does the memory master switch live?** *Decided 2026-09-21, against this spec's staging table:
   it stays on `Memory`.* The mirroring was real, but the switch sits beside the notice that says what
   turning it on sends off this machine, and the moment of flipping it is the moment that notice matters.
   A notice read on another screen is not a notice. Control's Memory tab reports the state and links out —
   the same "link, don't duplicate" rule the screen's own header states, applied to the one case where the
   duplicate would have been the *destination* rather than the source.

### 7.3 Reversal — 2026-09-21

The three answers to §7.2 were **retracted by the operator**, on the grounds that following them would
add complexity. Assessed individually rather than accepted wholesale:

| Question | Original answer | Retracted to | Assessment |
|---|---|---|---|
| 1. Gateway screen | Complement it | Own nav entry | **Retraction accepted.** "Complement" is underspecified — it leaves two screens both called some flavour of Gateway, the naming problem §7.2(1) already flags. An own nav entry is simpler and retires the question instead of deferring it. |
| 2. Control + Observe split | Split | One screen | **Retraction accepted.** A split doubles the shell surface — two nav entries, two loading states, two error paths — to serve a tab set only four tabs wide. §7.2(2) already recorded the split as the *next* move rather than the first, and the tab structure keeps it a lift-and-shift. |
| 3. Persist the memory master | Persist | Don't persist | **Retraction rejected.** The change is ~20 lines, entirely backend, and touches the UI not at all — so it adds no UI complexity, which was the stated objection. It removes a daily annoyance the operator reported two messages earlier. Left open in §7.2(3) rather than silently dropped. |

**None of the three affects the Rust foundation.** The ring buffer, the recorder, and the command are
byte-for-byte identical under either set of answers — which is why the backend was built first and
without waiting for this to settle.

---

## 8. Implementation notes

- **Navigation is three edits**, not one: `ui-state.ts`, `Shell.tsx`, `App.tsx`.
- **`deny_unknown_fields` on nested payloads.** A tauri command arg and a serde field are different
  boundaries. Any nested struct crossing the host edge gets `deny_unknown_fields`, or a field-name
  mismatch is silently ignored — which is how `memory_capture_batch` dropped `sessionId` for months.
- **vitest does not typecheck.** Run the full gate (`pnpm ci:local`), not just vitest. Note `cargo` is
  not on PATH — use `~/.cargo/bin/cargo`, or the gate ends `FAILED (1): Rust (cargo missing)`.
- **Test counts to update** if new commands land: Rust `cargo test --lib`, desktop, browser.
- **Record at the four ingress handlers, not inside `inject_context`.** That function has ~30 call
  sites in tests, none of which should be writing telemetry, and keeping the injection contract free of
  side effects is worth four extra call sites. The `InjectionOutcome → InjectionEvent` mapping lives on
  `GatewayCore::record_injection`, so each site is one line and there is a single place to change a
  field. All four have `id` and the model in scope: `gateway_handlers.rs:65`, `gateway_anthropic.rs:192`,
  `gateway_responses.rs:134`, `gateway_gemini.rs:232`.
- **The webview reads camelCase.** Every DTO returned from `gateway_cmds` carries
  `#[serde(rename_all = "camelCase")]` (`GatewayStatus`, `gateway_cmds.rs:192`). Dropping `rename_all`
  breaks the screen at runtime with no compile error anywhere to warn about it, so a spec pins the wire
  names (`injection_log.rs::the_wire_names_are_camel_case`).
- **The shim returns a populated row, not `{}`.** With an empty object, a field-name mismatch between
  the Rust DTO and the screen passes the browser sweep unnoticed. The keys in `web-test/shim.ts` mirror
  the DTO under camelCase deliberately.

---

## 9. What this deliberately does not do

- **No pixel-level visual design.** Layout and interaction logic only; colour and typography belong to
  the design system already in the app.
- **No new control over the memory *write* path.** The capture queue, distillation caps, and the
  scope-binding gate stay as designed. This screen observes and switches; it does not change what may
  be learned.
- **No loosening of the scope predicate.** The 0-usable-facts state is surfaced as a *hint with a
  link*, never auto-corrected. Auto-scoping would destroy the contamination guarantee
  (`store.rs:664-668`).

---

## 10. Iteration log

Recorded so the reasoning is auditable — each of these changed the design.

**Round 1 — initial draft.**

- Four tabs: Gateway, Memory, Context, Tools. Two-column even split. Telemetry depth chosen as
  counters + last-100 ring buffer; ownership chosen as *move, don't mirror*; audience chosen as
  operator + future users, giving the two-layer treatment.

**Round 2 — self-review.**

1. **Merged Memory and Context into one tab.** They share one header, one pipeline, and one budget
   (§4.0.1). Context alone was a thin tab. Tab set became Gateway / Memory & context / Tools / Routing.
2. **Added Routing**, which the first draft omitted entirely despite failover and concurrency being
   cross-cutting switches currently buried in `Settings.tsx`.
3. **Blocker-first layout.** The screen's job is "is anything wrong?" — so blockers lead the tab and
   the header aggregates them, rather than being buried.
4. **Named the blocker rule** (§4.4), including the insight that telemetry is the *evidence* that
   distinguishes a deliberate off from a broken one. This reordered the build: capture comes first.
5. **Specified switch interaction states** (§4.5). Slow switches get a pending state; nothing shows a
   state the host has not confirmed.
6. **Changed the layout proportion** from 50/50 to **1/3 + 2/3**, because switch-first and
   telemetry-first tabs want different weights.
7. **Added Shell chip integration** (§4.6) so ambient status leads into the detail.

**Round 3 — decisions from review.**

8. **Routing split by kind.** Control takes the operational switches (failover, concurrency); Settings
   keeps the preferences (default models, system AI, rotation). The rule: **Control is about state,
   Settings is about preference.** This resolved the open question from round 2 without gutting
   `Settings.tsx`.
9. **Persistence is asymmetric.** Gateway tools and mutation persist — their in-memory state reads as
   incidental. The memory master switch stays session-only, because its non-persistence reads as
   deliberate: memory cannot be left switched on unattended. Persistence of the two tools switches
   moved from *nice to have* to *must have*. They landed 2026-09-21 by extending the `gateway` settings
   object; see §6 must-have 5 for why the `#[serde(default)]` half of that decision was wrong, and what
   the real hazard turned out to be.
10. **Regular nav entry.** Control does not become the home screen; the launch experience is unchanged
    and the Shell chips carry blocker visibility globally.

**Still open** — see §7.2. None of the three remaining questions blocks the build: the tabs can land
before the Gateway-screen naming is resolved.

**Round 4 — backend landed, three answers retracted.**

11. **§5 built first, as §4.4 argued.** `injection_log.rs` (ring + counters), the `GatewayCore` field and
    accessors, the four ingress call sites, `gateway_injection_stats`, and the `shim.ts` case. 6 specs,
    408 → 414 Rust lib tests.
12. **§5.1 corrected against measurement, twice.** Counters are a `HashMap` under one mutex rather than
    `AtomicU64`, so a snapshot cannot show a count disagreeing with the list beside it. And `id` is the
    client-visible `gw-{n}` — the draft's capture-id rationale assumed the Activity ledger could be
    joined on a request id, and it cannot: `ledger_append` carries no id at all. Recorded in §5.1 rather
    than quietly changed.
13. **The three §7.2 answers were retracted** (§7.3). Two retractions accepted, one rejected with the
    reason. Nothing in the backend depended on any of them, which is why it could be built first.
14. **Every new spec was falsified before being trusted.** Disabling the counters failed exactly the two
    counter specs; disabling ring eviction failed exactly the two ring specs; removing `rename_all`
    failed the wire-name spec and printed `ts_ms` on the wire. A spec that passes with its mechanism
    removed is decoration, not evidence.
