# Assistant chat — gap analysis & phased implementation plan

Date: 2026-09-30
Scope: `apps/desktop/src/screens/Assistant.tsx` and the shared components it depends on.
Reference: compared against Claude Code, Cursor, Cline, Continue, Windsurf, Zed, and the
ChatGPT/Claude web chat surfaces.

## Status

- **Phase 1 — DONE (2026-09-30).** Per-message actions (copy / retry / edit-&-resend / fork /
  delete-from-here). `Msg.id` + `newMsgId`/`withIds`; `send()` refactored into `runTurn(text,
  baseMsgs)` shared by send/retry/edit; pure index helpers `retryPoint`/`editPoint` in
  `lib/chat/actions.ts` (6 unit tests). 283 unit tests green, typecheck + vite build clean.
- **Phase 6 (cheap trio) — DONE (2026-09-30).** Sticky auto-scroll + "jump to latest" pill;
  Chat/Image panels now stay mounted and hide with CSS (fixes transcript loss on tab switch AND
  the orphaned in-flight run / missing Stop); image tab got a working Stop via AbortController +
  signal.
- **Web-test picker debt — FIXED (2026-09-30).** The `web-test` specs drove the model picker via
  `getByRole("combobox")`, which stopped matching in commit `721c115` (searchable picker). All
  four specs now use a shared `web-test/model-picker.ts` helper. Full suite went 86→101 passing;
  `ui.spec.ts` is fully green.
- **Remaining (pre-existing, NOT this work):** 17 web-test failures cluster in the **Memory**
  subsystem (12: memory.spec 9, memory-recall 3, smoke 1 — one root cause: seeded memory does not
  render on the Memory screen / reach the graph) and **trail-health + drift-history** (4). Neither
  screen is touched by the Assistant work; both need their own investigation.

## What already exists (baseline — do not rebuild)

- Searchable model picker with qualified/bare id forms (`ModelPicker`, `lib/models/selectable.ts`).
- Streaming text with markdown + Prism highlighting + per-code-block copy (`components/Markdown.tsx`).
- Stop button, per-request trace line (ms / provider / key / fallback chain).
- Agent mode: 8 sandboxed tools (`lib/tools/registry.ts`), per-call allow/deny modal, workspace-root
  confinement, live sandbox policy, tool-step budget, memory recall/distillation.
- Persistence to the `context_nodes` graph; History screen with rename/delete + resume.

The gaps below are almost entirely in the **conversation surface**, not the router.

---

## Grounding facts that shape the plan

1. `TextRequest` (`packages/router-core/src/ports.ts:74`) **already declares** `temperature`,
   `maxTokens`, `responseFormat` — per-request parameters are pass-through-ready; only the UI is missing.
2. `CodeCandidateReview` is **not** a generic change-review component — it is specific to Tier-2 code
   adapters (schema/lint/compile/contract gates). File-change review needs a new component.
3. `startSession()` / `activeSession()` (`lib/context/recorder.ts`) exist — "New chat" is a clean call.
4. `orchestrator` keeps AbortControllers in a **module-level** `Map` (`lib/agent/orchestrator.ts:32`)
   and already survives navigation to the dashboard. The tab-switch orphan is because the plain-chat
   path and `Chat` keep a *local* `abortRef` instead of registering with the orchestrator.
5. `msgs` in `Chat` is keyed by array index (`key={i}`) and has no stable identity — retry/edit/fork
   require message ids first.
6. `Chat` unmounts on the Chat↔Image tab switch; any state that must survive that switch belongs in
   `AssistantScreen` (as the option switches already do) or in a module-level store.

---

## Phase 1 — Per-message actions (retry · regenerate · edit · copy · fork)

**Why first.** This is the defining feature of every coding-agent chat and is entirely absent. It is
self-contained in `Assistant.tsx` and touches no router code.

**Deliverables**
- Stable ids on `Msg` (`id: string`, generated on append) and `key={m.id}` in the render loop.
- Hover action row on each turn: **Copy**, **Retry** (assistant), **Edit & resend** (user),
  **Delete turn** (and everything after it), **Fork from here**.
- Retry/regenerate: re-run `send()` from a truncated history (`msgs.slice(0, i)`) reusing the existing
  `replayHistory` builder; only the last user turn keeps its text.
- Edit & resend: inline editor over the user bubble; on commit, truncate at that turn and re-send.
- Fork: clone `msgs.slice(0, i)` into a new session id (`startSession(newId)`) and continue there.

**Files:** `screens/Assistant.tsx` (new `MessageActions` component), `lib/context/recorder.ts`
(fork helper), `ui-state.ts` if fork needs a resume handoff (it already has `resumeTranscript`).

**Effort:** M. **Risk:** low (pure UI + reuse of existing send path).

**Acceptance:** retry on a failed turn re-issues the same prompt and replaces the failed bubble; edit
truncates and re-sends; copy puts the raw message on the clipboard; fork opens a clean session seeded
with the prefix.

