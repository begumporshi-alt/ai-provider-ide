/**
 * Tauri host bridge for agent-mode tools (2026-09-17).
 *
 * This is the ONLY module in the tools layer that touches `@tauri-apps/api`. The agent loop
 * never imports it; it depends only on the `ToolHost` interface, so tests inject a fake.
 * Each call forwards to the Rust `tool_run` command, which is where the allowlist, path
 * confinement, timeout and output caps are actually enforced (tools.rs) — this file is a
 * thin, key-blind pass-through. MCP tools (`mcp_*` names) route to `mcp_call` instead, with
 * the same result shape and the same failure mapping — one honest reason either way.
 */
import { invoke } from "@tauri-apps/api/core";
import { mcpTargetOf } from "./mcp";
import type { ToolHost } from "./types";

interface WireToolResult {
  ok: boolean;
  output: string;
  error?: string | null;
}

export interface ToolsPolicy {
  /** The programs that start with no configuration. */
  programs: string[];
  /**
   * The user's additions, kept separate from `programs` so the screen can say which list a program
   * came from rather than rendering one merged set it cannot explain.
   */
  extra_programs: string[];
  /**
   * Programs refused unconditionally — these stay refused even if added, so the screen shows them
   * for the same reason it shows `programs`: the user should see the boundary, not infer it.
   */
  never_allowed: string[];
  git_subcommands: string[];
  max_command_ms: number;
  max_output_bytes: number;
}

/** Build a `ToolHost` bound to one workspace root. Every call is confined to that root. */
export function createTauriToolHost(root: string): ToolHost {
  return {
    async run(name, args, opts) {
      const callId = opts?.callId;
      const signal = opts?.signal;
      // Aborted before the call even went out: report it, do not start work the user just
      // cancelled. (The loop checks its own signal at the same boundary; this is the host's own
      // guarantee for a caller that does not.)
      if (signal?.aborted) return { ok: false, output: "stopped by you — this call was not run" };

      // MCP tools ride their own command, routed through the dispatch map the last listing
      // populated. A name no live server advertised fails closed rather than guessing a server.
      const mcpTarget = name.startsWith("mcp_") ? mcpTargetOf(name) : null;
      const inflight = mcpTarget
        ? invoke<WireToolResult>("mcp_call", {
            server: mcpTarget.server,
            tool: mcpTarget.tool,
            arguments: args,
          })
        : invoke<WireToolResult>("tool_run", {
            req: { name, arguments: args, root },
            ...(callId ? { callId } : {}),
          });
      // The stop path. Flipping the abort signal cannot by itself end a sandbox command that is
      // already running, so the host asks the sandbox to cancel it — SIGINT, then SIGKILL, to the
      // child's whole process group — and resolves immediately. The invoke above still settles
      // when the Rust side returns `stopped by you`; whichever lands first, the caller gets the
      // honest reason. Nothing is left dangling: `race` handles both promises.
      const stopped = new Promise<WireToolResult>((resolve) => {
        if (!signal) return; // never settles — the race is then just `inflight`
        signal.addEventListener(
          "abort",
          () => {
            if (callId) void invoke<boolean>("tool_cancel", { callId }).catch(() => undefined);
            resolve({ ok: false, output: "", error: "stopped by you" });
          },
          { once: true },
        );
      });

      const res = await Promise.race([inflight, stopped]);
      // A refusal carries its reason in `error`, not `output` — on the failure path `output` is
      // deliberately empty (`ToolResult::err`). Returning it as-is handed the model a blank tool
      // result for every denied or refused call, which is how a run ends with "the tool results
      // came back empty" and no way to tell why. Never let a failure reach the model empty.
      if (!res.ok) {
        const reason = res.error?.trim() || res.output.trim() || `tool "${name}" failed`;
        return { ok: false, output: reason };
      }
      return { ok: true, output: res.output };
    },
  };
}

/** Surface the sandbox allowlist to the UI so the user sees what agent mode can actually do. */
export async function fetchToolsPolicy(): Promise<ToolsPolicy> {
  return invoke<ToolsPolicy>("tools_policy");
}

/**
 * Read a background job's status and output tail — the same read-only `process_output` sandbox
 * tool the model polls, invoked from the UI so the person can watch a long job live instead of
 * seeing "running…" until the model happens to poll. Never mutates; a wrong or evicted id comes
 * back as `ok: false` with the sandbox's own explanation.
 */
export async function fetchProcessOutput(
  root: string,
  job: string,
  waitMs = 0,
): Promise<{ ok: boolean; output: string }> {
  const res = await invoke<WireToolResult>("tool_run", {
    req: { name: "process_output", arguments: { job, wait_ms: waitMs }, root },
  });
  if (!res.ok) return { ok: false, output: res.error?.trim() || res.output };
  return { ok: true, output: res.output };
}

/**
 * Stop a background job — the same `process_kill` sandbox tool the model is told to use, invoked
 * from the UI so the person does not have to ask the assistant to stop their own job. SIGINT to
 * the process group, then SIGKILL after the grace window (tools.rs); the card's next poll reads
 * the resulting status.
 */
export async function killProcess(root: string, job: string): Promise<{ ok: boolean; output: string }> {
  const res = await invoke<WireToolResult>("tool_run", {
    req: { name: "process_kill", arguments: { job }, root },
  });
  if (!res.ok) return { ok: false, output: res.error?.trim() || res.output };
  return { ok: true, output: res.output };
}

/**
 * Replace the sandbox's user-added programs (Settings → Tools), returning the policy now in force.
 *
 * The returned policy — not the requested list — is what the screen must render: the host
 * normalises (trims, de-duplicates, sorts) and refuses a never-allowed or path-shaped name, so a
 * screen that echoed its own input would claim a program runs that does not.
 */
export async function setToolsExtraPrograms(programs: string[]): Promise<ToolsPolicy> {
  return invoke<ToolsPolicy>("tools_set_extra_programs", { programs });
}

/**
 * Persist an approved plan under the workspace's `.zcode/plans/`, returning the relative path.
 *
 * Deliberately not a sandbox tool: a plan is not a workspace change, so it must not enter the
 * run's change set, be offered to "revert this run", or be refused by plan mode as a write — the
 * plan is the one document a planning pass exists to leave behind (`core/plan_doc.rs`).
 *
 * Best-effort: `null` means the file could not be written, and an approval the user already gave
 * stands either way rather than being lost to a filesystem error.
 */
export async function savePlan(
  root: string,
  sessionId: string,
  markdown: string,
): Promise<string | null> {
  try {
    return await invoke<string>("plan_save", { root, sessionId, markdown });
  } catch (e) {
    // Degrade, but not silently: the approval stands without the file, and a systematic failure
    // (an old build without the command, an unwritable workspace) would otherwise be
    // indistinguishable from success — plans would simply never reach disk and nobody would know.
    console.warn("plan_save failed — the plan was approved but not written", e);
    return null;
  }
}

/**
 * The workspace agent mode starts in, or `null` when the host cannot name one.
 *
 * The agent cannot run without a root, and an empty root is what disables Send — so a fresh
 * screen used to greet the user with a dead Send button and no explanation. Asking the host is
 * what makes "a default is already set" true: the folder is the one the gateway confines its own
 * tools to, so the two paths agree on where the workspace is.
 *
 * `null` is not an error to show. It means this host cannot answer (an older backend), and the
 * user types a root exactly as before.
 */
export async function fetchDefaultRoot(): Promise<string | null> {
  try {
    const root = await invoke<string>("tools_default_root");
    return root && root.trim() ? root : null;
  } catch {
    return null;
  }
}
