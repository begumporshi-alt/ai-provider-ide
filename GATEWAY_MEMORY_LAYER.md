# Gateway Memory & Context Layer — Design

_Status: proposal. Written against the code as of 2026-09-20 (v1.0.0)._

## 0. Verdict on the plan first

The plan is sound and it is the only design that can serve external agent IDEs — but as written it
collides with a deliberate decision already in this codebase, and it underestimates three costs.
My recommendation: **build it, but behind an off-by-default toggle, with a hard token budget, and
with capture off the request path.** Concretely:

1. **It reverses the "gateway is blind" rule.** `REFERENCE.md` records: *"Skills are frontend-only;
   skills in the gateway would bill tokens on every request from every client and make instructions
   invisible at a layer with no review step."* Memory injection is the same hazard, larger — a
   memory block is typically bigger than a skill block and it is injected on *every* call from
   *every* client, including runaway agent loops. The skills decision was correct and this feature
   inherits its risk. Mitigation is not "be careful", it is the same three controls the tool path
   uses: a host-side toggle (`memory_enabled`), a per-request budget cap, and an audit row.
2. **Recall is cheap and can be fully host-side — capture cannot.** `memory.rs::recall` is BM25 over
   SQLite FTS5 with no model involved, so retrieval on the request path costs one indexed query.
   Distilling a raw turn into L1/L2 needs a model, and the webview owns the gateway client
   (`distilTurn` in `src/lib/memory/engine.ts`). **Do not put a model call on the request path.**
   Capture must be a queue drained off-path.
3. **Header-only metadata will not work for the clients you named.** Cursor and Continue let you set
   a base URL and an API key; they do not reliably let you set arbitrary headers. The contract needs
   a **body-level fallback** (`metadata.aip`) or half the target clients cannot opt in at all. This
   is the single most likely way this feature ships and gets zero adoption.
4. **Privacy inversion.** L0 is verbatim conversation. Injecting cross-session L0 into a request
   routed to vendor B means the user's session from vendor A is now in vendor B's prompt. Default
   must be **L1/L2/L3 only**, with L0 opt-in per scope.
5. **It is a billing change, not just a feature.** Every injected token is billed and comes out of
   the existing per-app spend cap (R4). A runaway loop currently stops at the cap; with injection it
   burns the cap faster per call. The cap needs to stay in front of injection, not behind it.

Everything below is the design that follows from those five points.

---

## 1. Where injection physically goes

Established by reading the code, not assumed:

```
Cursor / Claude Code / Continue / Aider
  │  POST /v1/chat/completions | /v1/messages | /v1/responses | Gemini generateContent
  ▼
local-gateway (Rust, axum) — 4 ingress handlers
  │  check_gateway_key → try_slot → translate dialect → canonical `chat` Value
  ▼
core.bridge.dispatch(BridgeRequest { kind: "chat", body, headers })
  ▼
webview router-core → egress-gateway → provider
```

Facts that fix the design:

- **All four dialects converge on a canonical OpenAI-shaped `chat` body before dispatch.** Verified
  in `gateway_anthropic.rs:27-28` (folds Anthropic `system` into a `messages[0].role="system"` entry)
  and dispatched at `:187`. The OpenAI handler dispatches its own `req`. So there is **one
  canonical shape to inject into**, at four call sites.
- **The Rust gateway has no store on the chat path.** `chat_h` takes `State<Arc<GatewayCore>>`;
  `Arc<Store>` lives on `GatewayState` (added for tool-call recording) and `GatewayCore` does not
  carry one. Threading the store into the core is change #1.
- **`forwarded_headers` is an allowlist of six headers** (`gateway.rs:1204`). Any `AIP-*` header is
  currently dropped before it reaches the bridge. Scoping metadata must be read in Rust and
  consumed there — never forwarded upstream.
- **Auth discards identity.** `check_gateway_key` returns only matched/not-matched; it loops app keys
  with constant-time compare and keeps no id. Per-agent scoping needs a principal resolved from the
  presented key.
- **Context window is unknown to Rust.** The catalog is TS-side. Without it, budgeting has to use a
  model→window cache table or a conservative default.

**Injection point: a single `inject_context()` called by each of the four handlers after dialect
translation and before `bridge.dispatch`.** Not in the webview — that would add an IPC round-trip per
request for data that already lives in Rust.

---

## 2. Architecture outline

```
                         ┌─────────────────────── request path (sync, no model) ───────────┐
 HTTP ingress (4 dialects)
   │
   ├─(1) PrincipalResolver ──── presented key → { user, agent, app_key_id }   [R4 keys]
   │
   ├─(2) ScopeResolver ──────── headers / metadata.aip / workspace root → scope key
   │
   ├─(3) BudgetPlanner ──────── window − reserve − prompt_in → mem_budget
   │
   ├─(4) Retriever ──────────── memory::recall (BM25) + live-context read → candidates
   │
   ├─(5) Ranker + Trimmer ───── scope boost → pinned → band/recency/layer → greedy fill
   │
   ├─(6) Composer ───────────── canonical system block, dialect-safe
   │
   └─(7) Auditor ────────────── one row + response headers; never fails the request
                         └────────────────────────────────────────────────────────────────┘

                         ┌─────────────────────── capture path (async, off-path) ──────────┐
 BridgeMsg::Done → memory_pending (queue) ──drained by webview──> distilTurn → memory::capture
                         └────────────────────────────────────────────────────────────────┘
```

Seven components, all host-side except the drain:

| # | Component | Lives in | Failure mode |
|---|---|---|---|
| 1 | `PrincipalResolver` | `gateway.rs` | fall back to `agent="unknown"`, proceed |
| 2 | `ScopeResolver` | new `context_scope.rs` | fall back to `default` scope |
| 3 | `BudgetPlanner` | new `context_scope.rs` | skip injection if below floor |
| 4 | `Retriever` | wraps `memory::recall` | empty candidate set, proceed |
| 5 | `Ranker`/`Trimmer` | new `context_scope.rs` | empty block, proceed |
| 6 | `Composer` | new `context_scope.rs` | empty block, proceed |
| 7 | `Auditor` | new table + response headers | swallow, log |

**Invariant: no component on the request path may return an error to the client.** A recall failure
degrades to "no memory block", never a 5xx. Same rule as `BufferedRecorder.flush()`.

---

## 3. Data schemas

### 3.1 Extend `memories` with scoping (migration `0008`)

`memories` today has only `session_id` and `subject` — no project, agent, or user dimension.