**Tests:** extend `lib/assistant-stream.test.ts`-style unit coverage for the truncation helper; an e2e
that retries a mocked failing turn.

---

## Phase 2 — Tool-result rendering (diff view · file links · structure)

**Why second.** Agent edits are currently unreadable: `edit_file`/`write_file` show raw JSON args and
plain `<pre>`. This is what separates a coding agent from a shell, and there is **no diff renderer
anywhere in the app**.

**Deliverables**
- `components/DiffView.tsx`: unified diff for `edit_file` (old→new) and `write_file` (new file), with
  added/removed line colouring and a copy button. Reuse the existing markdown Prism setup for context.
- File-path linkification: `path:line` tokens in tool output become clickable, opening the file in the
  host (new `invoke("open_path", …)` or reveal-in-finder; guard to workspace root).
- Structured `ToolResultBubble`: syntax-highlighted content for code results, line count badge,
  recognized-result renderers (`search_files` → grouped matches; `list_dir` → tree).
- Wire the same renderers into `History.tsx` timeline tool chips so past runs read the same way.

**Files:** new `components/DiffView.tsx`; `screens/Assistant.tsx` (`AgentLive`, `ToolResultBubble`);
`screens/History.tsx`; `lib/tools/registry.ts` (declare which args are file paths/diffs per tool, so
rendering is data-driven not name-hardcoded); Tauri `open_path` command.

**Effort:** M/L. **Risk:** low-medium (path-link command needs root confinement like `tool_run`).

**Acceptance:** an `edit_file` call renders as a red/green diff; clicking `src/x.ts:42` opens the file;
a `search_files` result groups by file.

---

## Phase 3 — Composer (attachments · vision input · slash commands · auto-resize)

**Why third.** A 2-row textarea with Enter-to-send blocks real multimodal use: you cannot send an image
*into* the text chat for vision models, and cannot attach a file to context.

**Deliverables**
- Auto-growing composer + a small toolbar (attach, model, params).
- **Attachments**: drag-drop, paste-image, and a file picker. Images → base64 `image_url` content parts
  (the router forwards `ChatMessage.content`; needs a content-parts extension — see note). Text files →
  appended as a fenced context block or an `@file` reference.
- **@-mentions**: type `@` to fuzzy-search workspace files (reuse `search_files` host call), inserting a
  path the agent resolves or the composer inlines.
- **Slash commands**: `/clear` (reset transcript), `/compact` (force Tier-2 summarize), `/model`
  (open picker), `/image` (switch tab). A tiny command registry, not a framework.

**Dependency / note:** image input requires `ChatMessage.content` to accept content-parts. Today it is
`string` only (`ports.ts:67`). **DECISION (2026-09-30, delegated to the implementer): widen it.**
Rationale: (a) all three dialects carry image parts natively — OpenAI `content` array, Anthropic
`image` blocks, Gemini `inlineData` — so the mapping is well-defined, and the per-dialect normalizer
already exists (`normalizeDialectMessages` in `manifest-interpreter.ts`) as the natural seam to extend;
(b) the alternative (inlining a data URI into `content`) puts megabytes into the message string, corrupts
token accounting, and cannot express multiple images or interleaved text+image ordering. Land it
backward-compatibly: widen the type to `string | ContentPart[]`, have the normalizer lift a plain
`string` to a single text part, and gate composer image input on the model declaring vision.

**Files:** new `components/Composer.tsx`; `screens/Assistant.tsx`; `packages/adapter-spec` +
`router-core/src/manifest-interpreter.ts` (the `ContentPart` union + normalizer extension);
Tauri file-drop/dialog support.

**Effort:** L. **Risk:** medium (multimodal content shape; dialect forwarding).

**Acceptance:** dropping a PNG attaches it and a vision model describes it; `@readme` searches the
workspace; `/clear` empties the transcript and starts a new session.

---

## Phase 4 — In-screen session management (New chat · title · switcher)

**Why fourth.** Session management lives entirely on a separate screen; there is no way to start a fresh
conversation without navigating away, and the chat header has no title.

**Deliverables**
- **New chat** button (calls `startSession()`, clears `msgs`/`trace`, resets `lastNodeRef`).
- Header shows the current session title (editable inline; reuses `setSessionTitle` from History).
- A collapsible session switcher (recent sessions from `loadHistorySessions`) so you can jump without
  leaving the Assistant. Reuses `resumeSession` + `setResumeTranscript` already wired for History→Assistant.

**Files:** `screens/Assistant.tsx`, `screens/History.tsx` (extract a shared `SessionList`), `store.ts`.

**Effort:** M. **Risk:** low.

**Acceptance:** "New chat" starts a clean session that appears in History; the header title edits and
persists; switching sessions swaps the transcript.

---

## Phase 5 — Agent control (approval modes · plan mode · change review · undo)

**Why fifth.** Today the only gate is a blocking per-call modal; there is no auto-approve, no
propose-then-execute, and no reviewable change set for agent edits.

