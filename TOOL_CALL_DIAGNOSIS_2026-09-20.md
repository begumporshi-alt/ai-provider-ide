# Post-Tool-Call Routing Failure — Diagnosis & Recommendation

**Date:** 2026-09-20 | **Author:** Jarvi (◈)
**Reported symptom:** "Once a tool call completes, our router fails to continue the work."
**Suspected cause:** Tauri build.

---

## 1. Verdict

| Question | Answer |
|---|---|
| Is Tauri the culprit? | **No.** Decisively ruled out — see §3. |
| What is the actual cause? | **Two defects in our own TypeScript tool-call assembly.** Both fixed and verified — §2, §4. |
| Should we rebuild on `freellmapi`? | **No.** The component that is broken is the one that repo does not contain — §5. |

The failure was never a transport, framework, or routing-strategy problem. It was a **five-line message-assembly bug** in the layer that builds the second request of a tool-calling conversation.

---

## 2. Root Cause

When a model calls a tool, the loop must send a **paired** turn back to the provider:

```json
[
  { "role": "assistant", "content": "…", "tool_calls": [ { "id": "X", "type": "function",
      "function": { "name": "write_file", "arguments": "{…}" } } ] },
  { "role": "tool", "content": "<result>", "tool_call_id": "X" }
]
```

The provider validates that `tool_call_id` matches a `tool_calls[].id` the assistant turn actually declared. If it does not, every OpenAI-compatible server answers **HTTP 400** and the conversation cannot continue. That is the reported symptom, exactly.

Our code violated that contract in two independent ways.

### Defect A — the two halves used *different* fallbacks for a missing id

`manifest-interpreter.ts:117` emits `id: undefined` whenever a provider's payload carries no id (or the manifest maps none):

```ts
sink({ id: typeof o.id === "string" ? o.id : undefined, name: …, arguments: … });
```

Both loops then applied their **own** fallback, and they disagreed:

| Site | Assistant turn declared | Tool result carried |
|---|---|---|
| `gateway-bridge.ts:240` / `:229` | `id: c.id ?? ""` → **`""`** | `tool_call_id: call.id ?? name` → **`"write_file"`** |
| `agentLoop.ts:98` / `:126` | `tool_calls: collected` → **absent** | `tool_call_id: call.id ?? name` → **`"write_file"`** |

Nothing required the two values to agree, because **nothing built them together** — they were assembled in two separate statements. When the provider supplied an id, both happened to use it and everything worked. When it did not, the pairing broke.

### Defect B — the `tool_calls` entry was not the wire shape

Both sites emitted a **flat** object:

```ts
{ id: "…", name: "write_file", arguments: "{}" }        // what we sent
{ id: "…", type: "function", function: { name: …, arguments: … } }   // what OpenAI requires
```

Missing `type: "function"` and missing the nested `function` object. `manifest-interpreter.ts:216` passes the array through **verbatim** (`messages: "{{messages}}"`) — the interpreter never reshapes it — so the malformed entry reached the provider unmodified.

`ToolCall` even carries the provider's original object in its `raw` field (`ports.ts:56`), but neither site used it.

### Evidence

**1. Reproduced in a spec** (falsified before the fix — this is the defect verbatim):

```
× a provider that omits the call id still gets a matched, wire-shaped pair
  → expected '' not to be ''        // declared id "" vs result id "write_file"
```

and for the agent-loop path:

```
× pairs the result with the declared id even when the provider omits one
  → expected 'undefined' to be 'string'
```

**2. Already in the live ledger.** Audit row 318 recorded `error_class=BAD_REQUEST_SCHEMA, http_status=400, provider=agnes/key-01` for a tool-call continuation. The provider rejected the *content* — not the transport.

**3. A partial fix had already landed and masked the real cause.** `Playground.tsx:46 replayHistory()` was added earlier to stop `tool_calls`/`tool_call_id` being *dropped* during replay. That fixed field loss — but it faithfully preserved `call.id ?? name`, so the **mismatch survived**. This is why the symptom persisted after a fix that looked correct.

### Why the tests did not catch it

Both existing specs used a well-behaved provider that supplies an id:

```ts
calls: [{ id: "c1", name: "write_file", arguments: '…' }]   // gateway-bridge.test.ts:116
calls: [{ id: "c1", name: "read_file", arguments: '…' }]    // agentLoop.test.ts:128
```

With `id` always present, the divergent fallbacks never fired and the flat shape was never asserted. The specs passed while the real path was broken.

