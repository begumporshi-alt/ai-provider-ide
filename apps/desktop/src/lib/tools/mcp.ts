/**
 * MCP (Model Context Protocol) tools — the pure half of the bridge (2026-10-06).
 *
 * External MCP servers declare tools over JSON-RPC; the Rust client (`core/mcp.rs`) connects,
 * lists and calls them. This module is the webview-side mapping from a server's tool declaration
 * to the registry's `ToolSpec`, plus the name→(server, tool) dispatch map the host uses to route
 * an `mcp_*` call. It is deliberately Tauri-free so it is node-testable — the convention
 * `host.ts` established.
 *
 * Effect discipline: a server's `readOnlyHint` annotation is the only thing that can soften an
 * MCP tool toward `read`; absence fails closed to `mutate`, the same rule `toolEffect` applies
 * to names it does not know. Third-party code never runs unprompted by default.
 */
import type { ToolEffect, ToolSpec } from "./types";

/** One configured MCP server, as the user wrote it (mirrors Rust `McpServerConfig`). */
export interface McpServerConfig {
  id: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

/** One discovered tool, as the Rust `mcp_refresh` reports it (mirrors `McpToolInfo`). */
export interface McpToolInfo {
  server: string;
  tool: string;
  fullName: string;
  description: string | null;
  readOnly: boolean;
  parameters: { properties: Record<string, unknown>; required?: string[] };
}

/** What `mcp_refresh` answered: the live tools plus per-server failures that did not stop
 *  the healthy servers. */
export interface McpRefreshOutcome {
  tools: McpToolInfo[];
  failures: string[];
}

/** The registry name the model sees for one server's tool. */
export function mcpName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`;
}

/** Map one wire tool to a `ToolSpec`. Pure: the dispatch map lives in `mcp-client.ts`, which
 *  owns the fetch. */
export function mcpToolToSpec(info: McpToolInfo): ToolSpec {
  const effect: ToolEffect = info.readOnly ? "read" : "mutate";
  return {
    name: info.fullName,
    description: info.description || `Tool "${info.tool}" from the "${info.server}" MCP server.`,
    effect,
    parameters: {
      properties: info.parameters?.properties ?? {},
      required: Array.isArray(info.parameters?.required) ? info.parameters.required : [],
    },
  };
}

// ---- dispatch ----
//
// The host holds only the name the model called; `mcp_call` needs the (server, tool) pair. The
// fetch populates this map from the listing, so a name can only be routed if the server actually
// advertised it — a stale or invented `mcp_*` name fails closed.

const DISPATCH = new Map<string, { server: string; tool: string }>();

/** Register one listing's worth of tools. Replaces whatever was there: the map always mirrors
 *  the most recent refresh. */
export function registerMcpDispatch(tools: McpToolInfo[]): void {
  DISPATCH.clear();
  for (const t of tools) {
    DISPATCH.set(t.fullName, { server: t.server, tool: t.tool });
  }
}

/** The (server, tool) behind a registry name, or `null` when no live server advertised it. */
export function mcpTargetOf(name: string): { server: string; tool: string } | null {
  return DISPATCH.get(name) ?? null;
}

/** Test seam: forget every routed tool. */
export function resetMcpDispatch(): void {
  DISPATCH.clear();
}
