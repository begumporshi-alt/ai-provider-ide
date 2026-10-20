/**
 * The system turns both send paths build, extracted from the Assistant screen (turn-engine
 * phase 1) so the screen's prompt editor, context meter and send paths read one definition.
 */
import { type ChatMessage } from "@aiprovider/router-core";
import { applyPromptPatches, type PromptPatchBlock } from "@aiprovider/axiom-core";
import { userWireContent } from "./messages";
import type { Msg } from "./messages";

/**
 * Agent-mode system prompt. Unlike the no-tools guard (which suppresses tool-call markup),
 * this one tells the model it DOES have tools and how to use them — confined to the workspace
 * root the user sets. It is deliberately terse; the sandbox, not the prompt, is the enforcement.
 */
export const AGENT_SYSTEM =
  "You are an agent inside AI-Provider Router. You have file and shell tools confined to the " +
  "workspace root the user specified. Complete the task by calling tools: search_files to find " +
  "a literal string you already know, or rg through run_command when the search needs a pattern " +
  "— rg -n \"fn handle_(request|response)\" src finds definitions by shape, rg -nw Name matches " +
  "a whole word. There is no type-aware navigation here, so a pattern plus read_file is how you " +
  "follow a symbol; read_file (with offset/limit for large files) and list_dir to inspect, " +
  "file_info to check a path exists, edit_file to change one exact snippet, write_file to " +
  "create a whole file, mkdir to make a directory, run_command for allowlisted commands. " +
  "Run a project's own toolchain through run_command rather than asserting a change is correct: " +
  "cargo build / cargo test / cargo clippy / cargo fmt in a Rust project, npm or pnpm test and " +
  "npm run for a JavaScript one. If there is no test script, run the checks the project does " +
  "define — typecheck, lint, build — and name which ones ran; never say \"nothing to run\" when " +
  "those exist. " +
  "For print output, render at the paper sizes and viewports that matter — browser_print takes " +
  "paper (a4/letter/legal or custom inches), margin_in, and viewport_width/viewport_height with " +
  "mobile — instead of only Chrome's default. For a connected Android device or emulator, use " +
  "device_list, device_open_url (10.0.2.2 is the host from the emulator), and device_screenshot. " +
  "For the public web, web_search (keyless, with fallback backends) finds pages, web_fetch reads one, " +
  "and web_ask answers a question about a page without loading it into this conversation. " +
  "read_document reads PDFs and Word files; read_image shows you an image if you support vision. " +
  "For image work beyond reading one — resize, crop, convert, optimise, or measure its real pixel " +
  "size — call sips through run_command (sips -Z 1600 in.jpg --out out.jpg; sips -g pixelWidth " +
  "-g pixelHeight img.jpg). " +
  "For any task with several steps, maintain the task list with todo_write (the whole list, each " +
  "task pending/in_progress/completed, one in_progress at a time) — the user watches it live. " +
  "Prefer inspecting before editing, and prefer edit_file over rewriting a whole file. " +
  "Never ask the user to run a command — call the tool. " +
  "Stop calling tools once the task is done and give a concise final answer.";

/**
 * The agent's system prompt, plus where it actually is.
 *
 * Without the root, "what is the exact path?" is a question the agent cannot answer: it has to
 * spend a tool call on `pwd`, and if that call is denied or fails it reports that it cannot tell.
 * The root is the user's own setting, so naming it costs nothing and answers the question outright.
 */
export function agentSystem(root: string, custom?: string): string {
  const base = custom && custom.trim() ? custom.trim() : AGENT_SYSTEM;
  const r = root.trim();
  if (!r) return base;
  return (
    base +
    `\n\nYour workspace root is: ${r}. Every relative path resolves inside it — answer questions ` +
    `about the path from this rather than spending a tool call on \`pwd\`.`
  );
}

/**
 * Plan mode's system prompt (Phase 5; rewritten 2026-10-10 around `exit_plan_mode`).
 *
 * The prompt is not the enforcement — the approval gate refuses every mutation itself, and would
 * refuse them even if this text were deleted. Saying it anyway is what makes the pass *useful*:
 * a model that is asked to research and is silently blocked at its first edit spends its tool
 * budget rediscovering that it cannot write, and then answers with an apology. Told up front —
 * including how the pass ends — it proposes instead.
 */
export const PLAN_MODE_SYSTEM =
  "\n\nPLAN MODE — this pass exists to agree on a plan before anything changes. Reading, listing, " +
  "searching and inspecting run without asking; every writing tool (write_file, edit_file, mkdir, " +
  "run_command, and the rest) is refused until a plan is approved, so do not attempt one. " +
  "Investigate whatever the plan needs first — never propose a change to code you have not read. " +
  "When the plan is ready, call exit_plan_mode with the complete plan in markdown: what we are " +
  "building; the files to create; the files to modify by exact path; how the result will be " +
  "verified; and what is explicitly out of scope. The user reviews it. If they approve, plan mode " +
  "ends and you implement the plan in this same pass, starting immediately; if they ask for " +
  "changes, revise the plan and call exit_plan_mode again. Anything you need to ask goes in your " +
  "answer — not in the plan.";

