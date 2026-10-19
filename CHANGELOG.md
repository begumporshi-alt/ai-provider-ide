# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**The shipping version is the one in `apps/desktop/src-tauri/tauri.conf.json`** — that is what Tauri
stamps onto the bundle and what the gateway reports. Every other manifest is expected to agree with
it, and `pnpm check-version-sync` fails the build when one does not.

## [Unreleased]

### Added

- **AXIOM: the app can now audit, diagnose and improve its own Assistant, and refuses to believe the
  Assistant's word about any of it.** A new sidebar screen and a new package,
  `packages/axiom-core`, run the seven-stage loop — observe, evaluate, diagnose, design, modify,
  validate, evolve — over the agent that is actually shipping. It reads what the Assistant did from
  `agent_runs`/`agent_steps`, runs it against a task suite whose expectations check the *transcript*
  rather than the agent's account of it, finds the root cause of what failed, proposes one bounded
  change, re-measures, and promotes only if the numbers moved past the noise floor and nothing that
  used to work stopped working.

  The stage that earns the name is **06 Validate**. A change is put to a Regression Guardian that
  compares the candidate against the baseline on pass rate, per-capability pass rate, cost, latency
  and tool-loop incidence, and to four independent roles — investigator, architect, critic,
  verifier — each of which can object. Promotion needs the guardian *and* every role. The fixture
  the package is tested against is an agent that lifts its headline metric by breaking a capability:
  told to verify before claiming, it produces a *cheap* verification and stops running the shell.
  `verificationCalls` goes up, the pass rate on the edited task goes up, the `shell` capability goes
  to zero — and AXIOM rejects it, retains the candidate as `rejected` rather than deleting it, and
  records which check blocked it. A rejected version is kept for the same reason a promoted one is:
  rollback is only possible because nothing was ever destroyed.

  **The measurements are of the real agent, not a model of it.** An eval task runs through the same
  `runAgentLoop`, `AGENT_TOOLS`, tool host and prompt composition a send uses, in a scratch
  directory (`.axiom-eval`) inside the workspace root, so a synthetic task's side effects land
  somewhere disposable. A fixture runner would have been cheaper and would have proven nothing about
  the thing shipping. Eval runs are paid, so the first one is gated on a consent dialog quoting the
  call count and the token assumption — and the estimate is deliberately *unknown* rather than
  guessed, because the gateway picks the provider and a price invented for the dialog would be a
  number nobody could check.

  **What a promoted version changes is narrow, and the narrowness is the point.** It travels as a
  set of prompt patches keyed by detector (`[axiom:premature-success]` and friends) applied on top
  of whatever base prompt the app composes today, never as a stored override run verbatim — so
  promoting a version cannot quietly discard a system prompt the user has since edited. Patches are
  idempotent by marker and capped, and a cap refusal is dropped rather than truncating an
  instruction mid-sentence. Of the loop parameters, exactly one crosses into an interactive turn:
  `verificationNudgeMax`. A version's `maxIterations` bounds AXIOM's own eval runs and nothing
  else, because D119 removed the interactive step bound on the rule that a bound is justified only
  where nobody can press Stop — and an unattended eval has nobody at the keyboard.

  **A stopped run is reported, never judged.** Aborting an evaluation mid-suite leaves numbers
  behind that look like measurements. They are surfaced, and refused as a basis for a decision: a
  candidate whose own run stopped is left `candidate` with no decision rather than rejected for
  tasks it never ran, and a baseline that stopped early produces no candidate at all. AXIOM is also
  the one screen that stays mounted once opened, hidden with CSS on navigation, because unmounting
  it would leave minutes of paid model calls running with no progress line and no Stop button.

  Persistence is four tables — `axiom_versions`, `axiom_findings`, `axiom_suite_results`,
  `axiom_decisions` — added by migration `0029`, with `schema_version` now 29 and a partial unique
  index enforcing at the schema level that at most one version is `active`. The core package holds
  no API key, performs no network I/O and touches no database: everything crosses ports implemented
  by the Rust host, which is what lets 245 unit tests run the whole loop against in-memory stores.

- **The Assistant can fan out: several independent sub-agent tasks in one round, with structured
  results.** `dispatch_agent` runs one child per call, so a set of independent items — survey these
  twelve files, check these eight endpoints — was either serialised across rounds or run as a batch
  whose summaries came back as N prose blocks the model had to keep straight itself. `fan_out` takes a
  list of tasks and returns **JSON keyed by the caller's own label**: one object per task carrying its
  summary, iteration count and tokens spent, under a one-line header with the counts. A bad item fails
  **only** that item — an unknown specialist names the valid ids, and the other children's completed
  work is not discarded — and the per-call cap of 12 is refused before any child starts, because each
  item is a full sub-agent run. A batch larger than the concurrency cap still works; it runs in waves.

  It is the **same child** as `dispatch_agent`, not a second kind. The child-run path is now one
  function both tools call, so the granted tool set, the definition narrowing it, the step budget and
  its hard backstop, the parent's approval gate riding along, the ledger row per child and the
  inactivity watchdog are one implementation. That is the point rather than tidiness: a second copy is
  how a fan-out child ends up at a different privilege level from a dispatched one, and the probe
  shows the sharing holds — breaking the grant reddens **every** test that pins it, `dispatch_agent`'s
  included, where a duplicate would have reddened only its own.

  `fan_out` is read-effect for the same reason `dispatch_agent` is: whatever a child writes is gated
  by the parent's approval, not by this call. It is also excluded from a child's own tool set, so
  delegation cannot recurse — the newest route to unbounded nesting, closed in the exclusion list
  rather than only left unsaid.

- **The manifest interpreter's two implementations are now pinned to each other by a shared corpus.**
  `apps/desktop/conformance/dialect-scenarios.json` holds 15 shaping scenarios executed by **both**
  the TypeScript reference and the Rust port (`core/dialect_shaping.rs`), so a divergence between
  what the wizard validates and what the gateway serves fails a test instead of surfacing later as a
  provider "behaving oddly". Drivers: `src/lib/dialect-conformance.test.ts` on the reference side and
  a `#[cfg(test)]` module in `dialect_shaping.rs` on the port side. The corpus header states the
  null-normalisation rule both drivers apply — Rust serialises `Option::None` as an explicit `null`
  where TypeScript omits the key, and absence is not what these scenarios test.

  The scope of this first slice is a real seam rather than an oversight: it covers the functions
  whose inputs are identical on both sides — role mapping, tool-call reading, text extraction, dotted
  field lookup, finish-reason mapping. `shapeToolDeclarations`, `attachToolParts` and
  `shapeMessageContent` are next: their TypeScript signatures take the template renderer as an
  **injected callback** (the interpreter owns rendering) while the Rust signatures render internally,
  so those drivers must pass `renderTemplate` explicitly or the comparison would partly be a
  comparison of the two drivers.

  *(Updated the same day: `shapeToolDeclarations`, `shapeMessageContent` and `attachToolParts` are now
  covered too, with the reference driver passing the package's own `renderTemplate` — the corpus is 22
  scenarios and covers **every** shaping function. `attachToolParts` was written last and from its
  semantics rather than its signature, because its output depends on relations between messages: a tool
  result's name is resolved by looking back at the assistant turn that declared the call, and a run of
  consecutive results collapses into one message. Both implementations agreed with the authored
  expectations on the first run.)*

- **A resumed session is now restored rather than reconstructed.** Until this change the only durable
  copy of a conversation was the context graph, which is built for edges rather than for replay: a
  message node's text is clipped for the force layout, its order comes from the sequence number
  embedded in its id, and the assistant turn a tool result belongs to has to be recovered by walking
  a `produced` edge. So `resumeSession` handed back a shortened conversation, and a resumed agent
  session could come back with tool calls whose results no longer lined up. Migration **0027** adds
  `session_messages` — the message as it was sent, with `tool_calls` on the assistant turn and
  `tool_call_id` on each result, which is the pair a provider validates on replay. Both turn paths
  append their turn, and `resumeSession` prefers rows, falling back to the graph for sessions
  recorded before 0027: a backfill could only invent the text the graph never stored.

  Three details worth knowing. A failed or stopped turn is recorded as **what the bubble says**
  (`⚠ boom`, or the partial text), not as the empty stream — a durable copy that disagreed with the
  conversation would be worse than none. Attachment **metadata** is stored and the image bytes are
  not: base64 is megabytes the user already has on disk, and a resume re-reads it from the turn that
  owns it. And a resumed session continues at `transcript_max_seq`, so its next turn cannot upsert
  over the session's own earlier rows — the same rule the graph recorder's sequence follows.

  The History screen's timeline **view** is deliberately unchanged: that is a rendering of the graph,
  which is what the graph is for. The transcript is what a *resume* reads, and `session_messages`
  goes with its session when one is deleted.

- **A sub-agent can be allowed to modify the workspace, and how much of its summary comes back is
  now a setting.** A `dispatch_agent` child was read-only by construction — its whole granted set
  was the read-effect tools — so delegation bought parallel *research* and never parallel *work*. A
  new switch in the Assistant's run panel (**Sub-agent writes**, off by default) grants the full
  tool set instead, and a second field sets how many characters of the child's summary reach the
  conversation (default 4000, clamped 500–16000).

  Three things keep this a delegation rather than a permission bypass. The switch is the **user's**
  and the only thing that widens anything: a specialist definition's `tools` list is applied as a
  filter *over* the granted set, so a definition naming `write_file` while writes are off gets
  nothing — asserted, not assumed. A write-capable child runs the **parent's own approval gate**,
  so its mutations ask exactly as the parent's would, and a denial reaches it as a refusal rather
  than a silent success. And the never-list is unchanged at every privilege level: `dispatch_agent`
  (unbounded recursion), `todo_write` (its transcript is discarded, so the list would be a lie the
  model told itself) and the plan-mode pair (a child cannot approve the plan the parent executes).

  The `dispatch_agent` description now changes with the setting. The read-only text states outright
  that the sub-agent "cannot modify the workspace", so a model running with writes enabled would
  have been told its own capability did not exist and would have spent the delegation asking the
  parent to make the change.

  One behaviour tightened on the way: an **empty** `tools` list on a definition now means *no*
  tools, where `.length` read it as "unset" and granted everything. That was harmless while every
  tool was read-only; with writes enabled it was the difference between no access and full access.

- **The `run_command` sandbox's program list can be extended from Settings, without weakening what
  the list guarantees.** The allowlist was thirty-eight hardcoded programs, so whole task classes
  were unreachable by construction: `cargo` could not be invoked directly, `rm` and `mv` could not
  tidy anything up, and `curl`, `sqlite3`, `docker` and `jq` were not there at all. A user may now
  add programs in **Settings → Agent tool sandbox**. The additions live in the `tools` settings row,
  are read at boot by the app *and* the daemon, and are applied by the one `core::tools` gate both
  serving paths already share — a policy only the app applied would mean one workspace with two
  sandboxes.

  Three properties keep the extension from being a hole. **The baseline is unchanged and still the
  default** — configured with nothing, the refusal path is the behaviour it had, which the existing
  golden test still asserts. **A name must be a bare executable** (`[A-Za-z0-9._+-]{1,64}`, no path
  separator, no `..`, at most 32 entries), because a path would be an escape the argument gate cannot
  close: the program itself would sit outside the workspace. And a ten-entry **never-allowed** list —
  `sudo`, `su`, `dd`, `shutdown`, `reboot`, `halt`, `diskutil`, `launchctl`, `csrutil`, `kextload` —
  outranks the configuration, refused at the setter so the user learns immediately *and* at the gate
  so a list persisted by an older store cannot slip one through. `rm` and `mv` are deliberately not
  on it: destructive but confinable, and refusing them forever is what made "tidy up the build
  output" impossible in the first place.

  The policy the screen renders reports the baseline, the additions and the refused list as three
  sets rather than one merged list, so the boundary is visible instead of inferred; the Settings
  section renders the policy the **host returned**, never the list that was typed.

