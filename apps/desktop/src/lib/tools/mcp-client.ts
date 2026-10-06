/**
 * MCP tools — the Tauri-touching half of the bridge (2026-10-06).
 *
 * Split from `mcp.ts` for the same reason `host.ts` is never imported by tests: this module
 * imports `@tauri-apps/api`, that one stays node-testable.
 *
 * `fetchMcpTools` is what the turn engine calls when it builds its registry. Failure philosophy:
 * MCP is additive, so every failure path collapses to "no extra tools" rather than breaking the
 * turn — a wedged MCP server must never take the builtin tools down with it.
 */
import { invoke } from "@tauri-apps/api/core";

import { mcpToolToSpec, registerMcpDispatch, type McpRefreshOutcome, type McpServerConfig } from "./mcp";
import { registerToolEffects } from "./registry";
import type { ToolSpec } from "./types";

/** How long a listing is trusted before the next turn re-asks the servers. Connections are
 *  cached Rust-side, so a re-list is one JSON-RPC exchange per server, not a respawn. */
const CACHE_MS = 60_000;

let cache: { tools: ToolSpec[]; at: number } | null = null;
let lastFailures: string[] = [];

/**
 * The MCP tools to merge under the builtin registry, cached briefly. Empty on any failure —
 * including "not running in the desktop shell at all".
 */
export async function fetchMcpTools(force = false): Promise<ToolSpec[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.tools;

  let outcome: McpRefreshOutcome | null = null;
  try {
    outcome = await invoke<McpRefreshOutcome>("mcp_refresh");
  } catch {
    outcome = null; // older backend, headless shell, or a total failure: the turn goes on
  }

  const tools = outcome?.tools.map(mcpToolToSpec) ?? [];
  registerMcpDispatch(outcome?.tools ?? []);
  // The approval policy reads effects by name (`toolEffect`); without this registration every
  // MCP tool would fail closed to `mutate` even when the server declared it read-only.
  registerToolEffects(tools);
  lastFailures = outcome?.failures ?? [];
  cache = { tools, at: Date.now() };
  return tools;
}

/** Per-server failures from the most recent refresh, for the settings screen to surface. */
export function mcpFailures(): string[] {
  return lastFailures;
}

/** Drop the cache — the settings screen calls this after editing the server list. */
export function clearMcpCache(): void {
  cache = null;
}

// ---- server config (the settings screen's seam) ----

/** The configured servers, as the user wrote them. Empty on failure — a screen that cannot read
 *  the list must still render. */
export async function fetchMcpServers(): Promise<McpServerConfig[]> {
  try {
    return await invoke<McpServerConfig[]>("mcp_servers_get");
  } catch {
    return [];
  }
}

/** Validate (Rust-side) and replace the whole list, then drop the tool cache so the next turn
 *  re-lists against the new configuration. */
export async function saveMcpServers(servers: McpServerConfig[]): Promise<void> {
  await invoke("mcp_servers_set", { servers });
  clearMcpCache();
}

/** Connect and list now, whatever the cache says. Failures come back per-server, and the cache
 *  is dropped so the next agent turn sees exactly what this refresh saw. */
export async function refreshMcp(): Promise<McpRefreshOutcome> {
  const outcome = await invoke<McpRefreshOutcome>("mcp_refresh");
  lastFailures = outcome.failures;
  clearMcpCache();
  return outcome;
}
