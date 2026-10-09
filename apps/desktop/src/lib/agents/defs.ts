/**
 * Subagent definitions (Phase: file-based specialists).
 *
 * A `dispatch_agent` delegation used to have exactly one shape: the built-in read-only
 * researcher (`SUBAGENT_SYSTEM` + `SUBAGENT_TOOLS` in agentLoop.ts). A definition file is the
 * user's way to add more: named specialists the model can route to deliberately, each with its
 * own system prompt, tool allowlist, optional model override, and step budget.
 *
 * The format mirrors ZCode's markdown agent files in spirit but lands as JSON next to the app's
 * sqlite db (`{app_data_dir}/agents/*.json`, written by the host's `agent_def_*` commands), so
 * the definitions are plain files a user can inspect, edit by hand, or keep in a backup — the
 * same manageability argument that made ZCode's agents and skills screens thin CRUD over files.
 *
 * Validation is hand-rolled and tolerant, in this codebase's house style (no zod): a file that
 * fails the guard is *skipped and surfaced*, never a crash inside the agent loop — the same
 * philosophy as `driftTriggerSummary` and the skills frontmatter parser. A definition must
 * never be a permission upgrade: the loop intersects any tool allowlist with the read-effect
 * set, so `tools` can only narrow what a sub-agent may call, never widen it.
 */
import { AGENT_TOOLS } from "../tools/registry";
import type { ToolSpec } from "../tools/types";

/** One user-authored sub-agent definition, as stored on disk and shown in the management UI. */
export interface SubagentDef {
  /** Stable slug — the `agent` argument the model passes to `dispatch_agent`, and the filename. */
  id: string;
  /** Display name. */
  name: string;
  /** What this specialist is for. Shown to the model (routing) and in the management screen. */
  description: string;
  /** The system turn the sub-agent runs under. The isolation suffix is appended by the loop. */
  systemPrompt: string;
  /** Optional allowlist of tool names. Absent/empty = the built-in read-only set. */
  tools?: string[];
  /** Optional model override (`provider/model`), else the parent's model. */
  model?: string | null;
  /** Step budget, clamped to the loop's bounds on use. */
  maxIterations?: number;
  /** Disabled definitions stay on disk but are never dispatched. */
  enabled: boolean;
}

/** The read-effect tool names a definition's allowlist may draw from. Precomputed once: the
 *  registry is static for the process lifetime (MCP tools are registered at runtime, but a
 *  sub-agent allowlist pinned to a session's MCP set would silently break on the next launch,
 *  so builtins only). */
const ALLOWABLE_TOOL_NAMES: ReadonlySet<string> = new Set(
  AGENT_TOOLS.filter((t: ToolSpec) => t.effect === "read").map((t) => t.name),
);

export function allowableToolNames(): string[] {
  return Array.from(ALLOWABLE_TOOL_NAMES);
}

/** A slug the model can type as `dispatch_agent`'s `agent` argument, and a safe filename. */
export function isValidDefId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id);
}

const MAX_PROMPT_CHARS = 20_000;

/** Parse one definition file's JSON. Returns the def, or a reason it was skipped — a reason the
 *  caller can show, because a definition the user wrote that silently never dispatches is the
 *  "evidence nobody can consult" failure all over again. */
export function parseSubagentDef(raw: unknown): { def: SubagentDef } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "not a JSON object" };
  }
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (!id) return { error: `"id" is missing` };
  if (!isValidDefId(id)) {
    return { error: `"id" must be lowercase letters, digits, - or _ (got "${id}")` };
  }
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return { error: `"name" is missing` };
  const description = typeof o.description === "string" ? o.description.trim() : "";
  if (!description) return { error: `"description" is missing — it is what the model routes on` };
  const systemPrompt = typeof o.systemPrompt === "string" ? o.systemPrompt.trim() : "";
  if (!systemPrompt) return { error: `"systemPrompt" is missing` };
  if (systemPrompt.length > MAX_PROMPT_CHARS) {
    return { error: `"systemPrompt" is over ${MAX_PROMPT_CHARS} characters` };
  }

  // The allowlist is validated against the read-effect registry here, at parse time, so the
  // management screen can flag a typo before the model ever runs with a silently missing tool.
  let tools: string[] | undefined;
  if (Array.isArray(o.tools)) {
    tools = [];
    for (const t of o.tools) {
      if (typeof t !== "string" || !t.trim()) return { error: `"tools" entries must be non-empty strings` };
      const tool = t.trim();
      if (!ALLOWABLE_TOOL_NAMES.has(tool)) {
        return { error: `"tools" names a tool that is not a read-effect builtin: "${tool}"` };
      }
      if (!tools.includes(tool)) tools.push(tool);
    }
  } else if (o.tools !== undefined && o.tools !== null) {
    return { error: `"tools" must be an array of tool names` };
  }

  let maxIterations: number | undefined;
  if (o.maxIterations !== undefined && o.maxIterations !== null) {
    if (typeof o.maxIterations !== "number" || !Number.isFinite(o.maxIterations)) {
      return { error: `"maxIterations" must be a number` };
    }
    maxIterations = Math.max(1, Math.min(50, Math.floor(o.maxIterations)));
  }

  const model = typeof o.model === "string" && o.model.trim() ? o.model.trim() : null;

  return {
    def: {
      id,
      name,
      description,
      systemPrompt,
      ...(tools ? { tools } : {}),
      model,
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      enabled: o.enabled !== false,
    },
  };
}

/** Parse a directory listing of `{ fileName, contentJson }` rows (from `agent_defs_list`) into
 *  defs plus visible skips. One malformed file is one warning row, never a failed load. */
export function parseSubagentDefs(
  rows: Array<{ fileName: string; contentJson: string }>,
): { defs: SubagentDef[]; skipped: Array<{ fileName: string; error: string }> } {
  const defs: SubagentDef[] = [];
  const skipped: Array<{ fileName: string; error: string }> = [];
  const byId = new Map<string, string>(); // id -> fileName that claimed it first
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.contentJson);
    } catch {
      skipped.push({ fileName: row.fileName, error: "not valid JSON" });
      continue;
    }
    const parsed = parseSubagentDef(raw);
    if ("error" in parsed) {
      skipped.push({ fileName: row.fileName, error: parsed.error });
      continue;
    }
    // Two files claiming one id are a hand-edit away from the model dispatching a specialist the
    // user did not write: the first file (the host lists alphabetically) wins, the loser is
    // surfaced rather than silently shadowed.
    const claimant = byId.get(parsed.def.id);
    if (claimant) {
      skipped.push({ fileName: row.fileName, error: `duplicate id "${parsed.def.id}" (also in ${claimant})` });
      continue;
    }
    byId.set(parsed.def.id, row.fileName);
    defs.push(parsed.def);
  }
  return { defs, skipped };
}
