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
 *
 * That split is now *declared* on each entry (`effect`) rather than only described here, because
 * Phase 5's approval modes and plan mode both have to ask "does this tool write?" on every call,
 * and a second hand-maintained list of mutating names is a list that eventually disagrees with
 * this one. `effect` and the gateway's `MUTATING_TOOLS` are pinned together by a test.
 */
import type { ToolEffect, ToolSpec } from "./types";

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    effect: "read",
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
    effect: "mutate",
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
    effect: "read",
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
    effect: "read",
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
    effect: "read",
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
    effect: "mutate",
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
    effect: "mutate",
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
    effect: "mutate",
    description:
      "Run a single allowlisted command inside the workspace. There is no shell, so ; | && ` ` and $( ) are inert literals, not syntax. git may clone, fetch, pull and push; gh covers GitHub (repos, PRs, issues, gists, releases, runs, api — gh auth and gh repo delete refused).",
    parameters: {
      properties: {
        program: {
          type: "string",
          description:
            "Executable from the allowlist: ls, cat, grep, rg, find, git, gh, node, npm, npx, pnpm, python3, make, tar, sed, awk, …",
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
  {
    name: "glob",
    effect: "read",
    description:
      "List workspace paths matching a glob pattern: ** spans directories, * and ? stay in one segment. Capped at 500 entries.",
    parameters: {
      properties: {
        pattern: {
          type: "string",
          description: 'Glob relative to the workspace root, e.g. "src/**/*.rs". May not contain "..".',
        },
        path: {
          type: "string",
          description: 'Optional workspace-relative base directory to match within. Defaults to ".".',
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_document",
    effect: "read",
    description:
      "Read text from a PDF or Word (.docx) document in the workspace — the binary documents read_file cannot serve. Text is capped.",
    parameters: {
      properties: {
        path: { type: "string", description: "Workspace-relative path of the .pdf or .docx." },
      },
      required: ["path"],
    },
  },
  {
    name: "read_image",
    effect: "read",
    description:
      "Read a workspace image (png/jpg/gif/webp, 4 MB cap) so a vision-capable model can see it in the next turn.",
    parameters: {
      properties: {
        path: { type: "string", description: "Workspace-relative path of the image." },
      },
      required: ["path"],
    },
  },
  {
    name: "web_ask",
    effect: "read",
    description:
      "Ask a question about a web page: fetches it and answers with the model in a side call, so the page text stays out of the conversation. Only the answer is returned.",
    parameters: {
      properties: {
        url: { type: "string", description: "The page's public http(s) URL." },
        question: { type: "string", description: "What you want to know from that page." },
      },
      required: ["url", "question"],
    },
  },
  {
    name: "http_request",
    effect: "mutate",
    description:
      "Run one HTTP request against a public URL: method, headers, body; returns the response. It sends data out, so it is always confirmed; private hosts are refused.",
    parameters: {
      properties: {
        url: { type: "string", description: "Public http(s) URL. Redirects are reported, not followed." },
        method: {
          type: "string",
          description: "Optional: GET (default), POST, PUT, PATCH, DELETE, HEAD, OPTIONS.",
        },
        headers: { type: "object", description: "Optional request headers as name/value strings." },
        body: { type: "string", description: "Optional request body (POST/PUT/PATCH only)." },
      },
      required: ["url"],
    },
  },
  {
    name: "apply_patch",
    effect: "mutate",
    description:
      "Write a unified diff (multi-hunk, multi-file) into workspace files: context must match exactly; a mismatch fails the whole patch.",
    parameters: {
      properties: {
        patch: {
          type: "string",
          description: "The full unified diff, ---/+++ and @@ hunks included. New files start from /dev/null.",
        },
      },
      required: ["patch"],
    },
  },
  {
    name: "todo_write",
    effect: "read",
    description:
      "Write the task list for the current run: replace it wholesale with every task and its status. Keep at most one task in_progress.",
    parameters: {
      properties: {
        todos: {
          type: "array",
          description: "The full task list, in order.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "The task, one sentence." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  {
    name: "web_fetch",
    effect: "read",
    description:
      "Read a public web page from the internet: fetched over http(s), HTML stripped, text capped at 32 KB. Private, loopback and non-http(s) URLs are refused.",
    parameters: {
      properties: {
        url: {
          type: "string",
          description: "The page's public http(s) URL. Redirects are reported, not followed — call again on the Location.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "web_search",
    effect: "read",
    description:
      "Search the public web (keyless, automatic fallback between backends) and get the top results: title, URL and snippet. Follow up with web_fetch to read a result.",
    parameters: {
      properties: {
        query: { type: "string", description: "What to search for, in the user's terms." },
      },
      required: ["query"],
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

/** Effects by tool name, for callers that hold a name rather than a spec. */
const EFFECT_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t.effect]));

/**
 * The effect of a call by name.
 *
 * **Unknown names are `"mutate"`.** A name this registry does not list is one the host would
 * refuse anyway, but the answer must not be "read" — that would let a tool that appears in a
 * future registry (or one a manifest-shaped host implements) run unprompted under
 * "auto-approve reads" on the strength of being unrecognised. Fail closed.
 */
export function toolEffect(name: string | undefined | null): ToolEffect {
  if (!name) return "mutate";
  return EFFECT_BY_NAME.get(name) ?? "mutate";
}