```sql
ALTER TABLE memories ADD COLUMN scope_user    TEXT NOT NULL DEFAULT 'local';
ALTER TABLE memories ADD COLUMN scope_project TEXT;
ALTER TABLE memories ADD COLUMN scope_agent   TEXT;
ALTER TABLE memories ADD COLUMN origin        TEXT NOT NULL DEFAULT 'assistant'
  CHECK (origin IN ('assistant','gateway','manual'));
ALTER TABLE memories ADD COLUMN salience      REAL NOT NULL DEFAULT 1.0;
ALTER TABLE memories ADD COLUMN superseded_at INTEGER;
ALTER TABLE memories ADD COLUMN stale_at      INTEGER;

CREATE INDEX idx_memories_scope ON memories(scope_user, scope_project, scope_agent, updated_at DESC);
CREATE INDEX idx_memories_live  ON memories(superseded_at, stale_at) WHERE superseded_at IS NULL;
```

Scope semantics — **revised after external review, and this was the single most-agreed problem.**
`NULL` does **not** mean global. Three reviewers independently identified nullable-means-global as a
contamination engine, and the argument is decisive: the whole reason `metadata.aip` exists is that
most IDEs *cannot* set headers, so the common case falls through to defaults → `project = NULL` →
injected as global. Capture then writes repo A's context into global and injection serves it into
repo B, and it compounds the more you use it.

Therefore:

- `NULL` project = **capture-only, never injected.** Only rows with an explicit project may be
  recalled, except for rows explicitly marked global.
- **Global is an explicit opt-in column** (`scope_global = 1`), not the absence of a value.
- Unresolvable project → inject **pinned items only**, nothing else.
- Contradictory identity signals are **rejected**, not silently resolved by precedence.

The FTS5 external-content triggers already key on `text` only, so adding columns does not disturb
the index — but any new write path must still go through `capture`/`update`, never raw SQL, or the
index drifts. (This is already a recorded rule; re-stating it because this migration adds writers.)

### 3.2 Live context — session turns (migration `0008`)

Deliberately **not** `context_nodes`: that table is the Context screen's display graph, has a closed
four-kind node set, no scoping, and no retention. Pushing 10k verbatim agent turns into it would
destroy the screen and the `graph(limit)` window.

```sql
CREATE TABLE router_sessions (
  id           TEXT PRIMARY KEY,
  scope_user   TEXT NOT NULL DEFAULT 'local',
  scope_project TEXT,
  scope_agent  TEXT,
  title        TEXT,
  turn_count   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_router_sessions_seen ON router_sessions(last_seen_at DESC);

-- Bounded ring per session. Pruned by count and by age, never grows without limit.
CREATE TABLE session_turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES router_sessions(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  text        TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE INDEX idx_session_turns ON session_turns(session_id, seq DESC);

-- Live context the agent pushes: open files, cursor position, current plan.
CREATE TABLE session_state (
  session_id  TEXT PRIMARY KEY REFERENCES router_sessions(id) ON DELETE CASCADE,
  open_files  TEXT,          -- JSON array, capped
  extra_json  TEXT,          -- JSON object, capped
  updated_at  INTEGER NOT NULL
);
```

### 3.3 Async capture queue (migration `0008`)

```sql
CREATE TABLE memory_pending (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT,
  scope_user  TEXT NOT NULL DEFAULT 'local',
  scope_project TEXT,
  scope_agent TEXT,
  user_text   TEXT NOT NULL,
  asst_text   TEXT,
  model       TEXT,
  status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','processing','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_memory_pending ON memory_pending(status, id);
```

The gateway writes here at `BridgeMsg::Done`. The webview drains it and calls the existing
`distilTurn` → `memory::capture_batch`. No model call on the request path, and a crashed webview only
delays learning — it never breaks a request.

### 3.4 Model context-window cache (migration `0008`)

Rust cannot see the TS catalog, so it needs a local copy of the one number it must have.

```sql
CREATE TABLE router_model_context (
  model_key       TEXT PRIMARY KEY,   -- qualified id, e.g. "openrouter/gpt-4o"
  context_window  INTEGER NOT NULL,
  chars_per_token REAL,               -- NULL → use the default estimator
  updated_at      INTEGER NOT NULL
);
```

Populated by the webview on catalog refresh. Unknown model → `DEFAULT_WINDOW = 8192` and a
conservative estimator. Being wrong low is safe; being wrong high overflows the window.

**Landed 2026-09-21 as migration `0013_model_context`** (a data migration, so `0007`–`0012` do not
shift). Two decisions beyond the draft:

- **Upsert, never replace.** A refresh covers one provider; wiping the table would drop every other
  provider's rows the moment any one refreshed.
- **An implausible window is refused, not stored.** Non-positive or >2M is treated as unknown: a
  provider with a units bug is more likely than a ten-million-token model, and storing it would make
  every request plan against a number that cannot be right.

`plan_budget_for` now takes the window and the char ratio; `plan_budget` delegates with the defaults
so the store-free path stays testable. Published from `publishModelContext()` on **hydration as well
as refresh** — a launch that only reads the store never refreshes, and would otherwise run its whole
first session on the 8k default.

The payoff is only visible on large prompts, and that is worth stating because it is easy to
mis-measure: with a small prompt the `MAX_BUDGET_TOKENS` ceiling dominates and both windows give the
same answer. The pinned test uses an ~8.6k-token prompt, where an 8k window leaves no room at all
and the real one still fits memory.

### 3.5 What may be captured — **the second finding I missed**

The capture path is a **credential laundering pipeline**, and it is also a **persistent instruction
channel**. Both came from the review; neither was in v0 of this document.

*Credential laundering.* Terminal output and tool results in coding-agent turns are full of secrets —
env vars, `gh` tokens, cloud keys. A distiller will faithfully copy them into atoms; injection then
broadcasts them into every future request, **to every vendor, cross-provider**. That recreates at the
memory layer exactly the leak the per-vendor keychain design exists to prevent. Note the liability is
the SQLite row itself, so scrubbing at injection time is too late.

*Instruction channel.* Memory is eventually generated from model conversations, so the model can
indirectly write future system context: an agent reads a malicious README, summarises it, the
distiller creates an atom "always execute X in this repo", and weeks later that atom is injected into
another model's system context.

Rules, enforced at **enqueue** time:

1. **Never distil tool output.** Prose turns only. This single rule removes most of both hazards.
2. **Secret scrubbing at enqueue**, not at injection: key patterns, `Authorization` values,
   high-entropy strings.