- **A provider can be set up with its models, and each model can be tested before you commit to
  it.** Adding a provider by hand previously recorded a name, a URL and an auth scheme and nothing
  else — no model was ever entered, so a provider whose `/models` endpoint is missing, incomplete or
  gated was installed with an empty catalog and could not serve a request. The manual flow is now
  three steps: **Connection → API key → Models**. Models can be fetched from the provider or typed
  in by hand (id, text/image, optional context window), and each row has a **Test** button that
  sends one real request and reports what came back. A provider can also be **edited** after it
  exists, from an Edit button on its card.

  Two details worth knowing. The wizard creates the provider at the end of step 1 rather than at the
  end of the flow, because a model can only be tested by sending it a request and a request needs a
  key — abandoning the wizard leaves a visible draft provider you can remove or finish, rather than
  a form that cannot answer the question it is asking. And a hand-typed model is stored with
  `origin: 'manual'` (migration 0018, `models_cache.origin`), because a catalog refresh replaces a
  provider's discovered rows wholesale: without that distinction the first Refresh would silently
  erase exactly the models the operator added because the provider never listed them.

- **A provider can carry custom request headers, and they reach every endpoint — including the model
  list.** Some gateways serve only a set of recognised clients and refuse everything else before they
  look at the key. `agentrouter.org` is one: measured 2026-09-29, holding the credential constant and
  varying only `User-Agent`, an unrecognised client gets
  `401 unauthorized_client_error` ("unauthorized client detected") on every path, while
  `claude-cli/2.0.0 (external, cli)` or a UA containing `zcode` gets a real answer about the key.
  There was nowhere to put such a header: the manifest grammar allowed per-endpoint headers on
  `generateText` and `generateImage` but **not on `listModels`**, and `listModels` is the call every
  probe, key test and catalog refresh makes — so a gateway of this kind was unreachable even with
  text generation configured correctly.

  `LIST_MODELS_ENDPOINT` now carries `headers` (both interpreters merge it, and the Rust read model
  gained the field), the manual form has a **Custom headers** field that applies to every endpoint,
  and auto setup offers the same field when it meets a gate. Two details: the field refuses a header
  named like the auth header, because the endpoint merge would replace the `{{secret}}` sentinel and
  the request would then be refused by `EgressError::SentinelMissing` — a correct refusal that looks
  like a credential fault; and editing a provider hydrates the field from its stored manifest
  (`headersToLines`, minus the template's own headers), because `save()` rebuilds the manifest
  whenever anything differs and an empty box would have deleted them while the operator was editing
  the provider's *name*.

- **Outbound provider requests now identify the client.** `egress.rs` built both reqwest clients
  without `user_agent()`, and nothing in `interpreter.rs`, the TS `ManifestInterpreter` or any
  manifest set one, so the app sent **no `User-Agent` at all** — non-conformant (RFC 9110 §10.1.5
  says one should be sent) and, on the gateway above, the direct cause of the refusal. The
  credentialed client now sends `AI-Provider-Router/<version>`, which covers both request paths
  (`EgressState::new` is what the app and the `aiproviderd` gateway each construct). It is the honest
  name and **not** a client these gateways already trust: opening them by impersonation, for every
  provider, is not a default this product should apply on the operator's behalf. A per-provider
  header overrides it, which is what the field above is for.

- **The Gateway screen walks an operator from "I use ZCode" to a working config.** The new
  **Connect your IDE** panel on Local Gateway is the front door for using the router as a custom
  provider from other coding agents: pick the IDE (ZCode, Claude Code, or any OpenAI-compatible
  client), mint a per-app key named for it with one click, and copy the exact config bytes —
  ZCode's `provider` entry for `~/.zcode/v2/config.json` (shape verified against a live
  custom-provider entry, including the top-level `"provider"` map and the `/v1`-carrying
  `options.baseURL`), Claude Code's `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` pair, or a
  base-URL/key/smoke-test card for anything else. The secret still never enters the webview:
  minting copies it host-side to the clipboard, and the snippet carries a
  `sk-aip-PASTE-KEY-HERE` slot to paste over. The model-id field defaults to the configured
  System AI model, so the smoke test references a model the router is known to serve.

- **The builtin skill catalog grew from four procedures to thirteen**, taking the procedures that
  were earned rather than invented: the original four (code review, commit message, explain code,
  write tests) plus `lean-reading` (map a large file instead of reading it whole, never re-read what
  is already in context, keep command output to the lines that matter), `verify-before-done` (name
  the check that would prove the work, run it after the last edit, report what stayed unverified),
  `grill-plan` (settle a plan in rounds of one decision each before starting), `subagent-dispatch`
  (when delegation pays for its overhead, and how to brief an agent that cannot see this
  conversation), `protocol-leak-triage` (raw protocol syntax in model output — whose string it is,
  and the strict-decode-then-salvage rule at the extraction seam), `byte-slice-panic` (the Rust
  crash from slicing at a byte index inside a character, plus the audit that finds the rest of the
  family), `error-notes` (record a fixed error so no session diagnoses it twice),
  `screen-design-brief` (settle the layout pattern, the primary interaction and the above-the-fold
  chrome before writing markup), and `fix-to-skill` (turn a confirmed fix into a paste-ready draft
  the operator can install).

  Each is still a procedure and not a capability: a skill cannot widen the tool surface, and one
  costs a line in the system prompt until the model loads its body on demand. All thirteen can be
  switched off globally on the Skills screen or per conversation in the session drawer, so the
  prompt index stays a decision rather than a tax.

- **A refused request now says what was wrong with it: `body_shape`, a structural report of the
  outgoing body, logged at the moment the refusal is built.** Four refusals in a row reached the
  ledger as `500 … "invalid_request_error"` and *nothing else* — D107, D108, D109 and D110. Nothing
  about the request survives a failure: no outgoing body is persisted anywhere, `failure_detail` is
  written as `NULL` on every production row, and the refusal text describes the **response**, never
  the request that caused it. So each of those four was diagnosed by archaeology — reading
  `agent_steps`, replaying a session transcript through the real shaping pipeline, and probing the
  upstream by hand — and **D110 is still unexplained, because its request was never written down at
  all.**

  A body a provider calls invalid is invalid *structurally*, and every such defect is visible in the
  request the instant it is sent. `core/body_shape.rs` (TS twin `packages/router-core/src/request-shape.ts`)
  renders them as one line: a role and part census, empty content, parts no dialect can name, and —
  capitalised, because these are the ones that make a body invalid rather than merely unusual —
  `UNANSWERED_TOOL_USE`, `ORPHAN_TOOL_RESULT`, `DUPLICATE_TOOL_USE_ID` and `UNDECLARED_TOOL`. The
  pairing rule is chosen from the body (the part-array shape's *answered in the immediately next
  message* versus OpenAI's `role:"tool"` replies), so an OpenAI-shaped body is not accused by a rule
  that does not apply to it, and `shape=clean` is reported too: ruling the shape out in one line is
  itself an answer, and it is the answer D110 would have needed.

  It is **structural only** — ids, counts, roles, part types; never message text, never an image's
  bytes — which is what makes it safe to log, and it reports the same defect the upstream names in
  its own words. Measured against the D109 body, it renders `UNANSWERED_TOOL_USE=["call_2@m1"]`:
  *"`call_2` at message 1 is unanswered"*, derived from the request side with no external
  experiment. The gate is stated and tested — `400`/`422`/`5xx` are described, `401`/`402`/`403`/
  `404`/`429` are not, since those are about the key, the balance, the route or the pace and a shape
  report there is noise that trains the reader to skip the line that matters. See
  `docs/dev-book/07-drift-register.md` D110, which this closes the *diagnosability* half of.

### Changed

- **The assistant can build, test and lint Rust — and `pnpm` works too.** Two independent defects
  sat behind one symptom, and the second was invisible until the first was fixed.

  **`cargo` was not on the command baseline, though the interpreters were.** `make`, `python3`,
  `node`, `npm`, `npx` and `pnpm` were all reachable; `cargo` was not. For a Rust repository that is
  a hard stop, and half of this product is Rust (`apps/desktop/src-tauri`) — the agent could edit
  that tree and had no way to compile it, run its tests, or check a lint. It could only assert that
  a change was correct. `cargo` now reaches the build/test/check surface, with the subcommands that
  write **outside** the workspace (`install`, `uninstall`) or mutate a remote or a credential
  (`publish`, `yank`, `owner`, `login`, `logout`, `credential`, `credentials`) refused by
  [`CARGO_DENIED`] — the same two classes `gh` is already gated against.

  **Adding it was not enough, because the child's `PATH` could not find it.** `CHILD_PATH` was
  system directories only, with no per-user bin directory, so `cargo` and `rustc` (rustup installs
  to `~/.cargo/bin`) were unreachable *no matter what the allowlist said* — and the error blamed
  the program: `cannot start "cargo": No such file or directory (os error 2)`. The same was already
  true of **`pnpm`**, which had been on the baseline all along and is this repository's own package
  manager. `child_path()` now appends `~/.cargo/bin`, `~/.local/bin`, `~/Library/pnpm` and
  `~/.bun/bin` **after** the fixed system directories, so a user directory can only add a program
  and never shadow a system one. It derives from `$HOME` rather than inheriting the parent's `PATH`
  on purpose: the ambient value differs between a launchd launch and a terminal `pnpm dev`, which is
  the "works in dev, not in the app" failure mode.

  **This also made the product's own advice false, which is why it was a defect and not a setup
  note.** The baseline docstring offered `cargo` as the worked example of a program a user may add
  by hand through Settings → Tools — a capability that could not have worked for anyone who took
  that advice. The two facts are one fact, and the error text pointed at the wrong half of it.

  **Falsified both halves.** Removing `cargo` from the baseline reddens with
  `program "cargo" is not on the allowlist`; restoring it and dropping `~/.cargo/bin` reddens with
  the original `cannot start "cargo"` — the bug reproduced on demand. A pre-existing test failed on
  this change and was right to: `the_policy_reports_baseline_additions_and_the_denylist` used
  `cargo` as its example of *"an addition is not a baseline program"*, which is now false; `sleep`
  takes that role and `cargo` is asserted from the baseline side instead. Writing the `PATH` test
  caught a tautology in the first version of it — it looped over the very list it was testing, so
  deleting `.cargo/bin` deleted the expectation with it and the test stayed green; the directories
  are now spelled out.

  **Residual, open.** A version-managed directory cannot be a fixed constant: this machine's `pnpm`
  is under an nvm version path, and any constant naming `v20.19.0` would be wrong at the next
  upgrade. So nvm-managed global bins are still unreachable by name — `npm` and `npx` are on the
  system half, so `npx pnpm …` reaches them; what is missing is the direct spelling, not the
  capability.

  **And one claim that had to be corrected rather than fixed.** The module's threat model said
  absent programs *"cannot run at any argument"*. They can, and always could: the baseline includes
  interpreters, so `rm` — refused by name — runs through `python3`. Measured, not argued:
  `the_baseline_already_runs_a_program_that_is_not_on_it` asserts the refusal and then deletes the
  same file through `python3 -c`. Rule 2 now says what is true — the allowlist bounds *naming*, not
  *capability*, and root confinement is the containment that actually holds. This is not a call to
  remove the interpreters; it is the reason adding `cargo` is not an escalation, since `cargo` can
  do nothing the baseline could not already do.

  **`generate_image` is still dead, and it is configuration, not code.** All 17 image-modality
  ledger rows have failed `NO_ROUTE` (2026-09-20 → 2026-10-14) because none of the six configured
  providers declares an image endpoint, and `models_cache` holds no image model at all. No commit
  closes that — it needs a provider that serves image generations added in Settings → Providers.
  Its description now says so, so the dead end is legible instead of silent. See D112, D113 and
  D114.

- **Search patterns are now something the agent knows it can do.** The surface has no symbol
  navigation and no codebase index — nothing type-aware — so following a definition means composing
  a pattern and reading around the hit. The tools allowed that; the instructions did not say so.
  `search_files` is a **literal** substring match, yet its description told the model to *"use this
  to find where something is defined"*, and the agent prompt never mentioned `rg` at all — so the
  model reached for the weaker tool on the job that needs the stronger one. `rg` is on the command
  baseline and takes full regex, so both now point at it (`rg -n "fn handle_(request|response)" src`
  to find definitions by shape, `rg -nw Name` for whole words), and the prompt states outright that
  there is no type-aware navigation rather than leaving the model to look for one.

  **This is the cheap half of D115, and the expensive half is named rather than implied.** An LSP
  client is a project of its own — per-language server discovery, JSON-RPC framing, capability
  negotiation, document sync, position↔offset conversion, a Settings surface — comparable in size to
  the MCP client and useful only for languages whose server is installed. It is not built here. The
  extension path already exists and needs no code: the MCP client registers whatever tools a
  configured server declares, so an LSP-backed MCP server supplies real navigation to anyone who
  points at one.

- **`sips` is on the command baseline, so the assistant can finally process an image instead of
  working around not being able to.** The tool surface had two image tools and neither processed
  anything: `read_image` lets a vision model *see* a file, and `generate_image` *creates* one — but
  there was no resize, crop, format conversion, compression, thumbnail, rotate, or any way to read
  an image's real pixel dimensions. `file_info` reports size and mtime only.

  Found in a real build rather than by reading the list. Building `green-energy-site`, the assistant
  needed a hero at 1920 and 1100 px and three cards at 900, had no local way to produce any of them,
  and wrote five scripts into the user's own project to compensate — one of which records the gap in
  its own docstring: *"no local image tooling is required (sips is not allowlisted here and PIL is
  absent)"*. It then re-requested every image from Wikimedia's thumbnail API at the width the layout
  wanted. That is a genuine workaround, but it is not a capability: it reaches only images a remote
  service happens to host, and cannot touch a local file, convert a format, crop, or report what it
  actually downloaded. The cost is visible in the same build — `wire_photos.py` hardcoded
  `height="1087"` from the width it *requested*, with nothing able to check the asset it *received*.

  Both halves of that docstring were verified before the change: `sips` exists at `/usr/bin/sips`,
  and it was absent from `BUILTIN_PROGRAMS` (43 entries, not one of them an image tool) though not
  from `NEVER_ALLOWED`, so it was already addable by hand through Settings → Tools. `PIL` is
  genuinely absent (`import PIL` fails on the system `python3`). The argument gate was checked too —
  it refuses absolute paths and `..` rather than flags, so `sips -Z 1920 in.jpg --out out.jpg` passes
  — because a list entry the gate would then refuse is not a capability.

  **Discoverability is part of the fix, not a footnote.** The whole reason this went unnoticed is
  that nothing told the model an image tool existed, so the `run_command` `program` description and
  the agent system prompt now both name `sips` and the two invocations that matter (`-Z` to scale the
  long edge, `-g pixelWidth -g pixelHeight` to measure). A silent allowlist entry would have left the
  gap exactly as it was.

  `sips` acts only on the paths it is given, under the same relative-path argument gate as `cp` and
  `tar` — neither destructive outside its own output nor network-facing — so it is not the kind of
  escalation `NEVER_ALLOWED` exists for. Pinned by
  `tools.rs::sips_resizes_a_real_png_through_the_gate`, which runs the capability rather than reading
  the list: it writes a real 8×8 PNG, resizes it to 4×4 through the gated path with no extra programs
  configured (so it proves the baseline, not mere addability), and reads the result's own `IHDR` to
  confirm the pixels changed. **Falsified:** removing `sips` from the baseline reddens it with
  `program "sips" is not on the allowlist`. macOS-only, because `sips` is.

  Still open, and not fixable in code: `generate_image` has **no working route** — none of the six
  active manifests declares an image endpoint, so every image-modality request in the ledger has
  failed `NO_ROUTE`, the most recent on 2026-10-14. That needs an image-capable provider configured.

