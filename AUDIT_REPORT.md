# AUDIT REPORT — AI-Provider Router

> **Audited:** [MASTER_PROMPT.md](MASTER_PROMPT.md) (spec/prompt) · [ARCHITECTURE.md](ARCHITECTURE.md)
> (architecture + implementation plan) · [diagrams/](diagrams/) (3 diagram sources)
> **Method:** two independent read-only audit passes — (1) architecture/blueprint/plan/security audit,
> (2) storage-schema design audit — synthesized below. No code exists yet; the documents are the
> entire project.
> **Date:** 2026-09-15
>
> **STATUS 2026-09-15 (later same day): fixes APPLIED.** All CRITICAL/HIGH findings and the
> MEDIUM/LOW items below have been applied to the documents: §2.6 → manifest grammar v1.1;
> new §3.4 compatibility contract, §3.5 gateway bridge contract, §3.6 timeout/concurrency
> policy; §4 → schema v1.1 + migration runner + WAL/backup + restore flow; invariants 12–16
> (webview hardening, gateway auth hardening, port-squatting); §2.1 typo fixed; Phase 0
> decisions spike + Phase 2a/2b split in §9; acceptance criteria 7–10 + de-staled build order
> in MASTER_PROMPT.md; H4 resolved earlier (third provider = b.ai, confirmed by the user).
> Findings below are the historical audit record; the documents are now the source of truth.

---

## Verdict

| Artifact | Verdict |
|---|---|
| Architecture | **READY AFTER FIXES** — shape is sound; specification gaps, not rework |
| Implementation plan | **READY AFTER FIXES** — ordering error + sizing + missing items |
| Master prompt | **READY AFTER FIXES** — stale sections, missing acceptance criteria for the two user-directive features |
| Storage schema | **SOUND AFTER FIXES** — right table shape; missing constraints/indices/rollups + 1 critical gap |

**Nothing found requires changing the architecture's shape.** All fixes are document-level or
additive schema work. With the top fixes applied (§7), the project is ready to scaffold Phase 0.

---

## 1. Strengths (confirmed by audit — keep as-is)

- **Three-way circular-dependency break** (§2.8): Tier-0 templates (no AI) / Tier-1 inert manifest
  data / Tier-2 sandbox, the `AiTextPort` dependency inversion, and the `excludeProviderIds`
  bootstrap guard. "Textbook-quality" — the runtime graph is a true DAG.
- **Key-blind egress** (§1.1, §5.2): secrets only in the Rust host; TS sends `{secretRef,
  request-without-auth}`. Mechanically enforced by module boundaries, not convention.
- **Bootstrap resolution** (§2.9): deterministic fingerprinting + templates solves cold-start
  without AI; the `systemAiAvailable` gate with honest UX copy.
- **Redaction contract + host pinning + paid-consent** (§2.3, §2.5): prompt injection addressed
  head-on; `generator_audit` records hashes, never content.
- **Storage split** (§4): refs in SQLite, secrets in keychain, CI key-leak grep test.
- **Drift design** (§2.10): error taxonomy, cross-provider isolation heuristic, versioned
  manifests with rollback, always-human-confirmed repairs.
- **Phase ordering** (host → core → UI → deterministic onboarding → AI generation → self-healing
  → sandbox): deterministic-before-AI-assisted is exactly right; per-phase acceptance mapping
  for criteria 1–6.
- Correct `keytar`→`keyring` correction, documented rather than silent.

---

## 2. Critical & High findings (must fix before/with Phase 0)

### [CRITICAL] C1 — Ledger cannot record the gateway traffic it is documented to record
§3.3 writes `usage-ledger.append({ ..., internal: false, via: "gateway" })` but the §4 `ledger`
table has **no `via` column**. The Usage screen cannot distinguish IDE traffic from Local
Gateway traffic — a headline feature with no data home.
**Fix:** replace the boolean `internal` with `source TEXT CHECK (source IN ('ui','gateway','generator'))`. *(Schema audit A1; also flagged by architecture audit 3.3.)*