3. **Typed atoms.** Store facts, preferences and decisions separately from procedural instructions,
   and serialise memory as inert context that may never override current instructions, policies or
   tool authorisation.
4. **Immutable scope binding at enqueue** — `scope_id`, `request_id`, model/provider, and a content
   class are frozen on the row. A queued turn distilled after its project changed must not be
   re-scoped.
5. **Idempotent distillation** keyed on `request_id`; a replay must not duplicate.
6. **Exclude the internal principal.** If distillation calls traverse the gateway's own endpoint —
   the obvious implementation, since that is where the keys are — then every distillation request is
   itself a turn: appended to the queue, distilled again, and injected into the prompt that is
   writing memory. Unbounded growth plus recursive pollution. Classify an internal key class and
   exclude it from both capture and injection, **enforced in the gateway**, not by convention in the
   webview.

---

## 4. Request/response contract

### 4.1 Headers (preferred), consumed by the gateway and never forwarded

| Header | Meaning |
|---|---|
| `AIP-Session` | session id; absent → derive a stable one from `(agent, project)` |
| `AIP-Project` | project scope; absent → workspace-root hash, else `NULL` |
| `AIP-Agent` | agent identity; absent → app-key label, else `unknown` |
| `AIP-User` | reserved; default `local` |
| `AIP-Memory` | `on` \| `off` \| `read` \| `write` per request |
| `AIP-Memory-Budget` | token override, clamped to the global cap |
| `AIP-Context` | JSON live context pushed by the agent |
| `AIP-Open-Files` | comma-separated paths (shorthand for the common case) |

### 4.2 Body fallback — **required**, not optional

Most IDEs cannot set headers. Anything they can put in the JSON body they can use:

```jsonc
{
  "model": "openrouter/gpt-4o",
  "messages": [ … ],
  "user": "cursor",                    // reused as agent hint when AIP-Agent is absent
  "metadata": {
    "aip": {
      "session": "s-123",
      "project": "ai-provider-router",
      "agent": "cursor",
      "memory": "on",
      "budget": 1200,
      "open_files": ["src/main.rs"],
      "context": { "task": "fix the SSE framing" }
    }
  }
}
```

Resolution order per dimension: **header → `metadata.aip` → `user` field (agent only) → app-key
label (agent only) → workspace root (project only) → unresolved.**

**`metadata.aip` must be stripped from the body before dispatch.** It is a gateway-invented field;
the vendor does not know it and at least one major dialect rejects unknown body fields outright.
Parse it, consume it, delete it. This is a guaranteed day-one bug if skipped, and it is the kind
that only shows up on one of four ingress paths.

### 4.3 Response headers

Cut from v1 per review (two reviewers independently): the full telemetry set (`-Injected` / `-Tokens`
/ `-Items` / `-Degraded` as separate headers) is replaced by one compact status header. Every extra
header is a string build on the hot path and no caller reads four of them.

```
AIP-Memory:       injected=1;items=7;tokens=412
AIP-Memory-Scope: user=local;project=ai-provider-router;agent=cursor
```

The scope header is always present, including on skips: "why didn't the model know X" is usually
"the scope resolved to something you did not expect", which is invisible if the header only appears
alongside an injection. Unresolved dimensions render as `-` so the header shape never shifts between
requests.

`AIP-Memory` when nothing was injected: `injected=0;reason=below_floor`.

---

## 5. Retrieval, ranking, and trimming within budget

### 5.1 Budget

```
window    = router_model_context[model] ?? 8192
reserve   = max_tokens ?? per_model_default(window)   // from §3.4, not a flat 20%
          + tool_schema_tokens + 256                  // safety
prompt_in = estimate(client messages)
avail     = window - reserve - prompt_in
budget    = min(avail * 0.25, MEM_MAX=1500)
```

**Revised after review.** All three reviewers attacked the 10% / 120-floor pair. Adopted:

- **25% of headroom, not 10%, with the same 1500 ceiling.** 10% of an 8k window and 10% of a 200k
  window are not the same behavioural cost; a flat percentage under-allocates badly on large windows
  while the ceiling already protects the top end.
- **Reserve uses the client's declared `max_tokens` when present**, not a flat 20% of window. A
  client asking for 8192 output against a small-window model is exactly the case the heuristic got
  wrong.
- **No blanket floor.** The 120-token floor was inverted: a single pinned 80-token atom
  ("this repo uses X, never do Y") is precisely what should survive a tight budget, and the floor
  dropped it. The floor now applies to **unpinned content only** — pinned always injects.
- **Budget alone never triggers injection.** At least one candidate must clear a minimum relevance
  threshold. Do not manufacture a memory block merely because room exists.
- **Add `AIP-Memory-Budget-Reason`** so a caller can audit why it got what it got.
- **Add retry-without-memory on an upstream context-length error**, and log it. An undercounted
  `prompt_in` currently surfaces as a vendor 400 with no recovery path.

**Token estimation.** No tokenizer in Rust and adding one is a new dependency for a number that only
needs to be safe. Use `ceil(chars / 3.5)`, which over-estimates typical prose and JSON —
over-estimating under-injects, which is the correct failure direction. `chars_per_token` in
§3.4 exists so a real value can replace the guess per model later.

### 5.2 Ranking

**Build the query, do not use the raw prompt.** Coding-agent turns are "run it again", "fix the
failing test", "continue". BM25 over that is noise, so recency and pins would dominate and retrieval
becomes decorative. Extract identifiers, file paths and backticked symbols from the last user message
plus any tool calls (regex is sufficient) and query those. Two supporting changes:

- FTS5's default `unicode61` tokenizer mangles `snake_case` and dotted symbols. Add a **trigram
  tokenizer** on a dedicated `symbols` column and query that column for identifiers.
- Keep BM25 for prose atoms; do not replace it.

Then rank, reusing `memory::recall`'s existing rerank (relevance band → recency → distillation layer)
with two terms in front:

1. **Pinned first** — always, budget permitting (the operator said these must be visible).
2. **Scope specificity** — exact `(user, project, agent)` > `(user, project)` > `(user)` > global.
   A project fact should outrank a vaguer global fact at comparable relevance.
3. Then the existing band/recency/layer order unchanged.

Note the existing order is already **recency before layer** within a relevance band, which is the
right way round: a recent project-specific L1 atom should beat an old generic L3 fact.

**Deterministic tie-breaking is mandatory, not cosmetic** — see §5.5.