- **The Skills screen is a list you can manage in place, modelled on the host app's skills panel.**
  It used to be three stacked sections of cards — Installed, Catalog, and a paste box — with a
  `revoke` link and an `active` checkbox on every row. It is now one screen of two grouped panels:
  a title with a **search field** (name, slug or description), **Status** and **Source** filters, an
  icon-only **Refresh**, and a **+ New** button that opens the SKILL.md composer in a dialog instead
  of parking a textarea under the list. Every installed row carries a **switch** and a **delete**,
  the delete asks first, and a footer counts `N skills · M enabled`. Rows are rows in a panel
  separated by hairlines rather than individual cards, so thirteen skills read as a list, and a row
  expands to show its instructions with a caret that says so.

  Two things are deliberately not ported from that panel, and both would need machinery this app
  does not have. It can **import skills from external agents** by copying or symlinking their
  directories and **sync a skill to a remote host** — our skills are database rows, not folders, and
  reading a directory outside the workspace root is a widening of host file access that should be a
  decision, not a side effect of a redesign. Its **scope selector** (per agent/workspace) has no
  equivalent here either: the Source filter covers builtin-versus-yours, and per-conversation reach
  is already the session drawer in the transcript.

  The two honesty notes stayed and were compressed to a line each. The instruction text is shown
  before installing and after, and the consequence of a delete is stated per source — a builtin can
  be installed again from the catalog, an operator's own skill cannot — because a confirmation that
  says the same thing either way is a confirmation about nothing.

- **The gateway no longer advertises tools it will refuse.** Four of the eight agent tools
  (`write_file`, `edit_file`, `mkdir`, `run_command`) are refused at call time while gateway
  mutation is off, which is the default — but all eight schemas went out on every request from
  every client that brought none. The gateway now advertises only the four it will actually run
  (`gateway_tool_set`), and the eight descriptions were trimmed by 318 characters (26%).
  **Measured on the live gateway: 1,721 → 1,042 prompt tokens, a 39.5% cut**, with the
  tools-suppressed control unchanged at 534 — so the whole delta is the registry. The saving is
  conditional on mutation being off; see `FIXED_CONTEXT_STRATEGY.md` §6.4 for why the two hosts
  disagree about that. Applies to the `aiproviderd` gateway and the in-app Assistant.

- **A key excluded by the auth breaker is no longer excluded forever.** Three consecutive auth
  failures opened a breaker that only a *successful* attempt could clear — and an open breaker meant
  the key was never tried again, so no success could ever arrive to clear it. A credential rotated
  back into service, or an upstream that had a bad five minutes, stayed dead to the router for the
  life of the process. The breaker is now half-open after 60 s: the key is tried again, and that one
  attempt either clears the breaker or re-arms it, so a genuinely revoked key costs one `401` per
  window instead of being silently dropped forever. Applies to both the `aiproviderd` gateway and
  the in-app Assistant. See `DECISIONS.md` 2026-09-27.

- **The Gateway's Claude Code preset pointed `ANTHROPIC_BASE_URL` at the `/v1` endpoint, which
  Claude Code appends `/v1/messages` to — `/v1/v1/messages`, a guaranteed 404.** Found while
  building the Connect-your-IDE panel, whose snippet builders pin the split (OpenAI-compatible
  bases carry `/v1`, Anthropic bases must not) in unit and browser tests asserting the wrong
  form *absent*.

### Fixed

- **A pre-headers timeout had no failover: the plan budget refused the next candidate, so the
  router reported `all attempts failed` after one attempt (drift D123).** `PLAN_BUDGET` was 36 s,
  and `candidate_is_affordable` admits a later candidate only when
  `elapsed + UPSTREAM_HEADER_TIMEOUT <= PLAN_BUDGET`. One candidate spending its whole 20 s header
  budget therefore left `20 s + 20 s > 36 s`, so the second candidate was refused by construction.
  `egress::stream` states that the engine is the recovery for this arm and `attempt_disposition`
  does return `Next`, but `engine::text` ended the plan `Spent` before the next dial — the chain
  showed one entry and the message named one attempt while the plan had two. Ledger rows
  7092/7099 (2026-10-19) are the case: `agent-router/key-03` timed out at 20 056/20 072 ms and was
  the only entry, while `key-04` served the same provider and model at 14:54:00 and 15:02:15. The
  positive control is row 5198 (2026-10-15): a first attempt that failed in ~12.7 s left
  `12.7 + 20 <= 36`, and `vice/key-01` was dialled. The arithmetic, not the provider, decided
  whether failover happened.

  The missing invariant is now asserted: `2 × UPSTREAM_FIRST_BYTE_TIMEOUT <= PLAN_BUDGET <
  FIRST_MSG_TIMEOUT`. `PLAN_BUDGET` moves 36 s → 44 s and `gateway::FIRST_MSG_TIMEOUT` 40 s → 48 s
  together, so the engine still fails before the gateway and the real class survives. The
  `the_plan_budget_fits_inside_the_gateway_bound` test gained the two-attempt clause; the
  per-attempt test that pinned entry 2's refusal is inverted; and
  `a_header_timeout_still_dials_the_next_candidate` drives the path on a paused clock, advancing the
  first dial by exactly 20 s. The stated cost: a genuinely dead request now surfaces at up to 44 s
  instead of 36 s, and a first key that stalls gets one more full attempt instead of failing at
  20 s.

- **A pre-output timeout now reaches a different provider before the failed host's next key, and the
  Assistant uses the bare model so a second provider is in the plan at all.** The plan is ordered
  provider-by-provider, so after `agent-router/key-03` timed out the next candidate was
  `agent-router/key-04` — the same host, which is exactly why the egress refuses to retry a header
  timeout. The measured case (ledger 7160, 2026-10-19) had both keys stall for 20 s while `vice`
  carried the same `deepseek-v4-flash`; the second key was dialled because the plan had no reason to
  prefer a different carrier. The engine now reorders only the *remaining* candidates after a
  `NETWORK` failure, moving other providers ahead of the failed one while preserving each group's
  relative order; a plan with no other carrier is unchanged. The Assistant's stored model moves from
  the qualified `agent-router/deepseek-v4-flash` to the bare `deepseek-v4-flash`, so the alias's
  `vice` carrier is planned. Pinned by `a_pre_output_timeout_prefers_a_different_provider`; the
  full suite is 1,684 green.

- **A network timeout now gets a bounded same-request retry when the plan has no different
  provider, and the Assistant paints the retry as it happens.** Borrowed from ZCode's AI-SDK
  policy (`maxRetries 2`, 2 s initial delay): after a `NETWORK` failure with nothing emitted and no
  other carrier left, the engine sleeps 2 s and re-dials the same candidate, at most twice. The
  wait is priced by the same plan-budget rule, so after a full 20 s header timeout exactly one
  retry fits (`20 + 2 + 20 = 42 <= 44`) and a third attempt does not. The notice travels the
  bridge as a contentless OpenAI chunk carrying `aip_retry` (`provider`, `key`, `attempt`, `max`,
  `delay_ms`, `reason`); the Assistant renders it as `Retrying agent-router · key-03 — attempt
  2/2 in 2s…` and clears it on the first token or when the turn settles. Pinned by
  `a_network_timeout_reprobes_the_same_candidate_when_no_other_provider_exists`, the budget
  arithmetic test, `a_retry_frame_rides_the_openai_stream_without_becoming_content`, and the
  gateway-turn parser test.

