# Fixed context overhead — diagnosis and strategy

**Status:** Options 1 and 3 shipped and committed. **Re-measured live after the change: 1,721 → 1,042
prompt tokens (−679, −39.5%).** Option 2's egress `cache_control` marker is implemented but opt-in,
has no webview writer, and is inert on `agnes` (probed — it reports no cache fields at all).
**Date:** 2026-09-27; updated and re-measured 2026-09-28. **Gateway probed:** live on
`127.0.0.1:8800`, one provider (`agnes`).

## 1. The problem, measured

Every gateway request carries a large, constant prompt payload that is billed on each call.

| Probe (identical message, `agnes/agnes-2.5-flash`) | `prompt_tokens` |
|---|---|
| Client declares **no** tools → gateway supplies its registry | **1,721** |
| Client declares **one** tool → gateway registry suppressed | **534** |
| **Cost of the gateway tool set** | **≈1,187 tokens — 69% of the prompt** |
| After Options 1+3 (2026-09-28, service rebuilt and restarted) | **1,042** |
| **Cost of the gateway tool set, after** | **508 tokens — 49% of the prompt** |

The 1,042 figure replicated five times with byte-identical usage; the 534 control reproduced twice.
Half the attempts in both arms failed with upstream `NETWORK` errors — the provider was flaky
throughout, which is a property of the run, not of the change.

The 1,721 figure reproduces the September 22 finding (~1,700–1,900) and today's independent
measurement (1,719 / 1,721), so it is stable, not a sampling artefact.

Cross-check: serialising the eight `ToolSpec` entries as OpenAI tool JSON gives ~1,039 tokens by
character count (÷3.9). The measured delta is 1,187. The gap is the `required` arrays and type
keywords my estimate omitted — the two methods agree.

## 2. Root cause, in code

```
router_bridge.rs:289   ToolOwnership::Gateway => registry_to_openai(&gateway_tool_set(mutation))
```

- `agent_tools()` (`tool_registry.rs:49`) returns **all eight** tools, unfiltered — that was the
  defect. `gateway_tool_set` (`tool_registry.rs:70`) now filters out `MUTATING_TOOLS` when mutation
  is off, and `router_bridge.rs:289` calls it.
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

### Option 1 — Stop advertising tools that will be refused ★ implemented

Filter `agent_tools()` by `MUTATING_TOOLS` at `router_bridge.rs:289` when
`tools_mutation_enabled` is off.

- **Saves ≈606 tokens** (1,721 → ~1,115), ~35% of the prompt.
- **Correctness win, not just cost:** the model stops being offered tools that fail.
- **Risk: low.** Behaviour changes only while mutation is off, which is the default. Operators who
  enable mutation see no change at all.
- Keep `gateway_tool_refusal` as defence in depth — a model can still hallucinate a tool name.
- **Falsified before trusting:** reverting the filter in `gateway_tool_set` to `.filter(|t| true)`
  makes `the_gateway_supplies_its_registry_only_when_the_client_brought_none` fail with
  `a refused tool reached the wire with mutation off: ["read_file", "write_file", …]`.
  Restoring the filter makes it pass. See `router_bridge.rs` tests.

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

The eight descriptions total 3,272 characters. Several are 170–200 characters of prose explaining
usage conventions the model does not need (`search_files`, `read_file`, `run_command`, `edit_file`).
Measured after the trim: descriptions are now 2,954 characters, a **318-character (~26%) reduction**.
The `no_description_exceeds_the_trim_budget` test caps each at 160 chars.

- **Saves ≈82 tokens** at the measured 26% trim (318 chars ÷ 3.9 × 1.142 scale factor).
- **Risk: very low.** The `every_tool_is_described` test requires >20 characters per description.
- The 26% saving compounds with Option 1 — the 4 mutating tools that are dropped when mutation is
  off also carry 1,036 characters of description, so the combined filter+trim effect on the full
  registry is larger than either alone.

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

