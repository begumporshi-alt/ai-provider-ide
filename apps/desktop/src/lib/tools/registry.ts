/**
 * Tool registry for agent mode (2026-09-17).
 *
 * This is the single source of truth for what the model may call. The four entries map 1:1
 * to the Rust sandbox handlers in tools.rs — if a tool is not listed here, the model cannot
 * name it, and even if it did, the host would refuse it. `registryToOpenAI` renders the
 * OpenAI `tools` array; `additionalProperties:false` keeps the model from smuggling extra
 * fields that the sandbox would ignore anyway.
 */
import type { ToolSpec } from "./types";

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the workspace and return its contents. Directories are rejected.",
    parameters: {
      properties: {
        path: {
          type: "string",
          description: 'Workspace-relative path, e.g. "src/main.rs". Cannot be absolute or escape the root.',
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write UTF-8 text to a workspace file, creating parent directories as needed. Overwrites any existing file.",
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
      },
      required: [],
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