- **The verification gate's own demand was being answered by the wrong branch of the test oracle, and
  it silently reverted the work under test (drift D121).** `92efa4a` added a gate that holds a turn
  which mutated the workspace, claimed completion, and verified nothing: it pushes an automated demand
  and gives the model one more round. That demand says *"browser_expect **against** the affected
  page"*, and the harness oracle's loose second-turn branch matches `/again/i` — a substring test, so
  `against` satisfies it. The demand round was therefore answered with
  `edit_file { old: "there", new: "world" }`, which undoes the edit the turn had just made. Seventeen
  specs across five files failed on the consequence: an approval modal for an edit nobody asked for,
  a change set that never rendered, a README back at its pre-turn contents, or a closing sentence
  rendered twice. Main's browser gate had been red since the gate landed.

  The commit anticipated the trap and dodged it for its own prompt by placing that prompt's branches
  above the loose one — placement only protects the branch it was written for. The fix is the same idea
  applied to every other prompt: `mock.mjs` now detects that the message being answered is the gate's
  demand, keyed on the **tail** of the wire rather than the demand's presence in the history (it stays
  there for the rest of the turn, and a presence test would answer an already-answered demand forever —
  an interactive turn has no step budget to stop it), and replies with the demand's own escape clause
  in wording that is neither a completion claim nor a repeat of the first answer, so the gate does not
  fire twice and the closing sentence renders once. The specs were left alone: they were asserting the
  right things about a workspace the harness had been quietly reverting.

- **A gated turn no longer collapses its reasoning into one blob (drift D122).** `attachReasoning`
  scopes itself to the current turn by walking back to the last user message and leaving everything
  before it alone. The verification gate pushes its demand as a user message *mid-turn*, so after a
  gate fired the boundary was the loop's own demand and every round the person had sent fell into the
  history prefix: their thinking went unconsumed and landed together on the final answer. A transcript
  that should have read `Thinking → tools → Thinking → answer` read `tools → claim → demand → all the
  thinking at once` — the 2026-10-06 defect that `agent-timeline.spec.ts` exists to pin, reintroduced
  on 2026-10-16. Measured rather than inferred: the rendered panel was labelled
  `Thought process · 176 characters`, and the oracle's two thoughts are 86 and 90 characters on the
  wire, so 86 + 90 = 176 is exactly the two rounds concatenated.

  The walk now skips a user turn that starts with the loop's own demand, imported from the loop rather
  than matched against a copied literal. A person's turn is still the boundary. This was invisible
  until the fix above landed, because the affected specs failed earlier on the reverted workspace and
  never reached their reasoning assertions — a red gate hides whatever else is red behind it.

- **A manifest that cannot read a stream no longer asks for one (drift D47).** A dialect with no
  `stream` block has no `chunkMap` to read SSE with, so the answer was already read as unary — but the
  request body still carried `"stream": true` from the caller's flag. A provider that honoured it
  replied with SSE, the unary branch parsed that as JSON, failed, and reported a transport error that
  the engine classifies as `NETWORK`: a `502` blaming a provider that had answered correctly. It was
  the third route to the misleading `502` the register already tracks and the second involving no
  allowlist at all, and it fired for a hand-written, imported or generated manifest — every manifest
  on the installed database declares the block, which is why no gate could see it.

  The fix is the repair the register named and had deliberately not taken: `{{stream}}` is now bound to
  **one** decision — "the caller asked to stream AND this manifest can read a stream" — and that same
  decision also governs whether `stream_options` is requested, which endpoint is dialled, and which
  branch reads the answer. Four things that used to disagree now cannot. It is a **both-sides** change
  (the reference and the Rust port), which is why it waited for a way to hold them together: each side
  now carries the same pair of tests, and the corpus added in this release is what makes a one-sided
  edit visible.

- **The same `null`-versus-`undefined` divergence, at a second site — found the same way, on the same
  day.** `shapeMessageContent` tested `contentField !== undefined`, and `"contentField": null` made it
  rename the content field to a key literally called `"null"`, while the Rust port's `Option<&str>`
  read the same manifest as having no rename. Both fields are `z.string().optional()` in the grammar,
  so neither case is reachable through a *validated* manifest — they arrive through the bypass the
  drift register already tracks for other fields (a hand-edited row, an imported config, a manifest
  stored by an older build). Both are fixed anyway: a differential corpus carrying an "except when the
  input is null" caveat is a corpus people learn to ignore.

- **`"systemField": null` in a manifest did nothing on one serving path and something on the other.**
  The reference tested `systemField === undefined`, but this value is parsed from a manifest file,
  where an absent-or-explicitly-null field is `null` at runtime. So a hand-written manifest carrying
  `"systemField": null` hoisted its system prompt into a path literally named `"null"`, while the
  Rust port's `Option<&str>` read the same manifest as having no system channel at all and dropped
  that content. Identical manifests, two behaviours, decided by which path served the request. The
  reference now tests `== null`. **Found by the new conformance corpus on its first run**, which is
  the case for having built it.

- **Two lazily-built runtimes could end the gateway process instead of answering the model.** The
  browser tools and the web search/fetch tools each build a private tokio runtime on their **first
  call** — that is the request path, not startup — and both reached for
  `.expect("the … runtime must start")`. Release builds use `panic = "abort"`, so a thread pool that
  could not be created (resource exhaustion, a restricted environment) killed the process and every
  in-flight client with it, rather than reporting a failed tool call. Both are now fallible, cached
  with their failure so a broken environment is not re-tried per call, and the tools return the
  reason to the model.

  Four more request-path panic expressions went with them, each one provably infallible *today* and
  one edit from not being: `browser.rs`'s `.expect("list_pages refuses empty")` (the refusal lives in
  another function), its `.expect("just connected")`, its `unreachable!` at the end of the retry loop,
  and `mcp.rs`'s `.expect("checked above")` — the last re-fetching `inputSchema` after testing it four
  lines earlier, on a **third-party server's** payload. The MCP one is now a single lookup and a
  match, so there is no invariant to hold.

- **`scripts/panic-census.py` — the panic-source count is now reproducible rather than quoted.**
  `docs/dev-book/06-conventions.md` says the census "goes stale the moment code lands, so re-derive it
  rather than quoting it", and the figure it quoted had drifted. The script masks comments and string
  literals before counting braces (the first version brace-counted raw text, so a test fixture
  containing `"{"` unbalanced the skip and reported four test-only `.unwrap()`s as production),
  preserves line numbers, and separates lock unwraps — unreachable under `panic = "abort"` — from the
  ones that can actually end the process. Re-derived 2026-10-13: **130 `.unwrap()`, all of them lock
  calls; 24 `.expect()`, of which 20 are literal regex/URL/serialization constants; zero
  `panic!`/`todo!`/`unimplemented!`/`unreachable!`.**

- **A builtin skill added to the catalog could never reach an install that already had skills.**
  Seeding stamped one boolean (`skills_seeded`) and returned early forever after, so `BUILTINS` was
  read by a fresh database and by nothing else: the catalog could grow, and every existing install
  kept the four it started with until the operator noticed the Catalog section and installed the
  rest by hand. The record is now per slug — a `settings` row naming the builtins already placed —
  so a builtin from a later release lands on a database seeded long ago, while a revoked one stays
  revoked and a disabled one stays disabled. The old flag is still read, and read as the *smaller*
  claim: a database carrying it holds the original four and not the current catalog, because
  recording more slugs than it holds is exactly what would resurrect a builtin the operator removed.
  One limit is worth stating: an already-placed row is never updated, so a release that *edits* a
  builtin's text still does not reach an install that already has it — revoke it and reinstall from
  the catalog to pick up a changed body. Newly added builtins reach every install; edited ones do
  not.

- **A reasoning model's answer was silently dropped on the non-streaming Anthropic path, because the
  template read block 0.** `content` is a mixed block array and the *provider* decides the order:
  measured 2026-09-29 against `agentrouter.org` (`deepseek-v4-flash`, extended thinking on), a
  perfectly good `200` answered
  `content:[{type:"thinking",…},{type:"text",text:"ok"}]`. The anthropic template's `text` selector
  was `$.content[0].text`, which on that body is `undefined` — so `manifest-interpreter` yielded
  **nothing at all**. The request succeeded, the text was in the response, and the caller received an
  empty message. Nothing downstream can tell that apart from a model that chose to say nothing, which
  is what makes it the worst available failure.

  The streaming path was already correct, and that is what hid this: there, text and reasoning are
  separated by *field name* (`delta.text` vs `delta.thinking`), so `chunkMap.delta` never saw a
  thinking delta. The two paths disagreed and the non-streaming one was wrong. `responseMap.text` now
  points at the block **array** (`$.content`) — exactly as `toolCalls` already did — and the
  interpreter selects the blocks that carry a string `text`, so a `thinking` or `tool_use` block
  cannot be mistaken for the answer. A scalar path is still returned unchanged, so every other
  dialect is untouched.

- **A provider speaking both dialects could not be set up automatically, and the wizard's own
  explanation for that was wrong.** The dialect fingerprinter classifies `anthropic-compat` as "a
  `/messages` endpoint exists **and no** `/chat/completions`" — a negative test, which a host serving
  both fails by construction. `agentrouter.org` is such a host: `GET /v1/models` advertises
  `supported_endpoint_types:["openai","anthropic"]`, and once the client-gate header is supplied
  every probed path answers `401`, so both routes "exist" and no unauthenticated signal is left to
  break the tie. Measured verdict: `unknown` — with the operator told *"Deterministic setup covers
  OpenAI- and Anthropic-compatible APIs"* about a provider that is both.

  **Auto setup now recognises a host it has already measured.** `PROVIDER_PROFILES` gains
  `agentrouter`, pinned to the Anthropic route — the OpenAI one answers `200` with `content: ""` and
  the model's output in `reasoning_content`, so it returns empty text through this product — and
  `profileForBaseUrl` matches it by whole hostname, so `agentrouter.org.evil.test` is a different
  host and does not match. `OnboardingOrchestrator.identify` falls back to the profile when the probe
  is inconclusive. A **client gate is deliberately excluded**: it means the probe never reached the
  provider, so the operator still owes a header and the gate panel is where they supply it. The
  profile names no `User-Agent`, for the same reason `client-gate.ts` declines to — which client to
  impersonate is the operator's decision, not a default this product applies on their behalf.

  The class is not closed: an *unmeasured* dual-dialect host is still unclassifiable, and that
  residual is recorded in the drift register rather than papered over.

- **The alias table was write-once, so the bare id the fix below offers could still have nobody to
  fail over to.** `model_aliases` has **two** writers — `persistAliases` writes derived rows, and
  `config_import` (`persist.rs`, `INSERT OR IGNORE`) merges the aliases out of an imported snapshot —
  and four columns, none of them recording which is which. Boot loaded the whole table as operator
  intent (`store.ts` mapped every row to `auto: false`), and `deriveAutoAliases` honours
  `auto: false` by **leaving that id alone**. So a derived row could never be re-derived, and a
  carrier that appeared after the last derivation could never join an alias that already existed.
  Measured 2026-09-29: `deepseek-v4-flash` carried by two enabled providers (`agent-routerv2`,
  `vice`) with **one** alias row (`vice`) — which is why the request below had nothing to fail over
  to even once its id's form was fixed. `agnes-3.0-flash`, which has a row per carrier, was
  unaffected and so was the model that made the defect invisible.

  `ModelCatalog.hydrateAliases` recovers the distinction by definition rather than by guesswork: a
  derived row is one the derivation *emits*, and `deriveAutoAliases` emits only bare rows
  (`alias === nativeModelId`) on a provider whose catalog carries that native id. Rows inside that
  set are re-derived; a row outside it cannot have come from a derivation, so it is kept and keeps
  its id — which is what preserves a `config_import`ed alias. The method also reports whether the
  rebuild moved the table, so a launch that changes nothing no longer rewrites the rows the gateway
  is reading.

  A provenance column was the other candidate and was rejected on evidence rather than taste: a
  migration would have to pick one default for two populations at once, so a row that predates it
  stays ambiguous either way, while this classification is exact for every row that can exist. The
  residual is narrow and named — a hand-authored row shaped exactly like a derived one would be
  re-derived — and nothing can author one today, because there is no alias editor. See
  `docs/dev-book/07-drift-register.md` D76.

  Five tests in `packages/router-core/test/model-catalog.test.ts`, falsified three times: restoring
  the pre-fix load reddens the incident pair (rows and plan); dropping the carrier half of the
  predicate reddens the pin test; neutering the change-report reddens the write-suppression test.

