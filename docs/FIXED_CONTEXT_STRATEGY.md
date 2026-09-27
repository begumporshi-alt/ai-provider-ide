# Fixed context overhead — diagnosis and strategy

**Status:** diagnosis complete and evidence-backed; implementation not started.
**Date:** 2026-09-27. **Gateway probed:** live on `127.0.0.1:8800`, one provider (`agnes`).

## 1. The problem, measured

Every gateway request carries a large, constant prompt payload that is billed on each call.

| Probe (identical message, `agnes/agnes-2.5-flash`) | `prompt_tokens` |
|---|---|
| Client declares **no** tools → gateway supplies its registry | **1,721** |
| Client declares **one** tool → gateway registry suppressed | **534** |
| **Cost of the gateway tool set** | **≈1,187 tokens — 69% of the prompt** |

The 1,721 figure reproduces the September 22 finding (~1,700–1,900) and today's independent
measurement (1,719 / 1,721), so it is stable, not a sampling artefact.

Cross-check: serialising the eight `ToolSpec` entries as OpenAI tool JSON gives ~1,039 tokens by
character count (÷3.9). The measured delta is 1,187. The gap is the `required` arrays and type
keywords my estimate omitted — the two methods agree.

## 2. Root cause, in code

```
router_bridge.rs:289   ToolOwnership::Gateway => registry_to_openai(agent_tools())
```

- `agent_tools()` (`tool_registry.rs:49`) returns **all eight** tools, unfiltered.
- `registry_to_openai` (`tool_registry.rs:58`) renders every one of them.
- Ownership is decided in `bridge_policy.rs:191` (`decide_tool_ownership`): the gateway registry is
  attached whenever the client declared none and `gateway_tools_enabled` is on — **which defaults
  to true** (`router.rs:266`).

So all eight schemas go out on every request from every client that does not bring its own tools.

**Half of them cannot be used.** `MUTATING_TOOLS` (`gateway.rs:812`) is
`write_file, edit_file, mkdir, run_command`, and mutation is **off by default** on the gateway path:
`gateway_tool_refusal` (`gateway.rs:825`) returns a refusal string instead of running them.

> We pay to advertise four tools that are refused at call time. That is not merely waste — a model
> that calls one gets a refusal and burns a round trip. The refusal message is correct as a
> backstop; the defect is that the tools are offered at all.

## 3. Where the remaining ~534 goes

Not yet decomposed. It is core context, session context and any skills, plus the message itself.
No large system prompt exists in the Rust core (the only `You are …` strings are test fixtures in
`gateway_anthropic.rs`), so this half is structural context rather than prose. **This needs its own
measurement pass before optimising** — see §6.

## 4. Options, ranked

Estimates below are computed from the schema character counts, scaled by 1.142 to match the
measured 1,187. Measured figures are labelled as such.

### Option 1 — Stop advertising tools that will be refused ★ recommended first

Filter `agent_tools()` by `MUTATING_TOOLS` at `router_bridge.rs:289` when
`tools_mutation_enabled` is off.

- **Saves ≈606 tokens** (1,721 → ~1,115), ~35% of the prompt.
- **Correctness win, not just cost:** the model stops being offered tools that fail.
- **Risk: low.** Behaviour changes only while mutation is off, which is the default. Operators who
  enable mutation see no change at all.
- Keep `gateway_tool_refusal` as defence in depth — a model can still hallucinate a tool name.

### Option 2 — Provider prompt caching on the stable prefix ★ highest ceiling

We currently emit **no** `cache_control` on egress. The tool block and core context are
byte-identical across requests, so they are close to an ideal cache candidate — and
`MAX_FROZEN_BLOCKS = 256` (`gateway.rs:809`) already exists expressly so a provider prefix cache
can hit. The intent is in the code; the marker is not.