Excluded from every recall: `superseded_at IS NOT NULL`, `stale_at IS NOT NULL`, and L0 unless the
scope has L0 explicitly enabled.

### 5.3 Trimming

Greedy fill in rank order; an item that does not fit is skipped and the next is tried (a near-fit
item should not block a smaller one that would fit). Never split a memory mid-sentence — drop whole
items, with one exception: the last item may be clipped to the remaining budget with an explicit
`…` marker. Precedence when the budget is tight:

```
L3 core  >  pinned  >  project facts  >  live context (open files)  >  L2  >  L1  >  recent turns  >  L0
```

### 5.4 Idempotency

Injection is **wire-only** — the gateway mutates the body it forwards, never the client's stored
history. So a client that keeps its own transcript does not accumulate injected blocks across turns.
One real hazard remains: if the agent replays its history *and* the router injects recent turns from
`session_turns`, the last turns appear twice. Rule: hash the last N user turns of the incoming
request and drop any injected turn whose hash is already present.

### 5.5 Prompt-cache stability — **the finding I missed**

Coding agents are the one workload deliberately architected around provider prompt caching (Claude
Code sets cache breakpoints; Cursor depends on cached prefixes). A memory block that is re-ranked and
re-composed per request sits at system position 0 — so **every mutation invalidates the entire cached
prefix.** Every request then pays full input price plus the cache-write premium, and TTFT rises. The
user sees bills jump several-fold on cache-heavy sessions and blames the vendor.

Two fixes, both cheap:

1. **Deterministic ordering.** Break every tie on a stable key (`memory.id`), never on `ts` or on
   hash-map iteration order.
2. **Freeze the composed block per `(scope, session)` for a TTL** (say 10 minutes) rather than
   re-ranking every request. Injection still happens every request; the *bytes* do not change, so the
   prefix caches.

This is arguably the highest-value item in the whole review: it halves token spend via cache hits,
which matters more than any ranking refinement.

**Landed 2026-09-21.** Five decisions beyond the draft:

- **The order is made total in two places, not one.** `m.id` is now the last key of the SQL
  `ORDER BY` *and* the last key of `rerank`. Both are needed: `rerank` can only reorder what it is
  shown, and `LIMIT` truncates the shortlist before that — so which rows survive to be ranked at all
  was also plan-dependent. The `rerank` half is proved in isolation by
  `rerank_breaks_ties_on_id`, which drives the function with a deliberately shuffled input.
- **Only the memory block is frozen; live context is not.** Context carries the latest turns, so
  freezing it would break the thing Phase 3 exists for. It is concatenated *after* the memory block,
  which is what makes the freeze worth anything: a provider caches the longest matching prefix, so
  the stable bytes have to be first. A test asserts that ordering — it is load-bearing, not cosmetic.
- **An empty result is never frozen.** It would pin "nothing to recall" for the whole TTL, and the
  first atom anyone distilled in a new project would stay invisible for ten minutes. Recall on an
  empty corpus is cheap; losing the first atom is not.
- **A frozen block that no longer fits the budget is re-composed, not served.** Budgets shrink as
  prompts grow. Re-composing costs one cache miss; shipping a block too large for the request is a
  correctness failure.
- **Invalidation is TTL-only, and that is a real trade.** New atoms are distilled by the webview, so
  the host has no hook to invalidate on write — a newly scoped atom can wait up to ten minutes to
  appear. The memory toggle does clear the map, because a block frozen before the operator switched
  memory off would make the toggle feel broken on the way back on.

The freeze lives on `GatewayCore` (`memory_freeze`), capped at 256 entries with oldest-out eviction
and swept on the way in — there is no background task and a request is the only moment the map is
touched. The TTL is a settable field for the same reason `first_msg_timeout` is: ten minutes is not
something a test can wait for, and `Duration::ZERO` proves expiry deterministically.

### 5.6 Hard deadline on the memory path — ✅ **landed 2026-09-21**

"Degrades gracefully" is not the same as "free". A synchronous BM25 query plus ranking plus
serialisation sits on the critical path, and under concurrent IDE traffic SQLite contention becomes
tail latency. Impose an explicit **10–20 ms deadline on the entire memory path**; if it does not
finish, dispatch without memory and log it. Never let a graph write or a lock delay the model request.
Audit rows are written asynchronously for the same reason.

Implementation: `Deadline` in `context_scope.rs`, started before the first byte of work and set to
`MEMORY_DEADLINE = 15ms`. Three decisions beyond the draft:

- **Checks sit between stages, not inside them.** The expensive steps are single SQLite calls that
  cannot be interrupted once started, so what the deadline really bounds is *how many of them one
  request may pay for* — which is precisely the contention case. Three boundaries: before recall
  (covers parse + the principal and window lookups), before live context (covers recall + rank +
  trim + compose), before the body is mutated.
- **A miss is abandoned whole, not trimmed.** There is no partial injection: the request goes out
  as it arrived, with `AIP-Memory: injected=0;reason=deadline`. Shipping a block that was cut short
  by the clock would make the failure invisible in the one place it is observable.
- **A miss aborts the writes, not just the read.** Live context is five reads and writes on the same
  connection — the writes are the thing contending for the lock, so a deadline that dropped the read
  and still let them through would protect nothing. The acceptance test asserts this from the
  outside: an aborted request records no turn, so the *next* request finds nothing to carry.
  Falsified two ways — disabling the deadline entirely breaks the reason assertion, disabling only
  the two pre-write guards breaks the "wrote nothing" assertion and leaves the reason intact.

Logged on miss at `warn` with `elapsed_ms`, `budget_ms`, the stage that missed and the resolved
scope; without the stage name, "recall got slow" and "live context is fighting for the write lock"
would be indistinguishable, and they have different fixes.

Out of scope by deliberate choice: the capture path. `finish_capture` enqueues *after* the model has
answered, so it cannot delay the request; it is already off the critical path.

---

## 6. Scoping, retention, invalidation, conflict resolution

### 6.1 Scoping

Three dimensions, all nullable-means-global: `user` × `project` × `agent`. A memory written by
Cursor in project A is invisible to Claude Code in project B, and visible to Cursor in project A.
Global memories (user preferences, L3 core) have `project`/`agent` NULL and are visible everywhere.

**Containment rule:** a request may only read memories whose non-null dimensions all match. Nothing
crosses a project boundary implicitly — ever, including for L3.

### 6.2 Retention

