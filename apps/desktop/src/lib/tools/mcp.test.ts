/**
 * MCP bridge unit tests (2026-10-06) — the pure half only (`mcp.ts`); `mcp-client.ts` touches
 * Tauri and follows the `host.ts` convention of staying out of tests. The Rust side owns the
 * protocol tests, including a real stdio server (core/mcp.rs).
 */
import { describe, expect, it } from "vitest";
import { mcpName, mcpTargetOf, mcpToolToSpec, registerMcpDispatch, resetMcpDispatch } from "./mcp";

describe("mcpToolToSpec", () => {
  it("maps a declared tool to a registry spec with the fail-closed effect", () => {
    const spec = mcpToolToSpec({
      server: "github",
      tool: "list_issues",
      fullName: "mcp_github_list_issues",
      description: "lists issues",
      readOnly: false,
      parameters: { properties: { repo: { type: "string" } }, required: ["repo"] },
    });
    expect(spec.name).toBe("mcp_github_list_issues");
    expect(spec.description).toBe("lists issues");
    expect(spec.effect).toBe("mutate");
    expect(spec.parameters).toEqual({
      properties: { repo: { type: "string" } },
      required: ["repo"],
    });
  });

  it("lets the server's readOnlyHint soften the effect to read", () => {
    const spec = mcpToolToSpec({
      server: "s",
      tool: "t",
      fullName: "mcp_s_t",
      description: null,
      readOnly: true,
      parameters: { properties: {} },
    });
    expect(spec.effect).toBe("read");
  });

  it("coerces a missing schema into an empty object schema and writes its own description", () => {
    const spec = mcpToolToSpec({
      server: "s",
      tool: "t",
      fullName: "mcp_s_t",
      description: null,
      readOnly: false,
      parameters: undefined as unknown as { properties: Record<string, unknown> },
    });
    expect(spec.parameters).toEqual({ properties: {}, required: [] });
    expect(spec.description).toBe('Tool "t" from the "s" MCP server.');
  });
});

describe("the mcp dispatch map", () => {
  it("routes advertised names and forgets the previous listing on refresh", () => {
    resetMcpDispatch();
    registerMcpDispatch([
      { server: "a", tool: "x", fullName: mcpName("a", "x"), description: null, readOnly: false, parameters: { properties: {} } },
    ]);
    expect(mcpTargetOf("mcp_a_x")).toEqual({ server: "a", tool: "x" });
    expect(mcpTargetOf("mcp_a_y")).toBeNull();

    registerMcpDispatch([
      { server: "b", tool: "y", fullName: mcpName("b", "y"), description: null, readOnly: false, parameters: { properties: {} } },
    ]);
    expect(mcpTargetOf("mcp_a_x")).toBeNull();
    expect(mcpTargetOf("mcp_b_y")).toEqual({ server: "b", tool: "y" });
  });
});