### [HIGH] H1 — Gateway↔webview bridge has unspecified failure modes
The entire gateway request path is: external app → axum → Tauri IPC → **webview event loop** →
TS router → back. Nothing specifies behavior when the webview is reloading (constant under HMR),
crashed, or its window closed (Tauri exits on last-window close by default): no 503/Retry-After
semantics, no client-disconnect → provider-stream cancellation, no concurrency bound, no
window-close/tray policy for v1.
**Fix:** add a "Gateway bridge contract" section (availability semantics, cancellation
propagation, max-concurrent bound + queueing, window policy, headless-mode scope) and **gate
Phase 2 on an end-to-end SSE-through-IPC spike**.

### [HIGH] H2 — The OpenAI-compatibility surface and normalization contract are undefined
"OpenAI-compatible" is the gateway's entire value proposition, but: no decision on
`tools`/`tool_choice`/`response_format`/`temperature` (agentic clients like Cursor send these —
silently dropping them produces wrong behavior, not errors), no merged `/v1/models` ID scheme
(`gpt-4o` exists on both OpenRouter and OpenCode — who serves it?), no gateway error-JSON shape,
no embeddings in/out decision. This also gates the manifest grammar (see M2).
**Fix:** add a "Compatibility contract" section before Phase 1 freezes schema v1.

### [HIGH] H3 — The two user-directive features have no acceptance criteria; the prompt's build order is stale
MASTER_PROMPT §8 criteria 1–6 are all pre-directive; self-construction (req 12) and the gateway
(req 13) — the differentiators — have no definition of done. The prompt's build order omits the
gateway entirely and its screen list misses the Gateway settings screen.
**Fix:** add criteria 7–10, e.g. *"7. Fresh install, zero AI: add an OpenAI-compatible provider
via the wizard and complete a Playground request." / "8. `curl` with the master key streams a
completion through the gateway; wrong key → 401; rotation kills the old key immediately." /
"9. Mock-provider drift is detected, patched, confirmed, and rolled back." / "10. Gateway
traffic is queryable in the ledger with source attribution."* Update the build order to match
ARCHITECTURE §9.

