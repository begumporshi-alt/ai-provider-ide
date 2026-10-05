# 02 — Architecture

The v1 design narrative is [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — written when the router core lived in
the webview, so its hosting sections are superseded (a banner there says so). **This chapter is the current
truth**; the request path itself is in [08 Flows](08-flows.md).

**Diagram:** [`../diagrams/architecture.html`](../../diagrams/architecture.html) — layers, the router, the
gateway and key-blind egress. The request path itself is in [08 Flows](08-flows.md).

## The one security boundary

**The TypeScript layer is key-blind by construction.** This is the single most important fact about the
codebase, and almost every other rule follows from it.

A request from `router-core` does not carry a credential. It carries a `secretRef`:

```
TS  →  { secretRef: "key:k1", method: "POST", url: "…/v1/chat/completions", body, headers }   // no auth
Rust →  resolve k1 in the vault → inject "Authorization: Bearer …" → send → drop the value
```

So the webview never holds a raw secret, and code running in the webview — including anything an AI generated
— cannot leak a key it can never read. There is exactly **one** module allowed to combine a `secretRef` with an
HTTP request: the Rust `egress-gateway`.

Two consequences worth stating plainly:

- **Do not add a `fetch()` in the UI.** It would not work anyway — providers do not send CORS headers, which is
  half the reason HTTP lives in Rust — but it would also create a second, unaudited egress path.
- **A key must never enter webview-observable state.** The one-shot reveal is a Rust-side native action for
  this reason. Do not "simplify" it into a value returned over IPC.

## Three runtimes, one codebase

| Runtime | Holds | May touch |
|---|---|---|
| Webview (TypeScript) | The React UI, `store.ts`, and the `router-core` package **as a test oracle and config layer** — settings, key tests, import validation, the repair orchestrator. It executes **no production generation** | Nothing privileged. Talks to the host through 135 registered typed IPC commands, and holds the 24-hour UI-session bearer that `/admin` fetches use |
| Rust host (the app) | The gateway, the router (`planner`/`engine` behind `RouterBridge`), egress, the vault, SQLite, memory, tools, the retention scheduler | The network with credentials, the local secrets file, the filesystem |
| Headless daemon (`aiproviderd`) | The same Rust serving stack with no Tauri — `cargo build --bin aiproviderd --no-default-features` compiles zero Tauri | Same as the Rust host, minus any window |

Until 2026-10-04 the router core ran **in the webview**, behind a hidden `gateway.html` worker window, and
this chapter described that bridge. The A1 consolidation (D95) moved the serving path fully into Rust: the
gateway bridges HTTP into the Rust `RouterBridge` (`core/router_bridge.rs`, a `BridgeMsg` protocol between
the HTTP handlers and the router), and the Assistant itself became a plain gateway client over loopback
HTTP (`src/lib/gateway-turn.ts`) — same admission, same ledger, same failover as an external IDE.
`router-core` survives as the differential/oracle suite for tests and for config-time work;
`packages/adapter-spec` is the frozen manifest grammar. The webview is no longer the brain; it is the
control panel for a brain that lives in the host.

### Why the serving core is Rust

1. **Credential injection has to be somewhere audited.** Rust makes "all egress flows through one module"
   mechanically true rather than aspirational (`core/egress.rs` is still the only place a secret meets a request).
2. **Availability.** The webview-hosted core answered `503` whenever the window was gone — the project's main
   structural risk for its whole v1. Closed 2026-10-04: the gateway lives in the host process, and the
   headless `aiproviderd` (launchd agent, default port 8800) serves with no window at all. App and daemon are
   the same code over the same SQLite store; at boot the app probes the port and **delegates** to the daemon
   when launchd already holds it, instead of double-binding.
3. **The vault and SQLite are Rust APIs.**

### Where the 503 still comes from

A *stopped* gateway — in-app or daemon — answers `503` + `Retry-After: 1` immediately ("AI-Provider Router
gateway is stopped"). The branch is no longer about the webview at all: it is simply "this process has no
listener on the port". `gateway_status.running` reflects the listener in this process, and the app says
plainly when it is delegating to the launchd agent.

## The layer stack

**This table describes the TypeScript packages — the UI plus the test oracle.** The Rust serving stack is
flatter: `gateway.rs` (HTTP surface, admission, auth, spend gate) → `router_bridge.rs` (the driver that owns
the tool loop and emits `BridgeMsg` frames) → `router.rs`/`planner.rs`/`engine.rs` (plan, attempt loop,
classification) → `egress.rs` (the only credential toucher), with `persist.rs`/`store.rs` under everything
and `retention.rs`/`drift.rs` as the off-path housekeeping.

Arrows point downward. **One relaxation is deliberate and must not be "fixed":** L3 services call L1 components
directly (`onboarding-orchestrator` → probe/generator/contract, `drift-monitor` → generator), because those L1
modules are the pipeline's tools rather than a layer beneath it.

| Layer | Contains |
|---|---|
| L4 Presentation | The 13 React screens, and `ipc-client` — the only UI↔core bridge |
| L3 Application | Provider registry, model catalog, usage ledger, onboarding orchestrator, drift monitor |
| L2 Router core | Model router, route planner, health tracker, execution engine, adapter runtime |
| L1 Adapters | Manifest interpreter, builtin templates, probe runner, redaction, adapter generator, contract suite, sandbox |
| L0 Host | Egress gateway, local gateway, vault, SQL store — all Rust |

**Hard rule:** the UI imports nothing except `ipc-client`. Any new screen is a new consumer of `ipc-client`;
nothing else should change.

## Self-construction, and the cycle it breaks

The naive cycle is: the generator needs an AI model (the router), the router needs adapters, and new adapters
come from the generator. It is broken three ways, and all three are load-bearing.

**1. Stratification — the structural break.**

| Tier | What it is | Needs AI? |
|---|---|---|
| 0 | Builtin dialect templates — static data shipped with the app | No |
| 1 | Declarative manifests — inert data, executed by **one** interpreter | No |
| 2 | Sandboxed code adapters — QuickJS (`rquickjs`, in-process Rust), last resort | No at runtime |

The router's only compile-time dependencies are the interpreter and the sandbox — both fixed, shipped code. The
generator's *output* is inert data, not a live dependency, so the runtime graph is a DAG.

**2. Dependency inversion — the module-level break.** `adapter-generator` imports only an `AiTextPort`
interface. `model-router` implements it. No import cycle is possible.

**3. Bootstrap guard plus the exclusion rule — the temporal break.** The generator is disabled until at least
one provider is live via a Tier-0 template, and every generator request carries `excludeProviderIds` containing
the provider being onboarded or repaired. The router can never be asked to serve a generation through the very
adapter that does not exist yet.

**Why this matters for the first run:** OpenRouter and OpenCode Zen are OpenAI-compatible, so the realistic
first-run experience needs **no AI at all**. Fingerprinting plus a builtin template is enough.

### Redaction is a security control, not hygiene

Everything destined for the generator passes `redaction` first: endpoint paths and methods, status codes,
response **JSON schemas with values stripped**, auth header *names* only, and an optional scrubbed docs excerpt.
No response bodies, no header values, a scrub for key-shaped strings, and a size cap.

Probe content is untrusted input — a prompt-injection surface. The defences are the structure-only redaction,
strict schema validation, and manifest lint pinning `baseUrl` to the user's input so a hostile provider cannot
smuggle a host change or an exfiltration endpoint through a generated manifest.

## Drift detection and repair

Providers change their APIs. The system notices and repairs itself, with a human in the loop.

- **Error taxonomy:** thirteen classes live in `core/engine.rs` — `AUTH_FAILED`, `RATE_LIMITED`, `NOT_FOUND`,
  `BAD_REQUEST_SCHEMA`, `PARSE_ERROR`, `SERVER_ERROR`, `TIMEOUT`, plus Rust-only additions such as
  `CLIENT_GATE` (a 401/403 that refused the *client*, not the key — rotating keys would be wrong there).
  Only `NOT_FOUND`, `BAD_REQUEST_SCHEMA`, `PARSE_ERROR` and provider-wide `AUTH_FAILED` count as drift signals.
- **Trigger:** the Rust drift monitor (`core/drift.rs`) reads the **ledger** on every retention pass — every
  30 minutes, not per request. A provider whose enabled traffic shows drift-class failures inside a
  **1-hour window**, while the *same requested model succeeded via a different provider* in that window, is
  drifting: the succeeded-elsewhere proof is what separates a provider-side API change from an upstream
  outage (an outage belongs to cooldowns and the auth breaker, not to repair). One open event per provider;
  the evidence lands in `drift_events` and the provider flips to `repairing`.
- **Repair:** mark `repairing` (failover keeps traffic flowing) → re-probe → re-fingerprint deterministically
  first → only then generate a manifest **patch** → contract suite → stage a new manifest version → human
  confirmation → hot-swap, with one-click rollback. The repair orchestrator is webview-side, and its AI port
  dials the gateway like any other client (`store.ts` `buildRepairPlan` → `gatewaySystemAiPort`).
- **Rate-limited:** at most one automatic re-probe per provider per hour. Repairs are always human-confirmed.
- **Single-provider dead end:** if the broken provider is the user's only one, AI-assisted repair has no
  candidate model. The flow falls back to deterministic re-fingerprinting and says so.

## Where to read more

| For | Read |
|---|---|
| The v1 spec narrative (rationale; hosting sections superseded) | [`../ARCHITECTURE.md`](../ARCHITECTURE.md) |
| Why a choice was made, with the date | [`../DECISIONS.md`](../DECISIONS.md) |
| The headless service and its phases | [10 Headless service](10-headless-service.md) |
| Memory and context subsystem | [`../GATEWAY_MEMORY_LAYER.md`](../GATEWAY_MEMORY_LAYER.md) |
| Control screen and audit trails | [`../CONTROL_SCREEN_BUILD.md`](../CONTROL_SCREEN_BUILD.md) |

## Next

[03 Contracts](03-contracts.md) — the interfaces and invariants that must not drift.