---

## 3. Is Tauri the Culprit? No.

Five independent reasons, in descending order of strength:

1. **The ledger proves Tauri delivered the request.** Row 318 records an *upstream* `HTTP 400` attributed to `agnes/key-01`. The request reached the provider through Tauri's egress layer and came back with a rejection. A Tauri fault cannot produce a provider-authored status code — it would surface as an `invoke` rejection, a channel error, or a serialization failure.

2. **Tauri never touches the message array.** The tool loop runs entirely in JavaScript (`gateway-bridge.ts`, `agentLoop.ts`). Tauri's IPC carries JSON payloads opaquely. The malformed `tool_calls` object was constructed in TS and passed through unmodified — Tauri had no opportunity to corrupt it.

3. **The identical bug exists in pure webview code.** `runAgentLoop` (`agentLoop.ts`) is a framework-free function with an injected `generate` and `host`, unit-tested with no Tauri present. It carried the same defect. If Tauri caused this, the framework-free path could not have it.

4. **The failure is content-dependent, not environment-dependent.** It fires only when a provider omits the tool-call id. A Tauri defect would correlate with the build, not with a specific provider's payload shape.

5. **`freellmapi` is Electron-based.** If Tauri were the problem, moving to a different desktop shell would be a lateral step at best — and it is not the problem.

**Corollary:** rebuilding would not have fixed this. The same code, copied into a new project, would fail identically.

---

## 4. What Was Fixed

A single module now builds both halves from **one decision**, so they cannot drift:

**New:** `apps/desktop/src/lib/tools/wire.ts`

```ts
export function toWireToolCalls(calls: ToolCall[]): { wire: WireToolCall[]; ids: string[] }
```

- Emits the correct wire shape: `{ id, type: "function", function: { name, arguments } }`
- **Synthesizes** a stable id (`call_<n>`) when the provider supplies none, and returns the ids alongside so results are paired with the *same* value the assistant turn declared
- Exports `toolCallName()` — a tolerant reader for the context graph, which walks transcripts that may hold either shape

**Changed:**

| File | Change |
|---|---|
| `gateway-bridge.ts` | `sandboxTurn` uses `toWireToolCalls`; `executeLocally(calls, ids)` pairs each result with the declared id |
| `agentLoop.ts` | Same — one `toWireToolCalls` call builds the assistant turn and the ids for its results |
| `Playground.tsx` | Context-graph reader uses `toolCallName(c)`, so nested wire entries still resolve to a skill name |

**Verification** (both specs falsified first, then fixed):

| Suite | Before | After |
|---|---|---|
| desktop vitest | 130 | **132** (+2) |
| router-core | 216 | **216** (untouched) |
| `tsc --noEmit` | — | **clean** |

Both falsification probes were removed and their absence confirmed.

### Live end-to-end verification (shipped build, :8787)

Rebuilt, installed, relaunched and driven through the real gateway. The keychain did **not** wedge
(`key refs probed` present, LISTEN on 127.0.0.1:8787).

**The decisive probe.** Seeded a uniquely-named file (`proof.txt`) in the gateway workspace, then asked
`cline/anthropic/claude-sonnet-4.5` to call `list_dir`. Response:

```
"The list_dir tool returned exactly one file: proof.txt"     HTTP 200 in 3.4s
```

The model could not have known that filename; it only exists because `list_dir` actually executed in the
Rust sandbox and its result was fed back. A tool call happened, the loop continued, and the second turn
was **accepted**.

**The ledger confirms two turns from one request** (`generateText` writes one row per turn):

| row | tokens in/out | turn |
|---|---|---|
| 337 | 1062 / 50 | turn 1 — emitted the tool call |
| **338** | **1128** / 19 | turn 2 — received the pair (+66 tokens) and answered |

Both `ok`, provider and key named, **0 error rows** across the run. Row 338 succeeding *is* the fix — that
second turn is exactly what was previously rejected with `BAD_REQUEST_SCHEMA / HTTP 400`.

**Two traps worth remembering** (both nearly produced a false negative):

1. **`agnes-2.5-flash` refuses to make tool calls.** It answered "I can't create that file… the request
   appears to be testing whether I'll execute arbitrary tool calls" — HTTP 200, no call. A 200 from an
   agnes tool probe proves nothing.
2. **A 200 with a plausible answer is not proof a tool ran.** Agnes confabulated "the result shows an
   empty directory" in 1.7s. Use an observable side effect, not a plausible-sounding reply.