- **`failoverEnabled` was inert for every model the UI could offer.** A qualified id
  (`slug/native`) resolves to exactly one provider — deliberately, so a pinned provider is never
  silently rerouted — and that was the **only** form any picker produced: `Assistant.tsx` and
  `Settings.tsx` both mapped the catalog to `slug/native`, and `Models.tsx`'s Default button wrote
  the same. So with `settings.router.failoverEnabled` set to `true`, a request for
  `agent-routerv2/deepseek-v4-flash` recorded a **one-entry** fallback chain
  (`[{"provider":"agent-routerv2","key":"key-01","cls":"BAD_REQUEST_SCHEMA"}]`) against a provider
  that failed ~29% of its requests — while `vice` carried the same model and serves it (measured
  live: `POST https://vyceai.com/chat/completions`, `model: deepseek-v4-flash` → `200`). The attempt
  loop has no `break` on a non-retryable class, so the plan *is* the retry policy: there was never a
  second candidate, and the reason was the id's form.

  `lib/models/selectable.ts` is now the single authority for what a picker offers, and all three
  call sites read it. It offers the bare id alongside the qualified ones — the form `Gateway.tsx`
  already documented ("a bare id to let the router pick + fail over"), which was simply unreachable.

  **The carrier set is resolved the way the planner resolves it, not the way the catalog lists it.**
  `ARCHITECTURE.md:501` says a bare ID "resolves through `model_aliases`", and `resolveWanted` skips
  the catalog scan entirely when an alias matches. On this machine the persisted alias
  `deepseek-v4-flash → vice` therefore narrows the bare id to **one** provider even though two
  enabled providers carry it. A first version of the module counted catalog rows and would have
  labelled that entry "any provider (failover)" while the planner pinned it — the defect being
  fixed, one layer down. `bareCarriers` mirrors the planner's precedence and every label is derived
  from the resolved set, so an alias-narrowed entry reads `· router default (vice)` instead, and the
  Model Browser marks it `routed` rather than `failover`.

  Twenty tests, and the fixture carries the **real** alias rows — an earlier draft passed
  `aliases: []`, which is not the shape production has and hid exactly this. Falsified twice:
  disabling the bare-id emission reddens the 5 tests that assert it exists; making `bareCarriers`
  ignore aliases reddens the 5 that assert precedence and label honesty.

- **A gateway that refused the *client* was reported as a provider that rejected the *key*, and the
  key was taken out of rotation for a decision the provider never made.** Adding `agentrouter.org`
  produced `key-01: the provider rejected this key — HTTP 401: {"error":{"message":"unauthorized
  client detected, contact support for assistance at https://discord.gg/HgekCyHJqB"},...}. It is out
  of rotation until you enable it.` Every word of that is wrong in a specific way. The provider did
  not reject the key — measured, it answers `unauthorized_client_error` to *any* unrecognised client
  and only reads the credential once the client is accepted, at which point the same dummy key is
  judged normally as `无效的令牌`. `verdictFor` mapped every `401`/`403` to `invalid`, and `invalid`
  is conclusive: `store.ts` writes it and `HealthTracker.isKeyUsable` then keeps the key out of
  rotation, so a working credential was disabled by a request that never examined it.

  A `401`/`403` whose body names a *client* problem is now classified `unverified` — the verdict that
  means "leave the status alone" — and the notice says the client was refused and the key was never
  judged. Detection lives in one place (`client-gate.ts`), because the desktop key test and the probe
  both need it and two copies of one rule is this repository's most reliable defect. The marker list
  is deliberately two strings long, both quoted from the measured response, and the module says what
  that costs: a gateway that words its refusal differently is not recognised and falls back to
  blaming the key, which is the status quo — the opposite direction would tell an operator their
  rejected key is fine. Four tests; falsified by disabling the detector, which reproduced the
  operator's message character for character.

- **Auto setup could not diagnose a client gate, and reported it as a fingerprint failure.**
  `runProbes` sent only `accept`, and `ProbeAttempt` recorded no body for a non-2xx response, so a
  gateway that refuses the caller looked exactly like one that refuses the key: nine `401`s with no
  shape. `fingerprint` then returned `unknown` — and, worse, still emitted "chat/completions endpoint
  exists" and "messages endpoint exists", which are vacuous on a host that answers `401` to every
  path, and handed the operator two confident facts that were artefacts of the refusal. The probe now
  reads a refusal body far enough to ask one question of it, keeps only the matched marker (never the
  body — `shapeOf` strips values, so the signal would not have survived redaction anyway), and
  `fingerprint` checks for a gate **first**, because a uniform refusal invalidates every other
  reading.

  The gate is now a configuration answer rather than a dead end. `runProbes` accepts extra headers,
  `OnboardingInput` carries them, and the wizard shows a panel naming the marker with a header field
  and **Retry with these headers** — which re-probes with them and keeps them on the provider, so
  they are used for every later request too. The generator is deliberately *not* run for a gate: it
  would spend calls on a refusal that is already explained, and it cannot know which client the
  gateway will accept. The failed provider row is deleted before the retry, because `start()` always
  creates a fresh pending provider and retrying without that would leave one abandoned row per press.

- **The automatic provider setup — probe, fingerprint, AI-written adapter, contract tests — was
  built, tested, and had no way in.** `Onboarding.tsx` implements the whole pipeline: create the
  provider, probe it, classify it with the deterministic `fingerprint`, and either instantiate the
  built-in template or — when no known dialect matches — run best-of-N AI candidate generation
  gated by schema → lint → free contract checks, with a Tier-2 sandboxed code adapter as the last
  resort. It is covered by `e2e/onboarding-e2e.test.ts` and by the live-UI harness. And
  `go("onboarding")` appeared **nowhere** in the app: the string existed only in the `ScreenId`
  union and the render branch in `App.tsx`, and the sidebar's `NAV` carried no entry. A screen that
  is implemented, tested and unreachable is indistinguishable to a user from a feature that was
  never built — the only provider flow anyone could find was the manual modal.

  The Providers screen now offers **Set up automatically**, from the first-run hero and from the
  header, and the sidebar carries **Auto setup** — which also gives an interrupted wizard a way
  back, since it persists its session and offers to resume. The manual flow keeps its own entry
  point and its Quick-add presets; the two buttons are deliberately worded differently so neither
  the user nor a test has to guess which flow a label means.

  Two live-UI specs had been reaching the wizard through an "Any other provider — guided setup"
  entry inside `AddProviderModal` that no longer exists in any component, so `web-test` cannot have
  been passing; they now navigate through the new button. `smoke.spec.ts`'s hand-copied
  `NAV_LABELS` gains the new item, which puts the screen under both the "every screen renders
  without an uncaught error" guard and the "no screen calls a command the shim does not implement"
  guard.

- **`?seed=systemai` could not boot the app, so every spec that used it timed out.** The seed's
  model rows carried five fields; `HostModelRow` declares seven, and `isHostModelRow` guards
  `pricingJson` and `capabilitiesJson` with `nullable` — which, unlike `maybe`, rejects an **absent**
  key (`host-boundary.ts:52`). So `arrayOf(isHostModelRow)` failed, `fetchAdminAs` threw
  `HostShapeError: GET /admin/models-cache: the host sent a shape this build does not understand`,
  and the app rendered its "App data could not be opened" card instead of the shell. Every
  `?seed=systemai` spec then failed on its first `getByRole` — 13 smoke tests, all of `memory.spec.ts`,
  `audit-log`, `agent-graph`, `app-budget` and `trail-health` — and each burned the full 120 s test
  timeout rather than reporting a boot failure.

  `SeedInput.models` is now host-shaped and **requires** both JSON columns, so the next omission is a
  compile error naming every offending row rather than a boot failure in an unrelated spec; the seven
  rows were given `pricingJson: null, capabilitiesJson: null`. Measured: the smoke spec's "AI
  Providers" render check went from a 2 m 11 s timeout to **1.1 s**, and `smoke.spec.ts` from
  never finishing to **14 passed in 22.5 s**.

- **`pnpm web-test` could not start its own server, so the live-UI suite never ran.** Playwright's
  `webServer` availability check resolves `http://127.0.0.1:1430/web-test/` through the ambient
  `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` variables, and a proxy that cannot reach a loopback
  address answers `404`. Playwright therefore waited its full 60 s and reported `Timed out waiting
  60000ms from config.webServer` — while vite was listening on the port and answering `200` to
  every other client. Measured on 2026-09-28: vite ready in **849 ms**, `curl` and Node's
  `http.get` both `200` on that exact URL, Playwright `404`; and the same suite green in **842 ms**
  with the six variables unset. The `web-test` script now unsets them itself, so the gate no longer
  depends on the shell it happens to be invoked from.

- **A provider whose base URL was missing its API path reported the symptom, never the cause.**
  A "New API"/One-API gateway serves an HTML single-page app from `/` and every unknown path — at
  **status 200** — while the real API lives under `/v1`. With `baseUrl` set to the bare host, all
  three of the wizard's probes hit the SPA and were parsed as JSON: **Fetch from provider** reported
  `JSON Parse error: Unrecognized token '<'`, the **key test** reported the same, and **Test** on a
  model reported *"answered with an empty response — the request succeeded but no content came
  back"*. Three different messages, one misconfiguration, and none of them named the URL or the
  likely remedy. Reproduced live on 2026-09-28: `api.hcnsec.cn/models` → `200 text/html`,
  `api.hcnsec.cn/v1/models` → `401 application/json`.

  Bodies are now parsed through `jsonBody(raw, url)`, which on a non-JSON body reports the URL it
  asked, quotes the first 80 characters of what came back, and — when the body opens with `<` —
  says the base URL is most likely missing its API path and suggests `https://<host>/v1`. The
  streaming path gets the same treatment: the first non-blank SSE line is checked for `<`, so an
  HTML body is named rather than read as a stream that ended cleanly. Guarded at all four parse
  sites (`listModels`, non-stream `generateText`, `generateImage`, the SSE loop). Four tests in
  `packages/router-core/test/non-json-body.test.ts`; the two guard tests were falsified against the
  unguarded interpreter.

  The wizard's Base URL field also asked for the wrong shape: its placeholder was
  `https://api.example.com` while onboarding's has read `https://api.example.com/v1` since the
  profile flow was written — the manual path was the one out of step, and the field takes the value
  **verbatim** (`buildManualManifest` assigns it to `provider.baseUrl` unchanged, while the template
  appends `/models` and `/chat/completions`). It now matches onboarding and carries a one-line hint.

- **Onboarding's first write left a ghost provider behind when the host refused it.**
  `createPendingProvider` added the provider to the registry and *then* wrote it host-side, with no
  rollback — while `addProvider` eleven lines up has had one since 26j, and the note above `addKey`
  names the same hazard for a credential. A refused write (the gateway down, a 401, a duplicate slug)
  therefore left a provider the host had never heard of: `addKey` ran against an id the host did not
  know, and every probe was refused for a host the allowlist never received — surfacing as "could not
  identify this API", a claim about the API produced by a local bookkeeping failure. It now removes
  the record it just added. `deleteProvider` rather than `refreshFromHost`: an unreachable host fails
  the resync too, which would leave the ghost in exactly the case that created it.