- Anthropic: mark the block `cache_control: {type: "ephemeral"}`; cached tokens bill at ~0.1×.
- OpenAI and several others: automatic prefix caching at ≥1024 tokens — our block qualifies alone.
- **Effect:** the remaining fixed block bills at roughly 10–50% of input price.
- **Risk: medium.** Needs per-dialect handling; Anthropic's TTL is ~5 minutes, so it only pays off
  under steady traffic. `ledger.cached_tokens` already exists (migration 0015) to record hits, and
  `usage.rs:53` is explicit that **`cached_tokens: None` is not `0`** — that invariant must survive.

### Option 3 — Trim the tool descriptions

The eight descriptions total ~1,203 characters (~352 tokens scaled). Several are 170–200 characters
of prose explaining usage conventions the model does not need (`search_files`, `read_file`,
`run_command`, `edit_file`).

- **Saves ≈176 tokens** at a 50% trim.
- **Risk: very low.** The `every_tool_is_described` test (`tool_registry.rs:218`) requires >20
  characters, which any real description clears.
- Small, but nearly free — and it compounds with Option 2, since a shorter cached block is cheaper
  to write once and cheaper to read.

### Option 4 — Let the client opt out

Today `tool_choice_for` (`bridge_policy.rs:213`) forces `"auto"` whenever the gateway owns the
tools, **overriding a client that sent `tool_choice: "none"`**. Such a client gets both the full
schema payload and `auto`. That is arguably a contract bug independent of cost.

- Honour `"none"` by omitting the registry entirely → **0 tool tokens** for clients that want none.
- **Risk: low–medium.** Changes observable behaviour for clients already sending `"none"`, who are
  currently being ignored.

### Option 5 — Two-phase lazy injection (not recommended now)

Send no tools; if the turn looks tool-shaped, re-issue with the registry. Highest theoretical saving
but adds a round trip, complicates streaming, and risks latency regressions against the
sub-millisecond overhead that is one of our few measured advantages. Revisit only if 1–4 are
insufficient.

## 5. Recommendation

Do **1 and 3 together** — both are small, both are safe, and together they take 1,721 → **~940
tokens, a ~45% cut** with no architectural change.

Then do **2**: it is the only option that changes the *billing model* rather than the token count,
and it is the durable answer to OmniRoute's compression claim — a cached prefix is not re-billed at
full price, which is the same economic effect they advertise, achieved without lossy compression.

Then **4** if any client actually needs the opt-out.

Defer **5**.

## 6. Open questions before implementing

1. **Decompose the ~534 baseline.** Measure with gateway tools off (`gateway_tools_enabled = false`)
   to separate tool cost from core/session/skills cost. Every number above isolates the tool set;
   the rest is currently unmeasured.
2. **Confirm the mutation toggle is readable at the attach site.** `router_bridge.rs:289` needs
   `is_tools_mutation_enabled()` (`gateway.rs:1272`); verify the bridge can reach the setting without
   creating the reference cycle that `gateway.rs:816-821` exists to avoid.
3. **Does `agnes` even honour `cache_control`?** Option 2's payoff depends on upstream support;
   verify against the actual configured provider before building per-dialect markers.

## 7. Evidence

| Claim | Provenance |
|---|---|
| 1,721 vs 534 prompt tokens | Measured, live gateway, identical message |
| ~1,039-token schema estimate | Computed from `tool_registry.rs:84-198` |
| All 8 tools attached unconditionally | `router_bridge.rs:289`, `tool_registry.rs:49,58` |
| Mutation off by default; 4 tools refused | `gateway.rs:812,825`; `router.rs:266` |
| `tool_choice:"none"` overridden to `"auto"` | `bridge_policy.rs:213` |
| No `cache_control` emitted on egress | Searched `src/` — only test fixtures in `gateway_anthropic.rs` |

The 534-token baseline has one confirming sample; the provider returned intermittent
`NETWORK`/`SERVER_ERROR` during repeat attempts, so it is not yet replicated. Treat it as
indicative until §6.1 is done.