| Layer | Policy |
|---|---|
| L0 raw | TTL 30 days, ring-capped at 200 turns/session; **opt-in for injection** |
| L1 atoms | decay with the existing 30-day half-life; prune below a recency floor |
| L2 scenarios | same decay; prune on subject collapse |
| L3 core | **never auto-pruned** — explicit forget only |
| `session_turns` | ring of 200/session, TTL 14 days |
| `memory_pending` | drop `done` rows after 7 days; `failed` retried 3× then dropped |

Per-scope caps on rows and bytes; eviction order is lowest `(salience × recency × relevance)`,
never pinned, never L3. Pruning runs on app idle, never on the request path.

### 6.3 Invalidation

- **Explicit:** `AIP-Memory-Forget: <id>` header, or a host command from the Memory screen.
- **Stale:** a memory whose subject references a file or symbol that no longer resolves gets
  `stale_at` set by an idle validator, and drops out of recall without being deleted.
- **Scope switch:** changing project changes the scope key; nothing migrates, nothing leaks.
- **Toggle off:** `memory_enabled = false` disables read *and* write, host-side, and the response
  says so.

### 6.4 Conflict resolution

Ordered, first match wins:

1. **Pinned means retention and eligibility, not truth precedence.** Revised after review: making
   pinned outrank everything lets a pinned fact that has since become obsolete defeat every newer
   correction — a stale pin poisons retrieval permanently. Pinned now guarantees *survival* (never
   auto-pruned, always injected) while an explicit, newer correction can still supersede it, with the
   old record retained for audit.
2. **L3 beats lower layers.** A core fact is not overwritten by a session atom.
3. **Newer supersedes older within a layer** — the old row keeps `superseded_at` rather than being
   deleted, so a reversal is recoverable and the Context graph's edges stay valid.
4. **At equal layer and age, higher salience wins.**
5. **Direct contradiction of a pinned/L3 fact is never auto-resolved** — both stay, the newer is
   marked, and the conflict is surfaced in the Memory screen for a human.

`memory.rs` already refreshes rather than duplicates on re-capture; this adds the cross-row rules on
top of that behaviour, it does not replace it.

---

## 7. Model-agnostic injection and graceful degradation

All target models lack native memory — that is the premise. The real variability is elsewhere:

| Situation | Handling |
|---|---|
| System-role not supported / stripped | fold the block into the first user turn behind a delimiter |
| Anthropic ingress | already folded to `system` by the handler; injection happens after that fold |
| Gemini ingress | `systemInstruction` translated before dispatch; same downstream path |
| Window too small for the floor | skip injection, `AIP-Memory-Degraded: below_floor` |
| Recall throws / DB locked | log + audit, inject nothing, **never** fail the request |
| Provider rejects the body | existing rotation/failover applies unchanged |
| Unknown model | `DEFAULT_WINDOW=8192`, conservative estimator |
| Client sends no scoping metadata | `default` scope; L3-only injection |

The block itself is vendor-neutral prose with no tool markup and no dialect-specific syntax:

```
<memory>
Core preferences (always true):
- Prefers terse replies.
Project facts (ai-provider-router):
- Gateway binds 127.0.0.1 only.
Live context:
- Open: src-tauri/src/gateway.rs
</memory>
```

Structured enough to be ignorable, plain enough that no vendor chokes on it.

---

## 8. Gateway-side changes required

| # | File | Change |
|---|---|---|
| 1 | `gateway.rs` | add `store: Arc<Store>` to `GatewayCore` (or widen the axum state); add `memory_enabled: AtomicBool` + `memory_read/write` toggles mirroring `tools_enabled` |
| 2 | `gateway.rs` | extend `check_gateway_key` to return a **principal** (`app_key_id` / label) — currently identity is discarded after constant-time compare |
| 3 | `gateway.rs` | add `AIP-*` headers to the *consumed* set; keep `forwarded_headers` allowlist unchanged so nothing leaks upstream |
| 4 | `gateway_handlers.rs`, `gateway_anthropic.rs`, `gateway_responses.rs`, `gateway_gemini.rs` | call `inject_context(&core, &mut body, &headers, &principal)` after dialect translation, before `bridge.dispatch` |
| 5 | new `context_scope.rs` | ScopeResolver, BudgetPlanner, Retriever, Ranker, Trimmer, Composer |
| 6 | `gateway_handlers.rs` (+ 3 dialects) | at `BridgeMsg::Done`, append to `memory_pending` with the assembled assistant text |
| 7 | `store.rs` | migration `0008`, bump the hardcoded `schema_version`, update the migration-count assertion |
| 8 | `commands.rs` | `memory_enabled` toggle, scope inspector, `memory_pending` drain/flush commands |
| 9 | `src/lib/memory/engine.ts` | drain `memory_pending` → `distilTurn` → `capture_batch`; scope-aware `recallContext` |
| 10 | `src/screens/` | Memory screen: scope filter, conflicts, stale list; Gateway screen: memory toggle + budget slider |
| 11 | tests | `context_scope.rs` unit tests (budget, scope containment, trimming, degradation); gateway integration test asserting injection on all four dialects |

Migration rule from project memory, restated because it bites here: a migration is
`MIGRATIONS`/`DATA_MIGRATIONS` **+ bump the hardcoded `schema_version`** **+ update the count
assertion**, and rewind tests delete `WHERE version >= N`.

---

## 9. Phased implementation

**Phase 0 — decide the toggle default.** Off. One setting, host-side. Nothing ships without it.

**Phase 1 — plumbing, no behaviour.** ✅ **Landed 2026-09-20.** Store on `GatewayCore`, header +
`metadata.aip` parsing, `inject_context()` at all four dispatch sites, stripping `metadata.aip` and
otherwise skipping. Tests for scope resolution, the strip and the mode/budget parsers.
`cargo test --lib` 280 (13 new). Migration `0008` and per-app-key principal resolution deferred —
see the note below.

> **Correction found while implementing.** §1 claims "all four dialects converge on a canonical body,
> so there is *one* shape to inject into." That is true for **injection** and false for **parsing**:
> `to_chat_body` and its siblings rebuild the request from scratch and drop unknown fields, so
> `metadata.aip` never survives translation. Reading the contract from the canonical body would have
> silently ignored the body fallback for exactly the header-less clients it exists to serve.
> `inject_context` therefore takes `source: Option<&Value>` (the original ingress body) alongside
> `body: &mut Value` (the canonical one): `None` on the OpenAI path, `Some(&req)` on the other three.

