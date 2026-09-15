# UI/UX PLAN — AI-Provider IDE (v1)

> **Source:** two-round design discussion with ChatGPT (GPT), 2026-09-15 — round 1: full
> direction; round 2: pushback (theme scope, Overview screen, build order, AI-wait UX,
> component inventory, cut list). This document is the synthesized, locked plan.
> **Companion docs:** [MASTER_PROMPT.md](MASTER_PROMPT.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
> [AUDIT_REPORT.md](AUDIT_REPORT.md)

---

## North star

> **Fast to connect. Easy to understand. Impossible to accidentally hide what happened.**

The product is not "a place to store API keys" — it is a **local AI routing layer**. Providers
are inputs, the router is the product, the gateway is the output. The default experience is
calm (`✓ 421ms · OpenRouter · key-03`); every interesting event is explorable on demand
(*"Simple by default. Observable on demand."*).

## Locked v1 decisions

| Decision | Choice | Rationale |
|---|---|---|
| Theme | **Dark-only v1**, semantic CSS-variable tokens from day one (`--bg`, `--surface`, `--success`…, never `--dark-gray-1`) | Light mode's real cost is testing every state; defer to v1.1 via `[data-theme="light"]`. Tonal elevation (bg → sidebar → cards → modals) keeps dense info from becoming a gray blob |
| Navigation | **Sidebar** (grouped: PROVIDERS / TOOLS / SYSTEM) + **⌘K command palette** | 7 screens is sidebar territory; tabs only *inside* screens (Models: Text/Image; Activity: Requests/Failures) |
| Home screen | **Providers** — with a first-run hero that evolves into the operational summary | No Overview/dashboard screen in v1; a persistent sidebar health chip (`● Router healthy`) covers ambient status. Overview is a v1.1+ promotion when there's volume worth monitoring |
| "Add Provider" placement | An **action** inside Providers (`+ Add Provider`), not a peer screen | The entry point never changes; later phases add paths behind it |
| AI-wait UX | **Build-pipeline pattern** — staged milestones, parallel candidate cards, scorecard. **No streaming of the model's reasoning** | "Compiling/testing", not "watching an AI think"; no fake determinate percentages |
| Visual language | Linear's density + Raycast's command feel + VS Code credibility; **no AI-SaaS look** (giant cards, gradients, glow, purple-everything) | This is infrastructure: precise, trustworthy, inspectable |

## Design system

**Density** (medium-high): sidebar 220–240px · top bar 48–52px · table rows 36–44px · spacing
12–16px · corner radius 4–6px. Cards only for entity summaries; **tables for dense collections**
(15 providers × 40 keys × 300 models must not become a card wall).

**Typography**: UI sans (Inter/Geist/IBM Plex Sans); monospace *selectively* for technical
content only (endpoint URLs, model IDs, key fingerprints, latency, token counts, manifests).
Ramp: page title 20–24 semibold · section 14–16 semibold · body 13–14 · metadata 12 · code 12–13
mono. Hierarchy via weight + spacing, not huge size jumps.

**Color = state, not decoration**: green healthy/success · amber degraded/retrying · red
failed/dead/disabled · blue selection/informational · purple *sparingly* for AI-generated /
System-AI activity.

**One health vocabulary everywhere** (a single state machine reused by provider/key/model/router
on every screen): `Healthy · Testing · Degraded · Rate Limited · Cooling Down · Auth Failed ·
Unavailable · Disabled · Unknown`. Never three words for the same state.

**Four concepts, visually preserved everywhere**: Provider → Key → Model → Route
(`fast-chat → OpenRouter → key-03 → ✓ 421ms`). Never collapse into "OpenRouter — fast-chat":
once failover exists, users must see what *actually happened*.

## Screen-by-screen (what each must nail)

1. **Providers (home)** — first-run hero ("Connect your first provider" + the 3 drawn providers
   + "live in about 2 minutes"); then summary line (`3 providers · 8 keys · 47 models`) and
   compact provider cards with key rows: `key-03 · ••••••••7A2F · status · requests` —
   identity without secrets, full key lifecycle (add/test/enable/reorder/reveal-once/remove)
   without menu-hunting.
2. **Model Browser** — IDE explorer, not marketplace: Text/Image tabs, search + provider
   filters, dense table (Model · Provider · Context · Default · Alias). **Aliases are the
   value moment**: `fast-chat ↳ OpenRouter:model-x ↳ OpenCode:model-y` made explicit.
3. **Playground** — a **router diagnostic console**, not just a chatbot: model picker with
   alias resolution shown (`fast-chat → Auto → OpenRouter · key-03`); after every request an
   expandable diagnostics line; fallback promotes to `↻ 1 fallback · 1.2s` (click → RouteTrace
   with per-attempt outcomes). Image generation gets a **purpose-built workspace** (prompt,
   model, aspect ratio, output) — not the chat UI reused.
4. **Activity** — a professional **request ledger first**, analytics later (rollups are v1.1):
   dense table (time, model, provider, key, latency, tokens, cost, status) + a request-detail
   **drawer** (outcome, routing chain, timing breakdown). The routing trace is the trust asset.
5. **Router Settings** — sectioned (Routing / Reliability / System AI), no mega-form. The
   System AI pick gets explanatory treatment ("the model used for fingerprinting, adapter
   generation, diagnostics — runs against your configured providers").
6. **Add Provider wizard** — a pipeline, visually distinct from settings: persistent stepper
   (Connect → Probe → Identify → Build → Test → Review → Enable), human-language center
   ("Checking how this API behaves") with expandable technical detail, **always cancellable**.
   AI generation: 3 parallel candidate cards updating live, then a **verification scorecard**
   (checks × candidates, `8/8 · 7/8 · 8/8`, Recommended: A), then a **diff-like adapter
   review** — *"AI proposed this adapter. You approve it."* [Reject] / [Approve & Enable].
7. **Local Gateway** — "turning on a local service", not API config: Running status, the
   endpoint URL prominent, master key as `SecretAction` (copy primary, reveal-once secondary),
   client copy-presets (Cursor / OpenAI SDK / cURL).

## Make-or-break flows

- **First run (< 2 min):** welcome → pick provider (3 known + custom-coming-soon) → paste key
  ("stored in your OS keychain") → automatic test (`✓ Connected · 43 models · Text API
  compatible`) → *"Your router is live"* → **[Try a model]** (into Playground, not Settings).
- **Rotation/failover without noise — three levels:** (1) ambient: `✓ 421ms · OpenRouter ·
  key-03` or `↻ 1 fallback`; (2) inspectable: click → RouteTrace; (3) diagnostic: full timing
  and failure reasons. Only the exceptional event gets promoted.
- **Key dies mid-request:** if failover succeeds → success + one-line note ("Primary key
  rejected auth — retried with key-02 ✓"); if all keys fail → named attempts list
  (`key-01 401 · key-02 429 · key-03 timeout`) + [Test provider]. Never a bare
  "500 Internal Server Error". **Provider failure ≠ system failure** — green router + red
  provider is a *success state* for this architecture.
- **The 45-second AI wait:** milestone checklist (Understand API ✓ → Generate candidates ● →
  Contract tests ○ → Review ○), the actual contract dimensions listed as "what we're testing"
  (auth, models, text, streaming, errors, timeouts), live candidate cards, "you can leave this
  window open", Cancel always available. No percentages, no spinners-alone, no reasoning stream.

## State design checklist (write into the design system before implementation)

- **Empty** — every screen gets a useful empty state with a direct action ("No models
  discovered yet — connect a provider to populate your catalog").
- **Loading** — operation-specific verbs ("Discovering models…", "Testing key 2 of 3…"),
  skeletons for predictable content, progress for operations.
- **Streaming** — unmistakable ("Assistant is responding ●") with stable metadata beneath;
  no layout jump as text grows; final line lands with the routing summary.
- **Partial failure** — locally scoped (one provider ⚠ while router stays ● operational).

## Component inventory (19 + 1 — the shared design/code vocabulary)

`StatusDot` · `StatusBadge` · `KeyFingerprint` (masked, never the secret) · `ProviderIdentity` ·
`ProviderCard` · `KeyRow` · `ModelRow` · `ModelPicker` (searchable, alias-aware) ·
**`RouteTrace`** (model → provider → key → outcome, expandable fallback attempts — the most
important component in the app) · `RequestStatus` (`✓ 421ms` / `↻ 1 fallback` / `✕ Failed`) ·
`RequestDetailDrawer` · `HealthSummary` (sidebar chip) · `EmptyState` · `OperationProgress`
(the wizard's backbone) · `ActivityRow` · `SecretAction` (reveal/copy/rotate/revoke pattern) ·
`ConfirmDestructiveDialog` · `DiagnosticPanel` (expandable technical detail) ·
`CommandPalette` (⌘K) · `EventToast` (quiet — meaningful state transitions only, never
per-request).

## The v1 cut list (discipline)

No Overview dashboard (v1.1) · no light theme (v1.1, tokens ready) · no animated
traffic/topology visualization · no advanced analytics (cost/token graphs, heatmaps) · no
streaming AI reasoning · no three-IDE candidate workspace (compact cards only) · no custom
routing-rule graphs (round-robin/LRU/priority/failover/timeouts/caps are enough) · no provider
marketplace/directory (bring-your-own-accounts is the value) · no cinematic onboarding ·
no deep keyboard-shortcut system beyond ⌘K · no notification center (Activity is the record) ·
no deep gateway client-management (Running/endpoint/key/copy presets suffice).

## Phase mapping (engineering ↔ UX)

| Phase | UI work | Polish budget |
|---|---|---|
| 2a shell + screens | Sidebar shell, Providers (incl. first-run hero + **honest interim add-flow**: 3 known providers + "custom coming soon" — never fake the wizard), Playground, Models, Activity, Router Settings | Providers 35% · Playground 25% · Models 20% · Activity 12% · Settings 8% |
| 2b gateway | Gateway screen: Running, endpoint, `SecretAction` master key, copy presets | functional-clean |
| 3 wizard | Stepper, OperationProgress, template path end-to-end | high |
| 4 AI generation | Candidate cards, scorecard, adapter review ([Reject]/[Approve & Enable]) | high — the trust moment |
| 5 self-healing | Repair flow UI (reuses wizard patterns), rollback | functional |
| 6 hardening | Config export, diagnostics bundle surfaces | functional |

**The experience ladder** (each phase adds capability to the same UX, no redesigns):
connect provider → discover models → try model → see the successful route → add another key →
watch automatic failover → add a custom provider → AI proposes adapter → contract tests →
human approves → expose everything through the Gateway.