- **A provider added after the app started was refused on every request — `HTTP 599`, "host not
  allowlisted" — because the app process and the gateway each keep their own egress allowlist and
  only one of them was being maintained.** The app seeds its list once, in `setup()`
  (`tauri::app::initial_allow_hosts`). Provider CRUD from the webview goes over HTTP to the admin
  route, and `app.rs` **probes the port and delegates to the launchd agent when the agent already
  holds it** — so with the service installed that route recomputed the *agent's* list and left the
  app's untouched. The app's list was only ever correct when the app itself had bound the port,
  because then its embedded gateway shares the same `Arc`. Reproduced live on 2026-09-28: provider
  `vice` at `vyceai.com`, status `pending`, created 21:05 into an app started 20:54 — every request
  refused before any upstream dial, so the ledger held no row for it at all and a stale cache in a
  second process read as a network fault.

  `EgressState` now re-derives its list from `providers` before deciding (`refresh_allow`, called
  from `build` and `fetch_image`), so the refusal cannot be made on a stale list. The webview gains
  nothing by this: the rows are host-written (invariant 12) and its only way to add one is the
  gateway's authenticated admin route, which already widened the gateway's list. Two tests pin it —
  one asserted through `build`, so deleting the call site fails rather than passing on a helper, and
  one asserting a `draft` provider's host is still refused.

- **A successful turn whose only output was a tool call was recorded as `PARSE_ERROR`.** Tool calls
  travel by `on_tool_call`, never through the text sink, so a tool-call turn delivered zero chunks —
  and "did anything get served?" was being answered by counting chunks. The row said
  `status=error, error_class=PARSE_ERROR` for a request the client received intact, while the same
  request was recorded as `OK` in key health. 11 of the 42 rows written on 2026-09-27 were this.
  "Served" now means *delivered output*: a text chunk or a tool call. A `200` with an empty body is
  still `PARSE_ERROR` and an aborted request is still `CANCELLED`. Applies to both the
  `aiproviderd` gateway and the in-app Assistant. See `DECISIONS.md` 2026-09-27.

- **A tool call delivered and then a mid-stream break still failed over, re-issuing the tool call.**
  `emitted` — the flag that decides whether a break can still fail over to the next candidate — was
  chunk-only, so a tool call delivered and then a break produced `Next` rather than `Rethrow`. The
  next candidate re-issued the same tool call, and the consumer held two for the same turn. A
  delivered tool call now also ends failover: the predicate folds in a tool-call count, so the
  break produces `MidStream` (not `AllAttemptsFailed`) with the serving candidate named. The
  `records_key_health` invariant — a rethrown failure must be a drift class — still holds, because
  a mid-stream break after a tool call classifies the same way as one after a chunk. Applies to
  both the `aiproviderd` gateway and the in-app Assistant. See `DECISIONS.md` 2026-09-27.

- **A provider that answered with headers and then sent no body was recorded as a client abort.**
  The egress bounded the wait for *response headers* at 20 s but left the wait for the **first body
  byte** inside the 120 s streaming budget — four times the gateway's 30 s first-message bound — so
  the gateway always gave up first, cancelled the request, and the ledger wrote `CANCELLED` with an
  empty attempt chain and `http_status` null: a timeout filed under the name of a client disconnect,
  with no line in any log and no failover, because the engine sees a stream that ended cleanly rather
  than an attempt that failed. One deadline now encloses both phases, stamped *before* the request is
  sent, so a body that never starts fails at the same 20 s as one that never gets headers — with a
  real class, a populated chain, and a `warn!` naming the phase that expired. A request whose body
  has demonstrably started is untouched: the 120 s budget still governs silence between chunks.
  Measured on ledger row 1671. See `DECISIONS.md` 2026-09-27 and drift-register **D74**.

- **Adding a key could strand its secret in the vault with no row to reach it.** `addKey` writes the
  secret to the keychain and *then* records the `api_keys` row; when the row insert failed — a 500
  from the provider foreign key, a dead gateway, a 401 — the secret was left behind. It was invisible
  to the keys list, which reads `api_keys`, and so could be neither selected nor revoked anywhere in
  the UI. The secret is now deleted again when the row does not land, matching the rollback the host's
  `key_create_h` and `addProvider` already performed. See `DECISIONS.md` 2026-09-27.

- **Two operator scripts dialled a port nothing was listening on.** `soak-gateway.sh` defaulted to
  `8787` — the *other* gateway's compiled default — and `repro-restore.sh` probed the same port, while
  the service listens on `8800`. Both then took recovery paths that could not work either:
  `open -a "/Applications/AI-Provider Router.app"`, a bundle that is not installed there. Three more
  defects sat behind the port, each hidden by the one before it. `repro-restore.sh`'s
  `pkill -f "AI-Provider Router"` matched no process — the service is `aiproviderd` — so it killed
  nothing and reported a successful restore on every attempt. The soak's TSV wrote the five literal
  characters `$'\t'` between its fields, so every row carried 3 tab-separated columns against a
  4-column header. And the listener's supervisor was misidentified, because `launchctl list` prints
  nothing from a non-interactive shell while `launchctl print` reports the job running. Both scripts
  now resolve the port through a shared `scripts/lib/gateway-port.sh`, drive `launchctl` against the
  job that owns the listener, and emit parseable output. See `docs/dev-book/07-drift-register.md` D72.

- **A slow upstream was being aborted at 10 s and then retried with the same prompt — so a healthy
  request failed as `CANCELLED` at 30 s.** Four requests failed this way in eight minutes on
  2026-09-27 (ledger rows 1652/1655/1656/1658), reported to the client as *"the router produced no
  response within 30000ms"*. Three separate defects stacked behind that one symptom:

  **(1) The pre-headers budget was too small.** `first_msg_ms` — the only in-path time-to-first-byte
  this system records — measures **p50 2.1 s, p90 7.1 s, p99 18.6 s, max 18.6 s** across 54 real
  requests. At 10 s the bound was *manufacturing* the stall it existed to survive: 4/54 requests
  exceeded it and then succeeded on the retry, two of them measurably (attempt 2 delivered 2.80 s
  and 8.60 s after the stall). It is now **20 s**, which covers every success ever recorded.

  **(2) The retry was on the wrong arm.** A header timeout looped and re-sent the identical prompt
  to the identical host; a genuine transport error returned with no retry at all. The two are now
  the right way round: a transport error gets one more dial, because a *fresh connection* is a
  different roll; a header timeout does not, because it cannot be. The header budget is no longer
  multiplied by a retry count.

  **(3) Nothing bounded the plan.** `execute_text` walks every candidate, and with two candidates the
  worst case was `2 x 20 s = 40 s` against a 30 s gateway bound — so the last candidate was *always*
  cut off mid-attempt. The log proves it: entry 2 starts its own `attempt=1` 18 ms **after** the
  gateway has already given up. The engine now holds a **26 s plan budget** and admits a candidate
  only when it can fund a full attempt, so `20 s <= 26 s < 30 s` is a real ordering. A request that
  exhausts it now fails at ~20 s through the router's own path and is recorded with the class its
  attempts produced, instead of reaching 30 s and being filed as `CANCELLED`.

  **(Superseded 2026-10-13: the budget is 36 s and the gateway bound 40 s — the 26 s window turned
  out to be too narrow to fund the re-probe rounds added the next day. The reasoning above is
  unchanged and the ordering still holds; see the re-probe entry below and drift D104.)**

  The old invariant test pinned only one candidate's budget and so could not see (3); it now asserts
  the three-constant ordering. All three new tests were falsified against the previous behaviour
  before being trusted. See `docs/dev-book/07-drift-register.md` D73.

- **The same-key re-probe budget was unreachable, and the test that pinned it read a different
  clock.** `SERVER_ERROR_REPROBES_MAX = 3` was added on 2026-10-12 so a plan-exhausted candidate gets
  three re-dials instead of one. It never did. A re-probe is admitted only when
  `elapsed + wait + UPSTREAM_HEADER_TIMEOUT <= PLAN_BUDGET`, so against the **26 s** plan budget of
  the day a round had to be *decided* inside **4 s** — and the two keys of one provider had already
  spent 3.3–3.7 s failing before round one was decided. Round two was refused at ~7.5 s, and round
  three was unreachable for any timing at all, so the constant behaved as **1** in production. The
  ledger says so across its whole history: the longest attempt chain ever recorded is **3** dials,
  and not one row has ever carried four. Rows 4079/4083 (2026-10-13, `agent-router`,
  `deepseek-v4-flash`) are the user-visible form — `all attempts failed for
  agent-router/deepseek-v4-flash [key-01:SERVER_ERROR -> key-02:SERVER_ERROR -> key-02:SERVER_ERROR]`,
  with the upstream's own `500 Upstream rejected the request as invalid` preserved in the chain.

  The regression test could not catch it because **it measured a clock the budget does not read**: it
  runs `start_paused = true`, which makes `tokio::time::sleep` free, while the plan was stamped with
  `std::time::Instant`, which the paused clock never moves. Elapsed time stayed near zero, every
  round was affordable by construction, and the test exercised only the count.

  `PLAN_BUDGET` is now **36 s** and `gateway::FIRST_MSG_TIMEOUT` **40 s** — the pair moves together,
  because the plan sitting strictly below the gateway bound is what keeps a budget refusal legible as
  the real error class instead of a gateway `CANCELLED`. That widens the window to 14 s, which funds
  all three rounds at the measured ~1.83 s per refused dial. `text.rs` now stamps the plan with
  `tokio::time::Instant`, so the paused clock and the budget agree and the existing count test can
  actually fail; a new spec pins the arithmetic rather than the intent — three rounds affordable, the
  fourth not. The cost is bounded and stated: a bridge that never speaks now fails after 40 s rather
  than 30 s, and a normal request is unaffected because this bounds only the wait for the *first*
  message.

  Separately, `settings.assistant.model` still held the **qualified** `agent-router/deepseek-v4-flash`.
  A qualified id resolves to exactly one provider, so `failoverEnabled` was inert for the Assistant
  and every request during the flap burned an attempt on a host that was returning 500 — with `vice`
  carrying the same model the whole time (296 successful `deepseek-v4-flash` rows, most recent
  2026-10-12 20:28:49). It is the bare `deepseek-v4-flash` now, which resolves to agent-router with
  vice as live failover. See `docs/dev-book/07-drift-register.md` D104.

- **A tool call the model's output cap cut off mid-arguments was executed as an empty call and
  reported as `missing argument "path"`.** Measured 2026-10-13 from this machine's own
  `session_messages`: four consecutive `write_file` calls at 24 444 / 31 480 / 31 213 / 30 854
  characters, every one invalid JSON ending mid-string or mid-tag, each answered `missing argument
  "path"` — the "showing 3-4 times" report — while the 327-character call in the same turn parsed
  and wrote 258 bytes. Two halves of the code that should have caught it were unreachable. The
  provider *had* reported the cap (`finish_reason: "max_tokens"` → `"length"`), but the loop's
  truncation guard is gated on `collected.length === 0`, so a length cut **carrying** tool calls
  fell straight through to execution; and `parseArgs` returns `{}` for anything it cannot parse,
  which `do_write_file` read `path` from first — so the model was told a key was missing when its
  payload had never finished arriving. The remedy was already known to the model, which found it by
  experiment at seq 75 — *"Short writes work — the long one was too big. I'll build the file in
  chunks"* — and the file was then built to 77 118 bytes through `edit_file`.

  A length cut that arrives carrying tool calls is now re-asked once **with the remedy attached**
  (`TRUNCATED_TOOL_CALL_NOTE`: name the cut, say the call did not run, say to chunk) before anything
  is replayed or run — the blind re-ask is what produced four identical failures, so the guidance is
  the fix and not a nicety. A call whose arguments are present, non-empty and unparseable is refused
  with `argumentProblemMessage` instead of being sent as `{}`, while absent and empty arguments stay
  legitimate no-argument calls — the control that keeps the refusal from refusing every
  argument-free tool. Four new specs, all falsified against the previous behaviour before being
  trusted. See `docs/dev-book/07-drift-register.md` D105.

