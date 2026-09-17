/**
 * Gateway client detector — identifies which AI coding IDE is calling the gateway
 * from HTTP headers, so per-client adaptations can be applied.
 */

export type ClientHint = "workbuddy" | "claude-code" | "codex" | "zcode" | "cursor" | "generic";

export function detectClient(headers: Record<string, string>): ClientHint {
  const ua = (headers["user-agent"] || "").toLowerCase();
  const xClient = (headers["x-client-name"] || "").toLowerCase();
  const xCodex = headers["x-codex-client"] != null;

  if (ua.includes("workbuddy") || xClient.includes("workbuddy")) return "workbuddy";
  if (ua.includes("claude-code") || ua.includes("anthropic") || xClient.includes("claude-code")) return "claude-code";
  if (ua.includes("codex") || xClient.includes("codex") || xCodex) return "codex";
  if (ua.includes("z.ai") || ua.includes("zcode") || xClient.includes("zcode") || xClient.includes("z.ai")) return "zcode";
  if (ua.includes("cursor") || xClient.includes("cursor")) return "cursor";
  return "generic";
}