### [HIGH → RESOLVED] H4 — The third drawn provider ("Bolt") was a three-way inconsistency
AC-1 (Phase 2) required "all three drawn providers"; the provider's existence was only to be
investigated in **Phase 4**; the architecture diagram showed only two providers.
**RESOLVED 2026-09-15 by the user:** the third provider is **b.ai** (the vision analysis misread
the handwriting as "Bolt"). b.ai is a real, working AI provider — Anthropic-compatible
(`https://api.b.ai/v1`; the user's own config carries models `qwen3.8-flash`, `hy3`) — so AC-1 is
deliverable and both builtin dialect templates (openai-compat and anthropic-compat) are exercised
by the drawn trio.
**Remaining fix:** the Phase 0 spike still pins b.ai's exact auth style, model-list endpoint, and
pricing (and OpenCode Zen's base URL/auth) — facts to record, not existence questions.

### [HIGH] H5 — The webview is trusted absolutely, and that trust is never established
The UI renders model/provider-controlled text (catalog names, error messages, docs excerpts,
Playground output). One XSS slip gives injected JS `vault:reveal` (read a raw key) and
`egress:*` (spend with the user's credentials); `tauri-plugin-sql` lets webview JS run arbitrary
SQL. The key-blind design prevents leakage *by the Generator*, not *use/read by a compromised
webview*. No CSP, no Tauri 2 capability scoping, no text-only rendering rule.
**Fix:** add invariants 12–14: strict CSP; capability files scoping each command namespace
(`egress:*` core-context only); untrusted content renders as text only; reveal via a Rust-side
native dialog/copy that never enters the webview DOM. Cheap now, painful to retrofit.

### [HIGH] H6 — Schema has no constraints or indices at all
§4 is bare column lists: no PRIMARY KEYs, FOREIGN KEYs, UNIQUEs, or CHECKs (duplicate slugs,
two active manifests, orphaned keys, status typos all possible), and no indices — the hot
queries (drift windows, usage by time/provider, alias resolution, catalog by provider/modality)
would sequentially scan a 90-day append-only ledger. Also no `ledger_rollups` table despite the
documented 90-day + monthly-rollup retention policy.
**Fix:** apply the full constraint/index/rollup DDL delta in §5 below.

### [HIGH] H7 — New-machine restore has a dangling-`secret_ref` hole
The DB references keychain accounts (`key:<keyId>`) that don't exist on a new machine; every
egress request fails with a keychain lookup error, and the flow is described nowhere.
**Fix:** on startup, key-vault probes each `secret_ref`; on miss set `api_keys.status='invalid'`
and surface a re-enter-key UX (a `secret_hint` column — last 4 chars — makes it usable). Add a
no-secrets config export (manifests, aliases, settings, refs) for portable disaster recovery.

---

## 3. Medium findings

| # | Finding | Fix |
|---|---|---|
| M1 | **No request cancellation anywhere** — Playground stop, client hang-up, app quit all burn tokens to completion; same mechanism H1 needs | `router.generateText(req, { signal })`; channel teardown; gateway disconnect → core abort |
| M2 | **Manifest grammar v1 holes** — single auth header (no `api-key`+`organization`), no extra request headers (OpenRouter attribution), `{{maxTokens}}` emitted unconditionally (null breaks servers), no stream-error mapping, no model-list pagination → providers silently forced to Tier 2 | Extend grammar before Phase 1 freeze, or explicitly declare out-of-grammar |
| M3 | **`imageUrl` results conflict with the egress allowlist** (CDN hosts ≠ baseUrl host); retrieval path undefined | Define the carve-out: egress may follow URLs returned in a same-request response body, never persisted to the allowlist |
| M4 | **Timeout/retry/concurrency under-specified** — one "request timeout" can't serve connect/first-byte/idle-stream/total; retry-vs-rotation interplay undefined; no per-provider concurrency caps | Per-phase timeout budgets, max attempts, jittered backoff as planner policy; per-provider cap + bounded queue |
| M5 | **No backup/diagnostics story** compatible with "no telemetry" — no config export, no local crash logs, no scrubbed diagnostics bundle | Export/import format (SQLite snapshot minus secrets) + user-initiated diagnostics bundle through `redaction` |
| M6 | **Alias map has no population story** — failover (AC-3) depends on `model_aliases` but nothing creates them | Auto-derive same-native-ID across providers + manual alias editor in Model Browser |
| M7 | **§2.1 typo: "success → jump to [5]"** skips the contract suite (registration without validation); contradicts the state machine, the diagram, and req 12 | Correct to "[4]"; wording pass on diagram end-node vs §2.1 order |
| M8 | **Phase 2 has no provider-creation path** yet must deliver AC-1 (onboarding wizard is Phase 3) | State that Phase 2 includes a minimal manual add-provider form (backed by Phase 1 templates) |
| M9 | **Phase 1/2 sized M; realistically L** (Phase 1 = ~12 cross-language deliverables; Phase 2 = 7 UI modules + full axum gateway with SSE-through-IPC) | Resize to L or split Phase 2 (screens / gateway) with the H1 spike as the gateway phase's entry gate |
| M10 | **No test strategy for the Phase-2 gateway** (E2E is Phase 3+/6) — the only component accepting network input | Phase 2 must include Rust integration tests for the gateway (vs the Phase 1 mock server) + key-leak grep in Phase-2 CI |
| M11 | **LAN opt-in under-specified** — cleartext HTTP for key + prompts, no auth throttling, no constant-time compare | Throttle + constant-time compare; the LAN warning must state cleartext exposure |
| M12 | **Localhost port-squatting** — any local process can bind 8787 first and harvest pasted master keys | Document residual risk in settings UI; consider random high port default (8787 as opt-in); loud bind-failure detection |
| M13 | **Schema semantics** — `providers.enabled` duplicates `status`; `ledger.model` ambiguous (requested alias vs native served); timestamps unconventioned; `cost_estimate_micros` currency undefined; `providers.type` undefined; `onboarding_sessions` lacks `updated_at` + state enums; key status enum unnamed; single-active manifest unenforced | See DDL delta §5: drop `enabled`, split `requested_model`/`model`, INTEGER Unix-ms UTC everywhere, micro-USD pinned, partial unique index on active manifests, `updated_at` + CHECKs |
| M14 | **Migration split-brain risk** — tauri-plugin-sql's own migration list vs better-sqlite3 in tests = two mechanisms drifting | One ~50-line migration runner behind `store-port` (ordered `NNNN_name.sql`, transactional, history in `schema_version(version, name, applied_at)`) |
| M15 | **No WAL/pragma or DB-corruption story** — two SQLite consumers + async gateway traffic; the DB holds all AI-generated manifests (which cost real money) | `journal_mode=WAL, synchronous=NORMAL, foreign_keys=ON, busy_timeout=5000` per connection; `VACUUM INTO` dated backups (keep 7); `integrity_check` on open |
| M16 | **Unlisted risks** — webview as gateway bottleneck (H1), provider-semantics divergence breaking OpenAI-compat (H2), runaway spend via gateway consumers (no budgets/per-app keys — state as v1 known limit), model-ID collision, `quickjs-emscripten` maintenance, `tauri-plugin-sql` SQL surface | Add to the §8 risk register |

---

## 4. Low / informational findings

- **L1** Single-provider repair dead-end: repair of the only provider has zero Generator
  candidates (`excludeProviderIds=[P]`) — fall back to deterministic re-fingerprint with an
  explanatory message.
- **L2** `key-vault-service` "never exposes secrets to TS" contradicts the one-shot-reveal
  invariant — reword + implement reveal Rust-side (see H5).
- **L3** MASTER_PROMPT staleness cluster: §7 still offers "Tauri or Electron" (architecture
  commits to Tauri 2); screen 3 omits the system-AI pick; AC-6 says "one adapter file" vs the
  architecture's better "data-only via wizard"; package naming `@aiprovider/router-core` vs
  `packages/router-core` — pick one.
- **L4** Sandbox hardening details: WASM memory cap, rate limit on the sandbox `http` host
  function, lint bounds on OpenAPI-derived path counts.
- **L5** Allowlist wording: the *candidate's* baseUrl during probing is neither a registered
  provider nor a docs URL — clarify user-supplied baseUrls are allowlisted at input time;
  consider a lint whitelist of request-body fields per endpoint.
- **L6** Lifecycle hygiene: port-conflict UX, key-deletion → keychain cleanup, playground
  persistence, models-cache TTL, single-window rule (second window = second router core),
  i18n/a11y as declared non-goals, per-app gateway keys as a stated v1 limitation.
- **L7** tauri-driver macOS coverage is limited — state the per-OS E2E strategy (Playwright vs
  Vite dev server for UI logic; tauri-driver on Linux CI).
- **L8** Layering is intentionally relaxed (L3→L1 calls in the graph) — fine; note it so nobody
  "fixes" it later.

---

## 5. Schema v1.1 DDL delta (from the storage audit — apply to §4)

```sql
-- Conventions: all timestamps INTEGER Unix milliseconds (UTC);
-- cost_estimate_micros = micro-USD (pricing_json normalized to USD at cache-write time).

-- providers: drop `enabled` (derive from status); add rotation strategy
--   status TEXT NOT NULL CHECK (status IN ('draft','pending','enabled','disabled','repairing')),
--   rotation_strategy TEXT NOT NULL DEFAULT 'round_robin'
--     CHECK (rotation_strategy IN ('round_robin','lru','priority','cost_spread')),
--   slug TEXT NOT NULL UNIQUE, id TEXT PRIMARY KEY

-- api_keys: constraints + restore UX
--   PRIMARY KEY (id),
--   FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
--   status TEXT NOT NULL CHECK (status IN ('active','cooldown','invalid','disabled')),
--   secret_hint TEXT,          -- last 4 chars only; NOT the secret
--   cooldown_until INTEGER    -- NULL = none; survives restart
CREATE INDEX idx_api_keys_plan ON api_keys(provider_id, status, priority);

-- manifests: exactly one active per provider
--   PRIMARY KEY (id), FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
--   UNIQUE (provider_id, version)
CREATE UNIQUE INDEX uq_manifests_one_active ON manifests(provider_id) WHERE is_active = 1;

-- models_cache: natural identity
--   PRIMARY KEY (id), UNIQUE (provider_id, native_id)
CREATE INDEX idx_models_provider_modality ON models_cache(provider_id, modality);

-- model_aliases: NO FK to models_cache (cache refresh must not destroy the failover map)
--   PRIMARY KEY (alias, provider_id)
CREATE INDEX idx_aliases_alias ON model_aliases(alias);

-- ledger: source tracking (replaces `internal`), requested-vs-served model, NO FKs (log semantics)
--   ts INTEGER NOT NULL,
--   source TEXT NOT NULL DEFAULT 'ui' CHECK (source IN ('ui','gateway','generator')),
--   requested_model TEXT,      -- alias the caller asked for
--   model TEXT NOT NULL,       -- native model that actually served
--   id INTEGER PRIMARY KEY
CREATE INDEX idx_ledger_ts ON ledger(ts);
CREATE INDEX idx_ledger_provider_ts ON ledger(provider_id, ts);
CREATE INDEX idx_ledger_drift ON ledger(provider_id, ts)
  WHERE error_class IN ('NOT_FOUND','BAD_REQUEST_SCHEMA','PARSE_ERROR','AUTH_FAILED');

-- NEW: monthly rollups (kept indefinitely; idempotent upsert, complete months only)
CREATE TABLE ledger_rollups (
  month TEXT NOT NULL,                -- 'YYYY-MM' UTC
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  modality TEXT NOT NULL CHECK (modality IN ('text','image')),
  requests INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_estimate_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, provider_id, model, modality)
);

CREATE INDEX idx_drift_provider_time ON drift_events(provider_id, detected_at);

-- onboarding_sessions: updated_at + enumerated state machine (10 states from §2.1)
-- generator_audit: session_id ... ON DELETE SET NULL (audit outlives session pruning)

-- schema_version: migration history applied by ONE runner behind store-port
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

-- connection init (every connection, both drivers):
-- PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
-- PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
```

---

## 6. Implementation-plan corrections

1. **Phase 0 (new):** provider-facts spike (pin b.ai auth/models/pricing — existence confirmed
   2026-09-15 — and OpenCode Zen URL/auth) +
   compatibility-contract decision (H2) + manifest-grammar extension (M2) + gateway-bridge
   contract spec (H1) + webview hardening invariants (H5). All document work, hours–days.
2. **Phase 1:** resize M→L; add the DDL delta §5, migration runner, WAL/backup story.
3. **Phase 2:** split into 2a (shell + screens, incl. minimal manual add-provider per M8) and
   2b (gateway: entry-gated by the SSE-through-IPC spike; must ship Rust integration tests +
   key-leak grep per M10).
4. **Phase 3–6:** unchanged in order; add alias auto-derivation tests (M6) to Phase 1/3;
   export/diagnostics (M5) and cancellation (M1, with H1) to their dependency phases.
5. **Acceptance criteria 7–10** added (H3) and traced in the §9 table.

---

## 7. Top fixes before writing code

1. **Gateway bridge contract + end-to-end SSE-through-IPC spike** (H1, M1) — the single largest
   delivery risk.
2. **Compatibility contract: OpenAI field subset, tools in/out, merged `/v1/models` ID scheme,
   error shape, embeddings** — then extend manifest grammar v1 (H2, M2) before it freezes.
3. **Acceptance criteria 7–10 + de-stale the master prompt** (H3, L3) — the differentiators get
   a definition of done.
4. **Phase 0 provider-facts spike** (H4, now resolved to fact-pinning: b.ai details +
   OpenCode Zen) — *before* Phase 2 needs them.
5. **Webview hardening invariants (CSP, capability scoping, text-only rendering, Rust-side
   reveal) + gateway auth throttling/constant-time/ LAN cleartext warning** (H5, M11).
6. **Schema v1.1 DDL delta + migration runner + WAL/backup + restore-on-new-machine flow**
   (C1, H6, H7, M13–M15) — additive now, expensive after the first shipped migration.

---

*Audit sources: architecture-blueprint pass (30 findings: 5 HIGH, 8 MEDIUM, 8 LOW/INFO across
soundness/completeness/consistency/plan/security/risks) and database-expert pass (18 findings:
1 CRITICAL, 4 HIGH, 11 MEDIUM, 2 LOW/INFO + consolidated DDL delta). Full agent outputs retained
in the session record; this report is the deduplicated synthesis.*
