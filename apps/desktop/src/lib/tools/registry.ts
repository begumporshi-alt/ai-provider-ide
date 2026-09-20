/**
 * Tool registry for agent mode (2026-09-17).
 *
 * This is the single source of truth for what the model may call. Every entry maps 1:1
 * to a Rust sandbox handler in tools.rs — if a tool is not listed here, the model cannot
 * name it, and even if it did, the host would refuse it. `registryToOpenAI` renders the
 * OpenAI `tools` array; `additionalProperties:false` keeps the model from smuggling extra
 * fields that the sandbox would ignore anyway.
 *
 * `write_file`, `edit_file`, `mkdir` and `run_command` are MUTATING — the four the gateway
 * refuses unless mutation is explicitly enabled, and the four the Assistant confirms one call at
 * a time. The other four only read, and are always available.
 */
import type { ToolSpec } from "./types";

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the workspace and return its contents. Directories are rejected. Use offset/limit to read part of a large file instead of swallowing the whole thing.",
    parameters: {
      properties: {
        path: {
          type: "string",
          description: 'Workspace-relative path, e.g. "src/main.rs". Cannot be absolute or escape the root.',
        },
        offset: {
          type: "number",
          description: "Optional first line to return, 1-based. Omit to start at the top.",
        },
        limit: {
          type: "number",
          description: "Optional number of lines to return. Omit to read to the end.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write UTF-8 text to a workspace file, creating parent directories as needed. Overwrites any existing file — prefer edit_file for changing one part of a file you have read.",
    parameters: {
      properties: {
        path: { type: "string", description: "Workspace-relative path." },
        content: { type: "string", description: "Full text content to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_dir",
    description: "List the entries of a workspace directory. Defaults to the workspace root.",
    parameters: {
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative directory path. Optional; defaults to \".\".",
        },
        recursive: {
          type: "boolean",
          description: "Optional. true to include subdirectories instead of just one level.",
        },
      },
      required: [],
    },
  },
  {
    name: "search_files",
    description:
      "Search the workspace for a literal string and return matching lines as path:line: text. Case-insensitive by default. Use this to find where something is defined instead of reading files one at a time.",
    parameters: {
      properties: {
        pattern: { type: "string", description: "Literal text to find. Not a regex." },
        path: {
          type: "string",
          description: "Optional workspace-relative file or directory to search. Defaults to \".\".",
        },
        case_sensitive: {
          type: "boolean",
          description: "Optional. true to match case exactly (default is case-insensitive).",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "file_info",
    description:
      "Report whether a workspace path exists, and its kind, size and last-modified time. A missing path is a normal result, not an error.",
    parameters: {
      properties: {
        path: { type: "string", description: "Workspace-relative path." },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace an exact snippet in a file. The snippet must match exactly — including indentation — and must occur exactly once unless replace_all is true. Safer than rewriting a whole file.",
    parameters: {
      properties: {
        path: { type: "string", description: "Workspace-relative path of the file to edit." },
        old: { type: "string", description: "Exact text to find. Quote enough surrounding lines to make it unique." },
        new: { type: "string", description: "Replacement text. May be empty to delete the snippet." },
        replace_all: {
          type: "boolean",
          description: "Optional. true to replace every occurrence instead of refusing an ambiguous match.",
        },
      },
      required: ["path", "old", "new"],
    },
  },
  {
    name: "mkdir",
    description: "Create a directory inside the workspace, including any missing parents.",
    parameters: {
      properties: {
        path: { type: "string", description: "Workspace-relative directory path." },
      },
      required: ["path"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a single allowlisted command inside the workspace. There is no shell, so ; | && ` ` and $( ) are inert literals, not syntax. Network-facing git subcommands (push/pull/fetch/clone) are refused.",
    parameters: {
      properties: {
        program: {
          type: "string",
          description:
            "Executable from the allowlist: ls, cat, grep, rg, find, git, node, npm, npx, pnpm, python3, make, tar, sed, awk, …",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Positional arguments, each a literal string.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional wall-clock timeout in ms (enforced upper bound is 60 000).",
        },
      },
      required: ["program"],
    },
  },
];

/** Render the OpenAI `tools` array from a registry. Empty registry yields undefined so the
 *  caller can omit `tools`/`tool_choice` entirely (some providers 400 on an empty list). */
export function registryToOpenAI(registry: ToolSpec[]): unknown {
  if (registry.length === 0) return undefined;
  return registry.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: t.parameters.properties,
        required: t.parameters.required ?? [],
        additionalProperties: false,
      },
    },
  }));
}