**Deliverables**
- **Approval modes**: `ask every time` (today) / `auto-approve reads` (read-only tools run without a
  modal) / `yolo` (approve all). Extend the `confirm` gate in `runAgentLoop` (`lib/tools/agentLoop.ts`)
  to consult a mode; classify tools read-only vs mutating in `registry.ts`.
- **"Always allow this tool"** and **"allow for this session"** options inside `ConfirmModal`.
- **Plan mode**: the agent produces a plan (no mutations), the user approves, then it executes. v1 can
  be a system-prompt mode + a mutation-disallowed pass, reusing the existing loop.
- **Change review**: collect mutations from a run into a change set with a per-file diff (reuses
  `DiffView` from Phase 2) and Apply/Reject — the generic sibling of `CodeCandidateReview`, but for
  workspace edits, not adapter source.
- **Checkpoint/undo**: snapshot touched files before a run; offer "undo this run".

**Files:** `lib/tools/agentLoop.ts`, `lib/tools/registry.ts`, `screens/Assistant.tsx`,
new `components/ChangeSetReview.tsx`; Tauri for snapshot/restore.

**Effort:** L. **Risk:** medium-high (snapshot/restore safety; must be root-confined and never lose a
user file).

**Acceptance:** in "auto-approve reads" a `read_file` runs with no modal but `write_file` still prompts;
a run's edits are shown as a diff set that can be applied or reverted.

---

## Phase 6 — Streaming & reliability fixes

**Why grouped.** These are correctness bugs that make the existing surface feel broken; several are
already recorded in the 2026-09-30 audit memory.

**Deliverables**
- **Sticky auto-scroll**: only follow when already at the bottom; add a "jump to latest" pill
  (`Assistant.tsx:755, 952`).
- **Tab-switch abort fix**: register the plain-chat controller with the orchestrator too (or hold it in
  `AssistantScreen`), so switching Chat↔Image does not orphan a run (`Assistant.tsx:719`).
- **Image tab cancel**: `ImageBox` gets a Stop wired to `generateImage`'s signal.
- **Per-tool cancel**: cancel one in-flight tool without killing the run.
- **Gemini agent mode**: add a tools/tool_choice mapping to the `geminiCompat` template so agent mode
  works (`builtin-templates.ts` + `manifest-interpreter.ts`). **This is the only router-core change in
  this phase.**
- **Inline error retry**: a failed turn offers Retry directly (depends on Phase 1).

**Effort:** S–M per item. **Risk:** low, except Gemini mapping (medium — template grammar).

**Acceptance:** scrolling up during a stream does not yank you down; leaving the tab mid-run still lets
you stop it from the Agent dashboard; image generation can be cancelled; a Gemini model runs a tool.

---

## Phase 7 — Parameters & usage (temperature · maxTokens · system prompt · context meter · cost)

**Deliverables**
- Per-request parameter panel: `temperature`, `maxTokens` (both already in `TextRequest`), reasoning
  effort where the manifest supports it.
- **System prompt** editor (the agent/no-tools prompts are currently hardcoded strings in
  `Assistant.tsx`).
- **Context meter** in the composer: prompt tokens used vs the model's window (usage already flows via
  `onUsage` → ledger).
- **Running cost / token readout** for the session (reuse `lib/ledger/format.ts`).

**Files:** `screens/Assistant.tsx`, `lib/models/selectable.ts` (window metadata), read from
`catalog`/ledger.

**Effort:** M. **Risk:** low (params pass through today).

**Acceptance:** setting temperature changes the request body; the meter reflects real prompt tokens;
the session shows an estimated cost.

---

## Phase 8 — Navigation & shortcuts

**Deliverables:** keyboard shortcuts (new chat, focus composer, clear, stop), a command palette, and
conversation search over History. Optional: resizable panels.

**Effort:** S/M. **Risk:** low.

---

## Recommended sequencing

1. **Phase 1** (per-message actions) — biggest felt gap, isolated, low risk.
2. **Phase 6 bug-fixes that need no other phase** (sticky scroll, tab abort, image cancel) — cheap
   correctness wins; can ship alongside Phase 1.
3. **Phase 2** (diff/file rendering) — makes agent output trustworthy.
4. **Phase 4** (session management) — cheap, unblocks "start fresh".
5. **Phase 3** (composer) — highest cost; the multimodal content decision gates it.
6. **Phase 5** (agent control) — largest and riskiest; benefits from DiffView (2).
7. **Phase 7** (params/usage), then **Phase 8** (shortcuts).

Phases 1, 2, 4 are independent and can run in parallel on separate branches. Phase 3 depends on the
content-parts decision; Phase 5 depends on Phase 2's `DiffView`; Phase 6's Gemini item is independent.

## Decisions

- **Phase 3 multimodal content shape — RESOLVED (2026-09-30): widen `ChatMessage.content` to
  `string | ContentPart[]`.** See the Phase 3 note for rationale. Land backward-compatibly, gate image
  input on the model declaring vision.