- **The gateway refused any request body over 2 MB, and said so nowhere.** A client reported
  `413 Failed to buffer the request body: length limit exceeded` — axum's own `LengthLimitError`
  wording — on a turn that should simply have been large. The cause is a limit nobody declared:
  the ingress handlers take their body as a buffering extractor (`chat_h`'s `body: String`), so
  axum's **default** `DefaultBodyLimit` applied to every route. It was invisible at the point of
  use and in the logs alike — a grep for `length limit` over both `aiproviderd.log` and
  `gateway.log` returns nothing, because the extractor refuses *before* the handler and therefore
  before anything logs a dispatch.

  It was also within one session of ordinary traffic. The ledger's largest recorded request is
  **238 823** input tokens (next: 236 753 / 234 690 / 233 105 / 232 594), on the order of 1 MB of
  JSON against a 2 MB default — a bound nobody chose, about a factor of two above this gateway's
  own measured maximum, on a surface whose clients send whole agent transcripts.

  `MAX_REQUEST_BODY_BYTES` is now **64 MiB**, applied as `DefaultBodyLimit::max(…)` in the router's
  layer stack and derived rather than picked: ~64× the largest observed request, plus headroom for
  base64 attachments, since a single binary write is already allowed to be 8 MB and is ~10.7 MB
  once base64-inflated. It stays a real bound, and the reason it can be generous is the binding —
  the gateway listens on loopback only. Pinned by a test that posts a 3 MB conversation through the
  real router and asserts it is not `413` *and* is answered `200`, so it cannot pass by failing
  somewhere quieter; removing the layer reddens it with the exact client-visible status. One
  residual is registered rather than hidden: extraction precedes admission control, so bodies are
  buffered for connections that later queue. **And a second one, deliberately not fixed here:** the
  refusal is still silent, so a body over the *new* cap reproduces the original symptom — a
  client-side 413 with nothing in either log. Raising a limit moves the threshold; making the
  crossing legible needs a middleware plus the tracing-capture helper this repo does not yet have,
  and an unpinned log claim is worse than a registered gap. See
  `docs/dev-book/07-drift-register.md` D106.

- **A `500` that says your request was invalid was retried as though the provider were unwell.** A
  client reported `all attempts failed for agent-router/deepseek-v4-flash [key-03:SERVER_ERROR ->
  key-03:SERVER_ERROR -> key-03:SERVER_ERROR]` — three to four dials and ~15–19 seconds spent on a
  refusal that was identical every time. Ledger rows 4280 and 4283 record `SERVER_ERROR` / `http 500`
  with **`tokens_in = 0`**: the upstream refused *before reading the request*, so the verdict was
  about the body's shape and could not change between dials. The body said so plainly —
  `{"error":{"message":"Upstream rejected the request as invalid","type":"invalid_request_error"}}`.

  The taxonomy read the status and never the body: `classify` returned `ServerError` for any
  `status >= 500`, and `ServerError` is key-retryable, so the engine re-probed the same key and would
  have failed over. `detect_invalid_request` now supplies `BodyHint::Schema` — a hint the enum
  already declared and nothing produced — and a 5xx carrying it classifies as `BAD_REQUEST_SCHEMA`:
  drift, so the key is not burned, and absent from `is_retryable_with_next_key`, so nothing re-probes
  or rotates. The client is told its request was wrong instead of being told the provider is broken.
  Mirrored in `packages/router-core`, with the same test in both engines, both falsified: neutralizing
  the `classify` arm reddens Rust with `left: ServerError, right: BadRequestSchema`, and dropping the
  TypeScript hint reddens it with `expected 'SERVER_ERROR' to be 'BAD_REQUEST_SCHEMA'`.

  Two things this does **not** do, registered in D107 rather than implied away. It does not make those
  requests succeed — the bodies agent-router refused would still be refused. And it does not
  establish *why* they were refused: no outgoing body is persisted anywhere, so the reason string is
  the whole of the evidence. The leading reading is an aggregator relaying an upstream `400` as a
  `500` — the shape of the `tool_result` rejection measured on agentrouter.org on 2026-10-02 — and it
  is named as a hypothesis, not a finding. See `docs/dev-book/07-drift-register.md` D107.

- **The assistant turn of every tool call went out carrying a content part the caller never sent.**
  This is the cause of the refusals D107 only learned to report quickly. A turn that is nothing but
  tool calls carries `content: ""` — that is every tool-calling turn in every agent transcript — and
  Phase F spelled that empty string as `[{type:"text",text:""}]`. The parts assembler then passed
  the array through unfiltered and appended the `tool_use` beside it, so the body rendered as
  `[{"type":"text","text":""},{"type":"tool_use",…}]`: an **empty text block**, which
  Anthropic-shaped upstreams reject.

  It was a guard defeated by a spelling. `as_parts` refuses to *make* a text part out of an empty
  string (its string arm tests `!s.is_empty()`) while its array arm was a plain `items.clone()` — so
  whether the guard held depended on which layer had normalised the message, and Phase F always got
  there first. Reproduced by running the real pipeline order (normalize, then render) over the shape,
  and the failing requests are the gateway's own UI session (`app_key_id = ak-ui`) against
  `agent-router`, an Anthropic-dialect manifest: ledger 4280/4283/4340, every one
  `500 … "invalid_request_error"` with `tokens_in = 0`. The existing test had carried this exact
  fixture since D101 but asserted only the user and tool messages — never the assistant one.

  Fixed in both layers and both engines, because either alone leaves a path uncovered: Phase F no
  longer fabricates a part from empty content, and `as_parts`/`asParts` now drop empty `text` parts
  from an array — the only guard that reaches a client sending the array spelling directly.
  Falsifying it changed the tests: reverting `asParts` alone did **not** redden the Phase F test,
  which showed the two guards are not interchangeable and the array spelling needed its own case.

  **⚠ The causal claim above was FALSIFIED on 2026-10-15 and must not be used.** The prediction was
  made falsifiable on purpose and then tested against the live upstream: `content: ""`, `content: []`
  and `[{type:"text",text:""}]` — mid-transcript *and* as the final message — **all answer `200`**.
  The empty block was a real defect that happened not to be the cause. The change above stands as a
  **correctness** fix (a part the caller never sent is not emitted), but it is **not** what fixed the
  2026-10-14 refusals. Those were caused by an image part splitting a turn's `tool_result`s — see the
  D109 entry below and `docs/dev-book/07-drift-register.md` D109.

- **An image part split a turn's `tool_result`s, and the upstream rejected the whole request.** When
  an agent turn called `read_image` (or `generate_image`) *alongside* any other tool, the loop built
  the image's own `user` message while walking the results — putting a `user` message **between** two
  `tool_result`s. Anthropic requires each `tool_use` to be answered in the message **immediately**
  after it and rejects the entire request when one is not, so every attempt for that request failed
  and the whole turn was lost (6 tool calls in, 224k prompt tokens, `iterations = 0`).

  Isolated against the live `agentrouter.org`, not inferred: the split order answers **`400`** —
  *"messages.1:`tool_use` ids were found without `tool_result` blocks immediately after: call_2."* —
  and the control with both results together answers **`200`**. The fix appends results only, and
  pushes the image messages after the run, so results stay consecutive and the image still arrives
  with its note one message later.

  Five other candidates were killed by the same method (all `200`): the empty `text` block and empty
  assistant turns generally, the full replayed transcript, an image on a second consecutive `user`
  message, untemplated part shapes the upstream silently ignores, and size (8.39 MB is accepted;
  23 MB is a different failure — an `nginx` `413`). See `docs/dev-book/07-drift-register.md` D109.

  **Not everything with this signature is fixed.** Ledger 4280/4283 carry the same `500` +
  `invalid_request_error` but their runs read **no image**, so a second cause exists and is still
  open — registered as D110, with no fix claimed.

## [1.2.0] - 2026-09-26

### Changed

- **The OS keychain is gone. Secrets live in `<data_dir>/.secrets.json` (mode 600, atomic write).**
  `keyring` was removed from the dependency graph. This is a **one-time migration**: existing
  keychain entries are abandoned, not migrated. The first launch after this change answers
  `401 no master key configured` until you run `aiproviderd mint` (or use the UI's mint flow)
  to rotate a new key. Provider keys need one re-entry in the UI. See `DECISIONS.md` 2026-09-26.

- **`aiproviderd` subcommands.** Five new subcommands let you manage the headless service
  without opening the UI:
  - `aiproviderd install` — copy the binary to `~/Library/Application Support/…/bin/`,
    write the plist, `launchctl bootstrap`
  - `aiproviderd uninstall` — `launchctl bootout` + remove the plist
  - `aiproviderd status` — print the job's loaded/pid/health state
  - `aiproviderd self-install` — copy the running binary to `/opt/homebrew/bin` or
    `/usr/local/bin` (whichever exists)
  - `aiproviderd mint` — rotate the master key and write it to `.secrets.json`;
    prints the new key once (the old key stops working immediately)

### Added

- **Phase 6 — headless service end-to-end.** The `.app` bundle now ships the Tauri-free
  `aiproviderd` (no WebKit linkage). `scripts/substitute-tauri-free-aiproviderd.sh`
  (`pnpm build:headless`) is the post-bundle step; `scripts/check-bundled-aiproviderd-links.sh`
  is the gate. Both CI mirrors (`ci.yml`, `ci-local.sh`) and `release.yml` run the two steps.

- **`launchd_live` tests** (`#[ignore]`, Aqua session required). Test 1: `service::install`
  produces a job launchd actually runs. Test 2: a real `aiproviderd` binary is installed as
  the agent payload, `/health` is asserted live, and the app's probe-and-delegate decision
  reads `Some(port)` against the agent's port. Run from Terminal.app after building the
  Tauri-free binary.

## [1.1.0] - 2026-09-26

### Added

- **Headless service, Phase 1 — the gateway no longer has to live inside the desktop app.** The Rust
  half of the codebase is now split into `src/core/` (no dependency on the Tauri glue) and
  `src/tauri/` (commands, the worker-window bridge, app setup), and a new binary, `aiproviderd`,
  starts the HTTP server with no window, no WebView and no Tauri app.

  **What this does and does not do.** It proves the HTTP server starts and binds on its own:
  `aiproviderd` opens the same SQLite file, reads the master key from the same keychain, binds
  `127.0.0.1:8800` (persisted setting first), and answers `GET /health` with `200 {"status":"ok"}`.
  It does **not** serve completions, and is not meant to yet — the router core is still TypeScript
  running in a hidden webview, so the standalone service has nothing to bridge to and every
  completion route answers `503` by design. Porting the router core to Rust is Phase 2.

  `GET /health` is the one new route, and the one unauthenticated one: it reports that a process is
  listening and nothing more, so a client that does not yet hold a key can still find the service.
  All seven existing routes, and both the 404 and 405 refusals, still authenticate first.

  Three notes on the split, because they are not what the plan predicted: `persist.rs` and
  `egress.rs` sit in `core/` — not in `tauri/` — because `gateway.rs` calls `persist` in non-test
  code and `persist` in turn needs `egress` and `CommandError`; `core/` still imports the `tauri`
  *crate* (`persist.rs` carries 32 `#[tauri::command]` handlers), so the service is Tauri-free in
  source but not in dependency; and one `cfg(test)` edge in `gateway_tests.rs` still points back at
  `tauri/`, which affects `cargo test` and not `cargo build --bin aiproviderd`.

  CI gains a `headless-service` job building `aiproviderd` on macOS, Windows and Linux.

- **Per-app budgets.** A per-app gateway key can now carry its own monthly cap, so one runaway
  consumer — an agent loop in a connected IDE — is stopped without touching any other app, and
  without touching the owner's global budget. Until now the only cap was global and monthly: one
  `month_micros` against one `cap_micros`, which a single app could exhaust while every other app
  sat idle.

  The two limits are enforced **independently**, and the refusals are distinguishable. Both are
  `402 insufficient_quota`, but the body names which limit bound: `spend_cap_exceeded` for the
  global cap, `app_budget_exceeded` for one app's own. That distinction is load-bearing, because
  the remedies are opposite — the first is an operator problem that stops every app, the second is
  fixed by raising one key's budget or waiting for the month to turn.

  Migration 0017 adds the nullable `gateway_keys.cap_micros` and the index the per-app spend SUM
  needs, `ledger(app_key_id, ts)` — which 0016 deliberately declined to ship until a query existed
  to justify it. `cap_micros` is nullable and clearing stores `NULL` rather than `0`, so there is
  one spelling of "no budget" rather than two that behave identically until something queries
  `IS NULL`.

  Budgets are set per key on **Local Gateway**, beside the key they limit; the global cap stays on
  **Control**. Per-app *attribution* (0016) is the prerequisite and landed first — a budget has
  nothing to sum without it, and rows written before 0016 stay unattributed, so an app's total
  starts from the first request made after it.

- **Auto context compression.** Long conversations no longer overflow the model's window. Tier 1
  (hard truncation) and Tier 2 (summarization) are both included.

  Tier 1 drops the oldest **complete turns** until the prompt fits the budget, sized against the
  narrowest context window in the failover plan. Three properties are preserved, each pinned by a
  test: the `system` turn survives; the **newest** turn survives even when it alone exceeds the
  budget; and a tool call and its results are always dropped together.

  Tier 2 replaces the dropped turns with a compact summary, wired for the assistant via
  `createSummarizer`. The summarizer's own inner call sets `skipCompression: true`, because
  without it the chain would be unbounded — compressing would trigger a summary, which would
  compress again. The gateway stays on Tier 1 (stateless, latency-sensitive); Tier 2 is available
  via `generateText`'s `summarize` option for callers that want it.

  Both tiers are covered by the **same** trim: the two callers converge on `router.generateText`,
  so there is one rule rather than two that could drift apart.

- **Prompt-cache measurement.** The ledger now records `cached_tokens` for every request, read in
  whichever dialect the provider uses: OpenAI-shaped `prompt_tokens_details.cached_tokens`, or
  Anthropic's top-level `cache_read_input_tokens`.

  The column is **nullable on purpose**. `NULL` means the provider reported no cache block at all,
  which is a different finding from reporting a zero — and telling those apart is the entire point.
  Without it, every provider would look like a provider that caches nothing, and the question
  "would sending `cache_control` help?" could not be answered in either direction.

  This release is **measurement only**. No request shape changed and nothing sends `cache_control`
  yet; the data has to exist before that decision can be made honestly.

- `pnpm check-version-sync` — asserts the root `package.json`, both workspace packages,
  `apps/desktop/package.json`, `Cargo.toml` and `tauri.conf.json` all agree on one version.

- **Coverage measurement.** `pnpm test:coverage` runs all three vitest suites under
  `@vitest/coverage-v8` and prints one weighted figure across the workspace: **43.8% statements,
  37.3% branches, 31.1% functions, 45.4% lines**. Previously `coverage/` was gitignored and nothing
  produced it, so "did this change make things worse" had no answer at all.

  It is a **report, not a gate**. A coverage threshold fails unrelated refactors, and the cheapest way
  out of that failure is to lower the threshold — after which nobody reads the number. The gate keeps
  holding the line that matters: all 460 unit, 98 browser and 481 Rust tests must pass.

  Two mechanics worth knowing. The aggregate is **weighted** — counts are summed and the percentage
  recomputed, never the three `pct` values averaged, which would weight a 300-line package the same as
  a 6,000-line one. And a missing report is a hard error rather than a zero, because summing two of
  three and printing a confident percentage is the failure mode that matters most here.

- **Dependency auditing.** `pnpm audit --audit-level=moderate` now runs in `ci.yml` and in the local
  mirror, and a weekly `.github/workflows/audit.yml` re-runs it alongside a RustSec audit of the
  Tauri host on `ubuntu-latest`.

  The level started at `high` earlier the same day, and that was a measurement rather than a
  preference: two moderate advisories shared a single root cause — a `vitest` devDependency whose
  patched line (`>=4.1.11`) was a whole major version away — so `moderate` could not pass without a
  test-runner migration first. That migration landed the same day (see `### Changed`), so the level
  was raised to `moderate` and both mirrors re-verified. The scheduled job exists because an
  advisory can be published against code that has not changed, and a push-triggered gate never
  fires for that.

- **Per-app spend attribution.** The ledger now records *which* app key paid for a request
  (`ledger.app_key_id`, migration 0016), so a per-app budget finally has something to sum. The
  gateway's own app key (`gateway_keys.id`) previously appeared in no column at all: `ledger.key_id`
  holds the *provider* credential, and the two are different ids that both answer to "key".

  The column is only half of it. The identity is now returned by the gateway's auth check instead of
  being looked up a second time, threaded through all six dispatch sites, carried across the bridge
  to the webview, and mapped into the ledger write — and that last hop is the one that mattered,
  because the ledger is written on the webview side. A column, a TypeScript field and a sink mapping
  together would still have recorded nothing. Four tests cover it, each falsified before being
  trusted.

  This is **attribution only**. Nothing yet sets or enforces a per-app cap, and existing rows stay
  `NULL` — nothing can reconstruct which app paid for them.

- **A self-verifying release pipeline.** A release build can no longer succeed into a broken
  artefact. `scripts/release-preflight.sh` runs first and refuses to start the build when an Apple
  secret is missing, when the `.p12` will not open with the given password, or when a signing
  identity has been pinned in `tauri.conf.json`. `scripts/verify-release-signature.sh` then reads
  the built artefacts back and requires them to be Developer ID signed, hardened, and notarized; if
  they are not, the job fails and the draft release is deleted.

  The defect this closes was silent rather than loud. `tauri build` succeeds with **no** Apple
  secrets at all and emits an **ad-hoc signed** app, which launches fine locally — where Gatekeeper
  does not assess it — and is refused on a user's machine. A tag push therefore produced a green
  job and a draft Release containing something macOS refuses to open, and the failure surfaced for
  a user instead of in CI.

  **`codesign --verify` is not sufficient, which is why the verifier does not rely on it.** Measured
  against an ad-hoc bundle, it prints `valid on disk` and `satisfies its Designated Requirement` and
  **exits 0** — an ad-hoc signature is a valid signature. The checks that separate signed and
  notarized from ad-hoc are `spctl` (exit 3 vs 0), `stapler validate` (exit 65 vs 0), the
  `CodeDirectory` flags word (`0x2(adhoc)` versus `0x12a00(…,runtime)`) and the `Authority=` chain.
  Both scripts were falsified against both states before being written into the workflow.

  Provisioning the certificate and the six repository secrets remains a one-time manual step,
  written out in `CONTRIBUTING.md` under "Releasing" — it is an Apple Developer account action that
  no code change can perform.

### Fixed

- **A client-facing `Retry-After` is now the shortest wait, not the longest.** The route planner
  *drops* a cooled key rather than deprioritising it, so the earliest a retry can be served is when
  the first cooled key frees up. The gateway was telling clients to wait for the last one, which was
  longer than necessary. The value is still floored so a client is never told to retry into a window
  that has not closed.

### Changed

- **Licensed under Apache-2.0** (`LICENSE`), with a `license` field added to every manifest.
- `bundle.targets` narrowed to what is actually built and tested (macOS). The previous `"all"` also
  produced Windows and Linux installers that this project has never run.
- CI now runs `pnpm build`, so a bundle that no longer compiles cannot pass. Previously the
  Playwright harness exercised a **dev server**, which meant nothing in CI touched the production
  bundle — the local gate (`pnpm ci:local`) was the stricter of the two.
- CI now runs `pnpm check-version-sync`, which fails when any manifest disagrees with
  `tauri.conf.json` about the product version.
- **`vitest` 3.2.7 → 4.1.11 across all three packages**, clearing GHSA-82fw-gwwq-j7x9 (a path
  traversal in `@vitest/mocker`, vulnerable `>=2.1.0 <4.1.11`). **No test changed**: every vitest
  config used only long-stable options, so all 460 tests passed on 4.1.11 as written.

  The one real cost had nothing to do with vitest. `pnpm typecheck` then failed with
  `TS2591: Cannot find name 'node:child_process'` in `e2e/mock-servers.ts` and
  `src/lib/tools/agentLoop.test.ts`, while `@types/node@26.6.0` sat in the tree complete (89 `.d.ts`)
  and correctly symlinked. `tsc --listFilesOnly` enumerated **409 files including 83 `@types/node`
  files** before the bump and **238 including zero** after, so the reshaped dependency graph had
  stopped `@types/node` being auto-included at all. `apps/desktop/tsconfig.json` now states
  `"types": ["node"]` rather than inferring it: an implicit default is a dependency on the install,
  not on the code.

- **The Rust host is now rustfmt-formatted, and the gate enforces it.** `cargo fmt --check` runs in both
  mirrors, first in the Rust block. Adoption had been deferred because a stock config rewrites most of
  the host and destroys `git blame` for no behavioural change — measured on the 24,006-line host, that
  is **638 hunks / 42.2% of it**. `use_small_heuristics = "Max"`, the single non-default setting in the
  new `apps/desktop/src-tauri/rustfmt.toml`, cuts that to **354 hunks / 30.1%** by keeping the compact
  "one line if it fits" style the code already uses — so the rewrite preserves the host's look rather
  than replacing it. The 24 files, 4,172 insertions and 3,473 deletions it did touch carry no meaning
  whatsoever, which is exactly why they are their own commit rather than part of a release batch.

### Removed

- **The auto-updater documentation and scripts.** They described a mechanism that was never
  implemented, and three details were wrong in ways that would have cost real time:
  `SIGNING.md` claimed `tauri.conf.json` contained an `updater` block it did not contain, and put it
  at the top level where Tauri v1 kept it rather than under `plugins.updater` where Tauri v2 keeps
  it; it exported `TAURI_SIGNING_PUBLIC_KEY`, which is not a variable Tauri reads; and
  `generate-updater-keys.sh` produced an **RSA** keypair with `openssl`, while Tauri's updater
  verifies **minisign/ed25519** keys produced by `tauri signer generate` — so keys from that script
  could never have verified an update.

  A document that describes update signing incorrectly is worse than no document, because it is what
  the next contributor trusts. Updates are manual for now; see `README.md`.

- Three empty directories at the repository root (`IDE/`, `ai/`, `provider/`), untracked and so
  invisible to `git status`.

## [1.0.0] - 2026-09-22

The first release. A local-first desktop app that routes LLM requests across the user's own AI
provider accounts.

### Added

- **Provider management.** Providers are described by a declarative adapter manifest. Known profiles
  are available as quick-add; anything else can be added manually, or discovered by a guided
  probe → identify → contract-test → approve wizard that only enables a provider after you confirm
  it.
- **Local OpenAI-shaped gateway** on `127.0.0.1`, so other tools can reach every configured provider
  through one endpoint. Per-app gateway keys mean a leaked or retired client can be revoked without
  rotating the master key.
- **Keychain-backed secrets.** API keys are held in the OS keychain and never written to disk.
- **Usage ledger** with per-request tokens, cost estimates, latency and error class, plus monthly
  rollups — including source attribution, so UI, gateway and internal generator traffic are
  distinguishable.
- **Drift detection and repair** for providers whose API changes under them.
- **A memory layer** with scoped recall, plus a context graph of artifacts, memories, skills and
  messages.
- **An agent loop** with sandboxed tool execution and a visible step trail.

### Known limitations

- Developed and tested on **macOS only**. Windows and Linux are untested: the keychain-backed secret
  store and the gateway have never been exercised there.
- Updates are manual — there is no auto-updater.
- Distribution is not yet notarized; see `SECURITY.md` and `CONTRIBUTING.md`.
