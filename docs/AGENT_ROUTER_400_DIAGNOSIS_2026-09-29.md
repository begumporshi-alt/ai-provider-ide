# `agent-router/deepseek-v4-flash` → `BAD_REQUEST_SCHEMA` — diagnosis

**Date:** 2026-09-29 · **Scope:** why a request for this model is refused with HTTP 400, and a
correction of a prior analysis that attributed it to a schema mismatch.

---

## 1. Verdict

**The error is not a schema mismatch, and it is not produced by any validator in this repository.**

`BAD_REQUEST_SCHEMA` is the name this system gives to **an HTTP 400 returned by the upstream
provider**. It is a label applied to a remote refusal, not a local validation failure. There is no
TypeScript schema validator on the response path that could reject anything, and the response is
never inspected before the status is classified.

The two real causes are:

1. **An upstream content guard.** `agentrouter.org` refuses a deterministic fraction of ordinary
   prompts with `400 {"error":{"code":"content-blocked", …}}`. This is the provider's own policy,
   not a malformed request.
2. **The id's form — already fixed.** A *qualified* id (`slug/native`) resolves to exactly one
   provider by design, so a 400 from that provider is terminal. The bare id (`deepseek-v4-flash`)
   resolves through the alias table to both carriers, so the second one serves the request.

---

## 2. Where the class comes from — one site, one condition

`packages/router-core/src/errors.ts:29-38` is the only classification the execution engine uses:

```ts
if (status === 400) return bodyHint === "not_found" ? "NOT_FOUND" : "BAD_REQUEST_SCHEMA";
```

The engine calls this with the status alone, and no body hint
(`apps/desktop/src-tauri/src/core/engine.rs:2325` pins that consequence). So **any** upstream 400
becomes `BAD_REQUEST_SCHEMA`, whatever the upstream actually said. The upstream's own reason is
discarded and never reaches the operator.

The same taxonomy is mirrored in Rust (`engine.rs:163-171`), and both spellings are pinned by a
cross-language contract test (`engine.rs:2039-2047`).

---

## 3. What the router actually puts on the wire

The qualified form never reaches the provider. `execution-engine.ts:130` sends
`model: c.model.nativeId` — the **slug is stripped**, so `agent-router/deepseek-v4-flash` is dialled
as `model: "deepseek-v4-flash"`.

`route-planner.ts:104-145` (`resolveWanted`) is what consumes the qualified form, and its only effect
is to constrain the candidate set to one provider. Its comment states the intent: *"a genuinely
qualified id never reaches here, so it can never be silently rerouted to a different provider."*

So there is no name mismatch on the wire, and nothing for a schema to reject.

---

## 4. Evidence

All rows from the live ledger
(`~/Library/Application Support/dev.aiprovider.router/ai-provider-router.db`, WAL — read through it).

### 4.1 The id form decides the outcome

`deepseek-v4-flash`, 2026-09-29:

| id form | status | served by | first attempt | n |
|---|---|---|---|---|
| `deepseek-v4-flash` (bare) | **ok** | `vice` | `agent-router` → `BAD_REQUEST_SCHEMA` | 26 |
| `deepseek-v4-flash` (bare) | **ok** | `vice` | `agent-router` → `SERVER_ERROR` | 3 |
| `deepseek-v4-flash` (bare) | **ok** | `vice` | *(no failed attempt)* | 2 |
| `agent-routerv2/deepseek-v4-flash` (qualified) | error | — | `agent-routerv2` → `BAD_REQUEST_SCHEMA` | 6 |
| `agent-routerv2/…` (qualified) | error | — | *(chain empty)* | 1 |
| `agent-router/deepseek-v4-flash` (qualified) | error | — | `agent-router` → `BAD_REQUEST_SCHEMA` | 2 |

**Bare: 31/31 succeeded. Qualified: 9/9 failed.** A representative successful row:

```
id=2487  status=ok  model=deepseek-v4-flash  provider_id=d1007c28… (vice)
fallback_chain_json=[{"cls":"BAD_REQUEST_SCHEMA","key":"key-01","provider":"agent-router"}]
```

The chain records that agent-router was tried, refused, and the router moved on — which is the
behaviour the fix restored.

### 4.2 The upstream's own reason

`GET /v1/models` with the stored key returns **200** and lists `deepseek-v4-flash`, so the key, the
client gate, the model id and the base path are all correct. `POST /v1/messages` then returns:

```
400 {"error":{"code":"content-blocked","message":"content-blocked (request id: …)",
     "param":"","type":"agent_router_api_error"}}
```

`content-blocked` appears nowhere in this repository — the message the operator needs is thrown away
by the classifier.

### 4.3 There are two gates, and the content guard runs first

