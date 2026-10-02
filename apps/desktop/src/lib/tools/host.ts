/**
 * Tauri host bridge for agent-mode tools (2026-09-17).
 *
 * This is the ONLY module in the tools layer that touches `@tauri-apps/api`. The agent loop
 * never imports it; it depends only on the `ToolHost` interface, so tests inject a fake.
 * Each call forwards to the Rust `tool_run` command, which is where the allowlist, path
 * confinement, timeout and output caps are actually enforced (tools.rs) — this file is a
 * thin, key-blind pass-through.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ToolHost } from "./types";

interface WireToolResult {
  ok: boolean;
  output: string;
  error?: string | null;
}

export interface ToolsPolicy {
  programs: string[];
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

      const inflight = invoke<WireToolResult>("tool_run", {
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
