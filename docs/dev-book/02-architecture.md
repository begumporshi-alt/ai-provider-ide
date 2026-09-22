# 02 — Architecture

The full design narrative is [`../ARCHITECTURE.md`](../ARCHITECTURE.md). This chapter is the part you need
before touching anything: the split, the boundary, and the one place a change is likely to break a promise.

**Diagram:** [`../diagrams/architecture.html`](../../diagrams/architecture.html) — layers, the router, the
gateway and key-blind egress. The request path itself is in [08 Flows](08-flows.md).

## The one security boundary

**The TypeScript layer is key-blind by construction.** This is the single most important fact about the
codebase, and almost every other rule follows from it.

A request from `router-core` does not carry a credential. It carries a `secretRef`:

```
TS  →  { secretRef: "key:k1", method: "POST", url: "…/v1/chat/completions", body, headers }   // no auth
Rust →  resolve k1 in the OS keychain → inject "Authorization: Bearer …" → send → drop the value
```

So the webview never holds a raw secret, and code running in the webview — including anything an AI generated
— cannot leak a key it can never read. There is exactly **one** module allowed to combine a `secretRef` with an
HTTP request: the Rust `egress-gateway`.

Two consequences worth stating plainly:

- **Do not add a `fetch()` in the UI.** It would not work anyway — providers do not send CORS headers, which is
  half the reason HTTP lives in Rust — but it would also create a second, unaudited egress path.
- **A key must never enter webview-observable state.** The one-shot reveal is a Rust-side native action for
  this reason. Do not "simplify" it into a value returned over IPC.

## Two runtimes, one process

| Runtime | Holds | May touch |
|---|---|---|
| Webview (TypeScript) | The entire `router-core` package, the React UI | Nothing privileged. Talks to the host only through 125 typed IPC commands |
| Rust host | The gateway, the egress module, the keychain, SQLite | The network with credentials, the OS keychain, the filesystem |

Both live in one desktop process, but they are not peers. The webview is the brain and the Rust host is the
only thing with hands.

### Why the gateway is Rust and not TypeScript

Three reasons, in order of weight:

1. **Credential injection has to be somewhere audited.** Putting it in Rust makes "all egress flows through one
   module" mechanically true rather than aspirational.
2. **The webview origin cannot call provider APIs at all** — no CORS headers from providers.
3. **The keychain and SQLite are Rust APIs.** Anything else would need a second bridge.

### The gateway bridge, and its availability cost

The gateway bridges external HTTP into the router core, which lives in a **webview**. That is a real
architectural cost, and it is documented rather than hidden:

- The bridge runs in its **own hidden window** (`gateway.html` → `src/gateway-worker.ts`), not in the main app
  window. UI render work and Vite HMR reloads therefore cannot disturb in-flight gateway requests. Rust targets
  that window explicitly — see `GATEWAY_WINDOW` in `gateway_cmds.rs`.
- That window is granted **only** `core:event:allow-listen` and `allow-unlisten` by `capabilities/gateway.json`.
  No filesystem, no shell, no opener.
- **If the webview is reloading, crashed or closed, the gateway answers `503` + `Retry-After: 1` immediately.**
  It does not queue against a dead core.
- The app is **single-window** by decision. A second window would instantiate a second router core.
- A headless service mode — the gateway detached from any window — is an explicit **v2 extension point**, not a
  v1 feature. Until it exists, the gateway's availability is bounded by the app's.

> This is the project's main structural risk and it is worth being honest about: a desktop app whose HTTP
> gateway dies with its window is not a service. The mitigation is the 503 contract plus the window policy, not
> a claim that the problem does not exist.

## The layer stack

Arrows point downward. **One relaxation is deliberate and must not be "fixed":** L3 services call L1 components
directly (`onboarding-orchestrator` → probe/generator/contract, `drift-monitor` → generator), because those L1
modules are the pipeline's tools rather than a layer beneath it.

| Layer | Contains |
|---|---|
| L4 Presentation | The 13 React screens, and `ipc-client` — the only UI↔core bridge |
| L3 Application | Provider registry, model catalog, usage ledger, onboarding orchestrator, drift monitor |
| L2 Router core | Model router, route planner, health tracker, execution engine, adapter runtime |
| L1 Adapters | Manifest interpreter, builtin templates, probe runner, redaction, adapter generator, contract suite, sandbox |
| L0 Host | Egress gateway, local gateway, keychain vault, SQL store — all Rust |

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
| 2 | Sandboxed code adapters — QuickJS-WASM, last resort | No at runtime |

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

- **Error taxonomy:** `AUTH_FAILED`, `RATE_LIMITED`, `NOT_FOUND`, `BAD_REQUEST_SCHEMA`, `PARSE_ERROR`,
  `SERVER_ERROR`, `TIMEOUT`. Only `NOT_FOUND`, `BAD_REQUEST_SCHEMA`, `PARSE_ERROR` and provider-wide
  `AUTH_FAILED` count as drift signals.
- **Trigger:** at least 5 drift-class errors within 15 minutes affecting at least 2 models, while the same
  models succeed via other providers — which is what isolates a provider-side change from our own bug.
- **Repair:** mark `repairing` (failover keeps traffic flowing) → re-probe → re-fingerprint deterministically
  first → only then generate a manifest **patch** → contract suite → stage a new manifest version → human
  confirmation → hot-swap, with one-click rollback.
- **Rate-limited:** at most one automatic re-probe per provider per hour. Repairs are always human-confirmed.
- **Single-provider dead end:** if the broken provider is the user's only one, AI-assisted repair has no
  candidate model. The flow falls back to deterministic re-fingerprinting and says so.

## Where to read more

| For | Read |
|---|---|
| Module map, data flows, acceptance criteria | [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §§1, 3, 9 |
| Why a choice was made, with the date | [`../DECISIONS.md`](../DECISIONS.md) |
| Memory and context subsystem | [`../GATEWAY_MEMORY_LAYER.md`](../GATEWAY_MEMORY_LAYER.md) |
| Control screen and audit trails | [`../CONTROL_SCREEN_BUILD.md`](../CONTROL_SCREEN_BUILD.md) |

## Next

[03 Contracts](03-contracts.md) — the interfaces and invariants that must not drift.