> **Deferred from Phase 1, landed 2026-09-21.** Resolving an `app_key_id` principal.
> `vault_app_key_provider` returned secrets only, so mapping a presented key back to its id meant
> N keychain reads per request; it needed a cached id→secret map before it belonged on the request
> path. Four decisions, in the order they were forced:
>
> - **The provider now returns `{id, secret}`.** One keychain pass yields both, so identity costs
>   nothing extra over auth. A second call asking only "which id was that?" would have doubled the
>   per-request cost.
> - **The memo is keyed on the active-id set, not on a TTL.** The set is re-read from SQLite every
>   request (one indexed scan, no keychain), so create and revoke still take effect on the very
>   next request — the contract `gateway_app_key_create` documents. A bare TTL cache would have
>   kept a revoked key authenticating for the rest of its window: a security regression dressed as
>   an optimisation. The TTL (60s) survives only as a backstop for the case SQLite cannot see — a
>   secret removed from the keychain under an active row.
> - **No store ⇒ no caching.** The store is the only thing that can validate the memo. Without it
>   there is no authoritative id set, so the provider is read every time. This is what preserves
>   the pre-existing `r4_revoked_app_key_rejected_immediately` contract, whose harness mutates the
>   provider directly; a cache would have masked it.
> - **Two identities, either can deny.** Not one winner. If the `AIP-Agent` label alone decided, a
>   client holding a denied key would get memory back by sending an unlisted label; if the key
>   alone decided, a client would escape a denial on its label by dropping the header. Absence
>   still inherits, so an unlisted second identity adds nothing.
>
> The principal name is `key:<id>`, namespaced because an `AIP-Agent` value is free text a client
> chooses for itself while an id is assigned by this app. `principal::list` offers the active keys
> so the operator can find the name — `key:<id>` is not guessable and appears nowhere else.
> Resolution is skipped entirely when the master toggle is off, so "off" still costs no keychain
> read. The scan is constant-time over every candidate with no early break, for the same reason
> auth's loop has none.
>
> **Follow-up, 2026-09-21: the master key gets a name too.** Landing the app-key principal exposed
> an asymmetry. `key:<id>` covers per-app keys, but the master key resolved to `None` — so traffic
> presenting it with no `AIP-Agent` label had *no* identity at all, and absence inherits. An
> operator who had disabled every other caller would still have been serving memory to the master
> key, with no way to say otherwise. That is backwards: the master key is the one most operators
> actually hand out.
>
> It now resolves to `key:master`, offered by `principal::list` like any app key. Three properties
> hold. It cannot collide with an app key, because ids are `ak-<hex>` and `master` is not one a
> client can be issued. It costs nothing, because the master key is already cached — the check is a
> comparison against a value already in memory, never a keychain read. And denial stays per-caller,
> not global: a policy on `key:master` leaves every `key:ak-…` untouched, and is enforced on the
> write path as well as the read one.

**Phase 2 — read path. ✅ Landed 2026-09-21.** Recall + rank + trim + compose, behind the toggle,
L1/L2/L3 only. Compact response headers (`AIP-Memory` / `AIP-Memory-Scope`). Budget boundary tests.
The `skip` helper ensures every outcome, including skips, carries the resolved scope so mis-scope is
always answerable without guesswork. `forwarded_headers` is an allowlist-only construction; no
`AIP-*` header can leak upstream.

**Phase 3 — live context. ✅ Landed 2026-09-21.** `router_sessions`, `session_turns`,
`session_state` (migration `0010_live_context`, numbered as a data migration so the existing
`0007`–`0009` versions do not shift). Dedupe against incoming history (§5.4) implemented and
tested at both the unit and the request level.

Two implementation decisions worth recording, both stricter than the draft:

- **Only the tail of a request is recorded, not the whole transcript.** A coding agent replays its
  full history every turn; storing all of it writes ~50 rows per request and fills the ring with
  duplicates of turns already stored. Last assistant turn plus last user turn, two rows maximum,
  skipped when identical to what is already newest.
- **`system` and `tool` turns are never recorded.** `system` is the client's own instructions; tool
  output is the credential-laundering vector from §3.5. Neither belongs in a table whose contents
  are injected into another vendor's request.

Recording is gated on the memory toggle, so with memory off the gateway performs no writes at all.
Pruning is exposed as `gateway_prune_live_context`; scheduling it on host idle is Phase 5.

**Phase 4 — write path, async. ✅ Landed 2026-09-21.** `memory_pending` (migration
`0011_capture_queue`) + webview drain, with all six §3.5 rules enforced at enqueue — never at read
time, because the liability is the stored row. Enqueue is a single INSERT on the thread that has
already decided the response; distillation happens off-path in `src/lib/memory/drain.ts`, so a slow
or offline model delays learning and nothing else.

Three decisions worth recording:

- **Nothing the drain writes is auto-scoped.** A queue row carries the request's scope, but the L1
  atoms distilled from it are stored capture-only. Applying the request's scope automatically would
  put an agent's own traffic into the injected block with no review step — the exact objection that
  made §4b necessary. Binding stays a deliberate act in the Memory screen.
- **The drain reuses the chat path's prompt, not a copy of it.** `distillAndStore` is shared by
  `distilTurn` and `distilExchange`; a second `DISTIL_PROMPT` would drift, and drift here is
  invisible because it only produces slightly worse atoms.
- **A failing row is released, never completed.** `distilExchange` throws where `distilTurn`
  returns `[]`, precisely so the queue can tell "distilled, nothing durable" from "the call failed".
  The host retires a row after three attempts, so a turn that will not distil cannot wedge it.

Restart safety is pinned by test rather than by argument: a batch claimed and then abandoned is
re-queued by `requeue_stale` (10-minute claim TTL), and a restart distils each row exactly once.
`memory_pending` retention is a purge of `done`/`failed` rows after 7 days — never `queued` or
`processing`, so a purge cannot lose work. The master toggle is now reachable from the UI
(`gateway_set_memory_enabled`); it ships off, and with it off the gateway still performs no reads
and no writes.

**Phase 4b — review surface. ✅ Landed 2026-09-21.** Every atom is born capture-only and becomes
injectable only when someone scopes it in the Memory screen; an agent's traffic never reaches the
injected block on its own say-so.

**Phase 4a — per-principal toggle. ✅ Landed 2026-09-21.** `memory_principal_policy` (migration
`0012_principal_policy`), enforced on both the read path (`inject_context`) and the write path
(`prepare_capture`). Precedence is operator over client:

1. Master switch off → nothing happens for anyone. No row can override it.
2. No row → **inherit**. Default-deny would need a row for every IDE that ever connected before
   memory worked for anyone — silence would mean "no", and silence is what you get by default.
3. An explicit row beats the client's own `AIP-Memory: on`.

Denying a principal denies both directions: it is not injected *and* its turns are not recorded, so
"off" cannot quietly mean "still learning from you".

Identity is two strings, either of which may deny: the `AIP-Agent` label, and the key that
authenticated the request — `key:<id>` for a per-app key, `key:master` for the master key. (The
app-key half was deferred from Phase 1 for a cached id→secret map; it landed 2026-09-21, and the
master key was named the same day for the reason given above.)

**Cut from v1** (two reviewers independently proposed the same list): drop L2 scenarios — nothing in
the recall path consumes it and it is pure distillation cost; drop the client `AIP-Memory-Budget`
override (the gateway owns the safety budget); keep one compact status/debug ID instead of the full
response-header telemetry set.

**Phase 5 — retention and conflict UI. ✅ Pruning landed 2026-09-21; stale detection cut.**

*Pruning (landed).* `memory::prune` — L0 TTL 30 days plus a 200-row ring **per session**, L1/L2
dropped once their recency decays below `PRUNE_FLOOR` (~4.3 half-lives, i.e. roughly four months
without re-confirmation). Two absolute exemptions: **pinned** and **L3**, because both survive on
the operator's say-so rather than on recency. The cutoff is derived from `PRUNE_FLOOR` and
`RECENCY_HALF_LIFE_DAYS` rather than written down, so moving the half-life moves it.

Scheduling is `src/lib/memory/retention.ts`, started from `App.tsx` alongside the drain:

- **Runs off the request path**, which is the design's actual requirement. There is no idle *signal*
  available to a Tauri webview, so "idle" is a 30-minute timer plus one pass at start; inventing an
  idle detector to gate a bounded `DELETE` would cost more than it saves.
- **Gated on the master toggle.** With memory off, neither table is written either — live context
  is only recorded past the mode gate — so there is nothing to prune, and the off-by-default
  guarantee has to include deletes. A failed toggle read reads as *off*.
- **One pass at a time.** A prune is a table scan; two overlapping passes would each re-scan what
  the other is deleting.

`gateway_prune_live_context` had existed since Phase 3 and was never called from anywhere — both
tables grew without limit in practice, which is the actual defect this closes.

*Stale detection (§6.3) — cut, with a reason.* The rule is "a memory whose subject references a
file or symbol that no longer resolves". Subjects here are **not** file or symbol references: the
distillation prompt asks for "the shortest useful label" (2–4 words — `router work`, `writing
style`), so there is nothing that could stop resolving. Building a validator for a subject shape
the system never produces would be speculative code that can never fire. Revisit only if subjects
become real references.

*Conflict surfacing (§6.4) — landed 2026-09-21.* Migration `0014_superseded_at` (schema_version
14). Four decisions:

- **A superseded row is kept, not deleted** (§6.4.3), and leaves recall immediately — `recall_inner`
  and `session_atoms` filter on `superseded_at IS NULL`, while `list` deliberately does not, so the
  Memory screen can show and reverse it. `stats.injectable` uses the same predicate, because a count
  that disagrees with recall makes the panel untrustworthy.
- **`supersede` refuses pinned and L3** (§6.4.5). That refusal is what makes the conflict list mean
  anything: if the layer could quietly replace a pin, a stale pin would poison retrieval and nothing
  would ever surface. `Err` for a policy refusal, `Ok(false)` for "nothing to do" — a missing row and
  a self-supersession are not errors.
- **`conflicts` is deliberately narrow.** Only a pinned/L3 row versus a newer live row on the *same
  subject, in the same project*, with different text. Detecting real contradiction needs a model,
  and a broad "these might disagree" list is noise — so this surfaces exactly the case §6.4.1 exists
  to prevent, and nothing else.
- **The Memory screen offers two honest answers**: "the newer one is right" (unpin, then supersede —
  the host would refuse otherwise) and "the pin is still right" (forget the newer atom). For an L3
  held row the first is disabled with the reason, because a core fact is replaced by forgetting it.

**Phase 6 — adopt across dialects. ✅ Landed 2026-09-21.** Five tests in `gateway_tests.rs`, driving
real HTTP through the server against a synthetic bridge that now records what was dispatched:

