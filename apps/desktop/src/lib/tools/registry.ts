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

/**
 * How many items one `fan_out` call may carry.
 *
 * A **fan-out is not free**: every item is a full sub-agent run with its own step budget, so the
 * caller's spend is roughly the item count times one child. The cap is what keeps one model call from
 * committing to an unbounded number of runs, and the concurrency cap then decides how many of them
 * are actually in flight at once — a batch bigger than the cap still works, it just executes in waves.
 * The number is deliberately modest and declared here beside the tool's schema, where the model reads
 * it, rather than only enforced in the loop.
 */
export const FAN_OUT_MAX = 12;

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
          description:
            'Workspace-relative path, e.g. "src/main.rs". Cannot be absolute or escape the root.',
        },
        offset: {
          type: "number",
          description:
            "Optional first line to return, 1-based. Omit to start at the top.",
        },
        limit: {
          type: "number",
          description:
            "Optional number of lines to return. Omit to read to the end.",
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
    description:
      "List the entries of a workspace directory. Defaults to the workspace root.",
    parameters: {
      properties: {
        path: {
          type: "string",
          description:
            'Workspace-relative directory path. Optional; defaults to ".".',
        },
        recursive: {
          type: "boolean",
          description:
            "Optional. true to include subdirectories instead of just one level.",
        },
      },
      required: [],
    },
  },
  {
    name: "search_files",
    effect: "read",
    description:
      'Search the workspace for a LITERAL string (no regex) and return matching lines as path:line: text. Case-insensitive by default. Good for a name you already know. For a PATTERN — a regex, alternative spellings, a whole-word match, or finding definitions by shape — use run_command with rg instead (rg -n "fn handle_(request|response)" src; rg -nw MyType). This tool cannot express those.',
    parameters: {
      properties: {
        pattern: {
          type: "string",
          description: "Literal text to find. Not a regex.",
        },
        path: {
          type: "string",
          description:
            'Optional workspace-relative file or directory to search. Defaults to ".".',
        },
        case_sensitive: {
          type: "boolean",
          description:
            "Optional. true to match case exactly (default is case-insensitive).",
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
        path: {
          type: "string",
          description: "Workspace-relative path of the file to edit.",
        },
        old: {
          type: "string",
          description:
            "Exact text to find. Quote enough surrounding lines to make it unique.",
        },
        new: {
          type: "string",
          description: "Replacement text. May be empty to delete the snippet.",
        },
        replace_all: {
          type: "boolean",
          description:
            "Optional. true to replace every occurrence instead of refusing an ambiguous match.",
        },
      },
      required: ["path", "old", "new"],
    },
  },
  {
    name: "mkdir",
    effect: "mutate",
    description:
      "Create a directory inside the workspace, including any missing parents.",
    parameters: {
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative directory path.",
        },
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
            "Executable from the allowlist: ls, cat, grep, rg, find, git, gh, node, npm, npx, pnpm, python3, make, cargo (Rust: cargo build, cargo test, cargo clippy, cargo fmt — cargo install and cargo publish are refused), tar, sed, awk, sips (image work: resize, crop, convert, and report real pixel dimensions), …",
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Positional arguments, each a literal string.",
        },
        timeout_ms: {
          type: "number",
          description:
            "Optional wall-clock timeout in ms (enforced upper bound is 60 000).",
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
        url: {
          type: "string",
          description: "The page to open — an http(s) or file:// URL.",
        },
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
        port: {
          type: "number",
          description: "Optional debugger port. Defaults to 9222.",
        },
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
        element: {
          type: "number",
          description: "The [N] index from the latest browser_snapshot.",
        },
        port: {
          type: "number",
          description: "Optional debugger port. Defaults to 9222.",
        },
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
        element: {
          type: "number",
          description: "The [N] index from the latest browser_snapshot.",
        },
        text: { type: "string", description: "The value to enter." },
        port: {
          type: "number",
          description: "Optional debugger port. Defaults to 9222.",
        },
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
          description:
            "Optional workspace-relative save path. Defaults to images/browser-<timestamp>.png.",
        },
        port: {
          type: "number",
          description: "Optional debugger port. Defaults to 9222.",
        },
        viewport_width: {
          type: "number",
          description:
            "Optional emulated viewport width in CSS px for a mobile/tablet capture. Requires viewport_height.",
        },
        viewport_height: {
          type: "number",
          description:
            "Optional emulated viewport height in CSS px. Requires viewport_width.",
        },
        mobile: {
          type: "boolean",
          description:
            "Optional. true enables mobile emulation (meta viewport handling). Defaults to false.",
        },
        device_scale_factor: {
          type: "number",
          description:
            "Optional device pixel ratio for the emulated viewport. Defaults to 1.",
        },
      },
      required: [],
    },
  },
  {
    name: "browser_print",
    effect: "mutate",
    description:
      "Render the connected page to PDF with print media emulated — the only tool that applies @media print and @page — and save it into the workspace (documents/ by default). Use it to verify a print layout; browser_screenshot captures the screen instead. Read the result back with read_document.",
    parameters: {
      properties: {
        path: {
          type: "string",
          description:
            "Optional workspace-relative .pdf save path. Defaults to documents/print-<timestamp>.pdf.",
        },
        port: {
          type: "number",
          description: "Optional debugger port. Defaults to 9222.",
        },
        paper: {
          type: "string",
          enum: ["a4", "letter", "legal"],
          description:
            "Optional paper size. Without it Chrome uses the page's CSS @page size (Letter when unspecified).",
        },
        paper_width_in: {
          type: "number",
          description:
            "Optional custom paper width in inches. Requires paper_height_in.",
        },
        paper_height_in: {
          type: "number",
          description:
            "Optional custom paper height in inches. Requires paper_width_in.",
        },
        margin_in: {
          type: "number",
          description:
            "Optional uniform margin in inches; requires paper or custom paper dimensions. Without paper, CSS @page margins apply.",
        },
        landscape: {
          type: "boolean",
          description:
            "Optional. true renders landscape pages. Defaults to portrait.",
        },
        viewport_width: {
          type: "number",
          description:
            "Optional emulated viewport width in CSS px for mobile/tablet print. Requires viewport_height.",
        },
        viewport_height: {
          type: "number",
          description:
            "Optional emulated viewport height in CSS px. Requires viewport_width.",
        },
        mobile: {
          type: "boolean",
          description:
            "Optional. true enables mobile emulation (meta viewport handling). Defaults to false.",
        },
        device_scale_factor: {
          type: "number",
          description:
            "Optional device pixel ratio for the emulated viewport. Defaults to 1.",
        },
      },
      required: [],
    },
  },
  {
    name: "browser_console",
    effect: "read",
    description:
      "Report the console output and uncaught exceptions the connected page has printed since the last browser_console call, oldest first. This is how you learn WHY something did not work — a click that 'did nothing' usually threw. Drains: call it after acting on the page, and it will be quiet the second time.",
    parameters: {
      properties: {
        port: {
          type: "number",
          description: "Optional debugger port. Defaults to 9222.",
        },
      },
      required: [],
    },
  },
  {
    name: "browser_network",
    effect: "read",
    description:
      "Report requests that failed since the last browser_network call — 4xx/5xx responses, and requests that never got one (refused connection, CORS, DNS). Drains like browser_console. Only failures are kept; a request that loaded is not reported.",
    parameters: {
      properties: {
        port: {
          type: "number",
          description: "Optional debugger port. Defaults to 9222.",
        },
      },
      required: [],
    },
  },
  {
    name: "browser_wait_for",
    effect: "read",
    description:
      "Block until the page's visible text contains the given string (up to 30 000 ms, default 10 000). Use after clicking something asynchronous instead of guessing with repeated snapshots — a wait that times out means the page did not do what you expected.",
    parameters: {
      properties: {
        text: {
          type: "string",
          description: "The string to wait for in the page's visible text.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional deadline in ms (250–30 000, default 10 000).",
        },
        port: {
          type: "number",
          description: "Optional debugger port. Defaults to 9222.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_expect",
    effect: "read",
    description:
      'Assert that the page satisfies an expectation, retrying until a deadline: kind "text" (visible text contains value), "element" (a CSS selector matches), "url" or "title" (contains value). The assertion form of browser_wait_for — a miss reports what the page actually showed (title, URL, or text), so a failed test is a diagnosis, not a guess.',
    parameters: {
      properties: {
        kind: {
          type: "string",
          description: 'What to assert: "text", "element", "url", or "title".',
        },
        value: {
          type: "string",
          description:
            "For text/url/title: the string that must appear. For element: a CSS selector.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional deadline in ms (250–30 000, default 10 000).",
        },
        port: {
          type: "number",
          description: "Optional debugger port. Defaults to 9222.",
        },
      },
      required: ["kind", "value"],
    },
  },
  {
    name: "browser_start",
    effect: "mutate",
    description:
      "Start the machine's Chrome (or Chromium/Edge/Brave) with the debugger port so the browser tools can attach, using a dedicated throwaway profile. Use after a browser tool reported that no browser is answering. A browser already answering is reported as success, so calling this twice is safe.",
    parameters: {
      properties: {
        port: {
          type: "number",
          description: "Optional debugger port. Defaults to 9222.",
        },
      },
      required: [],
    },
  },
  {
    name: "device_list",
    effect: "read",
    description:
      "List the Android devices and emulators adb can see, with serial and state. Use it before device_open_url or device_screenshot; it says so when adb or a device is missing.",
    parameters: {
      properties: {},
      required: [],
    },
  },
  {
    name: "device_open_url",
    effect: "mutate",
    description:
      "Open a URL in the connected Android device's browser and wait briefly for it to load. From the standard emulator, 10.0.2.2 reaches the host. Use device_list first if unsure.",
    parameters: {
      properties: {
        url: {
          type: "string",
          description: "http:// or https:// URL to open.",
        },
        serial: {
          type: "string",
          description:
            "Optional adb serial from device_list. Defaults to the first ready device.",
        },
        wait_ms: {
          type: "number",
          description:
            "Optional wait after launching, in ms (default 1500, max 10000).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "device_screenshot",
    effect: "mutate",
    description:
      "Capture the connected Android device's screen as a PNG saved into the workspace (images/ by default) and attach it, so a vision model sees the real device. Use device_list first; pair with device_open_url.",
    parameters: {
      properties: {
        serial: {
          type: "string",
          description:
            "Optional adb serial from device_list. Defaults to the first ready device.",
        },
        path: {
          type: "string",
          description:
            "Optional workspace-relative .png save path. Defaults to images/device-<serial>-<timestamp>.png.",
        },
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
          description:
            'Glob relative to the workspace root, e.g. "src/**/*.rs". May not contain "..".',
        },
        path: {
          type: "string",
          description:
            'Optional workspace-relative base directory to match within. Defaults to ".".',
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
        path: {
          type: "string",
          description: "Workspace-relative path of the .pdf or .docx.",
        },
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
        path: {
          type: "string",
          description: "Workspace-relative path of the image.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "web_ask",
    effect: "network",
    description:
      "Ask a question about a web page: fetches it and answers with the model in a side call, so the page text stays out of the conversation. Only the answer is returned.",
    parameters: {
      properties: {
        url: { type: "string", description: "The page's public http(s) URL." },
        question: {
          type: "string",
          description: "What you want to know from that page.",
        },
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
        url: {
          type: "string",
          description:
            "Public http(s) URL. Redirects are reported, not followed.",
        },
        method: {
          type: "string",
          description:
            "Optional: GET (default), POST, PUT, PATCH, DELETE, HEAD, OPTIONS.",
        },
        headers: {
          type: "object",
          description: "Optional request headers as name/value strings.",
        },
        body: {
          type: "string",
          description: "Optional request body (POST/PUT/PATCH only).",
        },
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
          description:
            "The full unified diff, ---/+++ and @@ hunks included. New files start from /dev/null.",
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
              content: {
                type: "string",
                description: "The task, one sentence.",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  {
    name: "enter_plan_mode",
    effect: "read",
    description:
      "Ask the user to switch this pass into plan mode before anything changes: for a task big, " +
      "risky or ambiguous enough that the shape should be agreed first. In plan mode you can read, " +
      "list, search and inspect, but every write is refused until a plan is approved. The user " +
      "consents or declines, and their answer arrives as this tool's result. Do not call it when " +
      "plan mode is already on, and do not use it to ask a question — questions go in your answer.",
    parameters: { properties: {} },
  },
  {
    name: "exit_plan_mode",
    effect: "read",
    description:
      "Present the plan for approval — the way a planning pass ends. Pass the complete plan as " +
      "markdown: what we are building; the files to create; the files to modify by exact path; how " +
      "the result will be verified; and what is explicitly out of scope. The user reviews that " +
      "text. If they approve, plan mode ends and you implement the plan in this same pass, " +
      "starting immediately. If they ask for changes, revise the plan and call this again. Call it " +
      "when the plan is ready — never to ask a question, and never before you have looked at the " +
      "code the plan is about.",
    parameters: {
      properties: {
        plan: {
          type: "string",
          description:
            "The complete plan, in markdown. This exact text is what the user reviews.",
        },
      },
      required: ["plan"],
    },
  },
  {
    name: "web_fetch",
    effect: "network",
    description:
      "Read a public web page from the internet: fetched over http(s), HTML stripped, text capped at 32 KB. Private, loopback and non-http(s) URLs are refused.",
    parameters: {
      properties: {
        url: {
          type: "string",
          description:
            "The page's public http(s) URL. Redirects are reported, not followed — call again on the Location.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "web_search",
    effect: "network",
    description:
      "Search the public web (keyless, automatic fallback between backends) and get the top results: title, URL and snippet. Follow up with web_fetch to read a result.",
    parameters: {
      properties: {
        query: {
          type: "string",
          description: "What to search for, in the user's terms.",
        },
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
    name: "fan_out",
    effect: "read",
    description:
      "Run several independent delegated tasks at once and get one STRUCTURED result per task. Use it when the work is a set of similar, independent items — survey these twelve files, check these eight endpoints, read these six specs — where one `dispatch_agent` per round would serialise work that can run in parallel. Each task gets its own fresh context and its own summary, and the results come back as JSON, one object per task, so items can be compared and acted on individually. Use `dispatch_agent` instead when ONE survey needs several rounds of its own; use this when the items do not depend on each other. Each task is a full sub-agent run, so N tasks cost roughly N times one — and they still run under the same concurrency cap, so a batch larger than the cap simply executes in waves.",
    parameters: {
      properties: {
        tasks: {
          type: "array",
          description: `The tasks, at most ${FAN_OUT_MAX}. Each entry is one delegated run.`,
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                description:
                  "Short name for this item, echoed back in its result so you can tell which is which. Defaults to its position (task-1, task-2…).",
              },
              task: {
                type: "string",
                description:
                  "The complete task for this item, self-contained: the sub-agent sees nothing else of this conversation.",
              },
              agent: {
                type: "string",
                description:
                  "Optional: the specialist to run this item, by id. Omit for the general researcher. An unknown id fails THIS item only, naming the valid ids.",
              },
            },
            required: ["task"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "load_skill",
    effect: "read",
    description:
      "Load the full instructions of an installed skill. The system prompt lists the available skills by name with a one-line summary; when the current task matches one, load it here and follow its procedure before acting.",
    parameters: {
      properties: {
        name: {
          type: "string",
          description:
            "The skill's name, exactly as the system prompt's skill list shows it.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "generate_image",
    effect: "mutate",
    description:
      "Generate an image from a text prompt through the gateway's image route and save it into the workspace (images/ by default). The saved file is also attached as an image part, so a vision-capable model can see what it made. REQUIRES a provider that serves image generations (OpenRouter, OpenAI, Replicate…): none of the providers configured by default does, so this call fails with NO_ROUTE until one is added in Settings → Providers. Check that before promising an image; sips through run_command can resize or convert an existing file, but cannot create one.",
    parameters: {
      properties: {
        prompt: {
          type: "string",
          description: "What the image should show. Be specific and concrete.",
        },
        path: {
          type: "string",
          description:
            "Optional workspace-relative save path. Defaults to images/generated-<timestamp>.png.",
        },
        model: {
          type: "string",
          description:
            'Optional image model as "provider/model". Defaults to the configured default image model.',
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
        path: {
          type: "string",
          description: "Workspace-relative path of the .ipynb.",
        },
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
        path: {
          type: "string",
          description: "Workspace-relative path of the .ipynb.",
        },
        action: {
          type: "string",
          description: '"replace", "insert" or "delete".',
        },
        index: {
          type: "number",
          description:
            "0-based cell position, as read_notebook's listing shows.",
        },
        cell_type: {
          type: "string",
          description: 'insert only: "code" or "markdown".',
        },
        source: {
          type: "string",
          description: "replace/insert only: the full new cell text.",
        },
      },
      required: ["path", "action", "index"],
    },
  },
  {
    name: "list_sessions",
    effect: "read",
    description:
      "List the app's past conversation sessions, newest first: id, title, date range, model, turn and tool-call counts, and a one-line preview. Use search_sessions when looking for a topic; use this to browse or to answer 'what did we work on'.",
    parameters: {
      properties: {
        limit: {
          type: "number",
          description:
            "Optional maximum to return (default 25, capped at 100).",
        },
      },
    },
  },
  {
    name: "search_sessions",
    effect: "read",
    description:
      "Full-text search across every past session's transcript — both sides of every conversation, not just titles. Returns hits with the matched words bracketed, so you can judge context before reading a whole session. This is the only way to find where something was said; list_sessions only shows previews.",
    parameters: {
      properties: {
        query: {
          type: "string",
          description: "Words to look for. Case and word form don't matter.",
        },
        limit: {
          type: "number",
          description:
            "Optional maximum hits to return (default 30, capped at 200).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_session",
    effect: "read",
    description:
      "Read one past session's transcript in order: each turn's role, text and timestamps, with tool calls and their results. Get the session id from list_sessions or search_sessions. Long turns are clipped; ask for a session whose search hits looked relevant rather than reading many whole sessions.",
    parameters: {
      properties: {
        session_id: {
          type: "string",
          description:
            "The session's id, exactly as list_sessions or search_sessions returned it.",
        },
      },
      required: ["session_id"],
    },
  },
  {
    name: "search_agents",
    effect: "read",
    description:
      "Search conversations from other AI coding agents (Claude, Codex, Qoder, router sessions) that live outside this app. Returns the adapter name, native id, title, project root, turn count, and a preview. Use this when you need context from a different agent's session — then load_session to pull it in. The native store is read-only; load_session is the only write.",
    parameters: {
      properties: {
        query: {
          type: "string",
          description:
            "Words to match against titles, previews, and project roots. Case-insensitive.",
        },
        root: {
          type: "string",
          description:
            "Optional workspace root to scope the search to. When omitted, searches every adapter. When blank, searches none — use this only with a real workspace path.",
        },
        limit: {
          type: "number",
          description: "Optional maximum matches (default 25, capped at 100).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "load_session",
    effect: "read",
    description:
      "Import a session from another AI coding agent into this conversation's transcript store, scoped to its original project root. The foreign store is untouched — this copies the transcript, scrubs secrets, and writes rows under a derived id so re-importing is idempotent. Use search_agents to get the source and native_id. One session at a time, never a sweep.",
    parameters: {
      properties: {
        source: {
          type: "string",
          description: 'The adapter name from search_agents (e.g. "claude").',
        },
        native_id: {
          type: "string",
          description: "The session's native id from search_agents.",
        },
      },
      required: ["source", "native_id"],
    },
  },
  {
    name: "read_manifest",
    effect: "read",
    description:
      "Read this session's manifest: the scoped identity, preferences, decisions and verified capabilities the assistant was given. Each entry has a stable id you can quote to the user. Use it when asked what you remember or where a belief came from.",
    parameters: { properties: {} },
  },
  {
    name: "forget_memory",
    effect: "mutate",
    description:
      "Delete one memory by id. Only call this when the user explicitly asks to forget it. The id comes from read_manifest or a recall card.",
    parameters: {
      properties: {
        id: { type: "string", description: "The memory id to delete." },
      },
      required: ["id"],
    },
  },
];

/**
 * Tools a `dispatch_agent` sub-agent may never have, at any privilege level.
 *
 * `dispatch_agent` itself is excluded because a sub-agent that could spawn sub-agents is recursion
 * with no bound. `todo_write` is excluded because the sub-agent's transcript is discarded, so a
 * task list it writes would be a lie the model told itself. The plan-mode pair is excluded because
 * the mode belongs to the session, not to a child whose transcript nobody sees: a sub-agent that
 * could enter plan mode would gate the parent's writes, one that could exit it would silently open
 * them, and a child cannot be the thing that approves the plan the parent is executing.
 */
const SUBAGENT_NEVER = new Set([
  "dispatch_agent",
  "fan_out",
  "todo_write",
  "enter_plan_mode",
  "exit_plan_mode",
  // The session history is the parent conversation's own knowledge base: a child delegated one
  // self-contained task has no need to browse past sessions, and every session tool it spends
  // rounds on is context the parent already has — the parent can search sessions itself and hand
  // the child exactly the excerpt the task needs.
  "list_sessions",
  "search_sessions",
  "read_session",
  "search_agents",
  "load_session",
  // The manifest is this session's own header and `forget_memory` deletes from the user's durable
  // memory. A child's task is self-contained; neither read nor delete belongs in its hands, and a
  // deletion a parent cannot see is the exact shape of a silent destructive action.
  "read_manifest",
  "forget_memory",
]);

/**
 * The registry a `dispatch_agent` sub-agent runs with by default: the read-effect tools only.
 *
 * This is the shipped posture, and it is what every call site gets unless the user has turned
 * sub-agent writes on — see [`subagentTools`].
 */
export const SUBAGENT_TOOLS: ToolSpec[] = AGENT_TOOLS.filter(
  (t) => t.effect === "read" && !SUBAGENT_NEVER.has(t.name),
);

/**
 * The registry a sub-agent runs with when the user has enabled sub-agent writes: everything except
 * [`SUBAGENT_NEVER`] — writes, edits and commands are available; recursion, self-narration and plan
 * mode are not.
 */
export const SUBAGENT_WRITE_TOOLS: ToolSpec[] = AGENT_TOOLS.filter(
  (t) => !SUBAGENT_NEVER.has(t.name),
);

/**
 * Which set a sub-agent gets.
 *
 * **The user's setting is the only thing that can widen this.** That is worth stating plainly,
 * because it is one line away from being broken: a `SubagentDef.tools` list is applied by the loop
 * as a **filter over the granted set**, so a definition can only ever narrow — a definition naming
 * `write_file` while sub-agent writes are off gets nothing, not a permission. Nothing in a
 * definition file, and nothing a model can say, reaches [`SUBAGENT_WRITE_TOOLS`] on its own.
 */
export function subagentTools(canWrite: boolean): ToolSpec[] {
  return canWrite ? SUBAGENT_WRITE_TOOLS : SUBAGENT_TOOLS;
}

/**
 * The `dispatch_agent` description as shipped — the read-only one — read out of the registry rather
 * than repeated here, so the read-only path keeps exactly one copy of that text.
 */
const DISPATCH_READ_ONLY_DESCRIPTION =
  AGENT_TOOLS.find((t) => t.name === "dispatch_agent")?.description ?? "";

/**
 * The same description when sub-agent writes are on.
 *
 * It has to change with the setting and not merely alongside it: the read-only text says outright
 * that the sub-agent "cannot modify the workspace", so a model running with writes enabled would be
 * told its own capability does not exist — and would spend the delegation asking the parent to make
 * the change instead. The approval-gate sentence is the load-bearing half: it is what makes a
 * write-capable child a delegation rather than a permission bypass.
 */
const DISPATCH_WRITE_DESCRIPTION =
  "Delegate one self-contained task to a sub-agent that works in its own fresh context with the " +
  "FULL tool set — file writes, edits and commands included — and returns ONLY a final summary. " +
  "Use it when a survey, or a self-contained piece of work, would flood this conversation with " +
  "intermediate results. The sub-agent sees nothing of this conversation; it works in the same " +
  "workspace you do, and every mutation it attempts passes through YOUR approval gate — a denial " +
  "reaches it as a refusal, never as a silent success. The task text must carry everything it needs.";

/**
 * The parent registry with `dispatch_agent`'s description carrying the enabled specialists and the
 * privilege level the child will actually run at, so the model can route a task deliberately
 * instead of guessing ids. Cloned, never mutated: `AGENT_TOOLS` is a shared const, and both the
 * specialist list and the write setting are per-run state.
 */
export function withSubagentDefs(
  defs: { id: string; name: string; description: string }[],
  opts: { canWrite?: boolean } = {},
): ToolSpec[] {
  const list = defs
    .map((d) => `- ${d.id} (${d.name}): ${d.description}`)
    .join("\n");
  const description =
    (opts.canWrite === true
      ? DISPATCH_WRITE_DESCRIPTION
      : DISPATCH_READ_ONLY_DESCRIPTION) +
    (list
      ? '\n\nAvailable specialist sub-agents (pass one as "agent"; omit for the general researcher):\n' +
        list
      : "");
  return AGENT_TOOLS.map((t) =>
    t.name === "dispatch_agent" ? { ...t, description } : t,
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
