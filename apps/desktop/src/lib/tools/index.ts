/**
 * Agent-mode tools — public surface.
 *
 * Production UI imports `runAgentLoop`, `AGENT_TOOLS`, `createTauriToolHost`, `fetchToolsPolicy`.
 * Tests import `runAgentLoop` + `AGENT_TOOLS` and inject a fake `ToolHost` (host.ts not imported).
 */
export { AGENT_TOOLS, registryToOpenAI } from "./registry";
export { createTauriToolHost, fetchToolsPolicy, fetchDefaultRoot } from "./host";
export type { ToolsPolicy } from "./host";
export { runAgentLoop, clampIterations, DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS_CAP } from "./agentLoop";
export type { ToolSpec, ToolHost, GenerateFn, AgentEvent, AgentLoopOptions } from "./types";