**Useful detail:** `tools_enabled` defaults to `true` and `workspace_root` defaults to
`~/AI-Provider-Router-Workspace` (created if missing), so gateway mode engages after a relaunch with no
UI setup. The master key is retrievable without the UI:
`security find-generic-password -s ai-provider-router -a masterkey -w`.

**Downstream effect:** the Playground path is fixed too. `runAgentLoop` now returns wire-shaped `tool_calls`, so `replayHistory()` passes the provider a valid pair on the next plain message — closing the `BAD_REQUEST_SCHEMA` failure that was previously worked around.

---

## 5. Should We Rebuild on `freellmapi`? No.

I inspected the repository. The premise does not hold.

### What it actually is

`tashfeenahmed/freellmapi` is a **self-hosted OpenAI-compatible proxy that aggregates free tiers of ~34 LLM providers** (635 endpoints) behind one `/v1` endpoint. TypeScript/Node.js, Express + SQLite, React admin dashboard, **Electron** desktop app, MIT license.

It genuinely has: routing strategies, automatic failover, per-key rate tracking, AES-256-GCM encrypted keys, an MCP server, response caching, prompt compression.

### The disqualifying detail

> **It contains no agent loop and no tool execution.** It *relays and normalizes* tool calls (including rescuing plain-text tool calls into structured `tool_calls`), but the loop that calls a tool and continues the conversation lives in the **client** — Claude Code, Cline, Aider, and the other agents it is built to serve.

**The exact component that is broken in our app is the component that repo does not have.** There is nothing there to extract for this problem. It would not fix the bug, because it never implements the code path that has the bug.

### Why a rewrite would be a net regression

| Capability | This project | freellmapi |
|---|---|---|
| Agent loop + sandboxed tool execution | **Yes** (8-turn ceiling, allowlist, root confinement, no shell) | **No** — out of scope by design |
| Adapter model | Manifest-driven + AI-generated + code adapters | Hand-written per-provider adapters |
| Secret storage | **OS keychain** (never in DB, never in webview) | AES-256-GCM in SQLite (key material must live somewhere) |
| Security model | Numbered invariants, key-blind egress, host allowlist | Not documented as such |
| Ledger integrity | Cause-based error classes, spend caps, rollups | Not present |
| Maturity claim | — | **"Personal experimentation only… not production"** |

Rewriting would discard: the manifest/adapter system, key-blind egress, the sandboxed tool host, ledger honesty work, and **348 passing specs** — to adopt a codebase that is narrower in scope, weaker on secret handling, self-described as non-production, and **missing the one component we need**.

The correct reading of "it handles routing smoothly" is: *its routing works because it never has to continue a conversation after a tool call.* It delegates that to the client. We implement it ourselves, and that is where our bug was.

### What is genuinely worth borrowing (without a rewrite)

Three ideas are worth adopting, and each is a small, additive change:

1. **"Try models that reject tool calls last for tool requests."** They reorder candidates so models known to reject `tools` are attempted last when the request carries tools. We have the data (`drift-monitor`, health tracker) and the ordering hook (`orderCarriers`) to do this — it would cut wasted failover attempts on tool-bearing requests.
2. **Per-key token-budget tracking (RPM/RPD/TPM/TPD).** Our `HealthTracker` tracks cooldowns and auth breakers, but not token budgets. Free-tier providers commonly cap *tokens per day*; tracking it would let us rotate keys before a hard 429.
3. **Sticky sessions with context handoff.** Our key rotation uses a per-provider cursor, not session pinning. Pinning a conversation to one provider for a window would improve prompt-cache hit rates.

These are worth a follow-up; none requires leaving the current architecture.

---

## 6. Recommendation

1. **Do not rebuild.** The bug is fixed; the architecture is sound and materially more capable than the alternative.
2. **Ship the fix.** Rebuild the app and confirm end-to-end: a tool-calling request through the gateway should now complete with a second turn instead of a 400. Check the ledger — the continuation should write an `ok` row naming provider and key, not a `BAD_REQUEST_SCHEMA` error row.
3. **Watch the fallback path.** The synthesized id is `call_<n>` from a module counter. It is consistent within a pair, which is all the provider requires; if a transcript is ever replayed wholesale across processes, consider seeding the counter from a request-scoped value.
4. **Consider the three borrowed ideas** as separate, small enhancements — not as a migration.