| order | gate | signature |
|---|---|---|
| 1st | content guard — per text, deterministic | `400 … "code":"content-blocked"` |
| 2nd | client gate — `User-Agent` not allowlisted | `401 … "unauthorized client detected"` |

Measured matrix, `/v1/messages`, one request per cell:

| text | no UA | `claude-cli/2.0.18 (external, cli)` | `claude-cli/2.0.28` | `zcode` |
|---|---|---|---|---|
| `"Say hello."` | 400 content-blocked | 400 content-blocked | 400 content-blocked | 400 content-blocked |
| `"Say hello"` | 401 unauthorized client | **200** | 401 unauthorized client | **200** |
| `"Hello."` / `"Say hi."` / `"What is 2+2?"` | 401 | **200** | 401 | **200** |
| `"Tell me a joke."` / `"Define entropy."` | 400 content-blocked | 400 content-blocked | 400 content-blocked | 400 content-blocked |

Because the guard runs **before** the gate, a blocked text returns 400 even with no `User-Agent` —
which is how the client gate can look absent when it is not. The allowlist is per family **and
version**: `2.0.18` passes, `2.0.28` does not.

### 4.4 The guard's rate

| sample | blocked |
|---|---|
| 30 innocuous prompts | 5 (**17%**) |
| 8 innocuous prompts | 0 |
| 25 / 85 (prior session) | **29%**, samples 20–40% |
| 8 short · 8 with a Claude-Code system prompt · 8 with tools + ~1.8 kB body | **0/8, 0/8, 0/8** |

**Request shape does not move it** — system prompt, tools and body size were each tested and had no
effect. It is **deterministic per text**, so a repeated prompt fails identically every time. Combined
estimate: **~26%, varying 0–43% between text samples.**

The ledger's first-attempt failure rate for agent-router was **29/31 (~94%)**, far above any probe
rate. Given determinism, that is the signature of the *same* prompt being resent, not of a second
defect.

---

## 5. Why the primary is the failing provider

The alias table decides which carrier leads, and **the operator does not control it**:

```
alias              provider_id                           priority
deepseek-v4-flash  5af56734-… (agent-router)             102
deepseek-v4-flash  d1007c28-… (vice)                     103
```

`ModelCatalog.deriveAutoAliases` (`model-catalog.ts:202-218`) assigns `priority = pr++` while
iterating `[...byNative.entries()].sort()` and, within each, `[...provIds].sort()` — so the order is
the **lexical order of provider UUIDs**. `5` sorts before `d`, so agent-router leads. Nothing
operator-visible expresses that intent.

`hydrateAliases` re-derives every row the derivation could have emitted, so **editing a derived row's
priority is lost** (register D76). The usable levers are:

- **use the bare id** — the chain then has a second candidate (this is what the fix enabled); or
- **set the failing provider's `status` away from `enabled`** — `buildPlan` drops it at
  `route-planner.ts:49` while the alias row survives, so the bare id resolves to the healthy carrier
  with no wasted attempt.

---

## 6. Corrections to the prior analysis

| Claim | Verdict |
|---|---|
| "the agent router's TypeScript schema validation is rejecting the response" | **Wrong.** No validator runs on the response path. `BAD_REQUEST_SCHEMA` is a label for an upstream HTTP 400 (`errors.ts:34`). |
| "the provider returned 200 with 'First raw chunk received' / 'Stream completed'" | **Wrong.** The ledger records `http_status=400`. Neither quoted string exists in `aiproviderd.log` or `gateway.log` (control `dispatching chat request` = 908, `listening on` = 35, so the instrument works). |
| "the model is registered as `deepseek-v4-flash`, but the error says `agent-router/…`" | **Not a discrepancy.** `agent-router` is a *provider slug*; `deepseek-v4-flash` is a *model id*. The qualified form is the documented way to pin a provider. |
| "update the schema validation to be more permissive" | **Wrong remedy.** There is no local schema to loosen. The 400 is the provider's content guard. |
| "add a response transformation layer for DeepSeek models" | **Wrong remedy.** The failure precedes the response body; nothing is returned to transform. |
| "use the bare id as a workaround" | **Correct**, and it is the shipped fix — not a workaround. |
| "`models.json`" | There is **no `models.json`** in this repository. The router's catalog is `models_cache` in SQLite. (`~/.workbuddy-ai/models.json` is the *client's* file; it already uses the bare id and points at `127.0.0.1:8800`, i.e. through this router.) |

---

## 7. What to do

**Nothing to fix in the router.** Both defects were fixed and pushed on 2026-09-29:

- `f0ca340` — offer the bare id, so failover has a second candidate.
- `ac596fb` — make the alias table re-derivable, so a bare id can fan out.

**Operator guidance:**

1. Pick the **bare** `deepseek-v4-flash`, not a qualified id. The bare id fails over to `vice`.
2. If a prompt is refused, **reword it** — the guard is per text, so the same text fails every time.
3. Optionally disable `agent-router` while it is ~94% failing, to stop burning an attempt per request.

