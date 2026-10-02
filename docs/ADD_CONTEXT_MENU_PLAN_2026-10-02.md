# Composer "Add context" — gap analysis & phased plan

Date: 2026-10-02
Scope: `apps/desktop/src/components/Composer.tsx` and the screen that drives it
(`apps/desktop/src/screens/Assistant.tsx`).
Reference: the four-row picker in the product brief — **Upload files** / **Project files** /
**Instructions** / **Previous results** — compared against Cursor, Cline, Continue, Windsurf and the
ChatGPT/Claude web surfaces.

## The problem this fixes

The composer today has **two buttons that do the same thing** and **one label that lies**:

- a paperclip (`Composer.tsx:491-503`) and `＋ Add context ▾` (`Composer.tsx:552-561`) both call
  `pickerRef.current?.click()`, firing the same hidden input (`Composer.tsx:504-516`);
- the `▾` is `aria-hidden` decoration — "Add context" opens a file dialog, it does not open a menu.

So the brief's four rows are not a redesign of something that exists. They are the menu the button
already promises.

The second finding is why this is cheap: **all four rows are backed by machinery already in the
repo.** The work is mostly wiring plus two correctness repairs.

## Decisions taken

1. **One doorway.** The paperclip is removed; `Add context` becomes the single attach affordance with a
   real menu whose first row is Upload files. Drag-and-drop stays (a distinct affordance, not a
   duplicate), and paste-to-attach is added so the fast paths outlive the button.
2. **Instructions are a per-turn system channel**, not the persistent prompt. The app already has a
   home for durable configuration — the ⚙ run-config panel (`Assistant.tsx:881-900`) and the
   temp/max-tokens strip — so duplicating the system-prompt editor into this menu would create two
   controls for one decision. The menu's row is per-turn only, and links across to ⚙ for the durable
   version.
3. **Documents are refused honestly now, ingested properly in Phase 2.** See "The document trap"
   below — it is a genuine architecture decision, not a UI one, and Phase 1 must not paper over it.
4. **Nothing attaches invisibly.** Every context the menu adds is either visible in the draft or
   chipped in the composer. An instruction the user cannot see is the failure mode this avoids.

## Phases

### Phase 1 — the menu, the merge, and two correctness repairs

**Status: DONE (2026-10-02)** — see "What shipped" at the end of this document.

**Deliverables**

- `components/AddContextMenu.tsx` — the menu: two groups, four rows, the same keyboard contract the
  slash and mention menus already use (arrows move, Enter picks, Escape closes).
- `components/ProjectFilePicker.tsx` — a searchable, multi-select list over the workspace listing the
  composer already receives as `listFiles`, inserting `@path` references.
- `lib/chat/context-blocks.ts` — the pure logic (block builders, the document classifier, the button's
  summary label) in a `.ts` module so vitest can reach it without jsdom, matching
  `lib/chat/slash.ts` / `lib/chat/mentions.ts`.
- Composer: paperclip removed; `onPaste` added; per-turn instruction state plus a visible chip; the
  button shows what is currently attached.
- Assistant: the instruction reaches the system prompt on both paths (agent and plain chat), and the
  context meter counts it.

**The four rows**

| Row | Subtitle | Backed by |
|---|---|---|
| Upload files | Images, text, logs | `addFiles` + the existing hidden input |
| Project files | Reference code and folders | `listFiles` → `list_dir`, `matchMentions` scoring, `@`-mention expansion on send |
| Instructions | Requirements and constraints | New per-turn system channel (Phase 1) |
| Previous results | Reuse relevant outputs | The transcript's own assistant turns |

**Two repairs, folded in because they are in the same function**

- **Paste-to-attach does not exist.** The gap plan's Phase 3 note claims "attach button/drag-drop/
  paste", but there is no `onPaste` anywhere in `apps/desktop/src`. Pasting a screenshot does nothing
  today. One handler fixes the most common capture-then-ask workflow.
- **The picker mangles small documents.** `addFiles` branches on one test — is it an image — and sends
  everything else through `readAsText`, which is why a small PDF becomes mojibake in the draft (a large
  one is refused with a message about the 48 KB inline cap, which is true but says nothing about the
  real problem). Phase 1 classifies documents and refuses them with a reason that names the working
  path; Phase 2 makes them work.

**Files:** `components/Composer.tsx`, `components/AddContextMenu.tsx` (new),
`components/ProjectFilePicker.tsx` (new), `lib/chat/context-blocks.ts` (new),
`screens/Assistant.tsx`, `web-test/composer.spec.ts` (new cases).

**Effort:** M. **Risk:** low. The two touched seams are the composer's props and `runTurn`'s
signature, both extended with optional parameters so existing callers (retry, edit, plan-approve) are
unaffected.

**Acceptance**

- One attach affordance; the chevron opens a menu.
- Upload files, Project files, Instructions and Previous results each do what their subtitle says.
- Pasting an image attaches it.
- A PDF is refused with a reason that names `read_document` or a workspace path — never appended as text.
- A per-turn instruction appears in the request's system messages — asserted on the wire, not in the UI
  — and is visible as a chip before the send.
- Project files and Previous results grey out with a reason when there is no workspace root or no prior
  output, rather than offering a row that can only fail.

### Phase 2 — document ingestion (the architecture decision)

The composer reads **browser `File` objects**; the host reads **workspace paths**. A PDF chosen in the
file dialog has no path the host can resolve, so the host's existing `read_document`
(`core/tool_registry.rs:242`) cannot be reached from here by path. Two ways to close that, and they are
not equivalent:

