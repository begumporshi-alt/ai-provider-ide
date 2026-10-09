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
        background: {
          type: "boolean",
          description:
            "Start without waiting and return a job id (bg-N) immediately. Use for dev servers, watchers, long builds — anything you would otherwise kill at the timeout. Poll the job with process_output, stop it with process_kill. The result of a finished job stays readable until the job table (64 slots) evicts it.",
        },
      },
      required: ["program"],
    },
  },
  {
    name: "browser_navigate",
    effect: "mutate",
    description:
      "Point the connected browser tab at a URL and wait for the page to settle. Drives the user's own Chrome (or Chromium/Edge) started with --remote-debugging-port=9222 — nothing is spawned. Follow with browser_snapshot to see what the page offers.",
    parameters: {
      properties: {
        url: { type: "string", description: "The page to open — an http(s) or file:// URL." },
        port: {
          type: "number",
          description: "Optional debugger port. Defaults to 9222.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_snapshot",
    effect: "read",
    description:
      "List the connected page's visible interactive elements — buttons, links, inputs — each as [N] with its label. The [N] indexes are how browser_click and browser_fill address elements, and they go stale when the page changes: re-snapshot after navigating or clicking.",
    parameters: {
      properties: {
        port: { type: "number", description: "Optional debugger port. Defaults to 9222." },
      },
      required: [],
    },
  },
  {
    name: "browser_click",
    effect: "mutate",
    description:
      "Click a snapshot element with real mouse events at its position — hover, focus and the page's own event path run exactly as a user's click. The index is valid only for the most recent browser_snapshot.",
    parameters: {
      properties: {
        element: { type: "number", description: "The [N] index from the latest browser_snapshot." },
        port: { type: "number", description: "Optional debugger port. Defaults to 9222." },
      },
      required: ["element"],
    },
  },
  {
    name: "browser_fill",
    effect: "mutate",
    description:
      "Type a value into a snapshot element — text input, textarea, select or contenteditable. Delivered the way React and other frameworks listen for (native setter + input/change events), so controlled inputs update. The index is valid only for the most recent browser_snapshot.",
    parameters: {
      properties: {
        element: { type: "number", description: "The [N] index from the latest browser_snapshot." },
        text: { type: "string", description: "The value to enter." },
        port: { type: "number", description: "Optional debugger port. Defaults to 9222." },
      },
      required: ["element", "text"],
    },
  },
  {
    name: "browser_screenshot",
    effect: "mutate",
    description:
      "Capture the connected page as a PNG saved into the workspace (images/ by default) and attach it, so a vision-capable model sees the page. Pair with browser_snapshot: the screenshot shows layout, the snapshot names the elements.",
    parameters: {
      properties: {
        path: {
          type: "string",
          description: "Optional workspace-relative save path. Defaults to images/browser-<timestamp>.png.",
        },
        port: { type: "number", description: "Optional debugger port. Defaults to 9222." },
      },
      required: [],
    },
  },
  {
    name: "process_output",
    effect: "read",
    description:
      "Report a background command job's status and the tail of what it has printed. Use wait_ms to block briefly (up to 5 000) for a result instead of polling in a tight loop. Works whether the job is still running or has finished.",
    parameters: {
      properties: {
        job: {
          type: "string",
          description: 'The job id run_command returned, e.g. "bg-3".',
        },
        wait_ms: {
          type: "number",
          description:
            "Optional: block up to this many ms waiting for the job to finish (capped at 5 000). Default 0 — report immediately.",
        },
      },
      required: ["job"],
    },
  },
  {
    name: "process_kill",
    effect: "mutate",
    description:
      "Stop a background command job: SIGINT to its process group, escalated to SIGKILL after a short grace if it is still running. Jobs are NOT stopped by the session's Stop — this tool is their stop path. Killing an already-finished job is a no-op, not an error.",
    parameters: {
      properties: {
        job: {
          type: "string",
          description: 'The job id run_command returned, e.g. "bg-3".',
        },
      },
      required: ["job"],
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
  {
    name: "dispatch_agent",
    effect: "read",
    description:
      "Delegate one self-contained research task to a sub-agent that works in its own fresh context with the read-only tools and returns ONLY a final summary. Use it when a survey (many files, many pages) would flood this conversation with intermediate results. The sub-agent sees nothing of this conversation and cannot modify the workspace — the task text must carry everything it needs.",
    parameters: {
      properties: {
        task: {
          type: "string",
          description:
            "The complete task for the sub-agent, self-contained: what to find, where to look, and what the summary should cover.",
        },
        agent: {
          type: "string",
          description:
            "Optional: the specialist to run, by id, from the specialist list in this tool's description. Omit for the general researcher.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "load_skill",
    effect: "read",
    description:
      "Load the full instructions of an installed skill. The system prompt lists the available skills by name with a one-line summary; when the current task matches one, load it here and follow its procedure before acting.",
    parameters: {
      properties: {
        name: { type: "string", description: "The skill's name, exactly as the system prompt's skill list shows it." },
      },
      required: ["name"],
    },
  },
  {
    name: "generate_image",
    effect: "mutate",
    description:
      "Generate an image from a text prompt through the gateway's image route and save it into the workspace (images/ by default). The saved file is also attached as an image part, so a vision-capable model can see what it made. Needs an image model configured in Router Settings → defaults.",
    parameters: {
      properties: {
        prompt: { type: "string", description: "What the image should show. Be specific and concrete." },
        path: {
          type: "string",
          description: "Optional workspace-relative save path. Defaults to images/generated-<timestamp>.png.",
        },
        model: {
          type: "string",
          description:
            "Optional image model as \"provider/model\". Defaults to the configured default image model.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "read_notebook",
    effect: "read",
    description:
      "List the cells of a Jupyter notebook (.ipynb): index, type, execution count, outputs and a one-line preview of each — the map that edit_notebook targets by index.",
    parameters: {
      properties: {
        path: { type: "string", description: "Workspace-relative path of the .ipynb." },
      },
      required: ["path"],
    },
  },
  {
    name: "edit_notebook",
    effect: "mutate",
    description:
      "Edit one cell of a Jupyter notebook (.ipynb): replace its source, insert a new code/markdown cell, or delete one. Everything untouched — outputs, metadata, kernel spec — is preserved. Read the notebook first so the index matches the listing.",
    parameters: {
      properties: {
        path: { type: "string", description: "Workspace-relative path of the .ipynb." },
        action: { type: "string", description: '"replace", "insert" or "delete".' },
        index: { type: "number", description: "0-based cell position, as read_notebook's listing shows." },
        cell_type: { type: "string", description: 'insert only: "code" or "markdown".' },
        source: { type: "string", description: "replace/insert only: the full new cell text." },
      },
      required: ["path", "action", "index"],
    },
  },
];

/**
 * The registry a `dispatch_agent` sub-agent runs with: the read-effect tools only, minus two.
 * `dispatch_agent` itself is excluded — a sub-agent that could spawn sub-agents is recursion
 * with no bound — and `todo_write` is excluded because the sub-agent's transcript is discarded,
 * so a task list it writes would be a lie the model told itself.
 */
export const SUBAGENT_TOOLS: ToolSpec[] = AGENT_TOOLS.filter(
  (t) => t.effect === "read" && t.name !== "dispatch_agent" && t.name !== "todo_write",
);

/**
 * The parent registry with `dispatch_agent`'s description carrying the enabled specialists, so
 * the model can route a task to one deliberately instead of guessing ids. Cloned, never
 * mutated: `AGENT_TOOLS` is a shared const, and the specialist list is per-run state.
 */
export function withSubagentDefs(defs: { id: string; name: string; description: string }[]): ToolSpec[] {
  if (defs.length === 0) return AGENT_TOOLS;
  const list = defs
    .map((d) => `- ${d.id} (${d.name}): ${d.description}`)
    .join("\n");
  return AGENT_TOOLS.map((t) =>
    t.name !== "dispatch_agent"
      ? t
      : {
          ...t,
          description:
            t.description +
            "\n\nAvailable specialist sub-agents (pass one as \"agent\"; omit for the general researcher):\n" +
            list,
        },
  );
}

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

/**
 * Register dynamically discovered tools (MCP) into the effect lookup, so the approval policy
 * sees their declared effect instead of the fail-closed default. The fail-closed rule itself
 * does not move: a name registered here is one a live server advertised, and anything absent
 * from both this map and `AGENT_TOOLS` is still `"mutate"`.
 */
export function registerToolEffects(specs: ToolSpec[]): void {
  for (const spec of specs) EFFECT_BY_NAME.set(spec.name, spec.effect);
}
