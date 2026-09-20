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
    async run(name, args) {
      const res = await invoke<WireToolResult>("tool_run", {
        req: { name, arguments: args, root },
      });
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
