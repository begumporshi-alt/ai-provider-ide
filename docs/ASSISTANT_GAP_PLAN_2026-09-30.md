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
- **Phase 2 (diff / tool-result rendering) — DONE (2026-09-30).** `lib/tools/diff.ts` (bounded
  line-level LCS, pure + tested) and `lib/tools/render.ts` (pairs a tool result with the call that
  declared it — the arguments live on the assistant turn — and decides the view). `DiffView`
  component with added/removed colouring, copy button, and an honest truncation cap. Wired into the
  Assistant's live tool calls (`AgentLive`) and its completed transcript (`ToolResultBubble`), and
  into the History timeline (`HistoryTool`; the timeline stores the assistant turn's `tool_calls`,
  so a past edit's diff is reconstructible). `search_files` results group by file. 21 new unit tests
  + a new e2e (`tool-result-rendering.spec.ts`); web-test 119/119.
  Not done in this pass: clickable `path:line` file links (needs a root-confined host opener).
- **Phase 3 (composer) — DONE (2026-10-01).** The composer grew up: auto-growing box, an attach
  button/drag-drop/paste, image chips with thumbnails, a slash-command menu (`/clear` `/model`
  `/image` `/compact`) and `@file` references that list the workspace and inline a file's contents
  into the send. `ChatMessage.content` is now `string | ContentPart[]`, with each dialect's wire
  shape declared in the manifest (`contentPartTemplates`) rather than branched in the interpreter —
  OpenAI's `image_url` data URI, Anthropic's base64 `source`, Gemini's `inlineData`. Image attach is
  gated on the model declaring vision, and the three states are kept apart (`true`/`false`/absent)
  so "this provider publishes no capabilities" never reads as "your model cannot see".
  New files: `components/Composer.tsx`, `lib/chat/slash.ts`, `lib/chat/mentions.ts`,
  `lib/chat/slash-mentions.test.ts` (29 unit tests), `packages/router-core/src/content-parts.ts`
  + its 18 tests, `web-test/composer.spec.ts` (10 e2e). Verified: workspace typecheck clean, 742
  unit tests (23 + 373 + 346), vite build, 149/149 web-test.
  **Found and fixed while verifying:**
  (a) **Gemini requests carried no conversation at all.** The gemini-compat template put `{{messages}}`
  into `contents`, and each message kept the field name `content` — a field Gemini's generateContent
  API does not read (its message shape is `{role, parts}`). Every Gemini request was sending an empty
  `contents[]` as far as the provider was concerned. Fixed with a declarative `contentField: "parts"`
  plus the accompanying shape change (a string content becomes a one-part array), and pinned by a
  dialect test.
  (b) An image was measured as its base64 by the token estimator, which is what the compressor uses to
  decide how much conversation to drop — so one picture would have cost thousands of phantom tokens and
  compressed real turns away. `textOfContent` now flattens an image to a one-token marker.
  (c) `list_dir` returns a *formatted* listing (`file <path>` / `dir  <path>`), not bare paths; the
  parser is now `parseListing` in `lib/chat/mentions.ts` with tests, rather than a whitespace split
  that a path with a space would break.
  (d) Two of my own: the interpreter was handed the message *array* where a message's *content* was
  expected (parts silently unrendered), and `textOfContent` had lost the circular-JSON guard the old
  helper had. Both were caught by the new tests, not by review.
  **Not done in this pass:** Gemini's *tool* shapes (`functionCall`/`functionResponse`) remain
  unmodelled — a separate pre-existing gap, unchanged here.
- **Phase 4 (in-screen session management) — DONE (2026-09-30).** A session bar at the top of the
  Assistant: the current session's title (click to rename, persisted through `session_titles`), a
  **＋ New** button that swaps the recorder and clears the transcript, and a **Sessions ▾** switcher
  that resumes a past conversation in place. Resuming seeds the transcript but starts a *fresh*
  recorder — reusing the old session id would restart the node sequence and upsert over that
  session's existing nodes. New e2e `assistant-session.spec.ts`.
  **Surfaced and fixed a harness gap:** the browser shim never implemented `history_rename_session`
  / `history_delete_session`, and `history_sessions` had no `title` field — so rename/delete worked
  in the app (verified only by Rust tests) and silently did nothing in the browser harness.
- **Phase 6 (cheap trio) — DONE (2026-09-30).** Sticky auto-scroll + "jump to latest" pill;
  Chat/Image panels now stay mounted and hide with CSS (fixes transcript loss on tab switch AND
  the orphaned in-flight run / missing Stop); image tab got a working Stop via AbortController +
  signal.
- **Phase 7 (parameters & usage) — DONE (2026-09-30).** A composer strip carrying `temp` and
  `max tokens` (blank = the provider's own default, and blank is *omitted* from the body rather than
  sent as 0 — 0 is a real temperature), a ✎ **system prompt** editor with three fields (no-tools
  guard / agent instructions / plain chat, each blank meaning "the built-in constant", shown greyed
  as the placeholder so nobody forks a default by typing one character), a **context meter**
  (estimated prompt tokens for the next send against the chosen model's catalog `contextWindow`,
  coloured by pressure, with the provider's own last-reported count in its tooltip), and a running
  **Σ readout** of tokens in/out and cost, re-read from the ledger at the end of every turn.
  New e2e `assistant-params.spec.ts` (8 tests). Verified: workspace typecheck clean, 677 unit tests
  (23 + 350 + 304), vite build, 127/127 web-test.
  **Found and fixed while verifying:**
  (a) `packages/router-core/test/dialect-messages.test.ts` did not typecheck — an unused parameter
  and a `{role}`-only cast that read `.content` — so `pnpm typecheck` was red on `main` and had been
  since that test landed;
  (b) the browser harness's mock never answered `stream_options.include_usage`, so **no streamed
  request in the harness ever recorded a token**; it now emits the usage chunk a real OpenAI-shaped
  server sends, which is what makes the ledger's token path exercisable end-to-end;
  (c) `formatCost` existed only inside `Activity.tsx`, and the second copy written here had already
  drifted to different precision — it now lives in `lib/ledger/format.ts` with unit tests. The
  Assistant's total renders `—` (unknown) rather than `$0.00` (free) when nothing could be priced,
  and `≥ …` when only some of the traffic could be.
  **Not done in this pass:** reasoning-effort control — `TextRequest` carries no such field and no
  manifest declares one, so it is a router-core change rather than a UI knob.
- **Phase 8 (navigation & shortcuts) — DONE (2026-09-30).** A keyboard layer with one table behind
  both the binder and the help sheet (`lib/keys/shortcuts.ts`, 11 unit tests): `mod+K` command
  palette, `mod+/` shortcut sheet, `mod+Shift+O` new chat, `Escape` stop. A command palette that
  lists every screen plus three real actions ("New chat", "Focus the composer", "Search
  conversations"), says "already open" for the current screen, and **disables "New chat" while a
  turn is running** rather than offering a command that silently no-ops. Conversation search on
  History: client-side over the loaded page of sessions, matching title/preview/model, with a
  "3 of 41" count so the filter cannot read as a store that lost rows. New e2e
  `shortcuts.spec.ts` (11 tests). Verified: workspace typecheck clean, 690 unit tests
  (23 + 350 + 317), vite build, 139/139 web-test.
  **Found and fixed while verifying:**
  (a) **A stream the user stopped was reported as `✓`.** The engine's stream loop *returns* on an
  aborted signal rather than throwing, so the plain-chat path took its success branch and printed a
  green check with a partial answer — the user's own action attributed to the provider. The trace
  now says "stopped by you", matching what the agent path already did.
  (b) `lib/nav.ts` is now the single screen list: `Shell` and the palette both render it, and
  `smoke.spec.ts` walks it instead of a hand-copied array — the copy would have gone stale silently
  the first time a screen was added, leaving that screen never smoke-tested.
  (c) The harness could not test "while a turn is running" at all: the mock answered instantly, so
  the state was over before a key could arrive. It now supports an opt-in `slow:` prompt that streams
  over ~5 s.
  **Not done in this pass:** resizable panels (listed as optional in the phase).
- **Web-test picker debt — FIXED (2026-09-30).** The `web-test` specs drove the model picker via
  `getByRole("combobox")`, which stopped matching in commit `721c115` (searchable picker). All
  four specs now use a shared `web-test/model-picker.ts` helper. Full suite went 86→101 passing;
  `ui.spec.ts` is fully green.
- **Superseded note:** an earlier version of this section listed 17 pre-existing web-test failures
  (Memory, trail-health, drift-history). They are gone — the suite is 127/127 green as of Phase 7,
  so whatever fixed them landed with the intervening commits (Phase 4/6 and the picker work).
- **Remaining:** Phase 3 (composer/attachments — the multimodal `ContentPart` decision is already
  taken in its section, so it is implementation work now) and Phase 5 (agent approval modes / plan
  mode / change review — the largest and riskiest, deliberately left for a session with attention
  to spare).

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

**Status: DONE (2026-10-01)** — see the Status section above for what shipped, the four defects found
while verifying, and the one gap left (Gemini tool shapes).

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

**Status: DONE (2026-09-30)** — see the Status section above for what shipped, what was found while
verifying, and the one deliverable that was dropped (reasoning effort) and why.

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
