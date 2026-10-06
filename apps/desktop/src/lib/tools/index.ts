/**
 * Agent-mode tools — public surface.
 *
 * Production UI imports `runAgentLoop`, `AGENT_TOOLS`, `createTauriToolHost`, `fetchToolsPolicy`.
 * Tests import `runAgentLoop` + `AGENT_TOOLS` and inject a fake `ToolHost` (host.ts not imported).
 */
export { AGENT_TOOLS, registryToOpenAI, toolEffect, registerToolEffects } from "./registry";
export { createTauriToolHost, fetchToolsPolicy, fetchDefaultRoot } from "./host";
export type { ToolsPolicy } from "./host";
export { mcpName, mcpToolToSpec, mcpTargetOf } from "./mcp";
export type { McpServerConfig, McpToolInfo, McpRefreshOutcome } from "./mcp";
export { fetchMcpTools, mcpFailures, clearMcpCache } from "./mcp-client";
export { runAgentLoop, clampIterations, DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS_CAP } from "./agentLoop";
export type { ToolSpec, ToolEffect, ToolHost, GenerateFn, AgentEvent, AgentLoopOptions } from "./types";
export {
  APPROVAL_MODES, INITIAL_APPROVAL, decide, withTrustedTool, withAllowAll, planRefusal, modeApprovesWrites,
} from "./approval";
export type { ApprovalMode, ApprovalState, Verdict } from "./approval";
export { RunCheckpoint, createCheckpointingHost, revertPlan } from "./changeset";
export type { RunChangeSet, RunFileChange, RevertPlan, RevertOp } from "./changeset";