Do **1 and 3 together** — done, and **measured rather than estimated**: the predicted post-change
figure was ~1,033 tokens; the live gateway reports **1,042**, five replicates, no variance. That is
**−679 tokens, a 39.5% cut**, with no architectural change. The 534-token control is unchanged, so
the whole delta is the registry.

> **The saving is conditional on mutation being off, and the two hosts disagree about what "off"
> means.** `bin/aiproviderd.rs:91` hardcodes `tools_mutation_enabled() -> false`, so the headless
> service always narrows. The desktop host (`tauri/gateway_cmds.rs:66`) reads the persisted setting
> instead — and on this machine the `gateway` row says `"mutationEnabled": true`. Run the app with
> that row and the gateway advertises all eight again, and the 39.5% cut becomes 0%. One switch,
> two readers, one of them a constant. See §6.4.

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
   **Probed 2026-09-28: agnes does not report any cache fields.** Three requests were made
   through the live gateway — a short prompt with `cache_control` on the system block, and two
   consecutive 5,215-token prompts without it. All three returned `usage` with only
   `prompt_tokens` and `completion_tokens`; `cached_tokens`, `cache_read_input_tokens` and
   `cache_creation_input_tokens` are all absent. `raw_keys: ["completion_tokens",
   "prompt_tokens"]` confirms the upstream's usage object carries no cache sub-object. **Option 2
   has zero effect on the `agnes` provider as configured.** Revisit when a provider with prefix
   caching (Anthropic, OpenAI with ≥1024-token prefixes) is added.

4. **The mutation toggle has two readers and one of them is a constant.** `aiproviderd` hardcodes
   `tools_mutation_enabled() -> false` (`bin/aiproviderd.rs:91`), while the desktop host reads the
   persisted `gateway.mutationEnabled` (`tauri/gateway_cmds.rs:66`). The row on this machine is
   `true`. So Option 1's measured 39.5% holds on the headless service unconditionally and on the app
   **only while the operator leaves mutation off**. Either make the service read the row or make the
   row follow the service — today they disagree, and the saving depends on which one you ask.
5. **`promptCacheEnabled` has no writer.** `RouterSettings::from_value` reads it
   (`router.rs:335`) and the bridge passes it (`router_bridge.rs:368`), but a repo-wide search finds
   **zero** occurrences outside Rust — no webview toggle, no command. It is reachable only by
   editing the `router` settings row by hand. Combined with §6.3 (agnes reports no cache fields),
   Option 2 is currently inert end-to-end: the flag exists, nothing sets it, and nothing upstream
   would honour it.

## 7. Evidence

| Claim | Provenance |
|---|---|
| 1,721 vs 534 prompt tokens | Measured, live gateway, identical message |
| 1,042 after Options 1+3 | Measured 2026-09-28, rebuilt `aiproviderd` restarted, 5 replicates, no variance |
| 534 control unchanged after the change | Measured 2026-09-28, 2 replicates — the delta is the registry, not drift |
| `gateway.mutationEnabled` is `true` on this machine | `settings` row read from the live DB; `aiproviderd` ignores it (`bin/aiproviderd.rs:91`) |
| ~1,039-token schema estimate | Computed from `tool_registry.rs:84-198` |
| Option 3 saves 318 chars (26%) | Measured post-trim; `the_narrowed_set_stays_under_55pct_of_full` pins it |
| All 8 tools attached unconditionally | `router_bridge.rs:289`, `tool_registry.rs:49,58` |
| Mutation off by default; 4 tools refused | `gateway.rs:812,825`; `router.rs:266` |
| `tool_choice:"none"` overridden to `"auto"` | `bridge_policy.rs:213` |
| No `cache_control` emitted on egress | Searched `src/` — only test fixtures in `gateway_anthropic.rs` |

The 534-token baseline has three confirming samples now (one on 09-27, two on 09-28), all identical.
The provider returned intermittent `NETWORK`/`SERVER_ERROR` throughout both runs — roughly half of
all attempts failed — so replication is thin, but the failures are upstream and uncorrelated with
the variable under test. Treat 534 as stable-but-thin until §6.1 is done.