/**
 * Guard against the mercury-2.5 failure: Assistant declares no tools, and a model handed a
 * toolless request will sometimes invent tool-call markup from its agentic training data.
 * Saying so outright in the system turn stops it at the source. Off = raw model behaviour,
 * which is what you want when probing a provider's own prompting.
 */
export const NO_TOOLS_SYSTEM =
  "You are answering inside AI-Provider Router's Assistant — a plain chat console. " +
  "You have no tools, functions, plugins, or file/shell access of any kind. " +
  "Never emit tool-call markup (for example <tool_call>, <|tool_call_start|>, or <function=...>). " +
  "When a request would need a tool, say so in plain prose and describe the steps instead.";

/** Inputs to the agent request's system turn, in the order the pieces concatenate. */
export interface AgentSystemParts {
  root: string;
  /** The user's custom agent prompt; blank falls back to the built-in. */
  custom?: string;
  /** The skills block the screen appends verbatim (already newline-prefixed when non-empty). */
  skillsBlock: string;
  /** The session-references block, same convention as `skillsBlock` (see lib/chat/turn/
   *  session-references). The conversation's source links, listed so every reply can prefer them. */
  referencesBlock?: string;
  /**
   * The verified session manifest for this turn, empty when memory is off or nothing is scoped.
   * It reads above `recalledMemory` because it is the stable half of the context: identity,
   * decisions and live capabilities change slowly, while recall is this question's specifics.
   */
  manifest?: string;
  /** The recalled-memory text for this turn, empty when memory is off or nothing recalled. */
  recalledMemory?: string;
  planMode?: boolean;
  /** The per-turn instruction's system text, empty when none was set. */
  perTurn?: string;
  /**
   * The AXIOM blocks from the active version (`parsePromptPatches` on its stored prompt), or absent
   * when nothing is promoted. A stored version travels as its patches rather than as a whole
   * `promptOverride` so that promoting one cannot quietly discard a system prompt the user has since
   * edited — see `parsePromptPatches` in `@aiprovider/axiom-core`.
   */
  axiomPatches?: PromptPatchBlock[];
}

/**
 * The agent request's system turn: base prompt → AXIOM's patches → skills → manifest → recalled
 * memory → plan mode → the per-turn instruction, each absent piece omitted. Order matters — the
 * per-turn constraint is the most specific and reads last, directly above the user's turn.
 *
 * The patches go immediately after the base rather than at the end because that is what they are:
 * amendments to the agent's standing instructions, measured against this prompt and promoted as a
 * configuration. Everything after them is per-turn context, which changes underneath a standing
 * instruction every send.
 *
 * `applyPromptPatches` refuses past its own caps rather than appending a truncated block, so a
 * hand-edited row in `axiom_versions` cannot buy the agent an arbitrarily long prompt. The refusal
 * is dropped here on purpose: the version was capped when it was built, and the screen shows what the
 * active version contains — silently appending a half-instruction would be the worse failure.
 */
export function buildAgentSystem(parts: AgentSystemParts): string {
  const base = parts.axiomPatches?.length
    ? applyPromptPatches(agentSystem(parts.root, parts.custom), parts.axiomPatches).prompt
    : agentSystem(parts.root, parts.custom);
  return (
    base +
    parts.skillsBlock +
    (parts.referencesBlock ?? "") +
    (parts.manifest ? `\n\n${parts.manifest}` : "") +
    (parts.recalledMemory ? `\n\n${parts.recalledMemory}` : "") +
    (parts.planMode ? PLAN_MODE_SYSTEM : "") +
    (parts.perTurn ? `\n\n${parts.perTurn}` : "")
  );
}

/**
 * The plain-chat request's message array: system → manifest → recalled memory → per-turn
 * instruction → replayed history → the user's turn. Same ordering rule as the agent path; the
 * user's turn is content-parts when it carries images and a plain string otherwise.
 */
export function buildPlainRequestMessages(
  /** The resolved no-tools/custom prompt; `undefined` means "no system turn at all" (the blank
   *  editor's third state — the model gets its provider default). */
  systemPromptText: string | undefined,
  /** The verified session manifest, in its own system message above the recalled block. */
  manifestMsg: string | undefined,
  recallMsg: string | undefined,
  perTurn: string,
  history: ChatMessage[],
  userTurn: Pick<Msg, "content" | "attachments" | "imageReadings" | "imagesReadBy">,
): ChatMessage[] {
  return [
    ...(systemPromptText ? [{ role: "system" as const, content: systemPromptText }] : []),
    ...(manifestMsg ? [{ role: "system" as const, content: manifestMsg }] : []),
    ...(recallMsg ? [{ role: "system" as const, content: recallMsg }] : []),
    // Last, and directly above the user's turn: a per-turn constraint is the most specific
    // instruction in the request, and its own message keeps it from reading as the user's words.
    ...(perTurn ? [{ role: "system" as const, content: perTurn }] : []),
    ...history,
    {
      role: "user" as const,
      // `userWireContent` — the same rule the replay uses, so a turn carrying a reading sends the
      // reading on the first send and on every replay of it.
      content: userWireContent(userTurn),
    },
  ];
}