**Known residual gaps, reported and not fixed:**

- A content-policy 400 is filed `BAD_REQUEST_SCHEMA`, so the UI says "schema" and discards the
  upstream's `content-blocked` reason (`engine.rs:2325`).
- A `402` (budget-pool exhausted) is filed `NETWORK`, counting a billing condition against the
  provider's network health.
- `router.defaults.text` is `agnes/agnes-2.5-flash` — qualified, so `failoverEnabled` cannot apply
  to the default model.

---

## 8. "But it works in ZCode" — checked, and it is an arithmetic artifact

The obvious objection to §1 is that another client on this machine uses the same host and the same
model successfully. It does — and the reason is not a mechanism difference.

Read from that client's own database (`~/.zcode/cli/db/db.sqlite`, table `model_usage`; open with
`?immutable=1`, since plain `-readonly` reports "unable to open database file" on a file that is
readable and not in use):

| measure | value |
|---|---|
| its `agentrouter.org` provider, `deepseek-v4-flash`, all time | **2,047 completed / 8 error (0.4%)** |
| its **last 400** deepseek calls | **11 distinct prompts** — the most frequent repeated **214×** |
| those 11 distinct prompts, replayed through the guard | **0 blocked** |

**A 0.4% error rate over 2,047 calls is not 2,047 independent trials.** The workload is an agentic
loop that re-sends a small set of prompts; the guard is deterministic per text (§4.4), so one
accepted prompt is accepted on every repetition. 400 calls were 11 texts. The honest denominator is
**11**, and **0/11 is consistent with a ~26% rate** (p ≈ 3–13%) — it does not refute it.

### Everything about the transport was ruled out first

Each variable tested with the credential held constant:

| variable | test | result |
|---|---|---|
| **the key** | the router's stored key is byte-identical to that client's *failing* `agentblock` entry (`sha256` prefix `92bc9a06…`); its *working* entry uses a different key | all four keys block the same **3/8** texts |
| **request size** | a known-blocked text padded to 2 kB / 20 kB / 220 kB / 600 kB | **blocked at every size** |
| **`stream: true`** | blocked texts, streaming vs not | identical |
| **auth scheme** | `Authorization: Bearer` / `x-api-key` / `x-api-key` + `anthropic-version` / both | identical |
| **dialect** | `/v1/messages` vs `/v1/chat/completions` | both block the same texts |

### The generalisable point

**When a failure is deterministic per input, an observational error rate over a traffic log measures
how often the input repeats — not the probability of failure.** Two clients on one endpoint can
differ by two orders of magnitude on the same metric while behaving identically, because one loops on
a stable prompt and the other sends novel ones.

So the answer to the question is: **nothing about the competing client's path is different.** Same
host, same model, same endpoint, same client identity, and the guard fires identically for its key.
It simply sent eleven texts, repeatedly.


---

## Correction (2026-10-01)

The verdict above — *"the error is not a schema mismatch, and it is not produced by any validator in
this repository"* — is correct about the **label** and, measured today, incomplete about the **cause**.
Two things were true at once, and this document recorded only one of them:

1. **The upstream content guard** (recorded above, unchanged): `agentrouter.org` refuses a
   deterministic fraction of ordinary prompts with `400 {"error":{"code":"content-blocked", …}}`.
2. **Our request was also malformed for this dialect.** The provider's active manifest is
   `anthropic-messages-v1`, hand-edited with none of the dialect-shaping declarations. Rendered
   through the engine (measured 2026-10-01, before the fix), the request carried `role:"system"`
   inside `messages` — which the Anthropic Messages API rejects, and which this app sends on
   **every** request — plus OpenAI-wrapped `tools` and a bare-string `tool_choice`. The provider's
   ledger agrees it never served one successful request: three 400s and one 500, all terminal.

So the 400s this document investigated had (at least) two independent causes, and only the first was
identified. The phrase "the request or the manifest is wrong" in the class's own definition was
righter than the analysis beneath it.

**Fixed 2026-10-01:** profile selection matches by measured hostname (not slug spelling) and keeps
the stored row's operator headers; the builtin `anthropic-compat` template gained tool
declaration/replay shaping, and its `toolChoiceMap` — which emitted `{type:"const", value:"any"}`, a
shape in no Anthropic API surface, mapping `auto` to `any` (force a call) — now emits Anthropic's
real schema. The rendered body is verified Anthropic-shaped end to end in `dialect-messages.test.ts`,
and `lintManifest` now fails any unshaped anthropic/gemini manifest at setup time, naming what to
declare. `PARSE_ERROR`/400 evidence capture (drift D81) records what a refusing provider actually
says from this build forward.
