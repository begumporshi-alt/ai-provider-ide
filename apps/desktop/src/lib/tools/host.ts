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
      return { ok: res.ok, output: res.output };
    },
  };
}

/** Surface the sandbox allowlist to the UI so the user sees what agent mode can actually do. */
export async function fetchToolsPolicy(): Promise<ToolsPolicy> {
  return invoke<ToolsPolicy>("tools_policy");
}
