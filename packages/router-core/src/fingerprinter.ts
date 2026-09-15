/**
 * dialect-fingerprinter (L1, §2.4): the deterministic, NO-AI classifier. A probe report in,
 * a builtin template (pinned to the user's baseUrl) out. This is the fresh-install bootstrap
 * path — it must work with zero configured providers.
 *
 * Signatures (per §2.4):
 *   openai-compat:   a model list ({data:[{id,…}]}) at /models or /v1/models
 *                    AND a chat-completions endpoint that exists (any status — 401/405 proves it)
 *   anthropic-compat: a /messages or /v1/messages endpoint exists AND no chat-completions
 *   openapi:         an OpenAPI document was found (Phase 3: recorded as evidence; deriving a
 *                    manifest from the spec is the Phase 4 generator's job)
 */

import type { AdapterManifest } from "@aiprovider/adapter-spec";
import type { ProbeReport } from "./probe-runner.js";
import { BUILTIN_TEMPLATES, type BuiltinTemplateId } from "./builtin-templates.js";

export interface FingerprintResult {
  dialect: BuiltinTemplateId | "unknown";
  template?: AdapterManifest;
  evidence: string[];
}

interface Hit {
  ok: boolean; // 2xx
  exists: boolean; // any response (2xx/3xx/4xx) as opposed to network error/404
  modelsShape?: unknown;
}

function analyze(report: ProbeReport): Record<string, Hit> {
  const out: Record<string, Hit> = {};
  for (const a of report.attempts) {
    // normalize /v1/x and /x to x
    const key = a.path.replace(/^\/v1\//, "/").replace(/^\//, "");
    if (a.status === null) continue; // network error — no signal
    const exists = a.status !== 404 && a.status < 500;
    const ok = a.status >= 200 && a.status < 300;
    const hit: Hit = { ok, exists };
    if (key === "models" && ok && a.bodyShape) hit.modelsShape = a.bodyShape;
    // keep the first meaningful signal per normalized path
    if (!out[key] || (ok && !out[key]!.ok)) out[key] = hit;
  }
  return out;
}

export function fingerprint(report: ProbeReport): FingerprintResult {
  const h = analyze(report);
  const evidence: string[] = [];
  const models = h["models"];
  const chat = h["chat/completions"];
  const messages = h["messages"];

  const modelsListLooksRight = Boolean(
    models?.ok &&
      models.modelsShape &&
      JSON.stringify(models.modelsShape).includes("data"),
  );
  if (models?.ok) {
    evidence.push(
      modelsListLooksRight
        ? "model list responded with a {data:[…]} shape"
        : "model list responded but with an unexpected shape",
    );
  }
  if (chat?.exists) evidence.push(`chat/completions endpoint exists (HTTP ${chat.ok ? "200" : "reachable"})`);
  if (messages?.exists) evidence.push("messages endpoint exists");
  if (report.openapiShape) evidence.push("OpenAPI document found");

  // openai-compat: model list with the right shape + chat/completions exists.
  if (modelsListLooksRight && (chat?.exists || report.openapiShape)) {
    return { dialect: "openai-compat", template: BUILTIN_TEMPLATES["openai-compat"](report.baseUrl), evidence };
  }
  // anthropic-compat: messages endpoint, no OpenAI chat surface.
  if (messages?.exists && !chat?.exists) {
    return { dialect: "anthropic-compat", template: BUILTIN_TEMPLATES["anthropic-compat"](report.baseUrl), evidence };
  }
  // OpenAI-shaped model list alone is still a strong openai signal (chat may 404 OPTIONS on
  // some gateways); template it and let the contract suite decide.
  if (modelsListLooksRight) {
    return { dialect: "openai-compat", template: BUILTIN_TEMPLATES["openai-compat"](report.baseUrl), evidence };
  }
  return { dialect: "unknown", evidence };
}
