# Unified Harness & Memory — Architecture Validation and Target Design

**Date:** 2026-09-21
**Status:** proposal — nothing here is implemented
**Revised:** 2026-09-21, same session — the §2.1 skills row was corrected (bodies DB-backed, *consumption*
frontend-only), C3 was sharpened (`session_turns` vs `context_nodes`), and §9's first three uncertainties
were closed by reading `commands.rs:197`, `Gateway.tsx:117,121`, `lib.rs:76`, `context_scope.rs:777`,
`session_context.rs:125` and `gateway.rs:542`. Each correction is flagged inline where it lands.
**Method:** every claim below was read out of the source in this session and is cited as `file:line`.
Where I could not determine something, it is listed in §9 rather than guessed.

Companion documents: `ARCHITECTURE.md` (system overview), `GATEWAY_MEMORY_LAYER.md` (the memory
layer's design and review history), `docs/gateway-flexibility-plan.md` (client-compatibility plan),
`DECISIONS.md`.

---

## 1. The question, restated precisely

> Give both the Assistant and the gateway the same harness power, unity, and unified memory, with an
> architecture that is well-organised, robust, easy to understand, and free of gaps or loopholes.

Two words carry the weight here, so let me fix them before anything else:

- **Harness** = the turn engine: the loop that calls the model, collects tool calls, executes them
  under a policy, feeds results back, and terminates. Not the tools themselves — those already agree.
- **Unity** = one implementation of that loop and one implementation of context assembly, with the
  Assistant and the gateway as *adapters* over it, not as two parallel implementations.

**The headline finding: the two paths already share ~90% of their capability.** Same tool registry,
same sandbox, same iteration cap, same memory store, same capture queue, same provider dispatch. What
differs is **policy and assembly**, and those differences are currently expressed as *duplicated code
and hardcoded literals* rather than as parameters. That is the actual defect, and it is a much smaller
problem than "the two paths are different systems" — but it is a real one, because duplicated policy
drifts.

---

## 2. What exists today

### 2.1 Two entry points, one spine

| | Assistant | Gateway |
|---|---|---|
| caller | the local user, in the app's UI | a third-party process over HTTP |
| entry | `screens/Assistant.tsx:653` `send()` | `gateway.rs:1616-1624` axum router |
| transport | `router.generateText` | `gateway-request` Tauri event → webview → `gateway_chunk/result/done` |
| reaches Rust via | `tool_run` (`lib/tools/host.ts:30`) | `gateway_tool_run` (`gateway-bridge.ts:226`) |

Both funnel into the same places. This is the part that is already right:

| shared spine | evidence |
|---|---|
| **Tool sandbox** | `tool_run` and `gateway_tool_run` both land in `tools::tool_run` (`tools.rs:789-810`); no shell (`tools.rs:621-633`), executable + `git` subcommand allowlists (`tools.rs:37-57`), root confinement (`tools.rs:158-199`), `env_clear`, timeouts, output caps (`tools.rs:59-64`) |
| **Tool registry** | `AGENT_TOOLS` — exactly 8 tools (`lib/tools/registry.ts:16-149`) — used by *both* (`agentLoop.ts:93`, `gateway-bridge.ts:167`) |
| **Schema renderer** | `registryToOpenAI` (`registry.ts:153-168`) — both |
| **Iteration cap** | `DEFAULT_MAX_ITERATIONS = 8` (`agentLoop.ts:35`), and `gateway-bridge.ts:86` is literally `const MAX_TOOL_ITERATIONS = DEFAULT_MAX_ITERATIONS` |
| **Tool-call wire shape** | `toWireToolCalls` — both |
| **Memory store + ranking** | `memory.rs` — one table, one FTS5 + `rerank` |
| **Capture queue** | `capture.rs` — one queue, one §3.5.5 idempotency guard |
| **Context graph** | `context.rs` — one `context_nodes`/`context_edges` store |
| **Provider dispatch** | `execution-engine.ts:97` forwards `tools`, `toolChoice`, `onToolCall`, `responseFormat` to the adapter |
| **Skills storage** | `skills` table (`store.rs:230`) — bodies DB-backed, but *consumption* is frontend-only (see B7) |
| **Retention/drain** | `memory::prune`, `session_context::prune`, `capture::purge_finished`, driven by `App.tsx:45,53` timers |

### 2.2 Where they diverge

Thirteen axes, grouped into three families. "Cost" is my judgement of what breaks if it stays.

#### A. Harness / tool policy

| # | axis | Assistant | Gateway | cost |
|---|---|---|---|---|
| A1 | **per-call approval** | `confirm` → `ConfirmModal` before each mutating call (`agentLoop.ts:146`, `Assistant.tsx:614-618,1026`) | **none** — `executeLocally` calls straight through (`gateway-bridge.ts:213-235`) | high |
| A2 | **mutation gate** | the approval modal; no flag | global boolean `tools_mutation_enabled`, default **false**, covering `MUTATING_TOOLS = [write_file, edit_file, mkdir, run_command]` (`gateway.rs:614,663,1077-1087`) | high |
| A3 | **loop body** | `agentLoop.ts:97-175` | `gateway-bridge.ts:248-…` | medium |
| A4 | **tool-discipline prompt** | `AGENT_SYSTEM` + workspace root (`Assistant.tsx:64-89`) injected as the system turn | **not injected** — the gateway prepends only memory/context (`context_scope.rs:644-645,997-1003`) | medium |

A1/A2 are the sharp ones. The Assistant gates mutation *per call, interactively*; the gateway gates it
with *one global boolean*, and once that boolean is on there is no human in the loop and no
per-principal granularity. `gateway_tool_refusal(tool)` (`gateway.rs:1077`) takes only a tool name —
**the tool decision is not principal-scoped at all**. `principal::allows` (`principal.rs:155-174`)
governs *memory*, not tools.

#### B. Memory and context assembly

| # | axis | Assistant | Gateway | cost |
|---|---|---|---|---|
| B1 | **scope** | `recall(..., None)` — no scope predicate (`memory.rs:415`) | `recall_scoped` + `RecallScope{user,project,agent}` (`memory.rs:441`, built at `context_scope.rs:586-590`) | medium |
| B2 | **budget unit** | `DEFAULT_CONTEXT_BUDGET = 1200` **chars** (`engine.ts:30,377-392`) | 1500 **tokens**, memory share 0.60, model-aware (`context_scope.rs:37,101,823-876`) | medium |
| B3 | **layer selection** | two calls: `["L3","L2"]` then `["L1"]` (`engine.ts:345,353`) | one call, literal `["L1","L2","L3"]` (`context_scope.rs:593`) | low |
| B4 | **pinned handling** | up to 4 pinned prepended unconditionally (`engine.ts:337,357-364`) | via `rerank`, L3 always full (`memory.rs:367-401`) | low |
| B5 | **deadline** | none | `MEMORY_DEADLINE = 15ms`, checked at recall/context/prepend (`context_scope.rs:50,564,633,640`) | high if removed |
| B6 | **freeze** | none | composed block frozen per `(scope,session)` for 600 s, max 256 (`gateway.rs:600,604,847-883`) | low |
| B7 | **skills in prompt** | agent mode only (`Assistant.tsx:584-596,702`) | never | low |
| B8 | **system-message shape** | agent: **one** composed turn; plain chat: **two** separate (`Assistant.tsx:702`, `786-787`) | **one** prepended `<memory>…</memory><context>…</context>` at `messages[0]` | low |

Note B3: the *sets* now agree (L1/L2/L3, L0 excluded on both). The divergence is mechanism, not content.
Note B5: the 15 ms deadline exists because the gateway sits inside a live HTTP request from a foreign
client. This is not a wart — see §4.

#### C. Identity and attribution

| # | axis | Assistant | Gateway | cost |
|---|---|---|---|---|
| C1 | **principal** | none — the local user | `key:<id>` or `key:master`, plus the `AIP-Agent` label; either may deny (`principal.rs:125-141,155-174`) | by design |
| C2 | **session id** | `activeSession()` from the recorder (`Assistant.tsx:575-576`) | `AIP-Session` header, else `s-<fnv1a(user\|project\|agent)>` (`session_context.rs:64-75`) | medium |
| C3 | **context-graph writes** | full conversation graph via `recorder.ts` → `context_record` | tool-call nodes only (`gateway_cmds.rs:691-727`); gateway chat turns go to **`session_turns`** (`context_scope.rs:777` → `session_context.rs:125`), never to `context_nodes` | medium |

C3 is a visible product defect: a gateway session appears in History as a handful of tool nodes with no
conversation. The turns are **not** lost — `session_context::record_turns` writes them to `session_turns`
(a per-session ring, deduped against the session's most recent turn so a retry does not append a copy) —
but `session_turns` is not the table History renders, and the gateway path never calls `context::record`.
So the cheapest fix may be to read `session_turns` on the History path rather than to write a second copy
of the conversation into the graph.

---

## 3. What is realistically achievable

Three tiers. I recommend doing them in this order and shipping each independently.

### Tier 1 — Extract the turn engine (high value, low risk)

Create `apps/desktop/src/lib/harness/` holding **one** loop, and make both callers adapters.

- **Achievable now.** The two loops already share the registry, the cap, the wire shape and the
  sandbox. A1/A2/A4 become *policy fields* instead of duplicated branches.
- **Why it matters most:** it is the only change that makes capability parity *structural*. Today the
  gateway gets the same tools "by coincidence of a shared constant"; after Tier 1 it gets them because
  there is one implementation.
- **Risk:** medium-low. The gateway loop carries hard-won behaviour that must be preserved verbatim —
  the liveness probe before every turn (`gateway-bridge.ts:259-276`), `heldProse` preamble suppression
  (`:172-177`), and abort propagation. Losing any of those reintroduces a bug that was already paid for.
  Mitigation: extract *without rewriting*, and keep the gateway's test surface green.

### Tier 2 — Unify memory assembly (high value, medium risk)

One `assembleContext(query, policy)` returning `{ block, trace }`, used by both.

- **Achievable now.** The store, ranking and reranker are already shared; only the *wrapper* differs.
- **Budget must be unified on tokens, not chars.** B2 is a real defect: 1200 chars ≈ 343 tokens, so the
  Assistant injects roughly **a quarter** of what the gateway does, and the number is not model-aware.
  Unifying on the token model gives the Assistant a strictly better budget.
- **Scope stays a policy field, not a constant.** See §4 — the two callers legitimately differ.
- **Risk:** medium. The gateway's freeze and 15 ms deadline must survive as policy, and the Assistant
  must *not* inherit them.

### Tier 3 — Close the identity and attribution gaps (medium value, medium risk)

- C3: have the gateway write conversation nodes too, so History is complete for gateway sessions.
- C2: let the Assistant adopt the gateway's session resolution when it is acting on behalf of a
  scoped request, so the same conversation is one session regardless of entry point.
- C1 is **not** achievable and should not be attempted: the Assistant has no principal by construction.
  It is the local owner's surface. Instead, the policy object carries `principal: null` and every
  principal-dependent decision must fail *closed* on null (see §7).

### Explicitly NOT worth doing

- **Moving the turn engine into Rust.** The provider stack (selection, keys, fallback, adapters) lives
  in the webview, and `model_context.rs:1-19` documents why duplicating it in Rust was rejected. The
  harness must stay in the webview.
- **Unifying approval semantics.** They cannot be the same — see §4 — and pretending otherwise would
  either block a foreign HTTP request on a human or silently drop the Assistant's safety gate.
- **Unifying the two callers' *trust* levels.** Tier 1 shares the mechanism; it does not and should not
  share the trust model.

---

## 4. Constraints and limitations

These are hard. They are not implementation details to be smoothed away, and any design that ignores
them will be wrong.

1. **Trust asymmetry is irreducible.** The Assistant's caller can be asked a question and will answer.
   The gateway's caller is a foreign process holding an open HTTP request — asking it means blocking,
   and it may have no human at all. So approval *mechanism* must differ. What can be shared is the
   *decision function*: given (tool, args, policy) → allow / refuse / needs-approval. The Assistant maps
   "needs-approval" to a modal; the gateway maps it to a refusal (fail closed) or, optionally later, a
   deferred approval queue.
2. **The 15 ms memory deadline is a gateway-only requirement.** It exists to bound a live request path.
   The Assistant has no such bound — its latency is visible to one user. Making the deadline shared
   would degrade the Assistant for no benefit; making it absent would risk the gateway.
3. **Tool execution is webview-owned, deliberately.** The HTTP handler never runs a tool; it round-trips
   to the webview, which owns the provider stack. `docs/gateway-flexibility-plan.md:225-239` records
   what happened when a previous attempt assumed otherwise — every completion came back empty.
4. **Client-supplied tools must remain pass-through.** When a client brings its own tools the gateway
   returns them untouched and never executes them (`gateway-bridge.ts:150-170,348-354`). This is a
   boundary, not an oversight: running a foreign tool schema locally would be remote code execution.
5. **Memory precedence is fixed and non-negotiable.** Operator master switch → per-principal row beats
   the client's `AIP-Memory` header. A denied principal is denied in *both* directions.
6. **`panic = "abort"`.** No poison handling anywhere.
7. **Absence is not global.** `recall_scoped` with an unresolved project returns pinned globals only
   (`memory.rs:497-499`). Any unified assembler must preserve this — it is the rule three reviewers
   demanded (`memory.rs:418-424`).
8. **Client dialects are translated before assembly.** Anthropic/Gemini/Responses are converted to a
   canonical OpenAI body first (`gateway_anthropic.rs:27`, `gateway_responses.rs:24`,
   `gateway_gemini.rs:175-214`). Assembly happens once, after translation.

---

## 5. Target architecture

```
                        ┌──────────────────────────────┐
   Assistant UI ───────▶│  HarnessPolicy (explicit)    │◀─────── Gateway adapter
   (screen switches,    │  every field has a default;  │        (principal, scope,
    workspace root)     │  defaults are RESTRICTIVE    │         AIP-* headers)
                        └──────────────┬───────────────┘
                                       │
                        ┌──────────────▼───────────────┐
                        │  lib/harness/runTurn()       │   ONE loop
                        │  · model turn + tool calls   │
                        │  · decision(tool,args,policy)│
                        │  · execute via ToolHost      │
                        │  · terminate on no-calls/cap │
                        └──────────────┬───────────────┘
                                       │
             ┌─────────────────────────┼─────────────────────────┐
             ▼                         ▼                         ▼
   lib/memory/assemble.ts       tools.rs sandbox          router-core
   (recall + budget + scope)    (one execution path)      (one dispatch)
```

### 5.1 The policy object — the whole design in one type

```ts
/** Every field is required. `undefined` is never a shorthand for "permissive". */
interface HarnessPolicy {
  owner: "assistant" | "gateway";

  /** How a mutating tool call is resolved. */
  mutation: "ask" | "preauthorised" | "refuse";

  /** Where the tool surface comes from. */
  tools: "registry" | "client" | "none";

  /** null ⇒ unscoped (local owner only). Never null for a gateway request. */
  memoryScope: RecallScope | null;

  /** Tokens. Replaces the Assistant's char budget (see §3 Tier 2). */
  memoryBudget: { tokens: number; share: number; modelKey?: string };

  /** Gateway-only. Absent for the Assistant. */
  deadlineMs?: number;
  freeze?: { key: string; ttlMs: number };

  /** Assistant-only today; becomes shared once the gateway injects it. */
  systemPrompt: string;

  /** null for the Assistant. */
  principal: { label: string; keyId: string } | null;

  onEvent: (e: HarnessEvent) => void;
}
```

Both adapters become small:

- **Assistant** → `{ owner: "assistant", mutation: "ask", tools: "registry", memoryScope: null,
  principal: null, systemPrompt: agentSystem(root) + skillsBlock, onEvent: → React state }`
- **Gateway** → `{ owner: "gateway", mutation: preauthorised ? "preauthorised" : "refuse",
  tools: clientTools ? "client" : (enabled ? "registry" : "none"),
  memoryScope: { user, project, agent }, principal: {…}, deadlineMs: 15,
  freeze: { key: scopeSession, ttlMs: 600_000 }, onEvent: → gateway_chunk }`

**The design rule that removes the gaps:** capability is expressed as a *policy field with an explicit
default*, and every default is the restrictive one. There is no code path where "the field was not set"
means "allow". That single rule is what makes the surface auditable — you can read one type and know
every capability.

### 5.2 Where the loopholes are today, and how the target closes them

| id | loophole today | evidence | closure |
|---|---|---|---|
| **L1** | **Tools are not principal-scoped.** `gateway_tool_refusal` takes only a tool name. Any valid app key gets the full registry once the global flag is on. | `gateway.rs:1077` | decision moves into `policy.principal`; per-principal tool grants; null principal ⇒ `tools: "none"` |
| **L2** | `tools_mutation_enabled` is global, not per-principal | `gateway.rs:663` | becomes `mutation` on the policy, derived per principal |
| **L3** | Read tools are ungated: `read_file`/`list_dir`/`search_files`/`file_info` are not in `MUTATING_TOOLS`, so they run by default against the single global workspace root | `gateway.rs:614` | decide explicitly (see §8); if unintended, gate reads per principal too |
| **L4** | No per-call approval on the gateway path, so a prompt-injected foreign agent can write files with no human in the loop once the flag is on | `gateway-bridge.ts:213-235` | `mutation: "refuse"` is the default; a deferred approval queue is the only way to get "ask" |
| **L5** | The Assistant's recall is unscoped and this is only implied by a comment that names the *Memory screen* | `memory.rs:432-433` | scope becomes an explicit policy field; the comment is corrected |
| **L6** | Gateway chat turns never reach `context_nodes`, so History is incomplete for gateway sessions | `gateway_cmds.rs:691-727` | Tier 3: gateway writes conversation nodes |
| **L7** | Same conversation via two entry points yields two session ids | `session_context.rs:64-75` vs `Assistant.tsx:575` | Tier 3: one resolver |
| **L8** | Two loops drift silently — a fix to one is not a fix to the other | `agentLoop.ts:97` vs `gateway-bridge.ts:248` | Tier 1: one loop |

Not a loophole, worth recording as *verified parity*: a failed tool call never reaches the model as an
empty string on either path — `agentLoop.ts:159-161` guards it and `gateway-bridge.ts:229-231` does the
same. That rule (`""` is a valid model input and reads as "the tool returned nothing") is currently
upheld in two places, which is exactly the kind of thing Tier 1 makes impossible to get half-right.

---

## 6. Migration plan

Each phase is independently shippable, and each has a falsification step — this project's rule is that
a test which passes with the fix removed is not evidence.

**Phase 1 — extract, don't rewrite.** Move the gateway loop body and the assistant loop body into
`lib/harness/runTurn.ts` behind `HarnessPolicy`, preserving every existing comment and behaviour. Both
callers keep their own tests.
*Falsify:* with the gateway adapter switched back to its old inline loop, the gateway browser specs must
still pass — otherwise the extraction changed behaviour rather than relocating it.

**Phase 2 — the decision function.** Introduce `decide(tool, args, policy) → allow | refuse | ask`, and
route A1/A2 through it. Assistant maps `ask` to the modal; gateway maps `ask` to `refuse`.
*Falsify:* set the gateway policy to `mutation: "preauthorised"` and confirm the mutating tools run;
set it to `"refuse"` and confirm they are refused **with a model-visible message**, not silence.

**Phase 3 — one assembler.** Replace `recallContext` + `inject_context` with `assembleContext(query,
policy)`. Unify the budget on tokens. Keep `deadlineMs` and `freeze` as policy.
*Falsify:* assert the Assistant's injected block is now token-budgeted and the gateway's is unchanged at
the same scope — a single shared function must not change gateway output.

**Phase 4 — the system prompt.** Inject `AGENT_SYSTEM` on the gateway path too (A4).
*Falsify:* a gateway request with tools on must show the discipline text in the outgoing body; and a
request with tools off must **not** carry it (no tools ⇒ the text is a lie about its own capabilities).

**Phase 5 — identity/attribution (Tier 3).** Gateway conversation nodes; one session resolver.
*Falsify:* drive the same conversation through both entry points and assert one session id.

**Phase 6 — per-principal tool grants (closes L1/L2/L3).** Schema + UI + decision function.
*Falsify:* two app keys with different grants must get different tool surfaces from the same request.

---

## 7. Fail-closed register

The property that makes the target design robust is not any individual rule but this: **every
uncertainty resolves to the restrictive answer.** Enumerated so it can be tested:

| uncertainty | resolves to | precedent today |
|---|---|---|
| principal unknown / null | no tools, no memory | `principal.rs:178-189` (absence inherits deny-on-missing-store) |
| project unresolvable | pinned globals only | `memory.rs:497-499` |
| model window unknown | `DEFAULT_WINDOW_TOKENS = 8192` | `model_context.rs:11-13,88-112` |
| deadline exceeded | inject **nothing**, not a partial block | `context_scope.rs:646-650` |
| approval unavailable (no human) | refuse the mutating call | *new — L4* |
| tool name unrecognised | refuse | `tools.rs:808` |
| budget unset | conservative default, never unlimited | `context_scope.rs:576` |
| store unreachable | memory off, request still served | `context_scope.rs:532-549` |

The last row matters: a memory failure must never fail the request. That is already true and must stay
true through the refactor.

---

## 8. Open decisions for the operator

1. **Are read tools meant to be ungated for third-party agents?** Today `read_file`, `list_dir`,
   `search_files` and `file_info` run by default against the single global workspace root
   (`gateway.rs:614`, `tools.rs:716-750`). If a foreign agent should not be able to read the operator's
   workspace at all, that needs a read gate and per-principal roots — a schema change. (L3)
2. **Should the gateway ever get an approval queue?** A deferred queue preserves the "ask" semantics
   without blocking the HTTP request, but adds a UI surface and a new pending-state machine. The
   alternative — refuse mutating calls from the gateway, always — is simpler and is my recommendation
   until a concrete client needs it. (L4)
3. **Should gateway sessions appear in History as conversations?** Doing so closes C3/L6 but means the
   app stores foreign agents' transcripts, which is a retention and privacy decision, not just a
   plumbing one.
4. **Which is the canonical memory budget unit?** Tokens (my recommendation, matching the gateway and
   being model-aware) or chars (the Assistant's current behaviour, simpler to reason about). (B2)

---

## 9. Uncertainties

Per this project's standing rule, recorded rather than guessed.

### Resolved during this session

- **Where the live port `8800` is persisted — traced.** The literal appears nowhere in source. The *write*
  is the generic `settings_set` command (`commands.rs:197`, an upsert on `key`), called from
  `screens/Gateway.tsx:117,121` as `settings_set({key:"gateway"}, {port, enabled})` — written
  `enabled:false` *before* `gateway_enable` and `enabled:true` *after*, which is the forced
  stop → edit → start order the UI imposes. The *read* on boot is `persisted_gateway_port` (`lib.rs:76`),
  which returns `None` unless `enabled == true`. So `DEFAULT_PORT` (`gateway.rs:33`) and the UI default
  (`Gateway.tsx:99-101`) are both irrelevant once a row exists — reading the constant tells you nothing.
  (An earlier note cited `persist.rs:941` as the write path; that line is a **test fixture** inside
  `config_export_import_safety`, not production code.)
- **Whether any gateway path writes conversation turns — yes, but not where History looks.** Nothing in
  the gateway calls `context::record`. Instead `context_scope.rs:777` calls
  `session_context::record_turns`, which writes **`session_turns`** (`session_context.rs:125-162`). So C3
  stands as written, and the fix has a cheaper option than duplicating the conversation into the graph
  (see §2.2).
- **Whether `workspace_root` is per-principal — no.** It is one global `Mutex<Option<PathBuf>>`
  (`gateway.rs:542`), set by `set_workspace_root` (`:1094-1095`) via `gateway_set_workspace_root` and
  defaulting to `default_workspace_root()` (`:626,664`). This confirms L3's premise: every principal
  shares one root, so read tools are as broad as the workspace is.

### Still open

- **The exact host retention TTLs** as they interact with `retention.ts`'s 30-minute timer — the TTLs
  themselves are in `memory.rs`/`session_context.rs` and are cited above, but the interaction with the
  webview timer schedule was not traced.

---

## 10. Summary

- The two paths **already share the spine**: one sandbox, one registry, one cap, one store, one queue,
  one provider dispatch. Capability parity is real but *coincidental*, held together by shared
  constants rather than by construction.
- The real defects are **policy divergence expressed as duplicated code** (A1–A4), **a memory budget
  that differs by ~4× and is not model-aware** (B2), and **a tool surface that is not principal-scoped
  at all** (L1/L2), plus **gateway sessions missing from History** (C3).
- The fix is not a rewrite. It is **one loop + one assembler + one policy type**, with the Assistant and
  the gateway as adapters. The single most valuable rule is that every capability is an explicit policy
  field whose default is restrictive.
- Three things must *stay* different, and a design that unifies them is wrong: approval mechanism
  (a foreign HTTP client cannot be asked), the 15 ms deadline (live request path), and the principal
  (the Assistant has none).