- All four ingress dialects (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`,
  `/v1beta/models/*:generateContent`) carry the recalled block into the body handed to the worker,
  and leak no `AIP-*` header. Asserted on the **dispatched** body, not the ingress one — every
  dialect is translated twice, and a test that checked the request as it arrived would prove nothing.
- One test sends every `AIP-*` header there is and asserts none survive, while also asserting the
  forwarding allowlist is not simply empty — otherwise it would pass against a bridge that forwards
  nothing at all.

Two things the exercise surfaced, both worth keeping:

- **`aip-project` legitimately suppresses injection.** A dialect test that sent a literal project
  name saw no memory, because the resolved scope stopped matching the workspace-root hash. That is
  correct, not a bug; the dialect tests now send only `aip-agent` and the egress test sends the rest.
- **The Responses dialect dispatches as `responses`, not `chat`.** The assertion helper takes the
  expected kind per dialect rather than assuming one.

Scope note: this asserts the gateway→worker hop. The worker→provider hop is covered by the existing
sandboxed-adapter egress test, which drops a guest-set auth header and injects the real credential.

Ship-blocking acceptance: with memory off, behaviour is byte-identical to today; with memory on and
the DB unavailable, every request still succeeds.

---

## 10. Open questions

1. **Default toggle state.** I argue off. The counter-argument is that a feature nobody turns on is
   not a feature. Decide before Phase 1, not after.
   → **Decided 2026-09-21: off, and not persisted** — every launch starts off, as do the tool
   switches (`tools_enabled`, `tools_mutation_enabled`), which are in-memory `AtomicBool`s too.
   Persisting this would make it the only persisted gateway flag, and the one with the largest
   blast radius: it is the only setting that sends your traffic to a model you did not call.
   **Noted asymmetry (still open):** the *listener* does persist — `settings_set("gateway",
   {port, enabled})` and `lib.rs` auto-restores it on launch. So "the gateway came back but memory
   did not" is a real inconsistency, and the reset is now stated in the UI (`MEMORY_NOTE`) so it
   reads as intent rather than as a bug. Persisting remains a deliberate choice, not an oversight:
   if it is done, it should be done like the listener — a settings row, restored at startup, and
   shown as "restored from your last session" rather than silently on.
2. **Who pays for distillation.** Every captured turn costs a system-route call. Cap per session or
   per hour, or the memory feature becomes a quiet line item on the bill.
   → **Decided 2026-09-21, per hour, host-wide.** `capture::DISTILL_BUDGET_PER_HOUR` = 60
   distillations per rolling hour, counted by rows **claimed** (not completed) in the last hour —
   the cost is incurred when the call is made, so a call that then failed was still paid for. The
   cap lives inside `claim()`, so an over-budget drain takes nothing: it does not mark rows
   `processing` and does not spend an `attempt`, which matters because three attempts retire a row
   as `failed` — a cap that burned attempts would quietly **delete** the work it meant only to
   delay. `queue_status` reports `budget_left` and the Memory screen shows it, because a queue
   holding rows on purpose is otherwise indistinguishable from a drain that has stopped.
   No migration: `claimed_at` was already written on every claim.
3. **L0 opt-in granularity.** Per scope or global? Per scope is safer and more annoying.
4. **Multi-user.** `scope_user` is modelled but this is a single-user desktop app; the dimension is
   speculative until headless/service mode exists (§7 of `ARCHITECTURE.md` lists it as a non-goal).
5. **Cross-vendor privacy.** Even L1/L2 carries project facts to whichever vendor served the call.
   Worth an explicit statement in the UI, not just the docs.
   → **Decided 2026-09-21, stated beside the master switch** (`PRIVACY_NOTE` in `Memory.tsx`,
   `data-testid="memory-privacy-note"`). It names the two egresses separately, because they have
   different controls:
   - *Distillation* sends the tail of every captured turn to whichever provider serves the system
     model. This happens whatever the memory's scope — a capture-only memory has still been read
     by a model once, to distil it. Scope does not stop this.
   - *Injection* puts a recalled fact into whatever request is being served, and the router may
     send that to a different provider than the one the fact came from. Scope *does* gate this: a
     capture-only memory is never injected.
   Collapsing the two would let "it's capture-only, so it never left" be believed when it is false.
   With the layer off, neither happens — which is why the note sits next to the switch rather than
   in a settings pane nobody opens.

---

## 11. External validation (2026-09-20)

The plan was sent independently to **ChatGPT, Claude and chat.z.ai** through the AI Hub relay, with
the same adversarial brief ("be adversarial, do not restate my design, rank your findings"). All
three replied. Changes adopted above are marked **revised after review**.

### Adopted — flagged by all three

**Nullable-means-global is a contamination engine.** Unanimous, and the argument is self-defeating in
a way I missed: the reason `metadata.aip` exists is that IDEs can't set headers, so the *common case*
degrades to `project = NULL` → global. Fixed in §3.1: null project is capture-only, global is an
explicit column.

### Adopted — flagged by one, and genuinely a miss on my part

1. **Prompt-cache destruction (z.ai, P0).** Coding agents are built around provider prompt caching.
   A per-request re-ranked block at system position 0 invalidates the whole cached prefix every time.
   Fixed in §5.5 with deterministic tie-breaking and a per-scope block freeze. This is probably the
   highest-value change in the review: it halves token spend via cache hits.
2. **Memory as an instruction channel (ChatGPT).** Memory derived from model conversations lets the
   model indirectly write future system context. Plus **credential laundering** (z.ai): tool output is
   full of secrets, the distiller copies them into atoms, and injection broadcasts them cross-vendor
   to every provider — recreating at the memory layer the leak the keychain design prevents. Fixed in
   §3.5.
3. **`metadata.aip` must be stripped before dispatch (z.ai).** Guaranteed day-one bug on at least one
   dialect. Fixed in §4.2.
4. **Self-capturing distillation loop (z.ai).** If distillation calls traverse the gateway's own
   endpoint, each one is itself a turn. Fixed in §3.5.6.
5. **The query pipeline, not the ranking, is the gap (z.ai).** "Run it again" is noise for BM25;
   extraction of identifiers and paths plus a trigram tokenizer on a symbols column matters more than
   ranking sophistication. Fixed in §5.2.
6. **Pinned-means-truth poisons retrieval (ChatGPT).** Changed to retention/eligibility in §6.4.
7. **The 120-token floor is inverted (z.ai, ChatGPT).** It drops the one short pinned atom that most
   deserves to survive. Fixed in §5.1: floor applies to unpinned only.
8. **Hard deadline on the memory path (ChatGPT).** Degrading gracefully is not free. §5.6.

### Considered and rejected

- **"Drop BM25 for a keyword heuristic" (Claude).** Rejected — the other two reviewers said keep
  BM25 and augment it, and the no-embedding/no-second-process constraint makes BM25 the right
  primitive. Adopted the augmentation instead.
- **"Rank layer before recency" (Claude).** Rejected — the existing order is already recency before
  layer within a relevance band, which is the correct way round; a recent project-specific atom
  should beat an old generic fact. The review appears to have read the order backwards.
- **"Read-time decay is a bottleneck — 1000 `exp()` calls per request" (Claude).** Rejected as
  measured: candidates are bounded at `limit × 4` (a few dozen) and `recency_key` is integer
  arithmetic, not `exp()` per row.
- **"Don't ship off-by-default, it signals the design isn't solid" (Claude).** Rejected — opt-in
  *is* the mitigation for the billing and review-step objections, and the other two reviewers landed
  on opt-in independently. Claude's alternative (clients must send `AIP-Memory-Enabled`) is
  materially the same policy.
- **"Require all three scope dimensions or return 'missing scope'" (Claude).** Partially adopted — I
  took the stricter direction (null = never injected) but not the hard refusal, since that would
  break the header-less IDEs the feature exists to serve.

### Where they disagreed with each other

Budget sizing. Claude wanted it scaled by model family (large windows get more), z.ai wanted
`min(25% of remaining, 1500)`, ChatGPT wanted `min(8%, 1500)` with no floor. I took z.ai's shape for
the formula and Claude's point about per-model reserve, and kept the 1500 ceiling all three accepted.

---

### Tooling note

The AI Hub MCP server is configured at `http://127.0.0.1:8787/mcp` in `~/.workbuddy-ai/mcp.json`,
but **8787 is now held by this app's own gateway** (its documented default port). AI Hub is listening
on **8788**. Until that config is corrected or one of the two apps moves, `mcp__ai-hub__*` tools will
not resolve from an IDE session; the review above was run by calling the relay's JSON-RPC endpoint on
8788 directly.