1. **Send the document as a content part.** Extend `ContentPart` with a `document` variant and declare
   each dialect's wire shape in the manifest, exactly as images already work through
   `contentPartTemplates`. Most providers now accept PDFs directly (Anthropic `document`, OpenAI file
   input, Gemini `inlineData`), so no extraction is needed and no new host surface appears. This is the
   change that fits the codebase's own pattern.
2. **Extract text in the host.** A command taking bytes plus a filename. Reuses `read_document`'s
   extraction but adds a privileged surface that accepts arbitrary bytes — the thing
   `Composer.tsx:14-19` deliberately avoided.

**Recommendation:** option 1. It needs a per-dialect capability declaration (the same `true` / `false` /
absent three-state the vision gate uses) before it can be gated honestly, which is why it is its own
phase rather than a line in Phase 1.

**Effort:** M/L. **Risk:** medium — router-core `ContentPart`, four dialect templates, and a capability
gate.

### Phase 3 — depth on the rows that shipped thin

- **Project files:** folders and globs as sources (`glob` already exists as a tool), not just
  single-file picks; a "recent files" row read from the context graph.
- **Previous results:** reach beyond the current transcript — a past run's change set with its diff
  (`ChangeSetReview` + `DiffView` already render this), a specific tool result from
  `loadHistoryTimeline`, or an output from another session.
- **Instructions:** a reusable snippet library, so a constraint set the user types often is one click.
- **Skills:** pin one installed skill for a single turn. Today `Assistant.tsx:1629-1642` appends
  *every* enabled skill to the agent prompt; the missing control is per-turn scoping, not installation.
- **Memory:** preview which atoms recall would inject and let the user add or suppress a few. Recall is
  currently automatic and opaque (`recallContext` → `memoryBlock`, 1200-character budget).
- **Diagnostics:** attach the last failing request from the ledger (`listLedger`, the `AIP-*` gateway
  headers, `buildRepairPlan`). No competitor can offer this, because no competitor is a router.

### Phase 4 — context meter honesty

`Assistant.tsx:1801-1820` already admits two kinds of context fall outside its estimate: the recalled
memory block and the agent-mode tool definitions. `@`-referenced files are a third — they are expanded
at send time and never appear in the draft the meter counts. The menu makes mentions much easier to
attach, which makes the meter's silence more visible. Either estimate them or name them in the meter's
tooltip; a meter that is quietly wrong at the moment the user is watching it is worse than no meter.

## What was deliberately left out

- **A web-search toggle.** `web_search` and `web_fetch` exist as tools and agent mode already governs
  them; a composer switch would be a second control for one decision.
- **A "Projects" / knowledge-base row.** Workspaces, memory and skills already cover it; a fourth
  bucket for the same idea fragments it.
- **A file tree inside the menu.** A menu is a picker. Project files opens a picker surface; a tree
  belongs in a drawer.
- **MCP connectors.** No MCP subsystem exists in this repo. Different project.

## What shipped (Phase 1)

New files:

- `lib/chat/context-blocks.ts` — `fileKind` (image / text / document / unknown, name before type, with
  the container extensions and MIME families listed), `looksBinary`, `documentRefusal`,
  `binaryRefusal`, `instructionSystemText`, `clampInstruction`, `previousResultBlock`,
  `previousResultMarkerCount`, `contextSummary`, `MAX_INSTRUCTION_CHARS`. 23 unit tests.
- `components/AddContextMenu.tsx` — the grouped menu, per-row availability with a stated reason, two
  nested panels (the instruction editor, the reuse list), and the arrow / Enter / Escape contract.
- `components/ProjectFilePicker.tsx` — search plus multi-select over the workspace listing, reusing
  `matchMentions` for scoring and producing the same `@path` token the mention menu does.

Changed:

- `components/Composer.tsx` — the paperclip removed; the chevron now opens a menu; `onPaste` added
  (images attach, text still pastes as text); documents and unrecognised binaries refused with a
  reason that names the route that works; a visible instruction chip; a live badge on the button; and
  `appendToDraft` as the single writer for appended blocks.
- `screens/Assistant.tsx` — `runTurn` takes an optional `instruction`, appended as a system message
  on both the agent and plain-chat paths; the context meter counts it; `previousOutputs` derived from
  the transcript.
- `web-test/composer.spec.ts` — 11 new cases; 21 in the file, 174 across the suite.

**Two repairs found on the way, both in the code this touched**

- **The context meter was already under-reporting.** `addFiles` appended an inlined text file through
  a bare `setDraft`, so the parent's copy of the draft stayed empty and the meter read zero while the
  text sat visibly in the box. All appends now go through `appendToDraft`, which reports the new value
  upward; the new e2e case asserts the meter goes from zero to non-zero on exactly that path.
- **`+ Add context ▾` opened a file dialog.** The chevron is no longer decoration.

**The badge's rule** (worth stating, because it looks like an omission otherwise): it counts what the
draft does *not* show you — images, `@` references whose contents arrive at send time, reused results,
and the instruction. An inlined text file is not counted, because its whole body is in the box
already; counting it would make the badge a log of everything the menu ever did, including context the
user has since deleted.

**Left deliberately undone in this pass:** document extensions are not in the file input's `accept`
list. The input does not offer a type the composer refuses — a PDF in the dialog that comes back as a
refusal is a worse experience than one that is simply not offered yet. Phase 2 adds them when they
work.
